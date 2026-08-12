import { encodeCadLineStyle } from "./cad-line-style.mjs";
import {
  CURVE_GEOMETRY_PIXEL_ERROR,
  CURVE_PIXEL_ERROR,
  CURVE_POSITION_PIXEL_ERROR,
  MAX_CURVE_REFINEMENT_BATCH_BYTES,
  MAX_CURVE_REFINEMENT_GPU_BYTES,
  MAX_CURVE_SEGMENTS_PER_ENTITY,
} from "./curve-contract.mjs";
import { effectiveClipBounds } from "./instance-graph.mjs";
import {
  arbitraryAxisMat4,
  boundsAreFinite,
  emptyBounds3,
  identityMat4,
  includePoint,
  packedBoundsIntersect2D,
  transformPoint,
  transformedBounds2D,
} from "./math.mjs";
import {
  encodeMaskBucket,
  maskBucketFor,
} from "./mask-order.mjs";
import {
  GpuLineBatchKind,
  GPU_LINE_VERTEX_RECORD_SIZE,
} from "./scene-cache.mjs";
import {
  POLYLINE_FLAG_CONTINUOUS_LINETYPE,
  readPolylineDisplayVertices,
} from "./polyline-source.mjs";

const CURVE_EPSILON = 1e-12;
const MAX_SPLINE_DEGREE = 15;
const MAX_SPLINE_CONTROL_POINTS = 1_048_576;
const MAX_ADAPTIVE_DEPTH = 20;
const TAU = Math.PI * 2;
const MAX_BATCH_VERTICES =
  Math.floor(
    MAX_CURVE_REFINEMENT_BATCH_BYTES /
      (2 * GPU_LINE_VERTEX_RECORD_SIZE),
  ) * 2;
const ROOT_INSTANCES = Object.freeze({
  data: identityMat4(),
  clipIds: new Uint32Array([0]),
  count: 1,
  length: 1,
});
const EMPTY_INSTANCE_INDICES = new Uint32Array(0);

function finitePoint(point) {
  return (
    point?.length >= 3 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Number.isFinite(point[2])
  );
}

function normalizedSweep(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  const raw = end - start;
  if (Math.abs(raw) >= TAU - CURVE_EPSILON) {
    return TAU;
  }
  const sweep = ((raw % TAU) + TAU) % TAU;
  return sweep > CURVE_EPSILON ? sweep : null;
}

export function circularSegmentCount(
  radiusPixels,
  sweep,
  {
    pixelError = CURVE_GEOMETRY_PIXEL_ERROR,
    maximumSegments = MAX_CURVE_SEGMENTS_PER_ENTITY,
  } = {},
) {
  if (
    !Number.isFinite(radiusPixels) ||
    radiusPixels <= CURVE_EPSILON ||
    !Number.isFinite(sweep) ||
    sweep <= CURVE_EPSILON ||
    !Number.isFinite(pixelError) ||
    pixelError <= 0 ||
    !Number.isSafeInteger(maximumSegments) ||
    maximumSegments <= 0
  ) {
    return 0;
  }
  if (radiusPixels <= pixelError) {
    return 1;
  }
  const cosine = Math.max(-1, Math.min(1, 1 - pixelError / radiusPixels));
  const maximumAngle = 2 * Math.acos(cosine);
  if (!Number.isFinite(maximumAngle) || maximumAngle <= CURVE_EPSILON) {
    return maximumSegments + 1;
  }
  return Math.ceil(sweep / maximumAngle);
}

function pointDistance(left, right) {
  return Math.hypot(
    right[0] - left[0],
    right[1] - left[1],
    right[2] - left[2],
  );
}

function pointChordDistance(point, start, end) {
  const delta = [
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  ];
  const lengthSquared =
    delta[0] * delta[0] +
    delta[1] * delta[1] +
    delta[2] * delta[2];
  if (lengthSquared <= CURVE_EPSILON) {
    return pointDistance(point, start);
  }
  const parameter = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * delta[0] +
        (point[1] - start[1]) * delta[1] +
        (point[2] - start[2]) * delta[2]) /
        lengthSquared,
    ),
  );
  return Math.hypot(
    point[0] - (start[0] + delta[0] * parameter),
    point[1] - (start[1] + delta[1] * parameter),
    point[2] - (start[2] + delta[2] * parameter),
  );
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= CURVE_EPSILON) {
    return null;
  }
  return vector.map((value) => value / length);
}

function ownerFor(entity, blocks, instanceGraph, blockIndexByHandle) {
  const blockIndex = blockIndexByHandle.get(entity.ownerHandle);
  if (blockIndex === undefined) {
    return entity.ownerHandle === 0n
      ? {
          key: "model",
          kind: GpuLineBatchKind.ModelDetail,
          blockIndex: null,
          ownerHandle: entity.ownerHandle,
        }
      : null;
  }
  const block = blocks[blockIndex];
  if (instanceGraph.modelBlockIndices?.has(blockIndex)) {
    return {
      key: "model",
      kind: GpuLineBatchKind.ModelDetail,
      blockIndex: null,
      ownerHandle: entity.ownerHandle,
    };
  }
  if (block?.name.toUpperCase().startsWith("*PAPER_SPACE")) {
    return null;
  }
  return {
    key: `block:${blockIndex}`,
    kind: GpuLineBatchKind.BlockDefinition,
    blockIndex,
    ownerHandle: entity.ownerHandle,
  };
}

function instancesForOwner(owner, instanceGraph) {
  return owner.kind === GpuLineBatchKind.BlockDefinition
    ? instanceGraph.instancesByBlock?.get(owner.blockIndex) ?? {
        data: new Float64Array(0),
        clipIds: new Uint32Array(0),
        count: 0,
        length: 0,
      }
    : instanceGraph.modelInstances ?? ROOT_INSTANCES;
}

function matrixPixelsPerLocalUnit(matrix, offset, camera) {
  const pixelsPerWorldX = camera.width / camera.worldWidth;
  const pixelsPerWorldY = camera.height / camera.worldHeight;
  return Math.hypot(
    matrix[offset] * pixelsPerWorldX,
    matrix[offset + 4] * pixelsPerWorldX,
    matrix[offset + 8] * pixelsPerWorldX,
    matrix[offset + 1] * pixelsPerWorldY,
    matrix[offset + 5] * pixelsPerWorldY,
    matrix[offset + 9] * pixelsPerWorldY,
  );
}

function visibleOwnerInstances(owner, bounds, instanceGraph, camera) {
  const instances = instancesForOwner(owner, instanceGraph);
  if (!instances || instances.count === 0) {
    return null;
  }
  const viewport = {
    min: [
      camera.origin[0] - camera.worldWidth * 0.5,
      camera.origin[1] - camera.worldHeight * 0.5,
    ],
    max: [
      camera.origin[0] + camera.worldWidth * 0.5,
      camera.origin[1] + camera.worldHeight * 0.5,
    ],
  };
  const indices = [];
  const transformed = new Float64Array(4);
  const clipBounds = new Map();
  let maximumPixelsPerLocalUnit = 0;
  for (let index = 0; index < instances.count; index += 1) {
    const clipId = instances.clipIds?.[index] ?? 0;
    let clip = null;
    if (clipId > 0) {
      clip = clipBounds.get(clipId);
      if (clip === undefined) {
        clip = effectiveClipBounds(instanceGraph.clipNodes, clipId);
        clipBounds.set(clipId, clip);
      }
      if (
        !clip ||
        clip.max[0] < viewport.min[0] ||
        clip.min[0] > viewport.max[0] ||
        clip.max[1] < viewport.min[1] ||
        clip.min[1] > viewport.max[1]
      ) {
        continue;
      }
    }
    transformedBounds2D(bounds, instances.data, index * 16, transformed);
    if (clip) {
      transformed[0] = Math.max(transformed[0], clip.min[0]);
      transformed[1] = Math.max(transformed[1], clip.min[1]);
      transformed[2] = Math.min(transformed[2], clip.max[0]);
      transformed[3] = Math.min(transformed[3], clip.max[1]);
    }
    if (
      transformed[0] > transformed[2] ||
      transformed[1] > transformed[3] ||
      !packedBoundsIntersect2D(transformed, viewport)
    ) {
      continue;
    }
    const scale = matrixPixelsPerLocalUnit(
      instances.data,
      index * 16,
      camera,
    );
    if (!Number.isFinite(scale) || scale <= CURVE_EPSILON) {
      continue;
    }
    maximumPixelsPerLocalUnit = Math.max(
      maximumPixelsPerLocalUnit,
      scale,
    );
    indices.push(index);
  }
  if (indices.length === 0 || maximumPixelsPerLocalUnit <= 0) {
    return null;
  }
  return {
    instanceIndices:
      indices.length === instances.count
        ? null
        : Uint32Array.from(indices),
    maximumPixelsPerLocalUnit,
  };
}

function clippedConstructionParameters(
  point,
  direction,
  bounds,
  isRay,
) {
  let minimum = isRay ? 0 : Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 2; axis += 1) {
    if (Math.abs(direction[axis]) <= CURVE_EPSILON) {
      if (point[axis] < bounds.min[axis] || point[axis] > bounds.max[axis]) {
        return null;
      }
      continue;
    }
    const first = (bounds.min[axis] - point[axis]) / direction[axis];
    const last = (bounds.max[axis] - point[axis]) / direction[axis];
    minimum = Math.max(minimum, Math.min(first, last));
    maximum = Math.min(maximum, Math.max(first, last));
    if (minimum > maximum) {
      return null;
    }
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum)
    ? [minimum, maximum]
    : null;
}

function visibleConstructionLine(
  entity,
  owner,
  instanceGraph,
  camera,
) {
  const instances = instancesForOwner(owner, instanceGraph);
  if (!instances || instances.count === 0) {
    return null;
  }
  const viewport = {
    min: [
      camera.origin[0] - camera.worldWidth * 0.5,
      camera.origin[1] - camera.worldHeight * 0.5,
    ],
    max: [
      camera.origin[0] + camera.worldWidth * 0.5,
      camera.origin[1] + camera.worldHeight * 0.5,
    ],
  };
  const indices = [];
  const clipBounds = new Map();
  let minimumParameter = Number.POSITIVE_INFINITY;
  let maximumParameter = Number.NEGATIVE_INFINITY;
  let maximumPixelsPerLocalUnit = 0;
  for (let index = 0; index < instances.count; index += 1) {
    const matrixOffset = index * 16;
    const clipId = instances.clipIds?.[index] ?? 0;
    let bounds = viewport;
    if (clipId > 0) {
      let clip = clipBounds.get(clipId);
      if (clip === undefined) {
        clip = effectiveClipBounds(instanceGraph.clipNodes, clipId);
        clipBounds.set(clipId, clip);
      }
      if (!clip) {
        continue;
      }
      bounds = {
        min: [
          Math.max(viewport.min[0], clip.min[0]),
          Math.max(viewport.min[1], clip.min[1]),
        ],
        max: [
          Math.min(viewport.max[0], clip.max[0]),
          Math.min(viewport.max[1], clip.max[1]),
        ],
      };
      if (bounds.min[0] > bounds.max[0] || bounds.min[1] > bounds.max[1]) {
        continue;
      }
    }
    const point = transformPoint(
      instances.data,
      entity.point,
      matrixOffset,
    );
    const direction = [
      instances.data[matrixOffset] * entity.direction[0] +
        instances.data[matrixOffset + 4] * entity.direction[1] +
        instances.data[matrixOffset + 8] * entity.direction[2],
      instances.data[matrixOffset + 1] * entity.direction[0] +
        instances.data[matrixOffset + 5] * entity.direction[1] +
        instances.data[matrixOffset + 9] * entity.direction[2],
      instances.data[matrixOffset + 2] * entity.direction[0] +
        instances.data[matrixOffset + 6] * entity.direction[1] +
        instances.data[matrixOffset + 10] * entity.direction[2],
    ];
    const clipped = clippedConstructionParameters(
      point,
      direction,
      bounds,
      entity.kind === "ray",
    );
    if (!clipped) {
      continue;
    }
    const scale = matrixPixelsPerLocalUnit(
      instances.data,
      matrixOffset,
      camera,
    );
    if (!Number.isFinite(scale) || scale <= CURVE_EPSILON) {
      continue;
    }
    minimumParameter = Math.min(minimumParameter, clipped[0]);
    maximumParameter = Math.max(maximumParameter, clipped[1]);
    maximumPixelsPerLocalUnit = Math.max(
      maximumPixelsPerLocalUnit,
      scale,
    );
    indices.push(index);
  }
  if (
    indices.length === 0 ||
    !Number.isFinite(minimumParameter) ||
    !Number.isFinite(maximumParameter) ||
    minimumParameter > maximumParameter
  ) {
    return null;
  }
  return {
    instanceIndices:
      indices.length === instances.count ? null : Uint32Array.from(indices),
    maximumPixelsPerLocalUnit,
    minimumParameter,
    maximumParameter,
  };
}

function unionInstanceIndices(current, next) {
  if (current === null || next === null) {
    return null;
  }
  const union = new Set(current);
  for (const value of next) {
    union.add(value);
  }
  return Uint32Array.from([...union].sort((left, right) => left - right));
}

function curveAttributes(entity, sourceKind, maskOrder) {
  let style = encodeCadLineStyle({
    lineWeight: entity.lineWeight,
    linetypeCode: entity.linetypeCode,
    invisible: Boolean(entity.commonFlags & 1),
  });
  style |= sourceKind << 17;
  if (maskOrder?.enabled) {
    style = encodeMaskBucket(
      style,
      maskBucketFor(maskOrder, entity.ownerHandle, entity.handle),
    );
  }
  return {
    layerIndex: entity.layerIndex,
    color: entity.color >>> 0,
    handle: entity.handle,
    style: style >>> 0,
  };
}

export function scaleCurvePatternDistances(segments, linetypeScale = 1) {
  if (
    !(segments instanceof Float64Array) ||
    segments.length % 8 !== 0 ||
    !Number.isFinite(linetypeScale) ||
    linetypeScale <= 0
  ) {
    throw new TypeError("curve linetype scale input is invalid");
  }
  if (linetypeScale === 1) {
    return segments;
  }
  const scaled = new Float64Array(segments);
  for (let offset = 0; offset < scaled.length; offset += 8) {
    scaled[offset + 6] /= linetypeScale;
    scaled[offset + 7] /= linetypeScale;
  }
  return scaled;
}

class CurveBatchBuilder {
  constructor(group, firstSegment) {
    this.group = group;
    this.origin = [
      (firstSegment[0] + firstSegment[3]) * 0.5,
      (firstSegment[1] + firstSegment[4]) * 0.5,
      (firstSegment[2] + firstSegment[5]) * 0.5,
    ];
    this.buffer = new ArrayBuffer(GPU_LINE_VERTEX_RECORD_SIZE * 2);
    this.view = new DataView(this.buffer);
    this.byteLength = 0;
    this.vertexCount = 0;
    this.maximumPositionError = 0;
    this.bounds = emptyBounds3();
  }

  canAccept(segment, pixelsPerLocalUnit) {
    if (this.vertexCount + 2 > MAX_BATCH_VERTICES) {
      return false;
    }
    for (const first of [0, 3]) {
      for (let axis = 0; axis < 3; axis += 1) {
        const local = segment[first + axis] - this.origin[axis];
        if (
          Math.abs(Math.fround(local) - local) * pixelsPerLocalUnit >
          CURVE_POSITION_PIXEL_ERROR + 1e-7
        ) {
          return false;
        }
      }
    }
    return true;
  }

  write(segment, attributes) {
    this.ensure(GPU_LINE_VERTEX_RECORD_SIZE * 2);
    for (let endpoint = 0; endpoint < 2; endpoint += 1) {
      const sourceOffset = endpoint * 3;
      const offset = this.byteLength;
      const point = [
        segment[sourceOffset],
        segment[sourceOffset + 1],
        segment[sourceOffset + 2],
      ];
      for (let axis = 0; axis < 3; axis += 1) {
        const local = point[axis] - this.origin[axis];
        const stored = Math.fround(local);
        this.view.setFloat32(offset + axis * 4, stored, true);
        this.maximumPositionError = Math.max(
          this.maximumPositionError,
          Math.abs(stored - local),
        );
      }
      includePoint(this.bounds, point);
      this.view.setUint32(offset + 12, attributes.layerIndex, true);
      this.view.setUint32(offset + 16, attributes.color, true);
      this.view.setUint32(
        offset + 20,
        Number(attributes.handle & 0xffffffffn),
        true,
      );
      this.view.setUint32(
        offset + 24,
        Number(attributes.handle >> 32n),
        true,
      );
      this.view.setUint32(offset + 28, attributes.style, true);
      this.view.setFloat32(offset + 32, segment[6 + endpoint], true);
      this.byteLength += GPU_LINE_VERTEX_RECORD_SIZE;
      this.vertexCount += 1;
    }
  }

  ensure(additionalBytes) {
    const required = this.byteLength + additionalBytes;
    if (required <= this.buffer.byteLength) {
      return;
    }
    let capacity = this.buffer.byteLength;
    const maximum =
      MAX_BATCH_VERTICES * GPU_LINE_VERTEX_RECORD_SIZE;
    while (capacity < required) {
      capacity = Math.min(maximum, capacity * 2);
    }
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(
      new Uint8Array(this.buffer, 0, this.byteLength),
    );
    this.buffer = next;
    this.view = new DataView(next);
  }
}

class CurveMeshBuilder {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.groups = new Map();
    this.byteLength = 0;
    this.vertexCount = 0;
    this.lastFailure = null;
  }

  write(owner, instanceIndices, segments, attributes, pixelsPerLocalUnit) {
    this.lastFailure = null;
    const segmentCount = segments.length / 8;
    const requiredBytes =
      segmentCount * 2 * GPU_LINE_VERTEX_RECORD_SIZE;
    if (
      segmentCount <= 0 ||
      this.byteLength + requiredBytes > this.maximumBytes
    ) {
      this.lastFailure =
        segmentCount <= 0 ? "empty" : "gpu-budget";
      return false;
    }
    for (let index = 0; index < segments.length; index += 8) {
      const segment = segments.subarray(index, index + 8);
      const origin = [
        (segment[0] + segment[3]) * 0.5,
        (segment[1] + segment[4]) * 0.5,
        (segment[2] + segment[5]) * 0.5,
      ];
      for (const first of [0, 3]) {
        for (let axis = 0; axis < 3; axis += 1) {
          const local = segment[first + axis] - origin[axis];
          if (
            Math.abs(Math.fround(local) - local) *
              pixelsPerLocalUnit >
            CURVE_POSITION_PIXEL_ERROR + 1e-7
          ) {
            this.lastFailure = "position-error";
            return false;
          }
        }
      }
    }
    let group = this.groups.get(owner.key);
    if (!group) {
      group = {
        owner,
        instanceIndices:
          instanceIndices === null
            ? null
            : new Uint32Array(instanceIndices),
        batches: [],
        active: null,
      };
      this.groups.set(owner.key, group);
    } else {
      group.instanceIndices = unionInstanceIndices(
        group.instanceIndices,
        instanceIndices,
      );
    }
    for (let index = 0; index < segments.length; index += 8) {
      const segment = segments.subarray(index, index + 8);
      if (
        !group.active ||
        !group.active.canAccept(segment, pixelsPerLocalUnit)
      ) {
        group.active = new CurveBatchBuilder(group, segment);
        group.batches.push(group.active);
      }
      group.active.write(segment, attributes);
    }
    this.byteLength += requiredBytes;
    this.vertexCount += segmentCount * 2;
    return true;
  }

  finish() {
    const entries = [];
    let maximumPositionError = 0;
    for (const group of this.groups.values()) {
      for (const builder of group.batches) {
        const buffer = builder.buffer.slice(0, builder.byteLength);
        const batch = Object.freeze({
          id: entries.length,
          kind: group.owner.kind,
          lodLevel: 1,
          flags: 0,
          blockIndex: group.owner.blockIndex,
          firstVertex: 0,
          vertexCount: builder.vertexCount,
          origin: Object.freeze([...builder.origin]),
          bounds: Object.freeze({
            min: Object.freeze([...builder.bounds.min]),
            max: Object.freeze([...builder.bounds.max]),
          }),
          maximumPositionError: builder.maximumPositionError,
          instanceIndices: group.instanceIndices,
        });
        entries.push(
          Object.freeze({
            batch,
            vertices: Object.freeze({
              buffer,
              byteLength: buffer.byteLength,
              vertexCount: builder.vertexCount,
            }),
          }),
        );
        maximumPositionError = Math.max(
          maximumPositionError,
          builder.maximumPositionError,
        );
        builder.buffer = null;
        builder.view = null;
      }
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      byteLength: this.byteLength,
      vertexCount: this.vertexCount,
      maximumPositionError,
    });
  }
}

function circularBasis(center, radius, normal) {
  if (
    !finitePoint(center) ||
    !finitePoint(normal) ||
    !Number.isFinite(radius) ||
    radius <= CURVE_EPSILON ||
    Math.hypot(...normal) <= CURVE_EPSILON
  ) {
    return null;
  }
  const matrix = arbitraryAxisMat4(normal);
  const centerWorld = transformPoint(matrix, center);
  const bounds = emptyBounds3();
  for (let axis = 0; axis < 3; axis += 1) {
    const extent =
      radius * Math.hypot(matrix[axis], matrix[4 + axis]);
    bounds.min[axis] = centerWorld[axis] - extent;
    bounds.max[axis] = centerWorld[axis] + extent;
  }
  return { matrix, bounds };
}

function circularPoint(center, radius, angle, matrix) {
  return transformPoint(matrix, [
    center[0] + radius * Math.cos(angle),
    center[1] + radius * Math.sin(angle),
    center[2],
  ]);
}

function makeCircularSegments(
  center,
  radius,
  start,
  sweep,
  matrix,
  pixelsPerLocalUnit,
) {
  const segmentCount = circularSegmentCount(
    radius * pixelsPerLocalUnit,
    Math.abs(sweep),
  );
  if (
    segmentCount <= 0 ||
    segmentCount > MAX_CURVE_SEGMENTS_PER_ENTITY
  ) {
    return null;
  }
  const segments = new Float64Array(segmentCount * 8);
  const lengthPerSegment =
    Math.abs(radius * sweep) / segmentCount;
  let patternDistance = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    const first = circularPoint(
      center,
      radius,
      start + (sweep * index) / segmentCount,
      matrix,
    );
    const last = circularPoint(
      center,
      radius,
      start + (sweep * (index + 1)) / segmentCount,
      matrix,
    );
    const offset = index * 8;
    segments.set(first, offset);
    segments.set(last, offset + 3);
    segments[offset + 6] = patternDistance;
    patternDistance += lengthPerSegment;
    segments[offset + 7] = patternDistance;
  }
  return segments;
}

function ellipseBasis(entity) {
  if (
    !finitePoint(entity.center) ||
    !finitePoint(entity.majorAxis) ||
    !finitePoint(entity.normal) ||
    !Number.isFinite(entity.minorAxisRatio)
  ) {
    return null;
  }
  const majorLength = Math.hypot(...entity.majorAxis);
  const normal = normalized(entity.normal);
  const minorDirection = normal
    ? normalized(cross(normal, entity.majorAxis))
    : null;
  if (
    majorLength <= CURVE_EPSILON ||
    !minorDirection ||
    Math.abs(entity.minorAxisRatio) <= CURVE_EPSILON
  ) {
    return null;
  }
  const minorLength =
    majorLength * Math.abs(entity.minorAxisRatio);
  const minorAxis = minorDirection.map(
    (value) => value * minorLength,
  );
  const bounds = emptyBounds3();
  for (let axis = 0; axis < 3; axis += 1) {
    const extent = Math.hypot(
      entity.majorAxis[axis],
      minorAxis[axis],
    );
    bounds.min[axis] = entity.center[axis] - extent;
    bounds.max[axis] = entity.center[axis] + extent;
  }
  return { minorAxis, bounds };
}

function ellipsePoint(center, majorAxis, minorAxis, parameter) {
  const cosine = Math.cos(parameter);
  const sine = Math.sin(parameter);
  return [
    center[0] + majorAxis[0] * cosine + minorAxis[0] * sine,
    center[1] + majorAxis[1] * cosine + minorAxis[1] * sine,
    center[2] + majorAxis[2] * cosine + minorAxis[2] * sine,
  ];
}

function adaptiveParametricSegments(
  evaluate,
  intervals,
  pixelsPerLocalUnit,
) {
  const stack = [];
  for (let index = intervals.length - 1; index >= 0; index -= 1) {
    const [startParameter, endParameter] = intervals[index];
    const start = evaluate(startParameter);
    const end = evaluate(endParameter);
    if (!finitePoint(start) || !finitePoint(end)) {
      return null;
    }
    stack.push({
      startParameter,
      endParameter,
      start,
      end,
      depth: 0,
    });
  }
  const accepted = [];
  while (stack.length > 0) {
    const interval = stack.pop();
    const difference =
      interval.endParameter - interval.startParameter;
    const quarterParameter =
      interval.startParameter + difference * 0.25;
    const middleParameter =
      interval.startParameter + difference * 0.5;
    const threeQuarterParameter =
      interval.startParameter + difference * 0.75;
    const quarter = evaluate(quarterParameter);
    const middle = evaluate(middleParameter);
    const threeQuarter = evaluate(threeQuarterParameter);
    if (
      !finitePoint(quarter) ||
      !finitePoint(middle) ||
      !finitePoint(threeQuarter)
    ) {
      return null;
    }
    const error =
      Math.max(
        pointChordDistance(
          quarter,
          interval.start,
          interval.end,
        ),
        pointChordDistance(
          middle,
          interval.start,
          interval.end,
        ),
        pointChordDistance(
          threeQuarter,
          interval.start,
          interval.end,
        ),
      ) * pixelsPerLocalUnit;
    if (error <= CURVE_GEOMETRY_PIXEL_ERROR) {
      accepted.push([interval.start, interval.end]);
      if (accepted.length > MAX_CURVE_SEGMENTS_PER_ENTITY) {
        return null;
      }
      continue;
    }
    if (
      interval.depth >= MAX_ADAPTIVE_DEPTH ||
      accepted.length + stack.length + 2 >
        MAX_CURVE_SEGMENTS_PER_ENTITY
    ) {
      return null;
    }
    stack.push({
      startParameter: middleParameter,
      endParameter: interval.endParameter,
      start: middle,
      end: interval.end,
      depth: interval.depth + 1,
    });
    stack.push({
      startParameter: interval.startParameter,
      endParameter: middleParameter,
      start: interval.start,
      end: middle,
      depth: interval.depth + 1,
    });
  }
  const segments = new Float64Array(accepted.length * 8);
  let cursor = 0;
  for (let index = 0; index < accepted.length; index += 1) {
    const [start, end] = accepted[index];
    const offset = index * 8;
    segments.set(start, offset);
    segments.set(end, offset + 3);
    segments[offset + 6] = cursor;
    cursor += pointDistance(start, end);
    segments[offset + 7] = cursor;
  }
  return segments;
}

function makeEllipseSegments(entity, basis, pixelsPerLocalUnit) {
  const sweep = normalizedSweep(
    entity.startParameter,
    entity.endParameter,
  );
  if (!sweep) {
    return null;
  }
  const intervalCount = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
  const intervals = new Array(intervalCount);
  for (let index = 0; index < intervalCount; index += 1) {
    intervals[index] = [
      entity.startParameter + (sweep * index) / intervalCount,
      entity.startParameter +
        (sweep * (index + 1)) / intervalCount,
    ];
  }
  return adaptiveParametricSegments(
    (parameter) =>
      ellipsePoint(
        entity.center,
        entity.majorAxis,
        basis.minorAxis,
        parameter,
      ),
    intervals,
    pixelsPerLocalUnit,
  );
}

function readPolylineGeometry(source, entity) {
  const vertices = readPolylineDisplayVertices(
    source?.polylineVertices,
    entity,
    { maximumVertices: MAX_SPLINE_CONTROL_POINTS },
  );
  if (
    !vertices ||
    (entity.polylineKind !== 1 && entity.polylineKind !== 2) ||
    !finitePoint(entity.normal) ||
    Math.hypot(...entity.normal) <= CURVE_EPSILON
  ) {
    return null;
  }
  const values = new Float64Array(vertices.length * 4);
  let curved = false;
  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index];
    if (!finitePoint(vertex.position) || !Number.isFinite(vertex.bulge)) {
      return null;
    }
    const offset = index * 4;
    values[offset] = vertex.position[0];
    values[offset + 1] = vertex.position[1];
    values[offset + 2] = entity.elevation;
    values[offset + 3] = vertex.bulge;
    curved ||= Math.abs(vertex.bulge) > CURVE_EPSILON;
  }
  if (!curved) {
    return { curved: false };
  }
  const matrix = arbitraryAxisMat4(entity.normal);
  const closed = Boolean(entity.polylineFlags & 1);
  const sourceSegmentCount =
    vertices.length - 1 + Number(closed);
  const bounds = emptyBounds3();
  for (let index = 0; index < sourceSegmentCount; index += 1) {
    const next = (index + 1) % vertices.length;
    const startOffset = index * 4;
    const endOffset = next * 4;
    const start = [
      values[startOffset],
      values[startOffset + 1],
      values[startOffset + 2],
    ];
    const end = [
      values[endOffset],
      values[endOffset + 1],
      values[endOffset + 2],
    ];
    includePoint(bounds, transformPoint(matrix, start));
    includePoint(bounds, transformPoint(matrix, end));
    const bulge = values[startOffset + 3];
    if (Math.abs(bulge) <= CURVE_EPSILON) {
      continue;
    }
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    const chord = Math.hypot(deltaX, deltaY);
    if (!Number.isFinite(chord) || chord <= CURVE_EPSILON) {
      continue;
    }
    const centerOffset =
      (chord * (1 - bulge * bulge)) / (4 * bulge);
    const center = [
      (start[0] + end[0]) * 0.5 -
        (deltaY / chord) * centerOffset,
      (start[1] + end[1]) * 0.5 +
        (deltaX / chord) * centerOffset,
      entity.elevation,
    ];
    const radius = Math.hypot(
      start[0] - center[0],
      start[1] - center[1],
    );
    const centerWorld = transformPoint(matrix, center);
    for (let axis = 0; axis < 3; axis += 1) {
      const extent =
        radius * Math.hypot(matrix[axis], matrix[4 + axis]);
      bounds.min[axis] = Math.min(
        bounds.min[axis],
        centerWorld[axis] - extent,
      );
      bounds.max[axis] = Math.max(
        bounds.max[axis],
        centerWorld[axis] + extent,
      );
    }
  }
  if (!boundsAreFinite(bounds)) {
    return null;
  }
  return {
    curved: true,
    values,
    matrix,
    closed,
    continuousLinetype: Boolean(
      entity.polylineFlags & POLYLINE_FLAG_CONTINUOUS_LINETYPE,
    ),
    sourceSegmentCount,
    bounds,
  };
}

function makeBulgeSegments(geometry, pixelsPerLocalUnit) {
  const output = [];
  let patternDistance = 0;
  let segmentTotal = 0;
  const vertexCount = geometry.values.length / 4;
  for (let index = 0; index < geometry.sourceSegmentCount; index += 1) {
    if (!geometry.continuousLinetype) {
      patternDistance = 0;
    }
    const next = (index + 1) % vertexCount;
    const startOffset = index * 4;
    const endOffset = next * 4;
    const start = [
      geometry.values[startOffset],
      geometry.values[startOffset + 1],
      geometry.values[startOffset + 2],
    ];
    const end = [
      geometry.values[endOffset],
      geometry.values[endOffset + 1],
      geometry.values[endOffset + 2],
    ];
    const bulge = geometry.values[startOffset + 3];
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    const chord = Math.hypot(deltaX, deltaY);
    if (Math.abs(bulge) <= CURVE_EPSILON) {
      if (!Number.isFinite(chord) || chord <= CURVE_EPSILON) {
        continue;
      }
      if (segmentTotal + 1 > MAX_CURVE_SEGMENTS_PER_ENTITY) {
        return null;
      }
      const first = transformPoint(geometry.matrix, start);
      const last = transformPoint(geometry.matrix, end);
      output.push(
        ...first,
        ...last,
        patternDistance,
        patternDistance + chord,
      );
      patternDistance += chord;
      segmentTotal += 1;
      continue;
    }
    if (!Number.isFinite(chord) || chord <= CURVE_EPSILON) {
      continue;
    }
    const centerOffset =
      (chord * (1 - bulge * bulge)) / (4 * bulge);
    const center = [
      (start[0] + end[0]) * 0.5 -
        (deltaY / chord) * centerOffset,
      (start[1] + end[1]) * 0.5 +
        (deltaX / chord) * centerOffset,
      start[2],
    ];
    const radius = Math.hypot(
      start[0] - center[0],
      start[1] - center[1],
    );
    const sweep = 4 * Math.atan(bulge);
    const subdivisions = circularSegmentCount(
      radius * pixelsPerLocalUnit,
      Math.abs(sweep),
    );
    if (
      !Number.isFinite(radius) ||
      radius <= CURVE_EPSILON ||
      subdivisions <= 0 ||
      segmentTotal + subdivisions >
        MAX_CURVE_SEGMENTS_PER_ENTITY
    ) {
      return null;
    }
    const startAngle = Math.atan2(
      start[1] - center[1],
      start[0] - center[0],
    );
    const lengthPerSegment =
      Math.abs(radius * sweep) / subdivisions;
    for (let subdivision = 0; subdivision < subdivisions; subdivision += 1) {
      const firstAngle =
        startAngle + (sweep * subdivision) / subdivisions;
      const lastAngle =
        startAngle + (sweep * (subdivision + 1)) / subdivisions;
      const first = transformPoint(geometry.matrix, [
        center[0] + radius * Math.cos(firstAngle),
        center[1] + radius * Math.sin(firstAngle),
        center[2],
      ]);
      const last = transformPoint(geometry.matrix, [
        center[0] + radius * Math.cos(lastAngle),
        center[1] + radius * Math.sin(lastAngle),
        center[2],
      ]);
      output.push(
        ...first,
        ...last,
        patternDistance,
        patternDistance + lengthPerSegment,
      );
      patternDistance += lengthPerSegment;
      segmentTotal += 1;
    }
  }
  return output.length > 0 ? Float64Array.from(output) : null;
}

function readSplineGeometry(source, entity) {
  const degree = entity.degree;
  const controlCount = entity.controlPointCount;
  if (
    !Number.isInteger(degree) ||
    degree <= 0 ||
    degree > MAX_SPLINE_DEGREE ||
    !Number.isSafeInteger(controlCount) ||
    controlCount <= degree ||
    controlCount > MAX_SPLINE_CONTROL_POINTS ||
    !Number.isSafeInteger(entity.knotCount) ||
    entity.knotCount < controlCount + degree + 1 ||
    entity.firstKnot + entity.knotCount > source.splineKnots.length ||
    entity.firstControlPoint + controlCount >
      source.splineControlPoints.length ||
    !Number.isSafeInteger(entity.weightCount) ||
    (entity.weightCount !== 0 && entity.weightCount !== controlCount) ||
    entity.firstWeight + entity.weightCount >
      source.splineWeights.length
  ) {
    return null;
  }
  const knots = new Float64Array(entity.knotCount);
  for (let index = 0; index < knots.length; index += 1) {
    knots[index] = source.splineKnots.readValue(
      entity.firstKnot + index,
    );
    if (
      !Number.isFinite(knots[index]) ||
      (index > 0 && knots[index - 1] > knots[index])
    ) {
      return null;
    }
  }
  const controls = new Float64Array(controlCount * 3);
  const point = [0, 0, 0];
  const bounds = emptyBounds3();
  for (let index = 0; index < controlCount; index += 1) {
    source.splineControlPoints.readPoint(
      entity.firstControlPoint + index,
      point,
    );
    if (!finitePoint(point)) {
      return null;
    }
    controls.set(point, index * 3);
    includePoint(bounds, point);
  }
  const weights =
    entity.weightCount === 0
      ? null
      : new Float64Array(controlCount);
  if (weights) {
    let hasNonzeroWeight = false;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] = source.splineWeights.readValue(
        entity.firstWeight + index,
      );
      if (
        !Number.isFinite(weights[index]) ||
        weights[index] <= CURVE_EPSILON
      ) {
        return null;
      }
      hasNonzeroWeight ||= Math.abs(weights[index]) > CURVE_EPSILON;
    }
    if (!hasNonzeroWeight) {
      return null;
    }
  }
  const domainStart = knots[degree];
  const domainEnd = knots[controlCount];
  if (
    !Number.isFinite(domainStart) ||
    !Number.isFinite(domainEnd) ||
    domainEnd - domainStart <= CURVE_EPSILON ||
    !boundsAreFinite(bounds)
  ) {
    return null;
  }
  const intervals = [];
  for (let index = degree; index < controlCount; index += 1) {
    if (knots[index + 1] - knots[index] > CURVE_EPSILON) {
      intervals.push([knots[index], knots[index + 1]]);
    }
  }
  if (intervals.length === 0) {
    return null;
  }
  return {
    degree,
    controls,
    weights,
    knots,
    controlCount,
    domainEnd,
    intervals,
    bounds,
  };
}

function solveTridiagonal(lower, diagonal, upper, rightHandSide) {
  const count = diagonal.length;
  if (
    count === 0 ||
    lower.length !== count ||
    upper.length !== count ||
    rightHandSide.length !== count
  ) {
    return null;
  }
  const modifiedUpper = new Float64Array(count);
  const solution = new Float64Array(count);
  let pivot = diagonal[0];
  if (!Number.isFinite(pivot) || Math.abs(pivot) <= CURVE_EPSILON) {
    return null;
  }
  modifiedUpper[0] = upper[0] / pivot;
  solution[0] = rightHandSide[0] / pivot;
  for (let index = 1; index < count; index += 1) {
    pivot = diagonal[index] - lower[index] * modifiedUpper[index - 1];
    if (!Number.isFinite(pivot) || Math.abs(pivot) <= CURVE_EPSILON) {
      return null;
    }
    modifiedUpper[index] =
      index + 1 < count ? upper[index] / pivot : 0;
    solution[index] =
      (rightHandSide[index] - lower[index] * solution[index - 1]) /
      pivot;
  }
  for (let index = count - 2; index >= 0; index -= 1) {
    solution[index] -= modifiedUpper[index] * solution[index + 1];
  }
  return Array.from(solution).every(Number.isFinite) ? solution : null;
}

function solveCyclicTridiagonal(
  lower,
  diagonal,
  upper,
  upperRight,
  lowerLeft,
  rightHandSide,
) {
  const count = diagonal.length;
  if (count < 3) {
    return null;
  }
  const gamma = -diagonal[0];
  if (!Number.isFinite(gamma) || Math.abs(gamma) <= CURVE_EPSILON) {
    return null;
  }
  const adjustedDiagonal = Float64Array.from(diagonal);
  adjustedDiagonal[0] -= gamma;
  adjustedDiagonal[count - 1] -= (upperRight * lowerLeft) / gamma;
  const solution = solveTridiagonal(
    lower,
    adjustedDiagonal,
    upper,
    rightHandSide,
  );
  if (!solution) {
    return null;
  }
  const correctionRightHandSide = new Float64Array(count);
  correctionRightHandSide[0] = gamma;
  correctionRightHandSide[count - 1] = upperRight;
  const correction = solveTridiagonal(
    lower,
    adjustedDiagonal,
    upper,
    correctionRightHandSide,
  );
  if (!correction) {
    return null;
  }
  const denominator =
    1 +
    correction[0] +
    (lowerLeft * correction[count - 1]) / gamma;
  if (
    !Number.isFinite(denominator) ||
    Math.abs(denominator) <= CURVE_EPSILON
  ) {
    return null;
  }
  const scale =
    (solution[0] + (lowerLeft * solution[count - 1]) / gamma) /
    denominator;
  for (let index = 0; index < count; index += 1) {
    solution[index] -= scale * correction[index];
  }
  return Array.from(solution).every(Number.isFinite) ? solution : null;
}

function fitPointIntervalLength(start, end, knotParameterization) {
  if (knotParameterization === 2) {
    return 1;
  }
  const distance = pointDistance(start, end);
  if (!Number.isFinite(distance) || distance <= CURVE_EPSILON) {
    return null;
  }
  return knotParameterization === 1 ? Math.sqrt(distance) : distance;
}

function explicitSplineTangent(tangent) {
  return finitePoint(tangent) && Math.hypot(...tangent) > CURVE_EPSILON
    ? tangent
    : null;
}

function solveOpenFitPointTangents(points, intervals, startTangent, endTangent) {
  const pointCount = points.length;
  const lower = new Float64Array(pointCount);
  const diagonal = new Float64Array(pointCount);
  const upper = new Float64Array(pointCount);
  const rightHandSides = Array.from(
    { length: 3 },
    () => new Float64Array(pointCount),
  );
  if (startTangent) {
    diagonal[0] = 1;
    for (let axis = 0; axis < 3; axis += 1) {
      rightHandSides[axis][0] = startTangent[axis];
    }
  } else {
    diagonal[0] = 2;
    upper[0] = 1;
    for (let axis = 0; axis < 3; axis += 1) {
      rightHandSides[axis][0] =
        (3 * (points[1][axis] - points[0][axis])) / intervals[0];
    }
  }
  for (let index = 1; index + 1 < pointCount; index += 1) {
    const previousInterval = intervals[index - 1];
    const nextInterval = intervals[index];
    lower[index] = nextInterval;
    diagonal[index] = 2 * (previousInterval + nextInterval);
    upper[index] = previousInterval;
    for (let axis = 0; axis < 3; axis += 1) {
      const previousSlope =
        (points[index][axis] - points[index - 1][axis]) /
        previousInterval;
      const nextSlope =
        (points[index + 1][axis] - points[index][axis]) /
        nextInterval;
      rightHandSides[axis][index] =
        3 *
        (previousSlope * nextInterval + nextSlope * previousInterval);
    }
  }
  const last = pointCount - 1;
  if (endTangent) {
    diagonal[last] = 1;
    for (let axis = 0; axis < 3; axis += 1) {
      rightHandSides[axis][last] = endTangent[axis];
    }
  } else {
    lower[last] = 1;
    diagonal[last] = 2;
    for (let axis = 0; axis < 3; axis += 1) {
      rightHandSides[axis][last] =
        (3 * (points[last][axis] - points[last - 1][axis])) /
        intervals[last - 1];
    }
  }
  const axisSolutions = rightHandSides.map((rightHandSide) =>
    solveTridiagonal(lower, diagonal, upper, rightHandSide),
  );
  if (axisSolutions.some((solution) => !solution)) {
    return null;
  }
  const tangents = new Float64Array(pointCount * 3);
  for (let index = 0; index < pointCount; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      tangents[index * 3 + axis] = axisSolutions[axis][index];
    }
  }
  return tangents;
}

function solvePeriodicFitPointTangents(points, intervals) {
  const pointCount = points.length;
  if (pointCount < 3 || intervals.length !== pointCount) {
    return null;
  }
  const lower = new Float64Array(pointCount);
  const diagonal = new Float64Array(pointCount);
  const upper = new Float64Array(pointCount);
  const rightHandSides = Array.from(
    { length: 3 },
    () => new Float64Array(pointCount),
  );
  for (let index = 0; index < pointCount; index += 1) {
    const previous = (index + pointCount - 1) % pointCount;
    const next = (index + 1) % pointCount;
    const previousInterval = intervals[previous];
    const nextInterval = intervals[index];
    if (index > 0) {
      lower[index] = nextInterval;
    }
    diagonal[index] = 2 * (previousInterval + nextInterval);
    if (index + 1 < pointCount) {
      upper[index] = previousInterval;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const previousSlope =
        (points[index][axis] - points[previous][axis]) /
        previousInterval;
      const nextSlope =
        (points[next][axis] - points[index][axis]) / nextInterval;
      rightHandSides[axis][index] =
        3 *
        (previousSlope * nextInterval + nextSlope * previousInterval);
    }
  }
  const upperRight = intervals[0];
  const lowerLeft = intervals[pointCount - 2];
  const axisSolutions = rightHandSides.map((rightHandSide) =>
    solveCyclicTridiagonal(
      lower,
      diagonal,
      upper,
      upperRight,
      lowerLeft,
      rightHandSide,
    ),
  );
  if (axisSolutions.some((solution) => !solution)) {
    return null;
  }
  const tangents = new Float64Array(pointCount * 3);
  for (let index = 0; index < pointCount; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      tangents[index * 3 + axis] = axisSolutions[axis][index];
    }
  }
  return tangents;
}

function readFitPointSplineGeometry(source, entity) {
  let fitPointCount = entity.fitPointCount;
  if (
    !source.splineFitPoints ||
    !Number.isSafeInteger(fitPointCount) ||
    fitPointCount < 2 ||
    fitPointCount > MAX_CURVE_SEGMENTS_PER_ENTITY + 1 ||
    !Number.isSafeInteger(entity.firstFitPoint) ||
    entity.firstFitPoint + fitPointCount > source.splineFitPoints.length
  ) {
    return null;
  }
  const points = new Array(fitPointCount);
  const point = [0, 0, 0];
  for (let index = 0; index < fitPointCount; index += 1) {
    source.splineFitPoints.readPoint(entity.firstFitPoint + index, point);
    if (!finitePoint(point)) {
      return null;
    }
    points[index] = [...point];
  }
  const closed = Boolean(entity.splineFlags & 1);
  const periodic = closed && Boolean(entity.splineFlags & 2);
  const endpointsCoincide =
    pointDistance(points[0], points[points.length - 1]) <= CURVE_EPSILON;
  if (periodic && endpointsCoincide) {
    points.pop();
    fitPointCount -= 1;
  } else if (closed && !periodic && !endpointsCoincide) {
    points.push([...points[0]]);
    fitPointCount += 1;
  }
  if (
    fitPointCount < 2 ||
    fitPointCount - 1 + Number(periodic) > MAX_CURVE_SEGMENTS_PER_ENTITY
  ) {
    return null;
  }
  const segmentCount = fitPointCount - 1 + Number(periodic);
  const intervalLengths = new Float64Array(segmentCount);
  const parameters = new Float64Array(segmentCount + 1);
  for (let index = 0; index < segmentCount; index += 1) {
    const length = fitPointIntervalLength(
      points[index],
      points[(index + 1) % fitPointCount],
      entity.knotParameterization,
    );
    if (!length) {
      return null;
    }
    intervalLengths[index] = length;
    parameters[index + 1] = parameters[index] + length;
  }
  const tangents = periodic
    ? solvePeriodicFitPointTangents(points, intervalLengths)
    : solveOpenFitPointTangents(
        points,
        intervalLengths,
        explicitSplineTangent(entity.beginTangent),
        explicitSplineTangent(entity.endTangent),
      );
  if (!tangents) {
    return null;
  }
  const bounds = emptyBounds3();
  const intervals = new Array(segmentCount);
  for (let index = 0; index < segmentCount; index += 1) {
    const next = (index + 1) % fitPointCount;
    const intervalLength = intervalLengths[index];
    intervals[index] = [parameters[index], parameters[index + 1]];
    includePoint(bounds, points[index]);
    includePoint(bounds, points[next]);
    for (let axis = 0; axis < 3; axis += 1) {
      const firstControl =
        points[index][axis] +
        (tangents[index * 3 + axis] * intervalLength) / 3;
      const secondControl =
        points[next][axis] -
        (tangents[next * 3 + axis] * intervalLength) / 3;
      bounds.min[axis] = Math.min(
        bounds.min[axis],
        firstControl,
        secondControl,
      );
      bounds.max[axis] = Math.max(
        bounds.max[axis],
        firstControl,
        secondControl,
      );
    }
  }
  if (!boundsAreFinite(bounds)) {
    return null;
  }
  return {
    fitPoints: points,
    tangents,
    parameters,
    intervalLengths,
    segmentCount,
    intervals,
    bounds,
  };
}

function evaluateFitPointSpline(geometry, parameter) {
  if (!Number.isFinite(parameter)) {
    return null;
  }
  const { parameters, segmentCount, fitPoints, tangents } = geometry;
  let segment = segmentCount - 1;
  if (parameter < parameters[segmentCount] - CURVE_EPSILON) {
    let lower = 0;
    let upper = segmentCount;
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (parameters[middle] <= parameter) {
        lower = middle;
      } else {
        upper = middle;
      }
    }
    segment = lower;
  }
  const intervalLength = geometry.intervalLengths[segment];
  const localParameter = Math.max(
    0,
    Math.min(1, (parameter - parameters[segment]) / intervalLength),
  );
  const next = (segment + 1) % fitPoints.length;
  const inverse = 1 - localParameter;
  const startBasis = inverse * inverse * (1 + 2 * localParameter);
  const startTangentBasis =
    localParameter * inverse * inverse * intervalLength;
  const endBasis = localParameter * localParameter * (3 - 2 * localParameter);
  const endTangentBasis =
    localParameter * localParameter * (localParameter - 1) * intervalLength;
  const result = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    result[axis] =
      startBasis * fitPoints[segment][axis] +
      startTangentBasis * tangents[segment * 3 + axis] +
      endBasis * fitPoints[next][axis] +
      endTangentBasis * tangents[next * 3 + axis];
  }
  return finitePoint(result) ? result : null;
}

function evaluateSpline(geometry, parameter) {
  const {
    degree,
    controls,
    weights: sourceWeights,
    knots,
    controlCount,
    domainEnd,
  } = geometry;
  let span;
  if (parameter >= domainEnd - CURVE_EPSILON) {
    span = controlCount - 1;
  } else {
    for (let index = degree; index < controlCount; index += 1) {
      if (knots[index] <= parameter && parameter < knots[index + 1]) {
        span = index;
        break;
      }
    }
  }
  if (span === undefined) {
    return null;
  }
  const points = new Float64Array((degree + 1) * 3);
  const weights = new Float64Array(degree + 1);
  for (let index = 0; index <= degree; index += 1) {
    const controlIndex = span - degree + index;
    if (controlIndex < 0 || controlIndex >= controlCount) {
      return null;
    }
    const weight = sourceWeights?.[controlIndex] ?? 1;
    for (let axis = 0; axis < 3; axis += 1) {
      points[index * 3 + axis] =
        controls[controlIndex * 3 + axis] * weight;
    }
    weights[index] = weight;
  }
  for (let level = 1; level <= degree; level += 1) {
    for (let index = degree; index >= level; index -= 1) {
      const knotIndex = span - degree + index;
      const denominator =
        knots[knotIndex + degree - level + 1] - knots[knotIndex];
      const alpha =
        Math.abs(denominator) <= CURVE_EPSILON
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                (parameter - knots[knotIndex]) / denominator,
              ),
            );
      for (let axis = 0; axis < 3; axis += 1) {
        points[index * 3 + axis] =
          points[(index - 1) * 3 + axis] * (1 - alpha) +
          points[index * 3 + axis] * alpha;
      }
      weights[index] =
        weights[index - 1] * (1 - alpha) +
        weights[index] * alpha;
    }
  }
  const weight = weights[degree];
  if (!Number.isFinite(weight) || Math.abs(weight) <= CURVE_EPSILON) {
    return null;
  }
  const point = [
    points[degree * 3] / weight,
    points[degree * 3 + 1] / weight,
    points[degree * 3 + 2] / weight,
  ];
  return finitePoint(point) ? point : null;
}

function refinedHandleWords(handles) {
  const words = new Uint32Array(handles.size * 2);
  let offset = 0;
  for (const handle of handles) {
    words[offset] = Number(handle & 0xffffffffn);
    words[offset + 1] = Number(handle >> 32n);
    offset += 2;
  }
  return words;
}

function assertCamera(camera) {
  if (
    !camera ||
    !finitePoint(camera.origin) ||
    !Number.isFinite(camera.worldWidth) ||
    camera.worldWidth <= 0 ||
    !Number.isFinite(camera.worldHeight) ||
    camera.worldHeight <= 0 ||
    !Number.isFinite(camera.width) ||
    camera.width <= 0 ||
    !Number.isFinite(camera.height) ||
    camera.height <= 0
  ) {
    throw new TypeError("curve refinement camera is invalid");
  }
}

export function buildCurveRefinementMesh(
  source,
  blocks,
  instanceGraph,
  camera,
  {
    maximumGpuBytes = MAX_CURVE_REFINEMENT_GPU_BYTES,
    maskOrder = null,
  } = {},
) {
  assertCamera(camera);
  if (
    !Number.isSafeInteger(maximumGpuBytes) ||
    maximumGpuBytes < GPU_LINE_VERTEX_RECORD_SIZE * 2 ||
    maximumGpuBytes > MAX_CURVE_REFINEMENT_GPU_BYTES
  ) {
    throw new RangeError("curve refinement GPU byte limit is invalid");
  }
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const builder = new CurveMeshBuilder(maximumGpuBytes);
  const refinedHandles = new Set();
  const metrics = {
    sourceConstructionLines: source.constructionLines?.length ?? 0,
    sourceArcs: source.arcs.length,
    sourceCircles: source.circles.length,
    sourceEllipses: source.ellipses.length,
    sourcePolylines: source.polylines.length,
    sourceSplines: source.splines.length,
    considered: 0,
    visible: 0,
    refined: 0,
    scaledLinetypes: 0,
    skippedOffscreen: 0,
    skippedInvalid: 0,
    skippedLinear: 0,
    skippedOwner: 0,
    gpuLimitReached: false,
    pixelError: CURVE_PIXEL_ERROR,
    geometryPixelError: CURVE_GEOMETRY_PIXEL_ERROR,
    positionPixelError: CURVE_POSITION_PIXEL_ERROR,
  };

  const commit = (
    entity,
    sourceKind,
    owner,
    visibility,
    segments,
  ) => {
    if (!segments || segments.length === 0) {
      metrics.skippedInvalid += 1;
      return false;
    }
    const linetypeScale =
      source.curveLinetypeScales?.get(entity.handle) ?? 1;
    if (!Number.isFinite(linetypeScale) || linetypeScale <= 0) {
      metrics.skippedInvalid += 1;
      return false;
    }
    const displaySegments = scaleCurvePatternDistances(
      segments,
      linetypeScale,
    );
    if (
      !builder.write(
        owner,
        visibility.instanceIndices,
        displaySegments,
        curveAttributes(entity, sourceKind, maskOrder),
        visibility.maximumPixelsPerLocalUnit,
      )
    ) {
      if (builder.lastFailure === "gpu-budget") {
        metrics.gpuLimitReached = true;
      } else {
        metrics.skippedInvalid += 1;
      }
      return false;
    }
    refinedHandles.add(entity.handle);
    if (linetypeScale !== 1) {
      metrics.scaledLinetypes += 1;
    }
    metrics.refined += 1;
    return true;
  };

  const circularTarget = {
    center: [0, 0, 0],
    normal: [0, 0, 1],
  };
  const constructionTarget = {
    point: [0, 0, 0],
    direction: [0, 0, 0],
  };
  for (
    let index = 0;
    index < (source.constructionLines?.length ?? 0);
    index += 1
  ) {
    metrics.considered += 1;
    source.constructionLines.readEntity(index, constructionTarget);
    const owner = ownerFor(
      constructionTarget,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwner += 1;
      continue;
    }
    const visibility = visibleConstructionLine(
      constructionTarget,
      owner,
      instanceGraph,
      camera,
    );
    if (!visibility) {
      metrics.skippedOffscreen += 1;
      continue;
    }
    const directionLength = Math.hypot(...constructionTarget.direction);
    if (!Number.isFinite(directionLength) || directionLength <= CURVE_EPSILON) {
      metrics.skippedInvalid += 1;
      continue;
    }
    const start = constructionTarget.point.map(
      (value, axis) =>
        value +
        constructionTarget.direction[axis] * visibility.minimumParameter,
    );
    const end = constructionTarget.point.map(
      (value, axis) =>
        value +
        constructionTarget.direction[axis] * visibility.maximumParameter,
    );
    if (!finitePoint(start) || !finitePoint(end)) {
      metrics.skippedInvalid += 1;
      continue;
    }
    const minimumDistance =
      Math.abs(visibility.minimumParameter) * directionLength;
    const maximumDistance =
      Math.abs(visibility.maximumParameter) * directionLength;
    let segments;
    if (
      constructionTarget.kind === "xline" &&
      visibility.minimumParameter < 0 &&
      visibility.maximumParameter > 0
    ) {
      segments = new Float64Array([
        ...start,
        ...constructionTarget.point,
        minimumDistance,
        0,
        ...constructionTarget.point,
        ...end,
        0,
        maximumDistance,
      ]);
    } else {
      segments = new Float64Array([
        ...start,
        ...end,
        minimumDistance,
        maximumDistance,
      ]);
    }
    metrics.visible += 1;
    commit(
      constructionTarget,
      9,
      owner,
      visibility,
      segments,
    );
  }
  for (const [table, sourceKind] of [
    [source.arcs, 4],
    [source.circles, 5],
  ]) {
    for (let index = 0; index < table.length; index += 1) {
      metrics.considered += 1;
      table.readEntity(index, circularTarget);
      const owner = ownerFor(
        circularTarget,
        blocks,
        instanceGraph,
        blockIndexByHandle,
      );
      const basis = circularBasis(
        circularTarget.center,
        circularTarget.radius,
        circularTarget.normal,
      );
      const sweep = normalizedSweep(
        circularTarget.startParameter,
        circularTarget.endParameter,
      );
      if (!owner) {
        metrics.skippedOwner += 1;
        continue;
      }
      if (!basis || !sweep) {
        metrics.skippedInvalid += 1;
        continue;
      }
      const visibility = visibleOwnerInstances(
        owner,
        basis.bounds,
        instanceGraph,
        camera,
      );
      if (!visibility) {
        metrics.skippedOffscreen += 1;
        continue;
      }
      metrics.visible += 1;
      commit(
        circularTarget,
        sourceKind,
        owner,
        visibility,
        makeCircularSegments(
          circularTarget.center,
          circularTarget.radius,
          circularTarget.startParameter,
          sweep,
          basis.matrix,
          visibility.maximumPixelsPerLocalUnit,
        ),
      );
    }
  }

  const ellipseTarget = {
    center: [0, 0, 0],
    majorAxis: [0, 0, 0],
    normal: [0, 0, 1],
  };
  for (let index = 0; index < source.ellipses.length; index += 1) {
    metrics.considered += 1;
    source.ellipses.readEntity(index, ellipseTarget);
    const owner = ownerFor(
      ellipseTarget,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    const basis = ellipseBasis(ellipseTarget);
    if (!owner) {
      metrics.skippedOwner += 1;
      continue;
    }
    if (
      !basis ||
      !normalizedSweep(
        ellipseTarget.startParameter,
        ellipseTarget.endParameter,
      )
    ) {
      metrics.skippedInvalid += 1;
      continue;
    }
    const visibility = visibleOwnerInstances(
      owner,
      basis.bounds,
      instanceGraph,
      camera,
    );
    if (!visibility) {
      metrics.skippedOffscreen += 1;
      continue;
    }
    metrics.visible += 1;
    commit(
      ellipseTarget,
      6,
      owner,
      visibility,
      makeEllipseSegments(
        ellipseTarget,
        basis,
        visibility.maximumPixelsPerLocalUnit,
      ),
    );
  }

  const polylineTarget = { normal: [0, 0, 1] };
  for (let index = 0; index < source.polylines.length; index += 1) {
    metrics.considered += 1;
    source.polylines.readEntity(index, polylineTarget);
    const owner = ownerFor(
      polylineTarget,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwner += 1;
      continue;
    }
    const geometry = readPolylineGeometry(source, polylineTarget);
    if (geometry && !geometry.curved) {
      metrics.skippedLinear += 1;
      continue;
    }
    if (!geometry) {
      metrics.skippedInvalid += 1;
      continue;
    }
    const visibility = visibleOwnerInstances(
      owner,
      geometry.bounds,
      instanceGraph,
      camera,
    );
    if (!visibility) {
      metrics.skippedOffscreen += 1;
      continue;
    }
    metrics.visible += 1;
    commit(
      polylineTarget,
      polylineTarget.polylineKind,
      owner,
      visibility,
      makeBulgeSegments(
        geometry,
        visibility.maximumPixelsPerLocalUnit,
      ),
    );
  }

  const splineTarget = {
    normal: [0, 0, 1],
    beginTangent: [0, 0, 0],
    endTangent: [0, 0, 0],
  };
  for (let index = 0; index < source.splines.length; index += 1) {
    metrics.considered += 1;
    source.splines.readEntity(index, splineTarget);
    const owner = ownerFor(
      splineTarget,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwner += 1;
      continue;
    }
    if (splineTarget.degree <= 1 || (splineTarget.splineFlags & 16) !== 0) {
      metrics.skippedLinear += 1;
      continue;
    }
    const geometry =
      readSplineGeometry(source, splineTarget) ??
      readFitPointSplineGeometry(source, splineTarget);
    if (!geometry) {
      metrics.skippedInvalid += 1;
      continue;
    }
    const visibility = visibleOwnerInstances(
      owner,
      geometry.bounds,
      instanceGraph,
      camera,
    );
    if (!visibility) {
      metrics.skippedOffscreen += 1;
      continue;
    }
    metrics.visible += 1;
    commit(
      splineTarget,
      7,
      owner,
      visibility,
      adaptiveParametricSegments(
        (parameter) =>
          geometry.fitPoints
            ? evaluateFitPointSpline(geometry, parameter)
            : evaluateSpline(geometry, parameter),
        geometry.intervals,
        visibility.maximumPixelsPerLocalUnit,
      ),
    );
  }

  const mesh = builder.finish();
  const handleWords = refinedHandleWords(refinedHandles);
  return Object.freeze({
    entries: mesh.entries,
    refinedHandleWords: handleWords,
    byteLength: mesh.byteLength,
    vertexCount: mesh.vertexCount,
    metrics: Object.freeze({
      ...metrics,
      segments: mesh.vertexCount / 2,
      vertices: mesh.vertexCount,
      gpuBytes: mesh.byteLength,
      batches: mesh.entries.length,
      refinedHandles: refinedHandles.size,
      maximumPositionError: mesh.maximumPositionError,
    }),
  });
}

export function curveRefinementTransferables(refinement) {
  return [
    refinement.refinedHandleWords.buffer,
    ...refinement.entries.map((entry) => entry.vertices.buffer),
  ];
}

export {
  adaptiveParametricSegments,
  CURVE_GEOMETRY_PIXEL_ERROR,
  CURVE_PIXEL_ERROR,
  CURVE_POSITION_PIXEL_ERROR,
  evaluateSpline,
  evaluateFitPointSpline,
  readFitPointSplineGeometry,
  MAX_CURVE_REFINEMENT_BATCH_BYTES,
  MAX_CURVE_REFINEMENT_GPU_BYTES,
  MAX_CURVE_SEGMENTS_PER_ENTITY,
  makeBulgeSegments,
  makeCircularSegments,
  makeEllipseSegments,
  readSplineGeometry,
};
