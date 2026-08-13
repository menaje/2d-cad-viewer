import { arbitraryAxisMat4, transformPoint } from "./math.mjs";
import {
  encodeMaskBucket,
  maskBucketFor,
} from "./mask-order.mjs";
import { GpuLineBatchKind } from "./scene-cache.mjs";
import { encodeCadLineStyle } from "./cad-line-style.mjs";
import {
  appendRenderIdentityRange,
  packRenderIdentityRanges,
} from "./render-identity-ranges.mjs";
import { buildWidePolylineGeometry } from "./wide-polyline.mjs";

export const PRIMITIVE_VERTEX_STRIDE = 32;
export const MAX_POINT_GPU_BYTES = 8 * 1024 * 1024;
export const MAX_SOLID_FILL_GPU_BYTES = 16 * 1024 * 1024;
export const MAX_SOLID_OUTLINE_GPU_BYTES = 8 * 1024 * 1024;
export const MAX_WIPEOUT_MASK_GPU_BYTES = 8 * 1024 * 1024;
export const MAX_PRIMITIVE_GPU_BYTES =
  MAX_POINT_GPU_BYTES +
  MAX_SOLID_FILL_GPU_BYTES +
  MAX_SOLID_OUTLINE_GPU_BYTES +
  MAX_WIPEOUT_MASK_GPU_BYTES;

const MAX_BATCH_VERTICES = 24_576;
const MAX_POSITION_ERROR = 1e-3;
const MAX_NATIVE_HAIRLINE_WIDTH = MAX_POSITION_ERROR;
const GPU_STYLE_INVISIBLE = 1 << 16;
const WIPEOUT_BACKGROUND_COLOR =
  ((3 << 30) | (14 << 16) | (16 << 8) | 19) >>> 0;
const TRIANGLE_EDGES = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 2]),
  Object.freeze([2, 0]),
]);
const QUADRILATERAL_EDGES = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 2]),
  Object.freeze([2, 3]),
  Object.freeze([3, 0]),
]);

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

function pointsNear(left, right) {
  let scale = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    scale = Math.max(scale, Math.abs(left[axis]), Math.abs(right[axis]));
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(left[axis] - right[axis]) > scale * 1e-12) {
      return false;
    }
  }
  return true;
}

function triangleIsUsable(points) {
  const left = points[0];
  const firstX = points[1][0] - left[0];
  const firstY = points[1][1] - left[1];
  const firstZ = points[1][2] - left[2];
  const secondX = points[2][0] - left[0];
  const secondY = points[2][1] - left[1];
  const secondZ = points[2][2] - left[2];
  const crossX = firstY * secondZ - firstZ * secondY;
  const crossY = firstZ * secondX - firstX * secondZ;
  const crossZ = firstX * secondY - firstY * secondX;
  const scale = Math.max(
    1,
    Math.hypot(firstX, firstY, firstZ),
    Math.hypot(secondX, secondY, secondZ),
  );
  return Math.hypot(crossX, crossY, crossZ) > scale * scale * 1e-12;
}

class PackedBatchBuilder {
  constructor(owner, firstPoint, initialByteLength) {
    this.owner = owner;
    this.origin = [...firstPoint];
    this.buffer = new ArrayBuffer(initialByteLength);
    this.view = new DataView(this.buffer);
    this.byteLength = 0;
    this.vertexCount = 0;
    this.maximumPositionError = 0;
    this.identityRanges = [];
    this.bounds = {
      min: [...firstPoint],
      max: [...firstPoint],
    };
  }

  canAccept(points) {
    if (this.vertexCount + points.length > MAX_BATCH_VERTICES) {
      return false;
    }
    if (this.vertexCount === 0) {
      return true;
    }
    return points.every((point) =>
      point.every((coordinate, axis) => {
        const local = coordinate - this.origin[axis];
        return Math.abs(Math.fround(local) - local) <= MAX_POSITION_ERROR;
      }),
    );
  }

  write(points, writeAttributes, handle) {
    this.#ensure(points.length * PRIMITIVE_VERTEX_STRIDE);
    appendRenderIdentityRange(
      this.identityRanges,
      handle,
      this.vertexCount,
      points.length,
    );
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
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
      writeAttributes(this.view, offset, index);
      this.byteLength += PRIMITIVE_VERTEX_STRIDE;
      this.vertexCount += 1;
    }
  }

  #ensure(additionalBytes) {
    const required = this.byteLength + additionalBytes;
    if (required <= this.buffer.byteLength) {
      return;
    }
    let capacity = this.buffer.byteLength;
    const maximum = MAX_BATCH_VERTICES * PRIMITIVE_VERTEX_STRIDE;
    while (capacity < required) {
      capacity = Math.min(maximum, capacity * 2);
    }
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.byteLength));
    this.buffer = next;
    this.view = new DataView(next);
  }
}

class PackedMeshBuilder {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.groups = new Map();
    this.byteLength = 0;
    this.vertexCount = 0;
    this.maximumPositionError = 0;
  }

  canWrite(vertexCount) {
    return (
      this.byteLength + vertexCount * PRIMITIVE_VERTEX_STRIDE <=
      this.maximumBytes
    );
  }

  write(owner, points, writeAttributes, handle) {
    if (!this.canWrite(points.length)) {
      return false;
    }
    let group = this.groups.get(owner.key);
    if (!group) {
      group = { owner, batches: [], active: null };
      this.groups.set(owner.key, group);
    }
    if (!group.active || !group.active.canAccept(points)) {
      group.active = new PackedBatchBuilder(
        owner,
        points[0],
        points.length * PRIMITIVE_VERTEX_STRIDE,
      );
      group.batches.push(group.active);
    }
    group.active.write(points, writeAttributes, handle);
    this.byteLength += points.length * PRIMITIVE_VERTEX_STRIDE;
    this.vertexCount += points.length;
    return true;
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
        vertexCount: this.vertexCount,
      }),
      identityRanges: packRenderIdentityRanges(
        identityRanges,
        this.vertexCount,
      ),
      maximumPositionError: this.maximumPositionError,
    });
  }
}

function requireBudget(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} GPU byte limit is too small`);
  }
}

function writePackedPrimitives(
  builder,
  owner,
  points,
  verticesPerPrimitive,
  attributes,
  handle,
) {
  if (
    points.length === 0 ||
    points.length % verticesPerPrimitive !== 0 ||
    !builder.canWrite(points.length)
  ) {
    return false;
  }
  const maximumChunkVertices =
    Math.floor(MAX_BATCH_VERTICES / verticesPerPrimitive) *
    verticesPerPrimitive;
  for (
    let firstVertex = 0;
    firstVertex < points.length;
    firstVertex += maximumChunkVertices
  ) {
    const chunk = points.slice(
      firstVertex,
      Math.min(firstVertex + maximumChunkVertices, points.length),
    );
    if (!builder.write(owner, chunk, attributes, handle)) {
      return false;
    }
  }
  return true;
}

function handleWords(handles) {
  const words = new Uint32Array(handles.length * 2);
  for (let index = 0; index < handles.length; index += 1) {
    words[index * 2] = Number(handles[index] & 0xffffffffn);
    words[index * 2 + 1] = Number(handles[index] >> 32n);
  }
  return words;
}

function pointAttributes(entity, maskOrder) {
  const style = encodeMaskBucket(
    (entity.displayMode & 0xffff) |
      (entity.commonFlags & 1 ? GPU_STYLE_INVISIBLE : 0),
    maskBucketFor(maskOrder, entity.ownerHandle, entity.handle),
  );
  const normalizedAngle = Math.atan2(
    Math.sin(entity.xAxisAngle),
    Math.cos(entity.xAxisAngle),
  );
  const boundedSize = Math.max(
    -1e20,
    Math.min(1e20, entity.displaySize),
  );
  return (view, offset) => {
    view.setUint32(offset + 12, entity.layerIndex, true);
    view.setUint32(offset + 16, entity.color >>> 0, true);
    view.setFloat32(offset + 20, normalizedAngle, true);
    view.setFloat32(offset + 24, boundedSize, true);
    view.setUint32(offset + 28, style >>> 0, true);
  };
}

function solidFillAttributes(entity, maskOrder) {
  const style = encodeMaskBucket(
    entity.commonFlags & 1 ? GPU_STYLE_INVISIBLE : 0,
    maskBucketFor(maskOrder, entity.ownerHandle, entity.handle),
  );
  return (view, offset) => {
    view.setUint32(offset + 12, entity.layerIndex, true);
    view.setUint32(offset + 16, entity.color >>> 0, true);
    view.setUint32(offset + 20, entity.color >>> 0, true);
    view.setFloat32(offset + 24, 0, true);
    view.setUint32(offset + 28, style >>> 0, true);
  };
}

function solidOutlineAttributes(entity, maskOrder) {
  const style = encodeMaskBucket(
    encodeCadLineStyle({
      lineWeight: entity.lineWeight,
      linetypeCode: entity.linetypeCode ?? 0,
      invisible: Boolean(entity.commonFlags & 1),
    }),
    maskBucketFor(maskOrder, entity.ownerHandle, entity.handle),
  );
  return (view, offset) => {
    view.setUint32(offset + 12, entity.layerIndex, true);
    view.setUint32(offset + 16, entity.color >>> 0, true);
    view.setUint32(offset + 20, Number(entity.handle & 0xffffffffn), true);
    view.setUint32(offset + 24, Number(entity.handle >> 32n), true);
    view.setUint32(offset + 28, style >>> 0, true);
  };
}

function wipeoutPoint(entity, localPoint, target) {
  for (let axis = 0; axis < 3; axis += 1) {
    target[axis] =
      entity.insertionPoint[axis] +
      entity.uVector[axis] * localPoint[0] +
      entity.vVector[axis] * localPoint[1];
  }
  return target;
}

function maskFillAttributes(mask) {
  const style = encodeMaskBucket(0, mask.localBucket);
  return (view, offset) => {
    view.setUint32(offset + 12, mask.layerIndex, true);
    view.setUint32(offset + 16, WIPEOUT_BACKGROUND_COLOR, true);
    view.setUint32(offset + 20, WIPEOUT_BACKGROUND_COLOR, true);
    view.setFloat32(offset + 24, 0, true);
    view.setUint32(offset + 28, style, true);
  };
}

export function buildPrimitiveMeshes(
  source,
  blocks,
  instanceGraph,
  {
    maximumPointGpuBytes = MAX_POINT_GPU_BYTES,
    maximumSolidFillGpuBytes = MAX_SOLID_FILL_GPU_BYTES,
    maximumSolidOutlineGpuBytes = MAX_SOLID_OUTLINE_GPU_BYTES,
    maximumWipeoutMaskGpuBytes = MAX_WIPEOUT_MASK_GPU_BYTES,
    wipeoutFrame = null,
    fillMode = true,
    splineFrame = false,
    maskOrder = null,
  } = {},
) {
  if (
    !source?.points ||
    typeof source.points.readEntity !== "function" ||
    !source?.solids ||
    typeof source.solids.readEntity !== "function" ||
    !source?.faces ||
    typeof source.faces.readEntity !== "function" ||
    !source?.wipeouts ||
    typeof source.wipeouts.readEntity !== "function" ||
    typeof source.wipeouts.readClipVertex !== "function" ||
    !source?.polylines ||
    typeof source.polylines.readEntity !== "function" ||
    !source?.polylineVertices ||
    typeof source.polylineVertices.readVertex !== "function"
  ) {
    throw new TypeError(
      "primitive mesh builder requires POINT, SOLID, 3DFACE, WIPEOUT and polyline source tables",
    );
  }
  if (
    wipeoutFrame !== null &&
    (!Number.isInteger(wipeoutFrame) || wipeoutFrame < 0 || wipeoutFrame > 2)
  ) {
    throw new RangeError("WIPEOUT frame setting must be null, 0, 1 or 2");
  }
  if (typeof fillMode !== "boolean") {
    throw new TypeError("drawing FILLMODE must be a boolean");
  }
  if (typeof splineFrame !== "boolean") {
    throw new TypeError("drawing SPLFRAME must be a boolean");
  }
  requireBudget(
    maximumPointGpuBytes,
    PRIMITIVE_VERTEX_STRIDE,
    "POINT",
  );
  requireBudget(
    maximumSolidFillGpuBytes,
    PRIMITIVE_VERTEX_STRIDE * 3,
    "SOLID fill",
  );
  requireBudget(
    maximumSolidOutlineGpuBytes,
    PRIMITIVE_VERTEX_STRIDE * 2,
    "surface outline",
  );
  requireBudget(
    maximumWipeoutMaskGpuBytes,
    PRIMITIVE_VERTEX_STRIDE * 3,
    "WIPEOUT mask",
  );

  const blockIndexByHandle = new Map();
  for (const block of blocks) {
    blockIndexByHandle.set(block.handle, block.index);
  }
  const pointMesh = new PackedMeshBuilder(maximumPointGpuBytes);
  const solidFillMesh = new PackedMeshBuilder(maximumSolidFillGpuBytes);
  const surfaceOutlineMesh = new PackedMeshBuilder(
    maximumSolidOutlineGpuBytes,
  );
  const wipeoutMaskMesh = new PackedMeshBuilder(
    maximumWipeoutMaskGpuBytes,
  );
  const point = {
    location: [0, 0, 0],
    normal: [0, 0, 1],
  };
  const pointVertices = [point.location];
  const solid = {
    corners: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    normal: [0, 0, 1],
  };
  const face = {
    corners: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  };
  const polyline = { normal: [0, 0, 1] };
  const lineReplacementHandles = [];
  const wipeout = {
    insertionPoint: [0, 0, 0],
    uVector: [0, 0, 0],
    vVector: [0, 0, 0],
    size: [0, 0],
  };
  const wipeoutLocalStart = [0, 0];
  const wipeoutLocalEnd = [0, 0];
  const wipeoutRectangle = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const wipeoutWorldEdge = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const transformedCorners = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const firstTriangle = [
    transformedCorners[0],
    transformedCorners[1],
    transformedCorners[2],
  ];
  const secondTriangle = [
    transformedCorners[0],
    transformedCorners[2],
    transformedCorners[3],
  ];
  const triangleFill = [firstTriangle];
  const quadrilateralFill = [firstTriangle, secondTriangle];
  const outlineEdge = [transformedCorners[0], transformedCorners[1]];
  const metrics = {
    sourcePoints: source.points.length,
    renderedPoints: 0,
    hiddenPointModes: 0,
    sourceSolids: source.solids.length,
    renderedFilledSolids: 0,
    renderedOutlineSolids: 0,
    sourcePolylines: source.polylines.length,
    sourceWidePolylines: 0,
    renderedFilledWidePolylines: 0,
    renderedOutlineWidePolylines: 0,
    mixedWidthPolylines: 0,
    skippedInvalidWidePolylines: 0,
    widePolylineFillVertices: 0,
    widePolylineOutlineVertices: 0,
    widePolylineFillGpuBytes: 0,
    widePolylineOutlineGpuBytes: 0,
    widePolylineGpuLimitReached: false,
    sourceFaces: source.faces.length,
    renderedFaces: 0,
    renderedFaceEdges: 0,
    hiddenFaceEdges: 0,
    restoredFaceEdges: 0,
    skippedDegenerateFaceEdges: 0,
    sourceWipeouts: source.wipeouts.length,
    deferredWipeoutMasks: 0,
    renderedWipeoutMasks: 0,
    renderedWipeoutMaskTriangles: 0,
    skippedWipeoutMaskTriangles: 0,
    renderedWipeoutFrames: 0,
    renderedWipeoutFrameEdges: 0,
    skippedDegenerateWipeoutEdges: 0,
    wipeoutFrameSetting: wipeoutFrame,
    skippedOwners: 0,
    skippedDegenerateTriangles: 0,
    pointVertices: 0,
    solidFillVertices: 0,
    solidOutlineVertices: 0,
    faceOutlineVertices: 0,
    wipeoutOutlineVertices: 0,
    surfaceOutlineVertices: 0,
    pointGpuBytes: 0,
    solidFillGpuBytes: 0,
    solidOutlineGpuBytes: 0,
    faceOutlineGpuBytes: 0,
    wipeoutOutlineGpuBytes: 0,
    wipeoutMaskVertices: 0,
    wipeoutMaskGpuBytes: 0,
    surfaceOutlineGpuBytes: 0,
    gpuBytes: 0,
    batches: 0,
    pointGpuLimitReached: false,
    solidFillGpuLimitReached: false,
    solidOutlineGpuLimitReached: false,
    faceOutlineGpuLimitReached: false,
    wipeoutOutlineGpuLimitReached: false,
    wipeoutMaskGpuLimitReached: false,
    maskOrderEnabled:
      Boolean(maskOrder?.enabled) &&
      Boolean(instanceGraph.maskOrderEnabled),
  };

  for (let index = 0; index < source.points.length; index += 1) {
    source.points.readEntity(index, point);
    if ((point.displayMode & 0xffff) === 1) {
      metrics.hiddenPointModes += 1;
      continue;
    }
    const owner = classifyOwner(
      point,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwners += 1;
      continue;
    }
    if (
      !pointMesh.write(
        owner,
        pointVertices,
        pointAttributes(point, maskOrder),
        point.handle,
      )
    ) {
      metrics.pointGpuLimitReached = true;
      break;
    }
    metrics.renderedPoints += 1;
  }

  for (let index = 0; index < source.solids.length; index += 1) {
    source.solids.readEntity(index, solid);
    const owner = classifyOwner(
      solid,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwners += 1;
      continue;
    }
    const ocsToWcs = arbitraryAxisMat4(solid.normal);
    for (let corner = 0; corner < transformedCorners.length; corner += 1) {
      transformPoint(
        ocsToWcs,
        solid.corners[corner],
        0,
        transformedCorners[corner],
      );
    }
    const corners = transformedCorners;
    const isTriangle = pointsNear(corners[2], corners[3]);

    if (solid.fillMode) {
      let rendered = false;
      const triangles = isTriangle ? triangleFill : quadrilateralFill;
      const attributes = solidFillAttributes(solid, maskOrder);
      for (const triangle of triangles) {
        if (!triangleIsUsable(triangle)) {
          metrics.skippedDegenerateTriangles += 1;
          continue;
        }
        if (
          !solidFillMesh.write(
            owner,
            triangle,
            attributes,
            solid.handle,
          )
        ) {
          metrics.solidFillGpuLimitReached = true;
          break;
        }
        rendered = true;
      }
      if (rendered) {
        metrics.renderedFilledSolids += 1;
      }
      continue;
    }

    const edges = isTriangle ? TRIANGLE_EDGES : QUADRILATERAL_EDGES;
    let rendered = false;
    const attributes = solidOutlineAttributes(solid, maskOrder);
    for (const [start, end] of edges) {
      if (pointsNear(corners[start], corners[end])) {
        continue;
      }
      outlineEdge[0] = corners[start];
      outlineEdge[1] = corners[end];
      if (
        !surfaceOutlineMesh.write(
          owner,
          outlineEdge,
          attributes,
          solid.handle,
        )
      ) {
        metrics.solidOutlineGpuLimitReached = true;
        break;
      }
      metrics.solidOutlineVertices += outlineEdge.length;
      rendered = true;
    }
    if (rendered) {
      metrics.renderedOutlineSolids += 1;
    }
  }

  for (let index = 0; index < source.polylines.length; index += 1) {
    source.polylines.readEntity(index, polyline);
    if (polyline.polylineKind !== 1 && polyline.polylineKind !== 2) {
      continue;
    }
    const geometry = buildWidePolylineGeometry(source, polyline, {
      fillMode,
    });
    if (!geometry) {
      metrics.skippedInvalidWidePolylines += 1;
      continue;
    }
    const points = fillMode
      ? geometry.fillVertices
      : geometry.outlineVertices;
    if (points.length === 0) {
      continue;
    }
    metrics.sourceWidePolylines += 1;
    if (geometry.mixedWidth) {
      metrics.mixedWidthPolylines += 1;
    }
    const owner = classifyOwner(
      polyline,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwners += 1;
      continue;
    }
    const mesh = fillMode ? solidFillMesh : surfaceOutlineMesh;
    const attributes = fillMode
      ? solidFillAttributes(polyline, maskOrder)
      : solidOutlineAttributes(polyline, maskOrder);
    if (
      !writePackedPrimitives(
        mesh,
        owner,
        points,
        fillMode ? 3 : 2,
        attributes,
        polyline.handle,
      )
    ) {
      metrics.widePolylineGpuLimitReached = true;
      continue;
    }
    if (fillMode) {
      metrics.renderedFilledWidePolylines += 1;
      metrics.widePolylineFillVertices += points.length;
    } else {
      metrics.renderedOutlineWidePolylines += 1;
      metrics.widePolylineOutlineVertices += points.length;
    }
    // Filled quads narrower than the primitive position-error budget can
    // rasterize to zero pixels at normal zoom. Keep the native CAD line as a
    // hairline fallback while retaining the fill for close zoom levels.
    if (
      geometry.allDrawableEdgesWide &&
      geometry.maximumWidth > MAX_NATIVE_HAIRLINE_WIDTH
    ) {
      lineReplacementHandles.push(polyline.handle);
    }
  }

  for (let index = 0; index < source.faces.length; index += 1) {
    source.faces.readEntity(index, face);
    const owner = classifyOwner(
      face,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwners += 1;
      continue;
    }
    let rendered = false;
    const attributes = solidOutlineAttributes(face, maskOrder);
    for (let edge = 0; edge < QUADRILATERAL_EDGES.length; edge += 1) {
      if (!splineFrame && (face.invisibleEdges & (1 << edge)) !== 0) {
        metrics.hiddenFaceEdges += 1;
        continue;
      }
      if (splineFrame && (face.invisibleEdges & (1 << edge)) !== 0) {
        metrics.restoredFaceEdges += 1;
      }
      const [start, end] = QUADRILATERAL_EDGES[edge];
      if (pointsNear(face.corners[start], face.corners[end])) {
        metrics.skippedDegenerateFaceEdges += 1;
        continue;
      }
      outlineEdge[0] = face.corners[start];
      outlineEdge[1] = face.corners[end];
      if (
        !surfaceOutlineMesh.write(
          owner,
          outlineEdge,
          attributes,
          face.handle,
        )
      ) {
        metrics.faceOutlineGpuLimitReached = true;
        break;
      }
      metrics.renderedFaceEdges += 1;
      metrics.faceOutlineVertices += outlineEdge.length;
      rendered = true;
    }
    if (rendered) {
      metrics.renderedFaces += 1;
    }
  }

  let wipeoutBudgetExhausted = false;
  for (let index = 0; index < source.wipeouts.length; index += 1) {
    source.wipeouts.readEntity(index, wipeout);
    if (
      (wipeout.displayProperties & 1) !== 0 &&
      (wipeout.commonFlags & 1) === 0
    ) {
      metrics.deferredWipeoutMasks += 1;
    }
    if (
      wipeoutBudgetExhausted ||
      (wipeoutFrame !== 1 && wipeoutFrame !== 2)
    ) {
      continue;
    }
    const owner = classifyOwner(
      wipeout,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwners += 1;
      continue;
    }
    const usesClipBoundary =
      wipeout.clippingEnabled &&
      (wipeout.displayProperties & 4) !== 0;
    let edgeCount;
    if (usesClipBoundary && wipeout.clipType === 2) {
      edgeCount = wipeout.clipVertexCount;
    } else {
      if (usesClipBoundary) {
        source.wipeouts.readClipVertex(
          wipeout.firstClipVertex,
          wipeoutLocalStart,
        );
        source.wipeouts.readClipVertex(
          wipeout.firstClipVertex + 1,
          wipeoutLocalEnd,
        );
        wipeoutRectangle[0][0] = wipeoutLocalStart[0];
        wipeoutRectangle[0][1] = wipeoutLocalStart[1];
        wipeoutRectangle[1][0] = wipeoutLocalEnd[0];
        wipeoutRectangle[1][1] = wipeoutLocalStart[1];
        wipeoutRectangle[2][0] = wipeoutLocalEnd[0];
        wipeoutRectangle[2][1] = wipeoutLocalEnd[1];
        wipeoutRectangle[3][0] = wipeoutLocalStart[0];
        wipeoutRectangle[3][1] = wipeoutLocalEnd[1];
      } else {
        wipeoutRectangle[0][0] = -0.5;
        wipeoutRectangle[0][1] = -0.5;
        wipeoutRectangle[1][0] = wipeout.size[0] - 0.5;
        wipeoutRectangle[1][1] = -0.5;
        wipeoutRectangle[2][0] = wipeout.size[0] - 0.5;
        wipeoutRectangle[2][1] = wipeout.size[1] - 0.5;
        wipeoutRectangle[3][0] = -0.5;
        wipeoutRectangle[3][1] = wipeout.size[1] - 0.5;
      }
      edgeCount = 4;
    }

    let rendered = false;
    const attributes = solidOutlineAttributes(wipeout, maskOrder);
    for (let edge = 0; edge < edgeCount; edge += 1) {
      if (usesClipBoundary && wipeout.clipType === 2) {
        source.wipeouts.readClipVertex(
          wipeout.firstClipVertex + edge,
          wipeoutLocalStart,
        );
        source.wipeouts.readClipVertex(
          wipeout.firstClipVertex + ((edge + 1) % edgeCount),
          wipeoutLocalEnd,
        );
      } else {
        wipeoutLocalStart[0] = wipeoutRectangle[edge][0];
        wipeoutLocalStart[1] = wipeoutRectangle[edge][1];
        wipeoutLocalEnd[0] = wipeoutRectangle[(edge + 1) % edgeCount][0];
        wipeoutLocalEnd[1] = wipeoutRectangle[(edge + 1) % edgeCount][1];
      }
      wipeoutPoint(wipeout, wipeoutLocalStart, wipeoutWorldEdge[0]);
      wipeoutPoint(wipeout, wipeoutLocalEnd, wipeoutWorldEdge[1]);
      if (pointsNear(wipeoutWorldEdge[0], wipeoutWorldEdge[1])) {
        metrics.skippedDegenerateWipeoutEdges += 1;
        continue;
      }
      if (
        !surfaceOutlineMesh.write(
          owner,
          wipeoutWorldEdge,
          attributes,
          wipeout.handle,
        )
      ) {
        metrics.wipeoutOutlineGpuLimitReached = true;
        wipeoutBudgetExhausted = true;
        break;
      }
      metrics.renderedWipeoutFrameEdges += 1;
      metrics.wipeoutOutlineVertices += wipeoutWorldEdge.length;
      rendered = true;
    }
    if (rendered) {
      metrics.renderedWipeoutFrames += 1;
    }
  }

  if (metrics.maskOrderEnabled) {
    for (const mask of maskOrder.masks) {
      const owner = classifyOwner(
        mask,
        blocks,
        instanceGraph,
        blockIndexByHandle,
      );
      if (!owner) {
        metrics.skippedOwners += 1;
        continue;
      }
      let rendered = false;
      const attributes = maskFillAttributes(mask);
      for (let index = 0; index < mask.triangles.length; index += 3) {
        const triangle = [
          mask.points[mask.triangles[index]],
          mask.points[mask.triangles[index + 1]],
          mask.points[mask.triangles[index + 2]],
        ];
        if (!triangleIsUsable(triangle)) {
          metrics.skippedWipeoutMaskTriangles += 1;
          continue;
        }
        if (
          !wipeoutMaskMesh.write(
            owner,
            triangle,
            attributes,
            mask.handle,
          )
        ) {
          metrics.wipeoutMaskGpuLimitReached = true;
          break;
        }
        metrics.renderedWipeoutMaskTriangles += 1;
        rendered = true;
      }
      if (rendered) {
        metrics.renderedWipeoutMasks += 1;
      }
      if (metrics.wipeoutMaskGpuLimitReached) {
        break;
      }
    }
  }

  const points = pointMesh.finish();
  const solidFills = solidFillMesh.finish();
  const solidOutlines = surfaceOutlineMesh.finish();
  const wipeoutMasks = wipeoutMaskMesh.finish();
  metrics.pointVertices = points.vertices.vertexCount;
  metrics.solidFillVertices = solidFills.vertices.vertexCount;
  metrics.surfaceOutlineVertices = solidOutlines.vertices.vertexCount;
  metrics.pointGpuBytes = points.vertices.byteLength;
  metrics.solidFillGpuBytes = solidFills.vertices.byteLength;
  metrics.solidOutlineGpuBytes =
    metrics.solidOutlineVertices * PRIMITIVE_VERTEX_STRIDE;
  metrics.faceOutlineGpuBytes =
    metrics.faceOutlineVertices * PRIMITIVE_VERTEX_STRIDE;
  metrics.wipeoutOutlineGpuBytes =
    metrics.wipeoutOutlineVertices * PRIMITIVE_VERTEX_STRIDE;
  metrics.wipeoutMaskVertices = wipeoutMasks.vertices.vertexCount;
  metrics.wipeoutMaskGpuBytes = wipeoutMasks.vertices.byteLength;
  metrics.widePolylineFillGpuBytes =
    metrics.widePolylineFillVertices * PRIMITIVE_VERTEX_STRIDE;
  metrics.widePolylineOutlineGpuBytes =
    metrics.widePolylineOutlineVertices * PRIMITIVE_VERTEX_STRIDE;
  metrics.surfaceOutlineGpuBytes = solidOutlines.vertices.byteLength;
  metrics.gpuBytes =
    metrics.pointGpuBytes +
    metrics.solidFillGpuBytes +
    metrics.surfaceOutlineGpuBytes +
    metrics.wipeoutMaskGpuBytes;
  metrics.batches =
    points.batches.length +
    solidFills.batches.length +
    solidOutlines.batches.length +
    wipeoutMasks.batches.length;

  return Object.freeze({
    points,
    solidFills,
    solidOutlines,
    wipeoutMasks,
    lineReplacementHandleWords: handleWords(lineReplacementHandles),
    metrics: Object.freeze(metrics),
  });
}
