import { transformedBounds2D, transformPoint } from "./math.mjs";
import { GpuLineBatchKind } from "./scene-cache.mjs?v=1.19.0";
import { CAD_LINE_WEIGHTS } from "./cad-line-style.mjs";

const MATRIX_VALUES = 16;
const DEFAULT_TOLERANCE_PIXELS = 18;
const MAX_GRID_AXIS = 128;
const MAX_CELLS_PER_ITEM = 256;
const MAX_OCCURRENCES = 350_000;
const MAX_SEGMENT_CANDIDATES = 12_000;
const MAX_INTERSECTION_SEGMENTS = 64;
const MAX_POINT_SNAP_OCCURRENCES = 100_000;
const NO_LAYER_OVERRIDE = 0xffffffff;

const IDENTITY_INSTANCES = Object.freeze({
  data: new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]),
  measurementData: new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]),
  coordinateSpaceIds: new Uint8Array([1]),
  clipIds: new Uint32Array([0]),
  layerIndices: new Uint32Array([NO_LAYER_OVERRIDE]),
  visibilityRows: new Uint32Array([0]),
  handles: new BigUint64Array([0n]),
  count: 1,
  length: 1,
});

const SOURCE_KIND_NAMES = Object.freeze([
  "선",
  "경량 폴리선",
  "2D 폴리선",
  "3D 폴리선",
  "호",
  "원",
  "타원",
  "스플라인",
  "해치 경계",
  "구성선",
  "다중지시선",
  "뷰포트 경계",
  "지시선",
  "OLE 경계",
]);

function finiteBounds(bounds) {
  return (
    bounds?.min?.length >= 2 &&
    bounds?.max?.length >= 2 &&
    bounds.min.slice(0, 2).every(Number.isFinite) &&
    bounds.max.slice(0, 2).every(Number.isFinite) &&
    bounds.min[0] <= bounds.max[0] &&
    bounds.min[1] <= bounds.max[1]
  );
}

function instancesForBatch(batch, instanceGraph) {
  if (batch.kind !== GpuLineBatchKind.BlockDefinition) {
    return instanceGraph.modelInstances ?? IDENTITY_INSTANCES;
  }
  return (
    instanceGraph.instancesByBlock?.get(batch.blockIndex) ??
    IDENTITY_INSTANCES
  );
}

function selectedInstanceIndices(source, instances) {
  const selected = source.instanceIndices;
  if (
    !selected ||
    typeof selected.length !== "number" ||
    selected.length > instances.count
  ) {
    return null;
  }
  return selected;
}

function gridAxis(itemCount) {
  return Math.min(
    MAX_GRID_AXIS,
    Math.max(8, Math.ceil(Math.sqrt(Math.max(itemCount, 1) / 4))),
  );
}

function gridCellRange(bounds, gridBounds, columns, rows) {
  const width = Math.max(
    gridBounds.max[0] - gridBounds.min[0],
    Number.EPSILON,
  );
  const height = Math.max(
    gridBounds.max[1] - gridBounds.min[1],
    Number.EPSILON,
  );
  const cellX = (value) =>
    Math.min(
      columns - 1,
      Math.max(
        0,
        Math.floor(((value - gridBounds.min[0]) / width) * columns),
      ),
    );
  const cellY = (value) =>
    Math.min(
      rows - 1,
      Math.max(
        0,
        Math.floor(((value - gridBounds.min[1]) / height) * rows),
      ),
    );
  return [
    cellX(bounds.min[0]),
    cellY(bounds.min[1]),
    cellX(bounds.max[0]),
    cellY(bounds.max[1]),
  ];
}

class SpatialGrid {
  constructor(bounds, itemCount) {
    this.bounds = bounds;
    this.columns = gridAxis(itemCount);
    this.rows = this.columns;
    this.cells = new Map();
    this.global = [];
    this.stamps = new Uint32Array(itemCount);
    this.revision = 0;
  }

  add(index, bounds) {
    if (!finiteBounds(bounds)) {
      return;
    }
    const [firstX, firstY, lastX, lastY] = gridCellRange(
      bounds,
      this.bounds,
      this.columns,
      this.rows,
    );
    const cells = (lastX - firstX + 1) * (lastY - firstY + 1);
    if (cells > MAX_CELLS_PER_ITEM) {
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

  query(bounds, maximum = Infinity) {
    this.revision += 1;
    if (this.revision === 0xffffffff) {
      this.stamps.fill(0);
      this.revision = 1;
    }
    const output = [];
    const add = (index) => {
      if (
        output.length >= maximum ||
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
      bounds.max[0] < this.bounds.min[0] ||
      bounds.min[0] > this.bounds.max[0] ||
      bounds.max[1] < this.bounds.min[1] ||
      bounds.min[1] > this.bounds.max[1]
    ) {
      return output;
    }
    const [firstX, firstY, lastX, lastY] = gridCellRange(
      bounds,
      this.bounds,
      this.columns,
      this.rows,
    );
    for (let y = firstY; y <= lastY && output.length < maximum; y += 1) {
      for (
        let x = firstX;
        x <= lastX && output.length < maximum;
        x += 1
      ) {
        for (const index of this.cells.get(y * this.columns + x) ?? []) {
          add(index);
        }
      }
    }
    return output;
  }
}

function readVertex(view, byteOffset, origin, target) {
  target[0] = origin[0] + view.getFloat32(byteOffset, true);
  target[1] = origin[1] + view.getFloat32(byteOffset + 4, true);
  target[2] = origin[2] + view.getFloat32(byteOffset + 8, true);
  return target;
}

function handleAt(view, byteOffset) {
  return (
    BigInt(view.getUint32(byteOffset + 20, true)) |
    (BigInt(view.getUint32(byteOffset + 24, true)) << 32n)
  );
}

class BatchSegmentIndex {
  constructor(batch, vertices) {
    this.batch = batch;
    this.vertices = vertices;
    this.view = new DataView(vertices.buffer);
    this.recordSize = vertices.recordSize;
    this.segmentCount = Math.floor(batch.vertexCount / 2);
    this.grid = new SpatialGrid(batch.bounds, this.segmentCount);
    this.handleRanges = new Map();
    const first = [0, 0, 0];
    const last = [0, 0, 0];
    let previousHandle = null;
    let activeRange = null;
    for (let segment = 0; segment < this.segmentCount; segment += 1) {
      const vertex = batch.firstVertex + segment * 2;
      const firstOffset = vertex * this.recordSize;
      const lastOffset = firstOffset + this.recordSize;
      readVertex(this.view, firstOffset, batch.origin, first);
      readVertex(this.view, lastOffset, batch.origin, last);
      const handle = handleAt(this.view, firstOffset);
      if (handle !== previousHandle) {
        activeRange = { first: segment, count: 0 };
        let ranges = this.handleRanges.get(handle);
        if (!ranges) {
          ranges = [];
          this.handleRanges.set(handle, ranges);
        }
        ranges.push(activeRange);
        previousHandle = handle;
      }
      activeRange.count += 1;
      this.grid.add(segment, {
        min: [
          Math.min(first[0], last[0]),
          Math.min(first[1], last[1]),
        ],
        max: [
          Math.max(first[0], last[0]),
          Math.max(first[1], last[1]),
        ],
      });
    }
  }

  query(point, tolerance) {
    return this.grid.query(
      {
        min: [point[0] - tolerance, point[1] - tolerance],
        max: [point[0] + tolerance, point[1] + tolerance],
      },
      MAX_SEGMENT_CANDIDATES,
    );
  }

  read(segment, first, last) {
    const vertex = this.batch.firstVertex + segment * 2;
    const firstOffset = vertex * this.recordSize;
    const lastOffset = firstOffset + this.recordSize;
    readVertex(this.view, firstOffset, this.batch.origin, first);
    readVertex(this.view, lastOffset, this.batch.origin, last);
    const style = this.view.getUint32(firstOffset + 28, true);
    const handle = handleAt(this.view, firstOffset);
    const sourceKind =
      this.recordSize >= 36 ? (style >>> 17) & 0xf : null;
    let firstEndpoint = true;
    let lastEndpoint = true;
    if (sourceKind !== null && sourceKind >= 4 && sourceKind <= 7) {
      firstEndpoint =
        sourceKind !== 5 &&
        (segment === 0 ||
          handleAt(
            this.view,
            firstOffset - this.recordSize * 2,
          ) !== handle);
      lastEndpoint =
        sourceKind !== 5 &&
        (segment === this.segmentCount - 1 ||
          handleAt(
            this.view,
            lastOffset + this.recordSize,
          ) !== handle);
    }
    return {
      layerIndex: this.view.getUint32(firstOffset + 12, true),
      color: this.view.getUint32(firstOffset + 16, true),
      handle,
      style,
      lineWeight: CAD_LINE_WEIGHTS[style & 0x1f] ?? -1,
      linetypeCode: (style >>> 5) & 0x7ff,
      sourceKind,
      approximated: this.recordSize >= 36 && (style & (1 << 21)) !== 0,
      firstEndpoint,
      lastEndpoint,
    };
  }

  rangesForHandle(handle) {
    return this.handleRanges.get(handle) ?? [];
  }
}

function invertAffine2D(matrix, offset = 0) {
  const a = matrix[offset];
  const b = matrix[offset + 1];
  const c = matrix[offset + 4];
  const d = matrix[offset + 5];
  const tx = matrix[offset + 12];
  const ty = matrix[offset + 13];
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) {
    return null;
  }
  const inverse = 1 / determinant;
  return Object.freeze({
    a: d * inverse,
    b: -b * inverse,
    c: -c * inverse,
    d: a * inverse,
    tx: (c * ty - d * tx) * inverse,
    ty: (b * tx - a * ty) * inverse,
  });
}

function inversePoint(matrix, point) {
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.tx,
    matrix.b * point[0] + matrix.d * point[1] + matrix.ty,
  ];
}

function inverseTolerance(matrix, toleranceX, toleranceY) {
  return Math.max(
    Math.hypot(matrix.a * toleranceX, matrix.b * toleranceX),
    Math.hypot(matrix.c * toleranceY, matrix.d * toleranceY),
  );
}

function pointOnSegment(point, first, last, epsilon = 1e-9) {
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const cross = (point[0] - first[0]) * dy - (point[1] - first[1]) * dx;
  if (Math.abs(cross) > epsilon * Math.max(1, Math.abs(dx), Math.abs(dy))) {
    return false;
  }
  const dot =
    (point[0] - first[0]) * (point[0] - last[0]) +
    (point[1] - first[1]) * (point[1] - last[1]);
  return dot <= epsilon;
}

function pointInsidePolygon(point, vertices) {
  let inside = false;
  let previous = vertices.at(-1);
  for (const current of vertices) {
    if (pointOnSegment(point, previous, current)) {
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

export function pointInsideClipChain(instanceGraph, clipId, point) {
  let current = clipId;
  let depth = 0;
  while (current > 0 && depth < 64) {
    const node = instanceGraph.clipNodes?.[current - 1];
    if (!node || node.id !== current) {
      return false;
    }
    const inside =
      node.points.length >= 3 && pointInsidePolygon(point, node.points);
    if ((!node.inverted && !inside) || (node.inverted && inside)) {
      return false;
    }
    current = node.parentId;
    depth += 1;
  }
  return current === 0;
}

export function screenToWorld(camera, x, y, width, height) {
  return [
    camera.origin[0] + (x / Math.max(width, 1) - 0.5) * camera.worldWidth,
    camera.origin[1] + (0.5 - y / Math.max(height, 1)) * camera.worldHeight,
    camera.origin[2] ?? 0,
  ];
}

export function worldToScreen(camera, point, width, height) {
  return [
    ((point[0] - camera.origin[0]) / camera.worldWidth + 0.5) * width,
    (0.5 - (point[1] - camera.origin[1]) / camera.worldHeight) * height,
  ];
}

function nearestPoint(first, last, point) {
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared <= Number.EPSILON
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            ((point[0] - first[0]) * dx +
              (point[1] - first[1]) * dy) /
              lengthSquared,
          ),
        );
  return {
    point: [
      first[0] + dx * t,
      first[1] + dy * t,
      first[2] + (last[2] - first[2]) * t,
    ],
    t,
  };
}

function interpolate(first, last, t) {
  return [
    first[0] + (last[0] - first[0]) * t,
    first[1] + (last[1] - first[1]) * t,
    first[2] + (last[2] - first[2]) * t,
  ];
}

function segmentIntersection(first, last, otherFirst, otherLast) {
  const firstX = last[0] - first[0];
  const firstY = last[1] - first[1];
  const otherX = otherLast[0] - otherFirst[0];
  const otherY = otherLast[1] - otherFirst[1];
  const denominator = firstX * otherY - firstY * otherX;
  const scale = Math.max(
    1,
    Math.abs(firstX),
    Math.abs(firstY),
    Math.abs(otherX),
    Math.abs(otherY),
  );
  if (Math.abs(denominator) <= scale * scale * 1e-12) {
    return null;
  }
  const offsetX = otherFirst[0] - first[0];
  const offsetY = otherFirst[1] - first[1];
  const firstParameter =
    (offsetX * otherY - offsetY * otherX) / denominator;
  const otherParameter =
    (offsetX * firstY - offsetY * firstX) / denominator;
  const epsilon = 1e-10;
  if (
    firstParameter < -epsilon ||
    firstParameter > 1 + epsilon ||
    otherParameter < -epsilon ||
    otherParameter > 1 + epsilon
  ) {
    return null;
  }
  return {
    point: interpolate(
      first,
      last,
      Math.max(0, Math.min(1, firstParameter)),
    ),
    firstParameter: Math.max(0, Math.min(1, firstParameter)),
    otherParameter: Math.max(0, Math.min(1, otherParameter)),
  };
}

function cross3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize3(vector) {
  const length = Math.hypot(...vector);
  return Number.isFinite(length) && length > 1e-12
    ? vector.map((value) => value / length)
    : null;
}

function scale3(vector, scale) {
  return vector.map((value) => value * scale);
}

function addScaled3(center, major, majorScale, minor, minorScale) {
  return [
    center[0] + major[0] * majorScale + minor[0] * minorScale,
    center[1] + major[1] * majorScale + minor[1] * minorScale,
    center[2] + major[2] * majorScale + minor[2] * minorScale,
  ];
}

function normalizedSweep(start, end) {
  const full = Math.PI * 2;
  const raw = end - start;
  if (!Number.isFinite(raw)) {
    return null;
  }
  if (Math.abs(raw) >= full - 1e-10) {
    return full;
  }
  const sweep = ((raw % full) + full) % full;
  return sweep > 1e-10 ? sweep : null;
}

function exactCurveBasis(curve) {
  const sweep = normalizedSweep(
    curve.startParameter,
    curve.endParameter,
  );
  if (!sweep) {
    return null;
  }
  if (curve.kind === "ellipse") {
    const normal = normalize3(curve.normal);
    const majorLength = Math.hypot(...curve.majorAxis);
    const minorDirection = normal
      ? normalize3(cross3(normal, curve.majorAxis))
      : null;
    if (!minorDirection || !Number.isFinite(majorLength)) {
      return null;
    }
    return {
      center: curve.center,
      major: curve.majorAxis,
      minor: scale3(
        minorDirection,
        majorLength * Math.abs(curve.minorAxisRatio),
      ),
      start: curve.startParameter,
      sweep,
      closed: sweep >= Math.PI * 2 - 1e-10,
    };
  }
  const normal = normalize3(curve.normal);
  if (!normal) {
    return null;
  }
  const reference =
    Math.abs(normal[0]) < 1 / 64 && Math.abs(normal[1]) < 1 / 64
      ? [0, 1, 0]
      : [0, 0, 1];
  const xAxis = normalize3(cross3(reference, normal));
  const yAxis = xAxis ? normalize3(cross3(normal, xAxis)) : null;
  if (!xAxis || !yAxis) {
    return null;
  }
  return {
    center: addScaled3(
      [0, 0, 0],
      xAxis,
      curve.center[0],
      yAxis,
      curve.center[1],
    ).map(
      (value, axis) => value + normal[axis] * curve.center[2],
    ),
    major: scale3(xAxis, curve.radius),
    minor: scale3(yAxis, curve.radius),
    start: curve.startParameter,
    sweep,
    closed: curve.kind === "circle" || sweep >= Math.PI * 2 - 1e-10,
  };
}

function curvePoint(basis, parameter) {
  return addScaled3(
    basis.center,
    basis.major,
    Math.cos(parameter),
    basis.minor,
    Math.sin(parameter),
  );
}

function parameterInsideSweep(basis, parameter) {
  if (basis.closed) {
    return true;
  }
  const full = Math.PI * 2;
  const relative =
    ((parameter - basis.start) % full + full) % full;
  return relative <= basis.sweep + 1e-10;
}

function nearestCurveParameter(
  basis,
  point,
  displayMatrix,
  matrixOffset,
) {
  const displayCenter = transformPoint(
    displayMatrix,
    basis.center,
    matrixOffset,
  );
  const displayMajorPoint = transformPoint(
    displayMatrix,
    addScaled3(basis.center, basis.major, 1, basis.minor, 0),
    matrixOffset,
  );
  const displayMinorPoint = transformPoint(
    displayMatrix,
    addScaled3(basis.center, basis.major, 0, basis.minor, 1),
    matrixOffset,
  );
  const major = [
    displayMajorPoint[0] - displayCenter[0],
    displayMajorPoint[1] - displayCenter[1],
  ];
  const minor = [
    displayMinorPoint[0] - displayCenter[0],
    displayMinorPoint[1] - displayCenter[1],
  ];
  const distanceSquared = (parameter) => {
    const dx =
      displayCenter[0] +
      major[0] * Math.cos(parameter) +
      minor[0] * Math.sin(parameter) -
      point[0];
    const dy =
      displayCenter[1] +
      major[1] * Math.cos(parameter) +
      minor[1] * Math.sin(parameter) -
      point[1];
    return dx * dx + dy * dy;
  };
  const samples = 32;
  const step = basis.sweep / samples;
  let bestParameter = basis.start;
  let bestDistance = distanceSquared(bestParameter);
  let bestSample = 0;
  for (let sample = 1; sample <= samples; sample += 1) {
    const parameter = basis.start + step * sample;
    const distance = distanceSquared(parameter);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestParameter = parameter;
      bestSample = sample;
    }
  }
  let left =
    basis.start + step * Math.max(bestSample - 1, 0);
  let right =
    basis.start + step * Math.min(bestSample + 1, samples);
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const first = left + (right - left) / 3;
    const second = right - (right - left) / 3;
    if (distanceSquared(first) <= distanceSquared(second)) {
      right = second;
    } else {
      left = first;
    }
  }
  const refined = (left + right) * 0.5;
  return distanceSquared(refined) < bestDistance
    ? refined
    : bestParameter;
}

function exactCurveChoices(
  curve,
  point,
  displayMatrix,
  measurementMatrix,
  matrixOffset,
  enabledKinds,
  referencePoint = null,
) {
  const basis = exactCurveBasis(curve);
  if (!basis) {
    return null;
  }
  const choices = [];
  const add = (kind, parameter) => {
    const localPoint = curvePoint(basis, parameter);
    choices.push({
      kind,
      displayPoint: transformPoint(
        displayMatrix,
        localPoint,
        matrixOffset,
      ),
      measurementPoint: transformPoint(
        measurementMatrix,
        localPoint,
        matrixOffset,
      ),
      exact: true,
    });
  };
  if (enabledKinds.has("nearest")) {
    add(
      "nearest",
      nearestCurveParameter(
        basis,
        point,
        displayMatrix,
        matrixOffset,
      ),
    );
  }
  if (enabledKinds.has("midpoint") && !basis.closed) {
    add("midpoint", basis.start + basis.sweep * 0.5);
  }
  if (enabledKinds.has("endpoint") && !basis.closed) {
    add("endpoint", basis.start);
    add("endpoint", basis.start + basis.sweep);
  }
  if (enabledKinds.has("quadrant")) {
    for (const parameter of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      if (parameterInsideSweep(basis, parameter)) {
        add("quadrant", parameter);
      }
    }
  }
  if (
    enabledKinds.has("perpendicular") &&
    Array.isArray(referencePoint) &&
    referencePoint.length >= 2
  ) {
    add(
      "perpendicular",
      nearestCurveParameter(
        basis,
        referencePoint,
        displayMatrix,
        matrixOffset,
      ),
    );
  }
  return choices;
}

function measuredCurveLength(basis, measurementMatrix, matrixOffset) {
  const steps = Math.min(
    256,
    Math.max(24, Math.ceil((basis.sweep / (Math.PI * 2)) * 128)),
  );
  let previous = transformPoint(
    measurementMatrix,
    curvePoint(basis, basis.start),
    matrixOffset,
  );
  let length = 0;
  for (let index = 1; index <= steps; index += 1) {
    const current = transformPoint(
      measurementMatrix,
      curvePoint(
        basis,
        basis.start + (basis.sweep * index) / steps,
      ),
      matrixOffset,
    );
    length += Math.hypot(
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    );
    previous = current;
  }
  return length;
}

function exactCurveMeasurement(
  curve,
  displayMatrix,
  measurementMatrix,
  matrixOffset,
) {
  const basis = exactCurveBasis(curve);
  if (!basis) {
    return null;
  }
  const localMajor = addScaled3(
    basis.center,
    basis.major,
    1,
    basis.minor,
    0,
  );
  const localMinor = addScaled3(
    basis.center,
    basis.major,
    0,
    basis.minor,
    1,
  );
  const measurementCenter = transformPoint(
    measurementMatrix,
    basis.center,
    matrixOffset,
  );
  const measurementMajor = transformPoint(
    measurementMatrix,
    localMajor,
    matrixOffset,
  );
  const measurementMinor = transformPoint(
    measurementMatrix,
    localMinor,
    matrixOffset,
  );
  const majorRadius = Math.hypot(
    measurementMajor[0] - measurementCenter[0],
    measurementMajor[1] - measurementCenter[1],
    measurementMajor[2] - measurementCenter[2],
  );
  const minorRadius = Math.hypot(
    measurementMinor[0] - measurementCenter[0],
    measurementMinor[1] - measurementCenter[1],
    measurementMinor[2] - measurementCenter[2],
  );
  if (
    !Number.isFinite(majorRadius) ||
    !Number.isFinite(minorRadius) ||
    majorRadius <= 0 ||
    minorRadius <= 0
  ) {
    return null;
  }
  const circular =
    Math.abs(majorRadius - minorRadius) <=
    Math.max(majorRadius, minorRadius, 1) * 1e-9;
  const length = circular
    ? majorRadius * basis.sweep
    : measuredCurveLength(basis, measurementMatrix, matrixOffset);
  return Object.freeze({
    kind: curve.kind,
    displayCenter: Object.freeze(
      transformPoint(displayMatrix, basis.center, matrixOffset),
    ),
    measurementCenter: Object.freeze(measurementCenter),
    majorRadius,
    minorRadius,
    sweepRadians: basis.sweep,
    closed: basis.closed,
    length,
    area: basis.closed ? Math.PI * majorRadius * minorRadius : null,
  });
}

function pixelDistance(camera, left, right, width, height) {
  return Math.hypot(
    ((left[0] - right[0]) * width) / camera.worldWidth,
    ((left[1] - right[1]) * height) / camera.worldHeight,
  );
}

function resolvedLayerIndex(
  sourceLayer,
  instances,
  index,
  layerZeroIndex,
  instanceStyle = null,
) {
  const override =
    instanceStyle?.layerIndex ??
    instances.layerIndices?.[index] ??
    NO_LAYER_OVERRIDE;
  return sourceLayer === layerZeroIndex && override !== NO_LAYER_OVERRIDE
    ? override
    : sourceLayer;
}

function mappedSourceLayer(source, layerIndex) {
  if (
    layerIndex === NO_LAYER_OVERRIDE ||
    !(source.layerMap instanceof Uint32Array)
  ) {
    return layerIndex;
  }
  return layerIndex < source.layerMap.length
    ? source.layerMap[layerIndex]
    : source.layerMap[0];
}

function instancesForOwner(source, ownerHandle) {
  const blockIndex = source.blockIndexByHandle?.get(ownerHandle);
  if (
    blockIndex === undefined ||
    source.instanceGraph.modelBlockIndices?.has(blockIndex)
  ) {
    return source.instanceGraph.rootInstances ??
      source.instanceGraph.modelInstances ??
      IDENTITY_INSTANCES;
  }
  return (
    source.instanceGraph.instancesByBlock?.get(blockIndex) ??
    Object.freeze({ data: new Float64Array(0), count: 0 })
  );
}

function layerIsVisible(
  layerIndex,
  instances,
  instanceIndex,
  instanceGraph,
  layerVisibility,
) {
  if (layerIndex < layerVisibility.length && !layerVisibility[layerIndex]) {
    return false;
  }
  const rowIndex = instances.visibilityRows?.[instanceIndex] ?? 0;
  const row = instanceGraph.layerVisibilityRows?.[rowIndex];
  return !row || layerIndex >= row.length || row[layerIndex] !== 0;
}

function occurrenceBounds(batch, instances, instanceIndex) {
  const packed = transformedBounds2D(
    batch.bounds,
    instances.data,
    instanceIndex * MATRIX_VALUES,
  );
  return {
    min: [packed[0], packed[1]],
    max: [packed[2], packed[3]],
  };
}

function boundsInclude(target, source) {
  target.min[0] = Math.min(target.min[0], source.min[0]);
  target.min[1] = Math.min(target.min[1], source.min[1]);
  target.max[0] = Math.max(target.max[0], source.max[0]);
  target.max[1] = Math.max(target.max[1], source.max[1]);
}

function pointBounds(point) {
  return {
    min: [point[0], point[1]],
    max: [point[0], point[1]],
  };
}

function pointGrid(records) {
  const bounds = {
    min: [Infinity, Infinity],
    max: [-Infinity, -Infinity],
  };
  for (const record of records) {
    boundsInclude(bounds, pointBounds(record.displayPoint));
  }
  if (!finiteBounds(bounds)) {
    bounds.min = [0, 0];
    bounds.max = [1, 1];
  }
  const grid = new SpatialGrid(bounds, records.length);
  records.forEach((record, index) =>
    grid.add(index, pointBounds(record.displayPoint)),
  );
  return grid;
}

function blockKindName(block) {
  const name = String(block?.name ?? "").toUpperCase();
  if (block?.flags & (1 << 2)) {
    return "외부 참조";
  }
  if (/^\*D/u.test(name)) {
    return "치수";
  }
  return "블록 참조";
}

function matrixProperties(matrix, offset) {
  return Object.freeze({
    scale: Object.freeze([
      Math.hypot(
        matrix[offset],
        matrix[offset + 1],
        matrix[offset + 2],
      ),
      Math.hypot(
        matrix[offset + 4],
        matrix[offset + 5],
        matrix[offset + 6],
      ),
      Math.hypot(
        matrix[offset + 8],
        matrix[offset + 9],
        matrix[offset + 10],
      ),
    ]),
    rotation:
      Math.atan2(matrix[offset + 1], matrix[offset]) * (180 / Math.PI),
  });
}

function candidateRank(kind) {
  return {
    endpoint: 0,
    intersection: 1,
    midpoint: 2,
    center: 3,
    quadrant: 4,
    perpendicular: 5,
    insertion: 6,
    nearest: 7,
  }[kind] ?? 8;
}

function betterSnapCandidate(current, candidate) {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  const currentRank = candidateRank(current.kind);
  const nextRank = candidateRank(candidate.kind);
  return nextRank < currentRank ||
    (nextRank === currentRank &&
      candidate.distancePixels < current.distancePixels)
    ? candidate
    : current;
}

function renderPickMetadata(resolved) {
  return resolved && resolved !== true &&
    typeof resolved === "object" &&
    !Array.isArray(resolved)
    ? { renderPick: resolved }
    : {};
}

function relatedRenderPickMetadata(resolved) {
  return resolved && resolved !== true &&
    typeof resolved === "object" &&
    !Array.isArray(resolved)
    ? { relatedRenderPick: resolved }
    : {};
}

export class OverviewSnapIndex {
  constructor(
    sources,
    {
      layerZeroIndex = -1,
      getLayerVisibility = () => [],
      resolveRenderPick = () => true,
      maximumOccurrences = MAX_OCCURRENCES,
    } = {},
  ) {
    if (typeof resolveRenderPick !== "function") {
      throw new TypeError(
        "overview snap render pick resolver must be a function",
      );
    }
    this.sources = [...sources].map((source) =>
      Object.freeze({
        ...source,
        blockIndexByHandle: new Map(
          (source.blocks ?? []).map((block) => [
            block.handle,
            block.index,
          ]),
        ),
      }),
    );
    this.layerZeroIndex = layerZeroIndex;
    this.getLayerVisibility = getLayerVisibility;
    this.resolveRenderPick = resolveRenderPick;
    this.maximumOccurrences = maximumOccurrences;
    this.batches = [];
    this.insertions = [];
    this.curveCenters = [];
    this.curveRecordCount = -1;
    this.objectMeasurementCache = new WeakMap();
    this.occurrenceCount = 0;
    this.truncated = false;
    this.build();
  }

  objectMeasurement(
    source,
    handle,
    instances,
    instanceIndex,
    sourceKind,
  ) {
    if (
      source.wholeObjectMeasurements === false ||
      typeof handle !== "bigint" ||
      sourceKind === null ||
      sourceKind < 0 ||
      sourceKind > 3
    ) {
      return null;
    }
    let cache = this.objectMeasurementCache.get(instances);
    if (!cache) {
      cache = new Map();
      this.objectMeasurementCache.set(instances, cache);
    }
    const key = `${source.id ?? ""}:${instanceIndex}:${sourceKind}:${handle}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    const measurementData = instances.measurementData ?? instances.data;
    const matrixOffset = instanceIndex * MATRIX_VALUES;
    const localFirst = [0, 0, 0];
    const localLast = [0, 0, 0];
    const first = [0, 0, 0];
    const last = [0, 0, 0];
    let firstPoint = null;
    let previousPoint = null;
    let connected = true;
    let segmentCount = 0;
    let length = 0;
    let newellX = 0;
    let newellY = 0;
    let newellZ = 0;
    let approximated = false;
    const near = (left, right) => {
      const scale = Math.max(
        1,
        ...left.map(Math.abs),
        ...right.map(Math.abs),
      );
      return (
        Math.hypot(
          left[0] - right[0],
          left[1] - right[1],
          left[2] - right[2],
        ) <=
        scale * 1e-8
      );
    };
    for (const indexed of this.batches) {
      if (
        indexed.source !== source ||
        instancesForBatch(
          indexed.batch,
          indexed.source.instanceGraph,
        ) !== instances
      ) {
        continue;
      }
      for (const range of indexed.segmentIndex.rangesForHandle(handle)) {
        for (
          let segment = range.first;
          segment < range.first + range.count;
          segment += 1
        ) {
          const details = indexed.segmentIndex.read(
            segment,
            localFirst,
            localLast,
          );
          if (
            details.sourceKind !== sourceKind ||
            (details.style & (1 << 16)) !== 0
          ) {
            continue;
          }
          transformPoint(
            measurementData,
            localFirst,
            matrixOffset,
            first,
          );
          transformPoint(
            measurementData,
            localLast,
            matrixOffset,
            last,
          );
          if (
            !first.every(Number.isFinite) ||
            !last.every(Number.isFinite)
          ) {
            continue;
          }
          if (!firstPoint) {
            firstPoint = [...first];
          } else if (previousPoint && !near(previousPoint, first)) {
            connected = false;
          }
          length += Math.hypot(
            last[0] - first[0],
            last[1] - first[1],
            last[2] - first[2],
          );
          newellX +=
            (first[1] - last[1]) * (first[2] + last[2]);
          newellY +=
            (first[2] - last[2]) * (first[0] + last[0]);
          newellZ +=
            (first[0] - last[0]) * (first[1] + last[1]);
          previousPoint = [...last];
          approximated ||= details.approximated;
          segmentCount += 1;
        }
      }
    }
    const closed =
      sourceKind >= 1 &&
      sourceKind <= 3 &&
      segmentCount >= 2 &&
      connected &&
      firstPoint &&
      previousPoint &&
      near(firstPoint, previousPoint);
    const result =
      segmentCount > 0
        ? Object.freeze({
            length,
            area: closed
              ? Math.hypot(newellX, newellY, newellZ) * 0.5
              : null,
            closed: Boolean(closed),
            segments: segmentCount,
            approximated,
          })
        : null;
    if (cache.size >= 2_048) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, result);
    return result;
  }

  build() {
    const worldBounds = {
      min: [Infinity, Infinity],
      max: [-Infinity, -Infinity],
    };
    let requestedOccurrences = 0;
    for (const source of this.sources) {
      const recordSize = source.vertices?.recordSize;
      if (
        !(source.vertices?.buffer instanceof ArrayBuffer) ||
        !Number.isInteger(recordSize) ||
        recordSize < 32
      ) {
        continue;
      }
      for (const batch of source.batches ?? []) {
        if (batch.lodLevel !== 0) {
          continue;
        }
        if (
          batch.firstVertex * recordSize + batch.vertexCount * recordSize >
          source.vertices.buffer.byteLength
        ) {
          continue;
        }
        const batchIndex = this.batches.length;
        const segmentIndex = new BatchSegmentIndex(batch, source.vertices);
        this.batches.push({ source, batch, segmentIndex });
        const instances = instancesForBatch(batch, source.instanceGraph);
        requestedOccurrences +=
          selectedInstanceIndices(source, instances)?.length ??
          instances.count;
      }
    }
    const capacity = Math.min(
      requestedOccurrences,
      this.maximumOccurrences,
    );
    this.truncated = requestedOccurrences > capacity;
    this.occurrenceBatchIndices = new Uint32Array(capacity);
    this.occurrenceInstanceIndices = new Uint32Array(capacity);
    this.occurrenceBounds = new Float64Array(capacity * 4);
    let cursor = 0;
    for (let batchIndex = 0; batchIndex < this.batches.length; batchIndex += 1) {
      const { source, batch } = this.batches[batchIndex];
      const instances = instancesForBatch(batch, source.instanceGraph);
      const selected = selectedInstanceIndices(source, instances);
      const instanceCount = selected?.length ?? instances.count;
      for (
        let selectedIndex = 0;
        selectedIndex < instanceCount && cursor < capacity;
        selectedIndex += 1
      ) {
          const instanceIndex = selected?.[selectedIndex] ?? selectedIndex;
          if (
            !Number.isSafeInteger(instanceIndex) ||
            instanceIndex < 0 ||
            instanceIndex >= instances.count
          ) {
            continue;
          }
          const bounds = occurrenceBounds(batch, instances, instanceIndex);
          if (!finiteBounds(bounds)) {
            continue;
          }
          boundsInclude(worldBounds, bounds);
          this.occurrenceBatchIndices[cursor] = batchIndex;
          this.occurrenceInstanceIndices[cursor] = instanceIndex;
          this.occurrenceBounds.set(
            [
              bounds.min[0],
              bounds.min[1],
              bounds.max[0],
              bounds.max[1],
            ],
            cursor * 4,
          );
          cursor += 1;
      }
      if (cursor >= capacity) {
        break;
      }
    }
    this.occurrenceCount = cursor;
    if (!finiteBounds(worldBounds)) {
      worldBounds.min = [0, 0];
      worldBounds.max = [1, 1];
    }
    this.occurrenceGrid = new SpatialGrid(
      worldBounds,
      this.occurrenceCount,
    );
    for (let index = 0; index < this.occurrenceCount; index += 1) {
      const offset = index * 4;
      this.occurrenceGrid.add(index, {
        min: [
          this.occurrenceBounds[offset],
          this.occurrenceBounds[offset + 1],
        ],
        max: [
          this.occurrenceBounds[offset + 2],
          this.occurrenceBounds[offset + 3],
        ],
      });
    }
    this.buildInsertions();
  }

  buildInsertions() {
    const records = [];
    let requested = 0;
    for (const source of this.sources) {
      if (source.includeInsertions === false) {
        continue;
      }
      for (const [blockIndex, instances] of
        source.instanceGraph.instancesByBlock ?? []) {
        if (
          source.instanceGraph.modelBlockIndices?.has(blockIndex)
        ) {
          continue;
        }
        const block = source.blocks?.[blockIndex];
        if (!block) {
          continue;
        }
        requested += instances.count;
        for (
          let instanceIndex = 0;
          instanceIndex < instances.count &&
          records.length < MAX_POINT_SNAP_OCCURRENCES;
          instanceIndex += 1
        ) {
          const matrixOffset = instanceIndex * MATRIX_VALUES;
          const measurementData =
            instances.measurementData ?? instances.data;
          const displayPoint = transformPoint(
            instances.data,
            block.basePoint,
            matrixOffset,
          );
          const measurementPoint = transformPoint(
            measurementData,
            block.basePoint,
            matrixOffset,
          );
          if (
            !displayPoint.every(Number.isFinite) ||
            !measurementPoint.every(Number.isFinite)
          ) {
            continue;
          }
          const layerIndex =
            instances.layerIndices?.[instanceIndex] ??
            NO_LAYER_OVERRIDE;
          records.push(
            Object.freeze({
              source,
              block,
              instances,
              instanceIndex,
              displayPoint: Object.freeze(displayPoint),
              measurementPoint: Object.freeze(measurementPoint),
              layerIndex,
              handle: instances.handles?.[instanceIndex] ?? 0n,
              coordinateSpace:
                instances.coordinateSpaceIds?.[instanceIndex] ?? 1,
              transform: matrixProperties(
                measurementData,
                matrixOffset,
              ),
            }),
          );
        }
        if (records.length >= MAX_POINT_SNAP_OCCURRENCES) {
          break;
        }
      }
      if (records.length >= MAX_POINT_SNAP_OCCURRENCES) {
        break;
      }
    }
    this.insertions = records;
    this.insertionGrid = pointGrid(records);
    this.truncated ||=
      requested > MAX_POINT_SNAP_OCCURRENCES;
  }

  refreshCurveCenters() {
    const recordCount = this.sources.reduce(
      (total, source) => total + (source.exactCurves?.size ?? 0),
      0,
    );
    if (recordCount === this.curveRecordCount) {
      return;
    }
    this.curveRecordCount = recordCount;
    const records = [];
    let requested = 0;
    for (const source of this.sources) {
      for (const curve of source.exactCurves?.values() ?? []) {
        const basis = exactCurveBasis(curve);
        if (!basis || curve.invisible) {
          continue;
        }
        const instances = instancesForOwner(source, curve.ownerHandle);
        requested += instances.count;
        for (
          let instanceIndex = 0;
          instanceIndex < instances.count &&
          records.length < MAX_POINT_SNAP_OCCURRENCES;
          instanceIndex += 1
        ) {
          const matrixOffset = instanceIndex * MATRIX_VALUES;
          const measurementData =
            instances.measurementData ?? instances.data;
          const displayPoint = transformPoint(
            instances.data,
            basis.center,
            matrixOffset,
          );
          const measurementPoint = transformPoint(
            measurementData,
            basis.center,
            matrixOffset,
          );
          if (
            !displayPoint.every(Number.isFinite) ||
            !measurementPoint.every(Number.isFinite)
          ) {
            continue;
          }
          const sourceLayer = mappedSourceLayer(
            source,
            curve.layerIndex,
          );
          const layerIndex = resolvedLayerIndex(
            sourceLayer,
            instances,
            instanceIndex,
            this.layerZeroIndex,
          );
          records.push(
            Object.freeze({
              source,
              curve,
              instances,
              instanceIndex,
              displayPoint: Object.freeze(displayPoint),
              measurementPoint: Object.freeze(measurementPoint),
              sourceLayer,
              layerIndex,
              coordinateSpace:
                instances.coordinateSpaceIds?.[instanceIndex] ?? 1,
              curveMeasurement: exactCurveMeasurement(
                curve,
                instances.data,
                measurementData,
                matrixOffset,
              ),
            }),
          );
        }
        if (records.length >= MAX_POINT_SNAP_OCCURRENCES) {
          break;
        }
      }
      if (records.length >= MAX_POINT_SNAP_OCCURRENCES) {
        break;
      }
    }
    this.curveCenters = records;
    this.curveCenterGrid = pointGrid(records);
    this.truncated ||=
      requested > MAX_POINT_SNAP_OCCURRENCES;
  }

  find(
    point,
    camera,
    {
      width = camera.width,
      height = camera.height,
      tolerancePixels = DEFAULT_TOLERANCE_PIXELS,
      snapKinds = ["endpoint", "midpoint", "nearest"],
      referencePoint = null,
    } = {},
  ) {
    const toleranceX =
      (camera.worldWidth / Math.max(width, 1)) * tolerancePixels;
    const toleranceY =
      (camera.worldHeight / Math.max(height, 1)) * tolerancePixels;
    const occurrenceIndices = this.occurrenceGrid.query({
      min: [point[0] - toleranceX, point[1] - toleranceY],
      max: [point[0] + toleranceX, point[1] + toleranceY],
    });
    const enabledKinds = new Set(snapKinds);
    const layerVisibility = this.getLayerVisibility();
    const queryBounds = {
      min: [point[0] - toleranceX, point[1] - toleranceY],
      max: [point[0] + toleranceX, point[1] + toleranceY],
    };
    const localFirst = [0, 0, 0];
    const localLast = [0, 0, 0];
    const displayFirst = [0, 0, 0];
    const displayLast = [0, 0, 0];
    const measureFirst = [0, 0, 0];
    const measureLast = [0, 0, 0];
    let best = null;
    const intersectionSegments = [];
    const accept = (candidate) => {
      best = betterSnapCandidate(best, candidate);
    };

    if (enabledKinds.has("insertion")) {
      for (const index of this.insertionGrid.query(queryBounds)) {
        const record = this.insertions[index];
        if (
          !layerIsVisible(
            record.layerIndex,
            record.instances,
            record.instanceIndex,
            record.source.instanceGraph,
            layerVisibility,
          ) ||
          !pointInsideClipChain(
            record.source.instanceGraph,
            record.instances.clipIds?.[record.instanceIndex] ?? 0,
            record.displayPoint,
          )
        ) {
          continue;
        }
        const renderPick = this.resolveRenderPick({
          origin: "base",
          sceneId: record.source.id,
          handle: record.handle,
          blockIndex: record.block.index,
          instances: record.instances,
          instanceIndex: record.instanceIndex,
        });
        if (!renderPick) {
          continue;
        }
        const distancePixels = pixelDistance(
          camera,
          point,
          record.displayPoint,
          width,
          height,
        );
        if (distancePixels > tolerancePixels) {
          continue;
        }
        const sourceKindName = blockKindName(record.block);
        accept(
          Object.freeze({
            kind: "insertion",
            displayPoint: record.displayPoint,
            measurementPoint: record.measurementPoint,
            distancePixels,
            coordinateSpace: record.coordinateSpace,
            handle: record.handle,
            layerIndex: record.layerIndex,
            layerName:
              record.source.layers?.[record.layerIndex]?.name ?? "",
            sourceKind: null,
            sourceKindName,
            entityType:
              sourceKindName === "치수"
                ? "dimension"
                : sourceKindName === "외부 참조"
                  ? "xref"
                  : "block",
            blockName: record.block.name ?? "",
            blockFlags: record.block.flags ?? 0,
            insertionPoint: record.measurementPoint,
            transform: record.transform,
            color:
              record.instances.colors?.[record.instanceIndex] ?? 0,
            lineWeight:
              record.instances.lineWeights?.[record.instanceIndex] ??
              -3,
            linetypeCode:
              record.instances.linetypeCodes?.[record.instanceIndex] ??
              2,
            approximated: false,
            sourceId: record.source.id,
            sourceLabel: record.source.label ?? "",
            ...renderPickMetadata(renderPick),
          }),
        );
      }
    }

    if (enabledKinds.has("center")) {
      this.refreshCurveCenters();
      for (const index of this.curveCenterGrid.query(queryBounds)) {
        const record = this.curveCenters[index];
        if (!record.curveMeasurement) {
          continue;
        }
        const renderPick = this.resolveRenderPick({
          origin: "base",
          sceneId: record.source.id,
          handle: record.curve.handle,
          ownerHandle: record.curve.ownerHandle,
          instances: record.instances,
          instanceIndex: record.instanceIndex,
          sourceLayerIndex: record.sourceLayer,
          layerZeroIndex: this.layerZeroIndex,
        });
        if (!renderPick) {
          continue;
        }
        const layerIndex = resolvedLayerIndex(
          record.sourceLayer,
          record.instances,
          record.instanceIndex,
          this.layerZeroIndex,
          renderPick?.instanceStyle,
        );
        if (
          !layerIsVisible(
            layerIndex,
            record.instances,
            record.instanceIndex,
            record.source.instanceGraph,
            layerVisibility,
          ) ||
          !pointInsideClipChain(
            record.source.instanceGraph,
            record.instances.clipIds?.[record.instanceIndex] ?? 0,
            record.displayPoint,
          )
        ) {
          continue;
        }
        const distancePixels = pixelDistance(
          camera,
          point,
          record.displayPoint,
          width,
          height,
        );
        if (distancePixels > tolerancePixels) {
          continue;
        }
        const sourceKind =
          record.curve.kind === "arc"
            ? 4
            : record.curve.kind === "circle"
              ? 5
              : 6;
        accept(
          Object.freeze({
            kind: "center",
            displayPoint: record.displayPoint,
            measurementPoint: record.measurementPoint,
            distancePixels,
            coordinateSpace: record.coordinateSpace,
            handle: record.curve.handle,
            layerIndex,
            layerName:
              record.source.layers?.[layerIndex]?.name ?? "",
            sourceKind,
            sourceKindName: SOURCE_KIND_NAMES[sourceKind],
            color: record.curve.color,
            lineWeight: record.curve.lineWeight,
            linetypeCode: record.curve.linetypeCode,
            approximated: false,
            sourceId: record.source.id,
            sourceLabel: record.source.label ?? "",
            curveMeasurement: record.curveMeasurement,
            curveSource: record.curve,
            ...renderPickMetadata(renderPick),
          }),
        );
      }
    }
    for (const occurrenceIndex of occurrenceIndices) {
      const batchIndex = this.occurrenceBatchIndices[occurrenceIndex];
      const instanceIndex =
        this.occurrenceInstanceIndices[occurrenceIndex];
      const indexedBatch = this.batches[batchIndex];
      const { source, batch, segmentIndex } = indexedBatch;
      const instances = instancesForBatch(batch, source.instanceGraph);
      const matrixOffset = instanceIndex * MATRIX_VALUES;
      const inverse = invertAffine2D(instances.data, matrixOffset);
      if (!inverse) {
        continue;
      }
      const localPoint = inversePoint(inverse, point);
      const localTolerance = inverseTolerance(
        inverse,
        toleranceX,
        toleranceY,
      );
      const evaluatedExactHandles = new Set();
      for (const segment of segmentIndex.query(localPoint, localTolerance)) {
        const details = segmentIndex.read(segment, localFirst, localLast);
        if ((details.style & (1 << 16)) !== 0) {
          continue;
        }
        const renderPick = this.resolveRenderPick({
          origin: "base",
          sceneId: source.id,
          handle: details.handle,
          batch,
          instances,
          instanceIndex,
          sourceLayerIndex: details.layerIndex,
          layerZeroIndex: this.layerZeroIndex,
        });
        if (!renderPick) {
          continue;
        }
        const layerIndex = resolvedLayerIndex(
          details.layerIndex,
          instances,
          instanceIndex,
          this.layerZeroIndex,
          renderPick?.instanceStyle,
        );
        if (
          !layerIsVisible(
            layerIndex,
            instances,
            instanceIndex,
            source.instanceGraph,
            layerVisibility,
          )
        ) {
          continue;
        }
        transformPoint(
          instances.data,
          localFirst,
          matrixOffset,
          displayFirst,
        );
        transformPoint(
          instances.data,
          localLast,
          matrixOffset,
          displayLast,
        );
        const measurementData = instances.measurementData ?? instances.data;
        transformPoint(
          measurementData,
          localFirst,
          matrixOffset,
          measureFirst,
        );
        transformPoint(
          measurementData,
          localLast,
          matrixOffset,
          measureLast,
        );
        if (
          enabledKinds.has("intersection") &&
          !details.approximated &&
          (details.sourceKind === null || details.sourceKind <= 3) &&
          intersectionSegments.length < MAX_INTERSECTION_SEGMENTS
        ) {
          intersectionSegments.push({
            source,
            instances,
            instanceIndex,
            details,
            layerIndex,
            displayFirst: Object.freeze([...displayFirst]),
            displayLast: Object.freeze([...displayLast]),
            measureFirst: Object.freeze([...measureFirst]),
            measureLast: Object.freeze([...measureLast]),
            coordinateSpace:
              instances.coordinateSpaceIds?.[instanceIndex] ?? 1,
            renderPick,
          });
        }
        const exactCurve = source.exactCurves?.get(details.handle);
        let curveMeasurement = null;
        let choices = null;
        if (
          exactCurve &&
          details.sourceKind >= 4 &&
          details.sourceKind <= 6
        ) {
          if (evaluatedExactHandles.has(details.handle)) {
            continue;
          }
          evaluatedExactHandles.add(details.handle);
          curveMeasurement = exactCurveMeasurement(
            exactCurve,
            instances.data,
            measurementData,
            matrixOffset,
          );
          choices = exactCurveChoices(
            exactCurve,
            point,
            instances.data,
            measurementData,
            matrixOffset,
            enabledKinds,
            referencePoint,
          );
        }
        if (!choices) {
          const nearest = nearestPoint(displayFirst, displayLast, point);
          choices = [];
          if (enabledKinds.has("nearest")) {
            choices.push({
              kind: "nearest",
              displayPoint: nearest.point,
              measurementPoint: interpolate(
                measureFirst,
                measureLast,
                nearest.t,
              ),
            });
          }
          if (
            enabledKinds.has("midpoint") &&
            (details.sourceKind === null || details.sourceKind <= 3)
          ) {
            choices.push({
              kind: "midpoint",
              displayPoint: interpolate(displayFirst, displayLast, 0.5),
              measurementPoint: interpolate(measureFirst, measureLast, 0.5),
            });
          }
          if (
            enabledKinds.has("endpoint") &&
            details.sourceKind !== 5
          ) {
            if (details.firstEndpoint) {
              choices.push({
                kind: "endpoint",
                displayPoint: [...displayFirst],
                measurementPoint: [...measureFirst],
              });
            }
            if (details.lastEndpoint) {
              choices.push({
                kind: "endpoint",
                displayPoint: [...displayLast],
                measurementPoint: [...measureLast],
              });
            }
          }
          if (
            enabledKinds.has("perpendicular") &&
            Array.isArray(referencePoint) &&
            referencePoint.length >= 2
          ) {
            const perpendicular = nearestPoint(
              displayFirst,
              displayLast,
              referencePoint,
            );
            choices.push({
              kind: "perpendicular",
              displayPoint: perpendicular.point,
              measurementPoint: interpolate(
                measureFirst,
                measureLast,
                perpendicular.t,
              ),
            });
          }
        }
        for (const choice of choices) {
          if (
            !pointInsideClipChain(
              source.instanceGraph,
              instances.clipIds?.[instanceIndex] ?? 0,
              choice.displayPoint,
            )
          ) {
            continue;
          }
          const distancePixels = pixelDistance(
            camera,
            point,
            choice.displayPoint,
            width,
            height,
          );
          if (distancePixels > tolerancePixels) {
            continue;
          }
          accept(Object.freeze({
            ...choice,
            distancePixels,
            displaySegment: Object.freeze([
              Object.freeze([...displayFirst]),
              Object.freeze([...displayLast]),
            ]),
            measurementSegment: Object.freeze([
              Object.freeze([...measureFirst]),
              Object.freeze([...measureLast]),
            ]),
            coordinateSpace:
              instances.coordinateSpaceIds?.[instanceIndex] ?? 1,
            handle: details.handle,
            layerIndex,
            layerName: source.layers?.[layerIndex]?.name ?? "",
            sourceKind: details.sourceKind,
            sourceKindName:
              details.sourceKind === null
                ? "선형 객체"
                : SOURCE_KIND_NAMES[details.sourceKind] ?? "도면 객체",
            color: details.color,
            lineWeight: details.lineWeight,
            linetypeCode: details.linetypeCode,
            approximated: choice.exact ? false : details.approximated,
            sourceId: source.id,
            sourceLabel: source.label ?? "",
            curveMeasurement,
            curveSource: exactCurve ?? null,
            objectMeasurement: this.objectMeasurement(
              source,
              details.handle,
              instances,
              instanceIndex,
              details.sourceKind,
            ),
            ...renderPickMetadata(renderPick),
          }));
        }
      }
    }
    for (
      let firstIndex = 0;
      firstIndex < intersectionSegments.length;
      firstIndex += 1
    ) {
      const first = intersectionSegments[firstIndex];
      for (
        let otherIndex = firstIndex + 1;
        otherIndex < intersectionSegments.length;
        otherIndex += 1
      ) {
        const other = intersectionSegments[otherIndex];
        if (first.coordinateSpace !== other.coordinateSpace) {
          continue;
        }
        const intersection = segmentIntersection(
          first.displayFirst,
          first.displayLast,
          other.displayFirst,
          other.displayLast,
        );
        if (!intersection) {
          continue;
        }
        const distancePixels = pixelDistance(
          camera,
          point,
          intersection.point,
          width,
          height,
        );
        if (
          distancePixels > tolerancePixels ||
          !pointInsideClipChain(
            first.source.instanceGraph,
            first.instances.clipIds?.[first.instanceIndex] ?? 0,
            intersection.point,
          ) ||
          !pointInsideClipChain(
            other.source.instanceGraph,
            other.instances.clipIds?.[other.instanceIndex] ?? 0,
            intersection.point,
          )
        ) {
          continue;
        }
        const measurementPoint = interpolate(
          first.measureFirst,
          first.measureLast,
          intersection.firstParameter,
        );
        const otherMeasurementPoint = interpolate(
          other.measureFirst,
          other.measureLast,
          intersection.otherParameter,
        );
        const measurementScale = Math.max(
          1,
          ...measurementPoint.map(Math.abs),
          ...otherMeasurementPoint.map(Math.abs),
        );
        if (
          Math.hypot(
            measurementPoint[0] - otherMeasurementPoint[0],
            measurementPoint[1] - otherMeasurementPoint[1],
            measurementPoint[2] - otherMeasurementPoint[2],
          ) >
          measurementScale * 1e-7
        ) {
          continue;
        }
        accept(
          Object.freeze({
            kind: "intersection",
            displayPoint: Object.freeze([...intersection.point]),
            measurementPoint: Object.freeze(measurementPoint),
            distancePixels,
            coordinateSpace: first.coordinateSpace,
            handle: first.details.handle,
            relatedHandle: other.details.handle,
            layerIndex: first.layerIndex,
            layerName:
              first.source.layers?.[first.layerIndex]?.name ?? "",
            sourceKind: first.details.sourceKind,
            sourceKindName: "교차점",
            color: first.details.color,
            lineWeight: first.details.lineWeight,
            linetypeCode: first.details.linetypeCode,
            approximated: false,
            sourceId: first.source.id,
            sourceLabel: first.source.label ?? "",
            ...renderPickMetadata(first.renderPick),
            ...relatedRenderPickMetadata(other.renderPick),
          }),
        );
      }
    }
    return best;
  }

  snapshot() {
    return Object.freeze({
      sources: this.sources.length,
      batches: this.batches.length,
      occurrences: this.occurrenceCount,
      insertions: this.insertions.length,
      curveCenters: this.curveCenters.length,
      segments: this.batches.reduce(
        (total, value) => total + value.segmentIndex.segmentCount,
        0,
      ),
      truncated: this.truncated,
    });
  }
}

export function sourceKindName(kind) {
  return SOURCE_KIND_NAMES[kind] ?? "도면 객체";
}

export {
  DEFAULT_TOLERANCE_PIXELS,
  MAX_OCCURRENCES,
  MAX_SEGMENT_CANDIDATES,
};
