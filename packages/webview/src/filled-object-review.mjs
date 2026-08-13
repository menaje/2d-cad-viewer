import {
  arbitraryAxisMat4,
  transformPoint,
} from "./math.mjs";
import { composeExternalInstanceGraph } from "./external-reference.mjs";
import { HatchFlags, HatchStyle } from "./scene-cache.mjs";
import {
  instanceIsVisible,
  refreshInstanceVisibility,
} from "./instance-visibility.mjs";

const MATRIX_VALUES = 16;
const NO_LAYER = 0xffffffff;
const PATH_FLAG_SELF_INTERSECTING = 64;
const PATH_FLAG_DUPLICATE = 256;
const DEFAULT_TOLERANCE_PIXELS = 18;
const MAX_GRID_AXIS = 96;
const MAX_CELLS_PER_ITEM = 256;
const MAX_QUERY_CANDIDATES = 4_096;

export const MAX_REVIEW_FILLED_OCCURRENCES = 20_000;
export const MAX_REVIEW_FILLED_RINGS = 50_000;
export const MAX_REVIEW_FILLED_VERTICES = 250_000;
export const MAX_REVIEW_HATCH_LOOPS_PER_ENTITY = 2_048;

const EMPTY_INSTANCES = Object.freeze({
  data: new Float64Array(0),
  measurementData: new Float64Array(0),
  count: 0,
  length: 0,
});

function pointsNear(left, right) {
  let scale = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    scale = Math.max(scale, Math.abs(left[axis]), Math.abs(right[axis]));
  }
  return left.every(
    (value, axis) => Math.abs(value - right[axis]) <= scale * 1e-12,
  );
}

function dominantProjection(normal) {
  const absolute = normal.map(Math.abs);
  if (absolute[0] >= absolute[1] && absolute[0] >= absolute[2]) {
    return [1, 2];
  }
  if (absolute[1] >= absolute[2]) {
    return [0, 2];
  }
  return [0, 1];
}

function projectedArea(points, axes) {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubled +=
      current[axes[0]] * next[axes[1]] -
      next[axes[0]] * current[axes[1]];
  }
  return doubled * 0.5;
}

function projectedBounds(points, axes) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point[axes[0]]);
    bounds.minY = Math.min(bounds.minY, point[axes[1]]);
    bounds.maxX = Math.max(bounds.maxX, point[axes[0]]);
    bounds.maxY = Math.max(bounds.maxY, point[axes[1]]);
  }
  return bounds;
}

function pointOnSegment2D(point, first, last, epsilon = 1e-10) {
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const scale = Math.max(
    1,
    Math.abs(point[0]),
    Math.abs(point[1]),
    Math.abs(first[0]),
    Math.abs(first[1]),
    Math.abs(last[0]),
    Math.abs(last[1]),
  );
  const cross =
    (point[0] - first[0]) * dy - (point[1] - first[1]) * dx;
  if (Math.abs(cross) > scale * scale * epsilon) {
    return false;
  }
  return (
    point[0] >= Math.min(first[0], last[0]) - scale * epsilon &&
    point[0] <= Math.max(first[0], last[0]) + scale * epsilon &&
    point[1] >= Math.min(first[1], last[1]) - scale * epsilon &&
    point[1] <= Math.max(first[1], last[1]) + scale * epsilon
  );
}

function pointInsideProjectedRing(point, ring, axes) {
  let inside = false;
  let previous = ring.points.at(-1);
  for (const current of ring.points) {
    const first = [previous[axes[0]], previous[axes[1]]];
    const last = [current[axes[0]], current[axes[1]]];
    if (pointOnSegment2D(point, first, last)) {
      return true;
    }
    const crosses =
      (last[1] > point[1]) !== (first[1] > point[1]) &&
      point[0] <
        ((first[0] - last[0]) * (point[1] - last[1])) /
          (first[1] - last[1]) +
          last[0];
    if (crosses) {
      inside = !inside;
    }
    previous = current;
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

function classifyRingNesting(rings, axes) {
  for (const ring of rings) {
    let parent = null;
    const point = [
      ring.points[0][axes[0]],
      ring.points[0][axes[1]],
    ];
    for (const candidate of rings) {
      if (
        candidate === ring ||
        candidate.absoluteArea <= ring.absoluteArea ||
        !boundsContain(candidate.bounds, ring.bounds) ||
        !pointInsideProjectedRing(point, candidate, axes)
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
    ring.depth = depth <= rings.length ? depth : 0;
  }
}

function readHatchRings(source, entity) {
  const axes = dominantProjection(entity.normal);
  const rings = [];
  const loop = {};
  const vertex = [0, 0, 0];
  const loopCount = Math.min(
    entity.loopCount,
    MAX_REVIEW_HATCH_LOOPS_PER_ENTITY,
  );
  for (let loopOffset = 0; loopOffset < loopCount; loopOffset += 1) {
    source.readLoop(entity.firstLoop + loopOffset, loop);
    if (
      loop.pathFlags &
      (PATH_FLAG_SELF_INTERSECTING | PATH_FLAG_DUPLICATE)
    ) {
      continue;
    }
    const points = [];
    for (let index = 0; index < loop.vertexCount; index += 1) {
      source.readVertex(loop.firstVertex + index, vertex);
      if (vertex.every(Number.isFinite)) {
        points.push([...vertex]);
      }
    }
    if (points.length > 3 && pointsNear(points[0], points.at(-1))) {
      points.pop();
    }
    if (points.length < 3) {
      continue;
    }
    const area = projectedArea(points, axes);
    const bounds = projectedBounds(points, axes);
    const extent = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
    );
    if (
      !Number.isFinite(area) ||
      Math.abs(area) <= Math.max(extent * extent * 1e-14, 1e-18)
    ) {
      continue;
    }
    rings.push({
      points,
      pathFlags: loop.pathFlags,
      bounds,
      absoluteArea: Math.abs(area),
      parent: null,
      depth: 0,
    });
  }
  classifyRingNesting(rings, axes);
  return {
    rings,
    truncated: loopCount < entity.loopCount,
  };
}

function instancesForEntity(entity, blocks, instanceGraph, blockIndexByHandle) {
  const blockIndex = blockIndexByHandle.get(entity.ownerHandle);
  if (blockIndex === undefined) {
    return entity.ownerHandle === 0n
      ? instanceGraph.modelInstances ?? instanceGraph.rootInstances ??
          EMPTY_INSTANCES
      : EMPTY_INSTANCES;
  }
  if (instanceGraph.modelBlockIndices?.has(blockIndex)) {
    return (
      instanceGraph.modelInstances ??
      instanceGraph.rootInstances ??
      EMPTY_INSTANCES
    );
  }
  if (blocks[blockIndex]?.name?.toUpperCase().startsWith("*PAPER_SPACE")) {
    return EMPTY_INSTANCES;
  }
  return instanceGraph.instancesByBlock?.get(blockIndex) ?? EMPTY_INSTANCES;
}

function resolvedLayerIndex(
  entityLayer,
  instances,
  instanceIndex,
  layerZero,
  layerMap,
) {
  const override = instances.layerIndices?.[instanceIndex] ?? NO_LAYER;
  if (entityLayer === layerZero && override !== NO_LAYER) {
    return override;
  }
  return layerMap instanceof Uint32Array &&
    entityLayer >= 0 &&
    entityLayer < layerMap.length
    ? layerMap[entityLayer]
    : entityLayer;
}

function resolvedLinetypeCode(code, linetypeMap) {
  const normalized = Number.isInteger(code) && code >= 0 ? code : 2;
  return linetypeMap instanceof Uint16Array &&
    normalized < linetypeMap.length
    ? linetypeMap[normalized]
    : normalized;
}

function visibleInViewport(
  layerIndex,
  instances,
  instanceIndex,
  instanceGraph,
) {
  if (layerIndex === NO_LAYER) {
    return true;
  }
  const rowIndex = instances.visibilityRows?.[instanceIndex] ?? 0;
  const row = instanceGraph.layerVisibilityRows?.[rowIndex];
  return !row || layerIndex >= row.length || row[layerIndex] !== 0;
}

function polygonPerimeter(points) {
  let length = 0;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index];
    const last = points[(index + 1) % points.length];
    length += Math.hypot(
      last[0] - first[0],
      last[1] - first[1],
      last[2] - first[2],
    );
  }
  return length;
}

function polygonArea3D(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    x += (current[1] - next[1]) * (current[2] + next[2]);
    y += (current[2] - next[2]) * (current[0] + next[0]);
    z += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return Math.hypot(x, y, z) * 0.5;
}

function includedHatchRing(style, depth) {
  if (style === HatchStyle.Ignore) {
    return depth === 0;
  }
  if (style === HatchStyle.Outer) {
    return depth <= 1;
  }
  return true;
}

function hatchAreaSign(style, depth) {
  if (style === HatchStyle.Ignore) {
    return 1;
  }
  return depth % 2 === 0 ? 1 : -1;
}

function transformedRings(
  rings,
  displayMatrix,
  measurementMatrix,
  matrixOffset,
) {
  return rings.map((ring) => ({
    depth: ring.depth,
    display: ring.points.map((point) =>
      transformPoint(displayMatrix, point, matrixOffset),
    ),
    measurement: ring.points.map((point) =>
      transformPoint(measurementMatrix, point, matrixOffset),
    ),
  }));
}

function cloneClipNodes(instanceGraph) {
  return Object.freeze(
    (instanceGraph.clipNodes ?? []).map((node) =>
      Object.freeze({
        id: node.id,
        parentId: node.parentId,
        inverted: Boolean(node.inverted),
        points: Object.freeze(
          node.points.map((point) => Object.freeze([...point])),
        ),
      }),
    ),
  );
}

export function buildFilledObjectReviewData(
  source,
  blocks,
  instanceGraph,
  {
    maximumOccurrences = MAX_REVIEW_FILLED_OCCURRENCES,
    maximumRings = MAX_REVIEW_FILLED_RINGS,
    maximumVertices = MAX_REVIEW_FILLED_VERTICES,
    layerMap = null,
    linetypeMap = null,
    layerZeroIndex = instanceGraph.layerZeroIndex ?? NO_LAYER,
  } = {},
) {
  const records = [];
  const displayValues = [];
  const measurementValues = [];
  const ringStarts = [];
  const ringCounts = [];
  const ringDepths = [];
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const layerZero = Number.isSafeInteger(layerZeroIndex)
    ? layerZeroIndex
    : NO_LAYER;
  let truncated = false;
  const metrics = {
    sourceHatches: source.hatches?.length ?? 0,
    sourceSolids: source.solids?.length ?? 0,
    sourceFaces: source.faces?.length ?? 0,
    occurrences: 0,
    hatches: 0,
    solids: 0,
    faces: 0,
    rings: 0,
    vertices: 0,
    skippedInvisible: 0,
    skippedOwners: 0,
    skippedInvalid: 0,
    truncated: false,
  };

  const addOccurrence = (
    entity,
    kind,
    rings,
    instances,
    instanceIndex,
    metadata,
  ) => {
    const vertexCount = rings.reduce(
      (total, ring) => total + ring.points.length,
      0,
    );
    if (
      records.length >= maximumOccurrences ||
      ringStarts.length > maximumRings - rings.length ||
      displayValues.length / 3 > maximumVertices - vertexCount
    ) {
      truncated = true;
      return false;
    }
    const layerIndex = resolvedLayerIndex(
      entity.layerIndex,
      instances,
      instanceIndex,
      layerZero,
      layerMap,
    );
    if (
      !visibleInViewport(
        layerIndex,
        instances,
        instanceIndex,
        instanceGraph,
      )
    ) {
      return true;
    }
    const matrixOffset = instanceIndex * MATRIX_VALUES;
    const measurementMatrix =
      instances.measurementData ?? instances.data;
    const transformed = transformedRings(
      rings,
      instances.data,
      measurementMatrix,
      matrixOffset,
    );
    if (
      transformed.some(
        (ring) =>
          !ring.display.every((point) => point.every(Number.isFinite)) ||
          !ring.measurement.every((point) => point.every(Number.isFinite)),
      )
    ) {
      metrics.skippedInvalid += 1;
      return true;
    }
    const firstRing = ringStarts.length;
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    let perimeter = 0;
    let area = 0;
    for (const [ringIndex, ring] of transformed.entries()) {
      ringStarts.push(displayValues.length / 3);
      ringCounts.push(ring.display.length);
      ringDepths.push(ring.depth);
      for (let pointIndex = 0; pointIndex < ring.display.length; pointIndex += 1) {
        const display = ring.display[pointIndex];
        const measurement = ring.measurement[pointIndex];
        displayValues.push(...display);
        measurementValues.push(...measurement);
        bounds[0] = Math.min(bounds[0], display[0]);
        bounds[1] = Math.min(bounds[1], display[1]);
        bounds[2] = Math.max(bounds[2], display[0]);
        bounds[3] = Math.max(bounds[3], display[1]);
      }
      const depth = rings[ringIndex].depth;
      if (
        kind !== "hatch" ||
        includedHatchRing(metadata.hatchStyle, depth)
      ) {
        perimeter += polygonPerimeter(ring.measurement);
        area +=
          polygonArea3D(ring.measurement) *
          (kind === "hatch"
            ? hatchAreaSign(metadata.hatchStyle, depth)
            : 1);
      }
    }
    records.push(
      Object.freeze({
        kind,
        handle: entity.handle,
        ownerHandle: entity.ownerHandle,
        layerIndex,
        color: entity.color,
        lineWeight: entity.lineWeight,
        linetypeCode: resolvedLinetypeCode(
          entity.linetypeCode,
          linetypeMap,
        ),
        commonFlags: entity.commonFlags,
        coordinateSpace:
          instances.coordinateSpaceIds?.[instanceIndex] ?? 1,
        instances,
        instanceIndex,
        clipId: instances.clipIds?.[instanceIndex] ?? 0,
        firstRing,
        ringCount: transformed.length,
        bounds: Object.freeze(bounds),
        objectMeasurement: Object.freeze({
          length: perimeter,
          area: Math.max(0, area),
          closed: true,
          approximated: Boolean(metadata.approximated),
        }),
        ...metadata,
      }),
    );
    metrics.occurrences += 1;
    metrics[
      kind === "hatch" ? "hatches" : kind === "face" ? "faces" : "solids"
    ] += 1;
    return true;
  };

  const addEntity = (entity, kind, rings, metadata) => {
    if (entity.commonFlags & 1) {
      metrics.skippedInvisible += 1;
      return true;
    }
    if (rings.length === 0) {
      metrics.skippedInvalid += 1;
      return true;
    }
    const instances = instancesForEntity(
      entity,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (instances.count === 0) {
      metrics.skippedOwners += 1;
      return true;
    }
    for (let instanceIndex = 0; instanceIndex < instances.count; instanceIndex += 1) {
      if (
        !addOccurrence(
          entity,
          kind,
          rings,
          instances,
          instanceIndex,
          metadata,
        )
      ) {
        return false;
      }
    }
    return true;
  };

  const hatch = { normal: [0, 0, 1] };
  for (let index = 0; index < (source.hatches?.length ?? 0); index += 1) {
    source.hatches.readEntity(index, hatch);
    const { rings, truncated: ringLimitReached } = readHatchRings(
      source.hatches,
      hatch,
    );
    if (
      !addEntity(hatch, "hatch", rings, {
        hatchStyle: hatch.style,
        hatchFlags: hatch.flags,
        patternType: hatch.patternType,
        loopCount: hatch.loopCount,
        patternName: source.hatches.readPatternName(index),
        gradientName: source.hatches.readGradientName(index),
        patternAngle: hatch.patternAngle,
        patternScale: hatch.patternScale,
        interiorSelectable: true,
        approximated:
          ringLimitReached || Boolean(hatch.flags & HatchFlags.Truncated),
      })
    ) {
      break;
    }
  }

  const solid = {
    corners: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    normal: [0, 0, 1],
  };
  for (
    let index = 0;
    !truncated && index < (source.solids?.length ?? 0);
    index += 1
  ) {
    source.solids.readEntity(index, solid);
    const ocsToWcs = arbitraryAxisMat4(solid.normal);
    const corners = solid.corners.map((corner) =>
      transformPoint(ocsToWcs, corner),
    );
    if (pointsNear(corners[2], corners[3])) {
      corners.pop();
    }
    if (
      !addEntity(
        solid,
        "solid",
        [{ points: corners, depth: 0 }],
        {
          fillMode: solid.fillMode,
          normal: Object.freeze([...solid.normal]),
          thickness: solid.thickness,
          interiorSelectable: Boolean(solid.fillMode),
          approximated: false,
        },
      )
    ) {
      break;
    }
  }

  const face = {
    corners: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  };
  for (
    let index = 0;
    !truncated && index < (source.faces?.length ?? 0);
    index += 1
  ) {
    source.faces.readEntity(index, face);
    const corners = face.corners.map((corner) => [...corner]);
    if (pointsNear(corners[2], corners[3])) {
      corners.pop();
    }
    if (
      !addEntity(
        face,
        "face",
        [{ points: corners, depth: 0 }],
        {
          invisibleEdges: face.invisibleEdges,
          interiorSelectable: false,
          approximated: false,
        },
      )
    ) {
      break;
    }
  }

  metrics.rings = ringStarts.length;
  metrics.vertices = displayValues.length / 3;
  metrics.truncated = truncated;
  return Object.freeze({
    records: Object.freeze(records),
    displayPoints: new Float64Array(displayValues),
    measurementPoints: new Float64Array(measurementValues),
    ringStarts: new Uint32Array(ringStarts),
    ringCounts: new Uint32Array(ringCounts),
    ringDepths: new Uint16Array(ringDepths),
    clipNodes: cloneClipNodes(instanceGraph),
    instanceGraph,
    metrics: Object.freeze(metrics),
    truncated,
  });
}

export function buildExternalFilledObjectReviewData(
  source,
  blocks,
  childInstanceGraph,
  externalContext,
  options = {},
) {
  if (
    !externalContext ||
    !Number.isSafeInteger(externalContext.parentBlockIndex) ||
    !externalContext.parentInstances ||
    !Number.isSafeInteger(externalContext.parentInstances.count) ||
    externalContext.parentInstances.count < 0 ||
    !(externalContext.layerMap instanceof Uint32Array) ||
    !(externalContext.linetypeMap instanceof Uint16Array)
  ) {
    throw new TypeError("external filled-object context is invalid");
  }
  const parentInstanceGraph = {
    instancesByBlock: new Map([
      [
        externalContext.parentBlockIndex,
        externalContext.parentInstances,
      ],
    ]),
    clipNodes: externalContext.parentClipNodes ?? Object.freeze([]),
    layerVisibilityRows:
      externalContext.parentLayerVisibilityRows ?? Object.freeze([]),
  };
  const composed = composeExternalInstanceGraph(
    parentInstanceGraph,
    externalContext.parentBlockIndex,
    childInstanceGraph,
    Object.freeze([]),
    externalContext.layerMap,
    externalContext.linetypeMap,
  );
  return buildFilledObjectReviewData(
    source,
    blocks,
    composed.instanceGraph,
    {
      ...options,
      layerMap: externalContext.layerMap,
      linetypeMap: externalContext.linetypeMap,
      layerZeroIndex:
        childInstanceGraph.layerZeroIndex ?? options.layerZeroIndex,
    },
  );
}

function finiteBounds(bounds) {
  return (
    Array.isArray(bounds) &&
    bounds.length >= 4 &&
    bounds.every(Number.isFinite) &&
    bounds[0] <= bounds[2] &&
    bounds[1] <= bounds[3]
  );
}

function gridAxis(itemCount) {
  return Math.min(
    MAX_GRID_AXIS,
    Math.max(8, Math.ceil(Math.sqrt(Math.max(itemCount, 1) / 4))),
  );
}

class ReviewSpatialGrid {
  constructor(records) {
    this.records = records;
    this.bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const record of records) {
      if (!finiteBounds(record.bounds)) {
        continue;
      }
      this.bounds[0] = Math.min(this.bounds[0], record.bounds[0]);
      this.bounds[1] = Math.min(this.bounds[1], record.bounds[1]);
      this.bounds[2] = Math.max(this.bounds[2], record.bounds[2]);
      this.bounds[3] = Math.max(this.bounds[3], record.bounds[3]);
    }
    if (!finiteBounds(this.bounds)) {
      this.bounds = [0, 0, 1, 1];
    }
    this.columns = gridAxis(records.length);
    this.rows = this.columns;
    this.cells = new Map();
    this.global = [];
    this.stamps = new Uint32Array(records.length);
    this.revision = 0;
    records.forEach((record, index) => this.add(index, record.bounds));
  }

  range(bounds) {
    const width = Math.max(this.bounds[2] - this.bounds[0], Number.EPSILON);
    const height = Math.max(this.bounds[3] - this.bounds[1], Number.EPSILON);
    const cellX = (value) =>
      Math.min(
        this.columns - 1,
        Math.max(
          0,
          Math.floor(((value - this.bounds[0]) / width) * this.columns),
        ),
      );
    const cellY = (value) =>
      Math.min(
        this.rows - 1,
        Math.max(
          0,
          Math.floor(((value - this.bounds[1]) / height) * this.rows),
        ),
      );
    return [
      cellX(bounds[0]),
      cellY(bounds[1]),
      cellX(bounds[2]),
      cellY(bounds[3]),
    ];
  }

  add(index, bounds) {
    if (!finiteBounds(bounds)) {
      return;
    }
    const [firstX, firstY, lastX, lastY] = this.range(bounds);
    const cellCount = (lastX - firstX + 1) * (lastY - firstY + 1);
    if (cellCount > MAX_CELLS_PER_ITEM) {
      this.global.push(index);
      return;
    }
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        const key = y * this.columns + x;
        let values = this.cells.get(key);
        if (!values) {
          values = [];
          this.cells.set(key, values);
        }
        values.push(index);
      }
    }
  }

  query(bounds) {
    this.revision += 1;
    if (this.revision === 0xffffffff) {
      this.stamps.fill(0);
      this.revision = 1;
    }
    const output = [];
    const add = (index) => {
      if (
        output.length >= MAX_QUERY_CANDIDATES ||
        this.stamps[index] === this.revision
      ) {
        return;
      }
      this.stamps[index] = this.revision;
      output.push(index);
    };
    for (const index of this.global) {
      add(index);
    }
    if (
      bounds[2] < this.bounds[0] ||
      bounds[0] > this.bounds[2] ||
      bounds[3] < this.bounds[1] ||
      bounds[1] > this.bounds[3]
    ) {
      return output;
    }
    const [firstX, firstY, lastX, lastY] = this.range(bounds);
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        for (const index of this.cells.get(y * this.columns + x) ?? []) {
          add(index);
        }
      }
    }
    return output;
  }
}

function pointInsideRing(point, points) {
  let inside = false;
  let previous = points.at(-1);
  for (const current of points) {
    if (pointOnSegment2D(point, previous, current)) {
      return true;
    }
    const crosses =
      (current[1] > point[1]) !== (previous[1] > point[1]) &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
          (previous[1] - current[1]) +
          current[0];
    if (crosses) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
}

function pointInsidePackedRing(data, ringIndex, point) {
  const first = data.ringStarts[ringIndex];
  const count = data.ringCounts[ringIndex];
  let inside = false;
  let previous = pointAt(data.displayPoints, first + count - 1);
  for (let index = 0; index < count; index += 1) {
    const current = pointAt(data.displayPoints, first + index);
    if (pointOnSegment2D(point, previous, current)) {
      return true;
    }
    const crosses =
      (current[1] > point[1]) !== (previous[1] > point[1]) &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
          (previous[1] - current[1]) +
          current[0];
    if (crosses) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
}

function pointInsideClipChain(clipNodes, clipId, point) {
  let current = clipId;
  let depth = 0;
  while (current > 0 && depth < 64) {
    const node = clipNodes[current - 1];
    if (!node || node.id !== current) {
      return false;
    }
    const inside =
      node.points.length >= 3 && pointInsideRing(point, node.points);
    if ((!node.inverted && !inside) || (node.inverted && inside)) {
      return false;
    }
    current = node.parentId;
    depth += 1;
  }
  return current === 0;
}

function pointAt(values, index) {
  const offset = index * 3;
  return [values[offset], values[offset + 1], values[offset + 2]];
}

function ringPoints(data, ringIndex, values) {
  const first = data.ringStarts[ringIndex];
  const count = data.ringCounts[ringIndex];
  const points = new Array(count);
  for (let index = 0; index < count; index += 1) {
    points[index] = pointAt(values, first + index);
  }
  return points;
}

function nearestBoundary(
  data,
  record,
  point,
  pixelsPerWorldX,
  pixelsPerWorldY,
) {
  let best = null;
  for (
    let ringOffset = 0;
    ringOffset < record.ringCount;
    ringOffset += 1
  ) {
    const ringIndex = record.firstRing + ringOffset;
    const first = data.ringStarts[ringIndex];
    const count = data.ringCounts[ringIndex];
    for (let index = 0; index < count; index += 1) {
      if (
        record.kind === "face" &&
        (record.invisibleEdges & (1 << index)) !== 0
      ) {
        continue;
      }
      const startIndex = first + index;
      const endIndex = first + ((index + 1) % count);
      const start = pointAt(data.displayPoints, startIndex);
      const end = pointAt(data.displayPoints, endIndex);
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const scaledLengthSquared =
        (dx * pixelsPerWorldX) ** 2 +
        (dy * pixelsPerWorldY) ** 2;
      const parameter =
        scaledLengthSquared <= Number.EPSILON
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((point[0] - start[0]) *
                  pixelsPerWorldX *
                  dx *
                  pixelsPerWorldX +
                  (point[1] - start[1]) *
                    pixelsPerWorldY *
                    dy *
                    pixelsPerWorldY) /
                  scaledLengthSquared,
              ),
            );
      const displayPoint = [
        start[0] + dx * parameter,
        start[1] + dy * parameter,
        start[2] + (end[2] - start[2]) * parameter,
      ];
      const distancePixels = Math.hypot(
        (displayPoint[0] - point[0]) * pixelsPerWorldX,
        (displayPoint[1] - point[1]) * pixelsPerWorldY,
      );
      if (best && best.distancePixels <= distancePixels) {
        continue;
      }
      const measureStart = pointAt(data.measurementPoints, startIndex);
      const measureEnd = pointAt(data.measurementPoints, endIndex);
      best = {
        distancePixels,
        displayPoint,
        measurementPoint: [
          measureStart[0] +
            (measureEnd[0] - measureStart[0]) * parameter,
          measureStart[1] +
            (measureEnd[1] - measureStart[1]) * parameter,
          measureStart[2] +
            (measureEnd[2] - measureStart[2]) * parameter,
        ],
      };
    }
  }
  return best;
}

function insideRecord(data, record, point) {
  if (!record.interiorSelectable) {
    return false;
  }
  const containingDepths = [];
  for (
    let ringOffset = 0;
    ringOffset < record.ringCount;
    ringOffset += 1
  ) {
    const ringIndex = record.firstRing + ringOffset;
    if (pointInsidePackedRing(data, ringIndex, point)) {
      containingDepths.push(data.ringDepths[ringIndex]);
    }
  }
  if (containingDepths.length === 0) {
    return false;
  }
  if (record.kind !== "hatch") {
    return true;
  }
  if (record.hatchStyle === HatchStyle.Ignore) {
    return containingDepths.includes(0);
  }
  const deepest = Math.max(...containingDepths);
  return record.hatchStyle === HatchStyle.Outer
    ? deepest === 0
    : deepest % 2 === 0;
}

function kindName(kind) {
  return {
    hatch: "해치",
    solid: "솔리드",
    face: "3D 면",
  }[kind] ?? "채움 객체";
}

function fillRingIncluded(record, depth) {
  if (record.kind !== "hatch") {
    return Boolean(record.interiorSelectable);
  }
  return includedHatchRing(record.hatchStyle, depth);
}

function renderPickMetadata(resolved) {
  return resolved && resolved !== true &&
    typeof resolved === "object" &&
    !Array.isArray(resolved)
    ? { renderPick: resolved }
    : {};
}

export class FilledObjectSelectionIndex {
  constructor(
    data,
    {
      sourceId = "root",
      sourceLabel = "현재 도면",
      layers = Object.freeze([]),
      getLayerVisibility = () => [],
      resolveRenderPick = () => true,
    } = {},
  ) {
    if (typeof resolveRenderPick !== "function") {
      throw new TypeError(
        "filled-object render pick resolver must be a function",
      );
    }
    this.data = data;
    this.records = data?.records ?? [];
    this.sourceId = sourceId;
    this.sourceLabel = sourceLabel;
    this.layers = layers;
    this.getLayerVisibility = getLayerVisibility;
    this.resolveRenderPick = resolveRenderPick;
    this.grid = new ReviewSpatialGrid(this.records);
  }

  find(
    point,
    camera,
    {
      width = camera.width,
      height = camera.height,
      tolerancePixels = DEFAULT_TOLERANCE_PIXELS,
      snapKinds = ["entity"],
    } = {},
  ) {
    if (!snapKinds.includes("entity")) {
      return null;
    }
    const pixelsPerWorldX = Math.max(width, 1) / camera.worldWidth;
    const pixelsPerWorldY = Math.max(height, 1) / camera.worldHeight;
    const toleranceX = tolerancePixels / pixelsPerWorldX;
    const toleranceY = tolerancePixels / pixelsPerWorldY;
    const layerVisibility = this.getLayerVisibility();
    refreshInstanceVisibility(
      this.data.instanceGraph,
      layerVisibility,
    );
    let best = null;
    for (const recordIndex of this.grid.query([
      point[0] - toleranceX,
      point[1] - toleranceY,
      point[0] + toleranceX,
      point[1] + toleranceY,
    ])) {
      const record = this.records[recordIndex];
      if (
        !instanceIsVisible(record.instances, record.instanceIndex) ||
        (record.layerIndex < layerVisibility.length &&
          !layerVisibility[record.layerIndex]) ||
        !pointInsideClipChain(
          this.data.clipNodes,
          record.clipId,
          point,
        )
      ) {
        continue;
      }
      const renderPick = this.resolveRenderPick({
        origin: "base",
        sceneId: this.sourceId,
        handle: record.handle,
        ownerHandle: record.ownerHandle,
      });
      if (!renderPick) {
        continue;
      }
      const boundary = nearestBoundary(
        this.data,
        record,
        point,
        pixelsPerWorldX,
        pixelsPerWorldY,
      );
      const inside = insideRecord(this.data, record, point);
      if (
        !inside &&
        (!boundary || boundary.distancePixels > tolerancePixels)
      ) {
        continue;
      }
      const distancePixels = inside ? 0 : boundary.distancePixels;
      if (best && best.distancePixels <= distancePixels) {
        continue;
      }
      const displayPolygons = [];
      const measurementPolygons = [];
      const displayFillPolygons = [];
      for (
        let ringOffset = 0;
        ringOffset < record.ringCount;
        ringOffset += 1
      ) {
        const ringIndex = record.firstRing + ringOffset;
        const display = Object.freeze(
          ringPoints(this.data, ringIndex, this.data.displayPoints).map(
            (value) => Object.freeze(value),
          ),
        );
        displayPolygons.push(display);
        measurementPolygons.push(
          Object.freeze(
            ringPoints(
              this.data,
              ringIndex,
              this.data.measurementPoints,
            ).map((value) => Object.freeze(value)),
          ),
        );
        if (fillRingIncluded(record, this.data.ringDepths[ringIndex])) {
          displayFillPolygons.push(display);
        }
      }
      const displayPoint = inside
        ? Object.freeze([point[0], point[1], displayPolygons[0]?.[0]?.[2] ?? 0])
        : Object.freeze(boundary.displayPoint);
      const measurementPoint = inside
        ? measurementPolygons[0]?.[0] ?? Object.freeze([...point])
        : Object.freeze(boundary.measurementPoint);
      const displaySegments =
        record.kind === "face"
          ? Object.freeze(
              displayPolygons[0]
                .map((first, edge) =>
                  record.invisibleEdges & (1 << edge)
                    ? null
                    : Object.freeze([
                        first,
                        displayPolygons[0][
                          (edge + 1) % displayPolygons[0].length
                        ],
                      ]),
                )
                .filter(Boolean),
            )
          : null;
      best = Object.freeze({
        kind: "entity",
        entityType: record.kind,
        entityRecord: Object.freeze({ ...record }),
        sourceKind: null,
        sourceKindName: kindName(record.kind),
        handle: record.handle,
        layerIndex: record.layerIndex,
        layerName: this.layers[record.layerIndex]?.name ?? "",
        color: record.color,
        lineWeight: record.lineWeight,
        linetypeCode: record.linetypeCode,
        coordinateSpace: record.coordinateSpace,
        displayPoint,
        measurementPoint,
        displayPolygon:
          record.kind === "face" ? null : displayPolygons[0] ?? null,
        displayPolygons:
          record.kind === "face"
            ? Object.freeze([])
            : Object.freeze(displayPolygons),
        displaySegments,
        displayFillPolygons: Object.freeze(displayFillPolygons),
        measurementPolygons: Object.freeze(measurementPolygons),
        objectMeasurement: Object.freeze({ ...record.objectMeasurement }),
        distancePixels,
        approximated: Boolean(record.approximated),
        sourceId: this.sourceId,
        sourceLabel: this.sourceLabel,
        ...renderPickMetadata(renderPick),
      });
    }
    return best;
  }

  snapshot() {
    return Object.freeze({
      records: this.records.length,
      rings: this.data?.ringStarts?.length ?? 0,
      vertices: (this.data?.displayPoints?.length ?? 0) / 3,
      truncated: Boolean(this.data?.truncated),
    });
  }
}

export class CompositeFilledObjectSelectionIndex {
  constructor(
    sources,
    {
      getLayerVisibility = () => [],
      resolveRenderPick = () => true,
      truncated = false,
      failedSources = 0,
    } = {},
  ) {
    this.indexes = Object.freeze(
      (Array.isArray(sources) ? sources : [])
        .filter((source) => source?.data)
        .map(
          (source) =>
            new FilledObjectSelectionIndex(source.data, {
              sourceId: source.id,
              sourceLabel: source.label,
              layers: source.layers,
              getLayerVisibility,
              resolveRenderPick,
            }),
        ),
    );
    this.truncated = Boolean(truncated);
    this.failedSources = Number.isSafeInteger(failedSources)
      ? Math.max(0, failedSources)
      : 0;
  }

  find(point, camera, options = {}) {
    let best = null;
    for (const index of this.indexes) {
      const candidate = index.find(point, camera, options);
      if (
        candidate &&
        (!best || candidate.distancePixels < best.distancePixels)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  snapshot() {
    const snapshots = this.indexes.map((index) => index.snapshot());
    return Object.freeze({
      sources: this.indexes.length,
      failedSources: this.failedSources,
      records: snapshots.reduce(
        (total, snapshot) => total + snapshot.records,
        0,
      ),
      rings: snapshots.reduce(
        (total, snapshot) => total + snapshot.rings,
        0,
      ),
      vertices: snapshots.reduce(
        (total, snapshot) => total + snapshot.vertices,
        0,
      ),
      truncated:
        this.truncated ||
        snapshots.some((snapshot) => snapshot.truncated),
    });
  }
}

export function filledObjectReviewTransferables(data) {
  return [
    data.displayPoints.buffer,
    data.measurementPoints.buffer,
    data.ringStarts.buffer,
    data.ringCounts.buffer,
    data.ringDepths.buffer,
  ];
}
