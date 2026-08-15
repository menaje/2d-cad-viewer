import {
  GpuLineBatchKind,
  HatchFlags,
  HatchStyle,
} from "./scene-cache.mjs";
import {
  encodeMaskBucket,
  maskBucketFor,
} from "./mask-order.mjs";
import { encodeCadLineStyle } from "./cad-line-style.mjs";
import {
  appendRenderIdentityRange,
  packRenderIdentityRanges,
} from "./render-identity-ranges.mjs";

export const HATCH_PATTERN_VERTEX_STRIDE = 32;
export const MAX_HATCH_PATTERN_GPU_BYTES = 32 * 1024 * 1024;
export const MAX_HATCH_PATTERN_SEGMENTS = 250_000;
export const MAX_HATCH_PATTERN_SEGMENTS_PER_ENTITY = 65_536;
export const MAX_HATCH_PATTERN_LOOPS_PER_ENTITY = 2_048;
export const MAX_HATCH_PATTERN_INTERSECTION_TESTS = 8_000_000;
export const MIN_HATCH_PATTERN_SPACING_PIXELS = 1.5;

const MAX_BATCH_VERTICES = 16_384;
const INITIAL_BATCH_BYTES = 4 * 1024;
const MAX_POSITION_ERROR = 1e-3;
const GEOMETRY_EPSILON = 1e-10;
const PATH_FLAG_SELF_INTERSECTING = 64;
const PATH_FLAG_DUPLICATE = 256;

function dot3(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross2(leftX, leftY, rightX, rightY) {
  return leftX * rightY - leftY * rightX;
}

function normalize3(value) {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    return null;
  }
  return value.map((coordinate) => coordinate / length);
}

function ocsBasis(normal) {
  const zAxis = normalize3(normal);
  if (!zAxis) {
    return null;
  }
  const xCandidate =
    Math.abs(zAxis[0]) < 1 / 64 && Math.abs(zAxis[1]) < 1 / 64
      ? [zAxis[2], 0, -zAxis[0]]
      : [-zAxis[1], zAxis[0], 0];
  const xAxis = normalize3(xCandidate);
  if (!xAxis) {
    return null;
  }
  const yAxis = [
    zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
    zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
    zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0],
  ];
  return { xAxis, yAxis, zAxis };
}

function ocsPointToWcs(x, y, elevation, basis, target = [0, 0, 0]) {
  for (let axis = 0; axis < 3; axis += 1) {
    target[axis] =
      basis.xAxis[axis] * x +
      basis.yAxis[axis] * y +
      basis.zAxis[axis] * elevation;
  }
  return target;
}

function projectedArea(coordinates) {
  const originX = coordinates[0];
  const originY = coordinates[1];
  let twiceArea = 0;
  for (let index = 0; index < coordinates.length; index += 2) {
    const next = (index + 2) % coordinates.length;
    twiceArea +=
      (coordinates[index] - originX) *
        (coordinates[next + 1] - originY) -
      (coordinates[next] - originX) *
        (coordinates[index + 1] - originY);
  }
  return twiceArea * 0.5;
}

function pointOnSegment(x, y, startX, startY, endX, endY) {
  const scale = Math.max(
    1,
    Math.abs(x),
    Math.abs(y),
    Math.abs(startX),
    Math.abs(startY),
    Math.abs(endX),
    Math.abs(endY),
  );
  if (
    Math.abs(
      cross2(x - startX, y - startY, endX - startX, endY - startY),
    ) >
    scale * scale * Number.EPSILON * 64
  ) {
    return false;
  }
  const epsilon = scale * Number.EPSILON * 64;
  return (
    x >= Math.min(startX, endX) - epsilon &&
    x <= Math.max(startX, endX) + epsilon &&
    y >= Math.min(startY, endY) - epsilon &&
    y <= Math.max(startY, endY) + epsilon
  );
}

function pointInRing(x, y, coordinates) {
  let inside = false;
  for (
    let index = 0, previous = coordinates.length - 2;
    index < coordinates.length;
    previous = index, index += 2
  ) {
    const startX = coordinates[previous];
    const startY = coordinates[previous + 1];
    const endX = coordinates[index];
    const endY = coordinates[index + 1];
    if (pointOnSegment(x, y, startX, startY, endX, endY)) {
      return true;
    }
    if (
      startY > y !== endY > y &&
      x < ((endX - startX) * (y - startY)) / (endY - startY) + startX
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function boundsContain(outer, inner) {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

function classifyRingNesting(rings) {
  for (const ring of rings) {
    let parent = null;
    const x = ring.coordinates[0];
    const y = ring.coordinates[1];
    for (const candidate of rings) {
      if (
        candidate === ring ||
        candidate.absoluteArea <= ring.absoluteArea ||
        !boundsContain(candidate.bounds, ring.bounds) ||
        !pointInRing(x, y, candidate.coordinates)
      ) {
        continue;
      }
      if (!parent || candidate.absoluteArea < parent.absoluteArea) {
        parent = candidate;
      }
    }
    ring.parent = parent;
  }
  for (const ring of rings) {
    let current = ring.parent;
    let depth = 0;
    while (current && depth <= rings.length) {
      depth += 1;
      current = current.parent;
    }
    ring.depth = depth > rings.length ? 0 : depth;
    if (depth > rings.length) {
      ring.parent = null;
    }
  }
}

function patternGroups(rings, style) {
  const groups = [];
  for (const outer of rings) {
    const included =
      style === HatchStyle.Ignore
        ? outer.depth === 0
        : style === HatchStyle.Outer
          ? outer.depth === 0
          : outer.depth % 2 === 0;
    if (!included) {
      continue;
    }
    groups.push({
      outer,
      holes:
        style === HatchStyle.Ignore
          ? []
          : rings.filter(
              (ring) =>
                ring.parent === outer && ring.depth === outer.depth + 1,
            ),
    });
  }
  return groups;
}

function pointInGroups(x, y, groups) {
  return groups.some(
    ({ outer, holes }) =>
      pointInRing(x, y, outer.coordinates) &&
      !holes.some((hole) => pointInRing(x, y, hole.coordinates)),
  );
}

function classifyOwner(entity, blocks, instanceGraph, blockIndexByHandle) {
  const blockIndex = blockIndexByHandle.get(entity.ownerHandle);
  if (blockIndex === undefined) {
    return entity.ownerHandle === 0n
      ? { key: "model", kind: GpuLineBatchKind.ModelDetail, blockIndex: null }
      : null;
  }
  const block = blocks[blockIndex];
  if (instanceGraph.modelBlockIndices.has(blockIndex)) {
    return { key: "model", kind: GpuLineBatchKind.ModelDetail, blockIndex: null };
  }
  if (block?.name.toUpperCase().startsWith("*PAPER_SPACE")) {
    return null;
  }
  return {
    key: `block:${blockIndex}`,
    kind: GpuLineBatchKind.BlockDefinition,
    blockIndex,
  };
}

function readRings(source, entity, basis, metrics) {
  const rings = [];
  const loopTarget = {};
  const vertexTarget = [0, 0, 0];
  const loopCount = Math.min(
    entity.loopCount,
    MAX_HATCH_PATTERN_LOOPS_PER_ENTITY,
  );
  for (let loopOffset = 0; loopOffset < loopCount; loopOffset += 1) {
    const loop = source.readLoop(entity.firstLoop + loopOffset, loopTarget);
    if (
      loop.pathFlags & (PATH_FLAG_SELF_INTERSECTING | PATH_FLAG_DUPLICATE)
    ) {
      metrics.skippedInvalidLoops += 1;
      continue;
    }
    const coordinates = new Float64Array(loop.vertexCount * 2);
    const bounds = {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };
    for (let index = 0; index < loop.vertexCount; index += 1) {
      source.readVertex(loop.firstVertex + index, vertexTarget);
      const x = dot3(vertexTarget, basis.xAxis);
      const y = dot3(vertexTarget, basis.yAxis);
      coordinates[index * 2] = x;
      coordinates[index * 2 + 1] = y;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
    const area = projectedArea(coordinates);
    const extent = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
    );
    if (
      !Number.isFinite(area) ||
      Math.abs(area) <= Math.max(extent * extent * 1e-14, 1e-18)
    ) {
      metrics.skippedInvalidLoops += 1;
      continue;
    }
    rings.push({
      coordinates,
      bounds,
      absoluteArea: Math.abs(area),
      parent: null,
      depth: 0,
    });
  }
  if (loopCount < entity.loopCount) {
    metrics.truncatedHatches += 1;
  }
  classifyRingNesting(rings);
  return rings;
}

function projectedOcsRange(rings, normalX, normalY) {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (let index = 0; index < ring.coordinates.length; index += 2) {
      const value =
        ring.coordinates[index] * normalX +
        ring.coordinates[index + 1] * normalY;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  return { minimum, maximum };
}

function viewportRect(camera) {
  return {
    minX: camera.origin[0] - camera.worldWidth * 0.5,
    maxX: camera.origin[0] + camera.worldWidth * 0.5,
    minY: camera.origin[1] - camera.worldHeight * 0.5,
    maxY: camera.origin[1] + camera.worldHeight * 0.5,
  };
}

function transformPointXY(matrix, offset, point) {
  if (!matrix) {
    return [point[0], point[1]];
  }
  return [
    matrix[offset] * point[0] +
      matrix[offset + 4] * point[1] +
      matrix[offset + 8] * point[2] +
      matrix[offset + 12],
    matrix[offset + 1] * point[0] +
      matrix[offset + 5] * point[1] +
      matrix[offset + 9] * point[2] +
      matrix[offset + 13],
  ];
}

function transformVectorXY(matrix, offset, vector) {
  if (!matrix) {
    return [vector[0], vector[1]];
  }
  return [
    matrix[offset] * vector[0] +
      matrix[offset + 4] * vector[1] +
      matrix[offset + 8] * vector[2],
    matrix[offset + 1] * vector[0] +
      matrix[offset + 5] * vector[1] +
      matrix[offset + 9] * vector[2],
  ];
}

function transformedBoundsIntersect(bounds, matrix, offset, rectangle) {
  const center = [
    bounds.min[0] * 0.5 + bounds.max[0] * 0.5,
    bounds.min[1] * 0.5 + bounds.max[1] * 0.5,
    bounds.min[2] * 0.5 + bounds.max[2] * 0.5,
  ];
  const extent = [
    (bounds.max[0] - bounds.min[0]) * 0.5,
    (bounds.max[1] - bounds.min[1]) * 0.5,
    (bounds.max[2] - bounds.min[2]) * 0.5,
  ];
  const worldCenter = transformPointXY(matrix, offset, center);
  const worldExtentX =
    Math.abs(matrix[offset]) * extent[0] +
    Math.abs(matrix[offset + 4]) * extent[1] +
    Math.abs(matrix[offset + 8]) * extent[2];
  const worldExtentY =
    Math.abs(matrix[offset + 1]) * extent[0] +
    Math.abs(matrix[offset + 5]) * extent[1] +
    Math.abs(matrix[offset + 9]) * extent[2];
  return !(
    worldCenter[0] + worldExtentX < rectangle.minX ||
    worldCenter[0] - worldExtentX > rectangle.maxX ||
    worldCenter[1] + worldExtentY < rectangle.minY ||
    worldCenter[1] - worldExtentY > rectangle.maxY
  );
}

function visibleBlockInstances(instanceGraph, rectangle) {
  const visible = new Map();
  const boundsByIndex = instanceGraph.blockBoundsByIndex ?? [];
  for (const [blockIndex, instances] of instanceGraph.instancesByBlock ?? []) {
    const bounds = boundsByIndex[blockIndex];
    if (!bounds || instances.count === 0) {
      continue;
    }
    const indices = [];
    const linearOffsets = [];
    const linearKeys = new Set();
    for (let index = 0; index < instances.count; index += 1) {
      const offset = index * 16;
      if (
        !transformedBoundsIntersect(
          bounds,
          instances.data,
          offset,
          rectangle,
        )
      ) {
        continue;
      }
      indices.push(index);
      const key = [
        instances.data[offset],
        instances.data[offset + 1],
        instances.data[offset + 4],
        instances.data[offset + 5],
        instances.data[offset + 8],
        instances.data[offset + 9],
      ].join(":");
      if (!linearKeys.has(key)) {
        linearKeys.add(key);
        linearOffsets.push(offset);
      }
    }
    if (indices.length > 0) {
      visible.set(blockIndex, {
        data: instances.data,
        indices,
        packedIndices: Uint32Array.from(indices),
        linearOffsets,
      });
    }
  }
  return visible;
}

function screenDefinition(matrix, offset, base, direction, lineOffset) {
  const point = transformPointXY(matrix, offset, base);
  const transformedDirection = transformVectorXY(
    matrix,
    offset,
    direction,
  );
  const transformedOffset = transformVectorXY(
    matrix,
    offset,
    lineOffset,
  );
  const directionLength = Math.hypot(...transformedDirection);
  if (!Number.isFinite(directionLength) || directionLength <= GEOMETRY_EPSILON) {
    return null;
  }
  const normal = [
    -transformedDirection[1] / directionLength,
    transformedDirection[0] / directionLength,
  ];
  const spacing =
    normal[0] * transformedOffset[0] +
    normal[1] * transformedOffset[1];
  if (!Number.isFinite(spacing) || Math.abs(spacing) <= GEOMETRY_EPSILON) {
    return null;
  }
  return {
    point,
    direction: transformedDirection,
    directionLength,
    normal,
    spacing,
  };
}

function viewportProjectionRange(rectangle, normal) {
  const values = [
    rectangle.minX * normal[0] + rectangle.minY * normal[1],
    rectangle.minX * normal[0] + rectangle.maxY * normal[1],
    rectangle.maxX * normal[0] + rectangle.minY * normal[1],
    rectangle.maxX * normal[0] + rectangle.maxY * normal[1],
  ];
  return [Math.min(...values), Math.max(...values)];
}

function mergeRanges(ranges) {
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of ranges) {
    const active = merged.at(-1);
    if (!active || range[0] > active[1] + 1) {
      merged.push([...range]);
    } else {
      active[1] = Math.max(active[1], range[1]);
    }
  }
  return merged;
}

function mergeIntervals(intervals) {
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of intervals) {
    const active = merged.at(-1);
    const epsilon =
      Math.max(1, Math.abs(interval[0]), Math.abs(active?.[1] ?? 0)) *
      1e-9;
    if (!active || interval[0] > active[1] + epsilon) {
      merged.push([...interval]);
    } else {
      active[1] = Math.max(active[1], interval[1]);
    }
  }
  return merged;
}

export function buildHatchPatternBlockBounds(batches, blockCount) {
  const bounds = new Array(blockCount).fill(null);
  for (const batch of batches) {
    if (batch.kind !== GpuLineBatchKind.BlockDefinition) {
      continue;
    }
    let target = bounds[batch.blockIndex];
    if (!target) {
      target = {
        min: [...batch.bounds.min],
        max: [...batch.bounds.max],
      };
      bounds[batch.blockIndex] = target;
      continue;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      target.min[axis] = Math.min(target.min[axis], batch.bounds.min[axis]);
      target.max[axis] = Math.max(target.max[axis], batch.bounds.max[axis]);
    }
  }
  return bounds;
}

function clipLineInterval(point, direction, interval, rectangle) {
  let [minimum, maximum] = interval;
  for (const [coordinate, delta, low, high] of [
    [point[0], direction[0], rectangle.minX, rectangle.maxX],
    [point[1], direction[1], rectangle.minY, rectangle.maxY],
  ]) {
    if (Math.abs(delta) <= GEOMETRY_EPSILON) {
      if (coordinate < low || coordinate > high) {
        return null;
      }
      continue;
    }
    const first = (low - coordinate) / delta;
    const last = (high - coordinate) / delta;
    minimum = Math.max(minimum, Math.min(first, last));
    maximum = Math.min(maximum, Math.max(first, last));
    if (maximum - minimum <= GEOMETRY_EPSILON) {
      return null;
    }
  }
  return [minimum, maximum];
}

function lineIntersections(rings, point, direction, metrics, maximumTests) {
  const values = [];
  for (const ring of rings) {
    const coordinates = ring.coordinates;
    for (let index = 0; index < coordinates.length; index += 2) {
      metrics.intersectionTests += 1;
      if (metrics.intersectionTests > maximumTests) {
        metrics.cpuLimitReached = true;
        return null;
      }
      const next = (index + 2) % coordinates.length;
      const startX = coordinates[index];
      const startY = coordinates[index + 1];
      const edgeX = coordinates[next] - startX;
      const edgeY = coordinates[next + 1] - startY;
      const denominator = cross2(direction[0], direction[1], edgeX, edgeY);
      if (Math.abs(denominator) <= GEOMETRY_EPSILON) {
        continue;
      }
      const relativeX = startX - point[0];
      const relativeY = startY - point[1];
      const startSide = cross2(
        direction[0],
        direction[1],
        relativeX,
        relativeY,
      );
      const endSide = startSide + denominator;
      const sideEpsilon =
        Math.max(1, Math.abs(startSide), Math.abs(endSide)) *
        Number.EPSILON *
        64;
      const crosses =
        (startSide <= sideEpsilon && endSide > sideEpsilon) ||
        (endSide <= sideEpsilon && startSide > sideEpsilon);
      if (!crosses) {
        continue;
      }
      values.push(
        cross2(relativeX, relativeY, edgeX, edgeY) / denominator,
      );
    }
  }
  values.sort((left, right) => left - right);
  if (values.length % 2 !== 0) {
    metrics.skippedInvalidIntersections += 1;
    return [];
  }
  return values;
}

class PackedPatternBatch {
  constructor(owner, firstPoint) {
    this.owner = owner;
    this.origin = [...firstPoint];
    this.buffer = new ArrayBuffer(INITIAL_BATCH_BYTES);
    this.view = new DataView(this.buffer);
    this.byteLength = 0;
    this.vertexCount = 0;
    this.identityRanges = [];
    this.maximumPositionError = 0;
    this.bounds = { min: [...firstPoint], max: [...firstPoint] };
  }

  canAccept(points) {
    return (
      this.vertexCount + 2 <= MAX_BATCH_VERTICES &&
      points.every((point) =>
        point.every((coordinate, axis) => {
          const local = coordinate - this.origin[axis];
          return Math.abs(Math.fround(local) - local) <= MAX_POSITION_ERROR;
        }),
      )
    );
  }

  writeSegment(points, attributes) {
    this.#ensure(2 * HATCH_PATTERN_VERTEX_STRIDE);
    appendRenderIdentityRange(
      this.identityRanges,
      attributes.handle,
      this.vertexCount,
      2,
    );
    for (const point of points) {
      const offset = this.byteLength;
      for (let axis = 0; axis < 3; axis += 1) {
        const local = point[axis] - this.origin[axis];
        const stored = Math.fround(local);
        this.view.setFloat32(offset + axis * 4, stored, true);
        this.maximumPositionError = Math.max(
          this.maximumPositionError,
          Math.abs(stored - local),
        );
        this.bounds.min[axis] = Math.min(this.bounds.min[axis], point[axis]);
        this.bounds.max[axis] = Math.max(this.bounds.max[axis], point[axis]);
      }
      this.view.setUint32(offset + 12, attributes.layerIndex, true);
      this.view.setUint32(offset + 16, attributes.color >>> 0, true);
      this.view.setUint32(offset + 20, attributes.handleLow, true);
      this.view.setUint32(offset + 24, attributes.handleHigh, true);
      this.view.setUint32(offset + 28, attributes.style >>> 0, true);
      this.byteLength += HATCH_PATTERN_VERTEX_STRIDE;
      this.vertexCount += 1;
    }
  }

  #ensure(additionalBytes) {
    const required = this.byteLength + additionalBytes;
    if (required <= this.buffer.byteLength) {
      return;
    }
    let capacity = this.buffer.byteLength;
    while (capacity < required) {
      capacity = Math.min(
        MAX_BATCH_VERTICES * HATCH_PATTERN_VERTEX_STRIDE,
        capacity * 2,
      );
    }
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.byteLength));
    this.buffer = next;
    this.view = new DataView(next);
  }
}

class PatternMeshBuilder {
  constructor(maximumBytes, maximumSegments) {
    this.maximumBytes = maximumBytes;
    this.maximumSegments = maximumSegments;
    this.groups = new Map();
    this.byteLength = 0;
    this.segments = 0;
    this.maximumPositionError = 0;
  }

  canWriteSegment() {
    return (
      this.segments < this.maximumSegments &&
      this.byteLength + 2 * HATCH_PATTERN_VERTEX_STRIDE <= this.maximumBytes
    );
  }

  writeSegment(owner, points, attributes) {
    let group = this.groups.get(owner.key);
    if (!group) {
      group = { owner, batches: [], active: null };
      this.groups.set(owner.key, group);
    }
    if (!group.active || !group.active.canAccept(points)) {
      group.active = new PackedPatternBatch(owner, points[0]);
      group.batches.push(group.active);
    }
    group.active.writeSegment(points, attributes);
    this.byteLength += 2 * HATCH_PATTERN_VERTEX_STRIDE;
    this.segments += 1;
  }

  finish() {
    const buffer = new ArrayBuffer(this.byteLength);
    const destination = new Uint8Array(buffer);
    const batches = [];
    const identityRanges = [];
    let byteOffset = 0;
    let firstVertex = 0;
    for (const group of this.groups.values()) {
      for (const builder of group.batches) {
        destination.set(
          new Uint8Array(builder.buffer, 0, builder.byteLength),
          byteOffset,
        );
        batches.push(
          Object.freeze({
            id: batches.length,
            kind: builder.owner.kind,
            lodLevel: 1,
            flags: 0,
            blockIndex: builder.owner.blockIndex,
            instanceIndices: builder.owner.instanceIndices ?? null,
            firstVertex,
            vertexCount: builder.vertexCount,
            origin: Object.freeze([...builder.origin]),
            bounds: Object.freeze({
              min: Object.freeze([...builder.bounds.min]),
              max: Object.freeze([...builder.bounds.max]),
            }),
            maximumPositionError: builder.maximumPositionError,
          }),
        );
        for (const range of builder.identityRanges) {
          appendRenderIdentityRange(
            identityRanges,
            range.handle,
            firstVertex + range.firstVertex,
            range.vertexCount,
          );
        }
        this.maximumPositionError = Math.max(
          this.maximumPositionError,
          builder.maximumPositionError,
        );
        byteOffset += builder.byteLength;
        firstVertex += builder.vertexCount;
        builder.buffer = null;
        builder.view = null;
      }
    }
    return Object.freeze({
      batches: Object.freeze(batches),
      vertices: Object.freeze({
        buffer,
        byteLength: buffer.byteLength,
        vertexCount: this.segments * 2,
      }),
      identityRanges: packRenderIdentityRanges(
        identityRanges,
        this.segments * 2,
      ),
      maximumPositionError: this.maximumPositionError,
    });
  }
}

function dashValues(source, definition) {
  const values = new Array(definition.dashCount);
  let cycle = 0;
  let hasGapOrDot = false;
  for (let index = 0; index < definition.dashCount; index += 1) {
    const value = source.readPatternDash(definition.firstDash + index);
    values[index] = value;
    cycle += Math.abs(value);
    hasGapOrDot ||= value <= 0;
  }
  if (!hasGapOrDot) {
    return { continuous: true, values, cycle };
  }
  return {
    continuous: values.length === 0,
    values,
    cycle,
  };
}

function emitDashedInterval(
  interval,
  dash,
  dotLength,
  emit,
) {
  if (dash.continuous) {
    return emit(interval[0], interval[1]);
  }
  if (!Number.isFinite(dash.cycle) || dash.cycle <= GEOMETRY_EPSILON) {
    return true;
  }
  const firstCycle = Math.floor(interval[0] / dash.cycle) - 1;
  const lastCycle = Math.ceil(interval[1] / dash.cycle) + 1;
  for (let cycleIndex = firstCycle; cycleIndex <= lastCycle; cycleIndex += 1) {
    let cursor = cycleIndex * dash.cycle;
    for (const value of dash.values) {
      if (value > 0) {
        const start = Math.max(interval[0], cursor);
        const end = Math.min(interval[1], cursor + value);
        if (end - start > GEOMETRY_EPSILON && !emit(start, end)) {
          return false;
        }
        cursor += value;
      } else if (value < 0) {
        cursor += -value;
      } else {
        const start = Math.max(interval[0], cursor - dotLength * 0.5);
        const end = Math.min(interval[1], cursor + dotLength * 0.5);
        if (end - start > GEOMETRY_EPSILON && !emit(start, end)) {
          return false;
        }
      }
    }
  }
  return true;
}

export function buildHatchPatternMesh(
  source,
  blocks,
  instanceGraph,
  camera,
  {
    maximumGpuBytes = MAX_HATCH_PATTERN_GPU_BYTES,
    maximumSegments = MAX_HATCH_PATTERN_SEGMENTS,
    maximumSegmentsPerEntity = MAX_HATCH_PATTERN_SEGMENTS_PER_ENTITY,
    maximumIntersectionTests = MAX_HATCH_PATTERN_INTERSECTION_TESTS,
    minimumSpacingPixels = MIN_HATCH_PATTERN_SPACING_PIXELS,
    maskOrder = null,
    fillMode = true,
  } = {},
) {
  if (
    !source ||
    typeof source.readPatternLine !== "function" ||
    typeof source.readPatternDash !== "function"
  ) {
    throw new TypeError("HATCH pattern builder requires a v1.7 source table");
  }
  if (
    !camera ||
    !Array.isArray(camera.origin) ||
    !Number.isFinite(camera.worldWidth) ||
    !Number.isFinite(camera.worldHeight) ||
    camera.worldWidth <= 0 ||
    camera.worldHeight <= 0 ||
    camera.width <= 0 ||
    camera.height <= 0
  ) {
    throw new TypeError("HATCH pattern builder requires a finite camera");
  }
  if (
    !Number.isSafeInteger(maximumGpuBytes) ||
    maximumGpuBytes < 2 * HATCH_PATTERN_VERTEX_STRIDE ||
    !Number.isSafeInteger(maximumSegments) ||
    maximumSegments < 1
  ) {
    throw new RangeError("HATCH pattern GPU limits are invalid");
  }
  if (typeof fillMode !== "boolean") {
    throw new TypeError("drawing FILLMODE must be a boolean");
  }

  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const mesh = new PatternMeshBuilder(maximumGpuBytes, maximumSegments);
  const rectangle = viewportRect(camera);
  const pixelsPerWorld = camera.height / camera.worldHeight;
  const visibleInstances = visibleBlockInstances(instanceGraph, rectangle);
  const entity = { normal: [0, 0, 1] };
  const definition = { basePoint: [0, 0], offset: [0, 0] };
  const metrics = {
    sourceHatches: source.length,
    patternHatches: 0,
    renderedHatches: 0,
    sourceTruncatedHatches: 0,
    patternDefinitions: 0,
    doubleDefinitions: 0,
    renderedDefinitions: 0,
    candidateLines: 0,
    segments: 0,
    vertices: 0,
    gpuBytes: 0,
    batches: 0,
    skippedOwners: 0,
    skippedOffscreenHatches: 0,
    skippedInvalidLoops: 0,
    skippedInvalidDefinitions: 0,
    skippedInvalidIntersections: 0,
    skippedInvalidSegments: 0,
    skippedDenseDefinitions: 0,
    truncatedHatches: 0,
    intersectionTests: 0,
    gpuLimitReached: false,
    cpuLimitReached: false,
    maximumPositionError: 0,
    visibleBlockInstances: [...visibleInstances.values()].reduce(
      (total, instances) => total + instances.indices.length,
      0,
    ),
  };

  if (!fillMode) {
    const result = mesh.finish();
    return Object.freeze({
      ...result,
      metrics: Object.freeze(metrics),
    });
  }

  for (let entityIndex = 0; entityIndex < source.length; entityIndex += 1) {
    source.readEntity(entityIndex, entity);
    if (entity.flags & HatchFlags.Solid || entity.flags & HatchFlags.Gradient) {
      continue;
    }
    metrics.patternHatches += 1;
    if (entity.flags & HatchFlags.Truncated) {
      metrics.sourceTruncatedHatches += 1;
    }
    const owner = classifyOwner(
      entity,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwners += 1;
      continue;
    }
    const renderInstances =
      owner.kind === GpuLineBatchKind.BlockDefinition
        ? visibleInstances.get(owner.blockIndex)
        : {
            data: null,
            indices: [0],
            packedIndices: null,
            linearOffsets: [0],
          };
    if (!renderInstances) {
      metrics.skippedOffscreenHatches += 1;
      continue;
    }
    const patternOwner = {
      ...owner,
      instanceIndices: renderInstances.packedIndices,
    };
    const basis = ocsBasis(entity.normal);
    if (!basis) {
      metrics.skippedInvalidDefinitions += entity.patternLineCount;
      continue;
    }
    const rings = readRings(source, entity, basis, metrics);
    const groups = patternGroups(rings, entity.style);
    if (groups.length === 0) {
      continue;
    }
    const clippingRings = groups.flatMap(({ outer, holes }) => [
      outer,
      ...holes,
    ]);
    const attributes = {
      layerIndex: entity.layerIndex,
      color: entity.color,
      handle: entity.handle,
      handleLow: Number(entity.handle & 0xffffffffn),
      handleHigh: Number((entity.handle >> 32n) & 0xffffffffn),
      style: encodeMaskBucket(
        encodeCadLineStyle({
          lineWeight: entity.lineWeight,
          linetypeCode: 2,
          invisible: Boolean(entity.commonFlags & 1),
        }),
        maskBucketFor(maskOrder, entity.ownerHandle, entity.handle),
      ),
    };
    let entitySegments = 0;
    let renderedEntity = false;
    let entityTruncated = false;

    const doublePattern =
      Boolean(entity.flags & HatchFlags.Double) &&
      entity.patternType === 0;
    const definitionPasses =
      entity.patternLineCount * (doublePattern ? 2 : 1);
    for (
      let definitionOffset = 0;
      definitionOffset < definitionPasses;
      definitionOffset += 1
    ) {
      const sourceDefinitionOffset =
        definitionOffset % entity.patternLineCount;
      source.readPatternLine(
        entity.firstPatternLine + sourceDefinitionOffset,
        definition,
      );
      if (definitionOffset >= entity.patternLineCount) {
        const offsetX = definition.offset[0];
        definition.angle += Math.PI * 0.5;
        definition.offset[0] = -definition.offset[1];
        definition.offset[1] = offsetX;
        metrics.doubleDefinitions += 1;
      }
      metrics.patternDefinitions += 1;
      const direction = [
        Math.cos(definition.angle),
        Math.sin(definition.angle),
      ];
      const normalOcs = [-direction[1], direction[0]];
      const spacingOcs =
        normalOcs[0] * definition.offset[0] +
        normalOcs[1] * definition.offset[1];
      if (
        !Number.isFinite(spacingOcs) ||
        Math.abs(spacingOcs) <= GEOMETRY_EPSILON
      ) {
        metrics.skippedInvalidDefinitions += 1;
        continue;
      }
      const ringRange = projectedOcsRange(clippingRings, ...normalOcs);
      const baseIntercept =
        normalOcs[0] * definition.basePoint[0] +
        normalOcs[1] * definition.basePoint[1];
      const firstRingRatio =
        (ringRange.minimum - baseIntercept) / spacingOcs;
      const lastRingRatio =
        (ringRange.maximum - baseIntercept) / spacingOcs;
      const firstRingLine = Math.ceil(
        Math.min(firstRingRatio, lastRingRatio) - 1e-9,
      );
      const lastRingLine = Math.floor(
        Math.max(firstRingRatio, lastRingRatio) + 1e-9,
      );
      if (
        !Number.isSafeInteger(firstRingLine) ||
        !Number.isSafeInteger(lastRingLine) ||
        lastRingLine < firstRingLine
      ) {
        metrics.skippedInvalidDefinitions += 1;
        continue;
      }

      const baseLocal = ocsPointToWcs(
        definition.basePoint[0],
        definition.basePoint[1],
        entity.elevation,
        basis,
      );
      const directionLocal = ocsPointToWcs(
        direction[0],
        direction[1],
        0,
        basis,
      );
      const offsetLocal = ocsPointToWcs(
        definition.offset[0],
        definition.offset[1],
        0,
        basis,
      );
      let densityEligible = false;
      let maximumDirectionLength = 0;
      for (const matrixOffset of renderInstances.linearOffsets) {
        const screen = screenDefinition(
          renderInstances.data,
          matrixOffset,
          baseLocal,
          directionLocal,
          offsetLocal,
        );
        if (
          screen &&
          Math.abs(screen.spacing) * pixelsPerWorld >= minimumSpacingPixels
        ) {
          densityEligible = true;
          maximumDirectionLength = Math.max(
            maximumDirectionLength,
            screen.directionLength,
          );
        }
      }
      if (!densityEligible) {
        metrics.skippedDenseDefinitions += 1;
        continue;
      }

      const candidateRanges = [];
      const eligibleInstanceIndices = [];
      for (const instanceIndex of renderInstances.indices) {
        const matrixOffset = renderInstances.data ? instanceIndex * 16 : 0;
        const screen = screenDefinition(
          renderInstances.data,
          matrixOffset,
          baseLocal,
          directionLocal,
          offsetLocal,
        );
        if (
          !screen ||
          Math.abs(screen.spacing) * pixelsPerWorld < minimumSpacingPixels
        ) {
          continue;
        }
        maximumDirectionLength = Math.max(
          maximumDirectionLength,
          screen.directionLength,
        );
        eligibleInstanceIndices.push(instanceIndex);
        const viewportRange = viewportProjectionRange(
          rectangle,
          screen.normal,
        );
        const intercept =
          screen.normal[0] * screen.point[0] +
          screen.normal[1] * screen.point[1];
        const firstRatio = (viewportRange[0] - intercept) / screen.spacing;
        const lastRatio = (viewportRange[1] - intercept) / screen.spacing;
        const firstLine = Math.max(
          firstRingLine,
          Math.ceil(Math.min(firstRatio, lastRatio) - 1e-9),
        );
        const lastLine = Math.min(
          lastRingLine,
          Math.floor(Math.max(firstRatio, lastRatio) + 1e-9),
        );
        if (
          !Number.isSafeInteger(firstLine) ||
          !Number.isSafeInteger(lastLine) ||
          lastLine < firstLine
        ) {
          continue;
        }
        candidateRanges.push([firstLine, lastLine]);
        if (
          firstLine === firstRingLine &&
          lastLine === lastRingLine
        ) {
          break;
        }
      }
      if (candidateRanges.length === 0) {
        continue;
      }

      const dash = dashValues(source, definition);
      const dotLength =
        Math.max(camera.worldHeight / camera.height, Number.EPSILON) /
        maximumDirectionLength;
      let renderedDefinition = false;
      for (const [firstLine, lastLine] of mergeRanges(candidateRanges)) {
        for (
          let lineIndex = firstLine;
          lineIndex <= lastLine;
          lineIndex += 1
        ) {
          if (
            metrics.candidateLines >= MAX_HATCH_PATTERN_SEGMENTS ||
            entitySegments >= maximumSegmentsPerEntity
          ) {
            entityTruncated = true;
            metrics.cpuLimitReached ||=
              metrics.candidateLines >= MAX_HATCH_PATTERN_SEGMENTS;
            break;
          }
          metrics.candidateLines += 1;
          const linePoint = [
            definition.basePoint[0] + lineIndex * definition.offset[0],
            definition.basePoint[1] + lineIndex * definition.offset[1],
          ];
          const intersections = lineIntersections(
            clippingRings,
            linePoint,
            direction,
            metrics,
            maximumIntersectionTests,
          );
          if (intersections === null) {
            entityTruncated = true;
            break;
          }
          const pointLocal = ocsPointToWcs(
            linePoint[0],
            linePoint[1],
            entity.elevation,
            basis,
          );
          for (
            let index = 0;
            index + 1 < intersections.length;
            index += 1
          ) {
            const sourceInterval = [
              intersections[index],
              intersections[index + 1],
            ];
            if (
              sourceInterval[1] - sourceInterval[0] <= GEOMETRY_EPSILON
            ) {
              continue;
            }
            const midpoint = (sourceInterval[0] + sourceInterval[1]) * 0.5;
            if (
              !pointInGroups(
                linePoint[0] + direction[0] * midpoint,
                linePoint[1] + direction[1] * midpoint,
                groups,
              )
            ) {
              continue;
            }
            const visibleIntervals = [];
            for (const instanceIndex of eligibleInstanceIndices) {
              const matrixOffset = renderInstances.data
                ? instanceIndex * 16
                : 0;
              const interval = clipLineInterval(
                transformPointXY(
                  renderInstances.data,
                  matrixOffset,
                  pointLocal,
                ),
                transformVectorXY(
                  renderInstances.data,
                  matrixOffset,
                  directionLocal,
                ),
                sourceInterval,
                rectangle,
              );
              if (interval) {
                visibleIntervals.push(interval);
                if (
                  interval[0] <= sourceInterval[0] &&
                  interval[1] >= sourceInterval[1]
                ) {
                  break;
                }
              }
            }
            for (const interval of mergeIntervals(visibleIntervals)) {
              const completed = emitDashedInterval(
                interval,
                dash,
                dotLength,
                (start, end) => {
                  if (
                    !mesh.canWriteSegment() ||
                    entitySegments >= maximumSegmentsPerEntity
                  ) {
                    metrics.gpuLimitReached ||= !mesh.canWriteSegment();
                    return false;
                  }
                  const points = [
                    ocsPointToWcs(
                      linePoint[0] + direction[0] * start,
                      linePoint[1] + direction[1] * start,
                      entity.elevation,
                      basis,
                    ),
                    ocsPointToWcs(
                      linePoint[0] + direction[0] * end,
                      linePoint[1] + direction[1] * end,
                      entity.elevation,
                      basis,
                    ),
                  ];
                  if (
                    points.some((point) =>
                      point.some((coordinate) => !Number.isFinite(coordinate)),
                    )
                  ) {
                    metrics.skippedInvalidSegments += 1;
                    return true;
                  }
                  mesh.writeSegment(patternOwner, points, attributes);
                  entitySegments += 1;
                  renderedEntity = true;
                  renderedDefinition = true;
                  return true;
                },
              );
              if (!completed) {
                entityTruncated = true;
                break;
              }
            }
            if (entityTruncated) {
              break;
            }
          }
          if (entityTruncated || metrics.cpuLimitReached) {
            break;
          }
        }
        if (entityTruncated || metrics.cpuLimitReached) {
          break;
        }
      }
      if (renderedDefinition) {
        metrics.renderedDefinitions += 1;
      }
      if (entityTruncated || metrics.gpuLimitReached || metrics.cpuLimitReached) {
        break;
      }
    }
    if (renderedEntity) {
      metrics.renderedHatches += 1;
    }
    if (entityTruncated) {
      metrics.truncatedHatches += 1;
    }
    if (metrics.gpuLimitReached || metrics.cpuLimitReached) {
      break;
    }
  }

  const result = mesh.finish();
  metrics.segments = mesh.segments;
  metrics.vertices = result.vertices.vertexCount;
  metrics.gpuBytes = result.vertices.byteLength;
  metrics.batches = result.batches.length;
  metrics.maximumPositionError = result.maximumPositionError;
  return Object.freeze({
    ...result,
    metrics: Object.freeze(metrics),
  });
}
