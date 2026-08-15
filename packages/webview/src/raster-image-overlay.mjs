import {
  boundsAreFinite,
  emptyBounds3,
  identityMat4,
  includePoint,
  transformPoint,
} from "./math.mjs";
import { effectiveClipBounds } from "./instance-graph.mjs?v=1.26.0";
import {
  decodeCadColor,
  decodeCadOpacity,
} from "./cad-color.mjs";
import {
  indexDwgRenderDeltaStyles,
  renderDeltaInstanceStyle,
} from "./render-delta-style.mjs";
import {
  indexDwgRenderDeltaTransforms,
  renderDeltaInstanceMatrix,
} from "./render-delta-transform.mjs";
import {
  indexDwgRenderDeltaDependencies,
  isDwgRenderDeltaOwnerInvalidated,
} from "./render-delta-dependency.mjs";
import { maskBucketFor } from "./mask-order.mjs";
import {
  createDrawOrderScratch,
  drawOrderSurfaceFor,
  encodedDrawOrderColor,
  resizeDrawOrderSurface,
} from "./draw-order-overlay.mjs";
import {
  viewportLayerColor,
  viewportStyleRow,
} from "./viewport-layer-state.mjs";
import { instanceIsVisible } from "./instance-visibility.mjs";

const NO_LAYER = 0xffffffff;
const BY_LAYER_ENTITY_COLOR = 1 << 24;
const DEFAULT_MAXIMUM_SOURCE_IMAGES = 65_536;
const DEFAULT_MAXIMUM_OCCURRENCES = 4_096;
const DEFAULT_MAXIMUM_COMPRESSED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAXIMUM_IMAGE_PIXELS = 8_388_608;
const DEFAULT_MAXIMUM_DECODED_PIXELS = 16_777_216;
const DEFAULT_MAXIMUM_DECODE_DIMENSION = 4_096;
const DEFAULT_MINIMUM_SCREEN_DIMENSION = 0.75;
const DEFAULT_SCREEN_DECODE_OVERSAMPLE = 1.5;
const DEFAULT_DECODE_UPGRADE_FACTOR = 1.5;
const IDENTITY_INSTANCES = Object.freeze({
  data: identityMat4(),
  measurementData: identityMat4(),
  clipIds: new Uint32Array([0]),
  layerIndices: new Uint32Array([NO_LAYER]),
  opacities: new Float32Array([1]),
  visibilityRows: new Uint32Array([0]),
  coordinateSpaceIds: new Uint8Array([1]),
  count: 1,
  length: 1,
});

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function referenceKey(cacheId, imageIndex) {
  return `${cacheId}:${imageIndex}`;
}

function normalizedBytes(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  return null;
}

function bitmapTargetSize(
  width,
  height,
  maximumPixels,
  maximumDimension,
) {
  const scale = Math.min(
    1,
    maximumDimension / Math.max(width, height),
    Math.sqrt(maximumPixels / (width * height)),
  );
  return Object.freeze({
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  });
}

function requestedBitmapTargetSize(
  sourceWidth,
  sourceHeight,
  requestedWidth,
  requestedHeight,
  maximumPixels,
  maximumDimension,
  oversample = DEFAULT_SCREEN_DECODE_OVERSAMPLE,
) {
  const maximum = bitmapTargetSize(
    sourceWidth,
    sourceHeight,
    maximumPixels,
    maximumDimension,
  );
  if (
    !Number.isFinite(requestedWidth) ||
    requestedWidth <= 0 ||
    !Number.isFinite(requestedHeight) ||
    requestedHeight <= 0
  ) {
    return maximum;
  }
  const requestedScale = Math.min(
    1,
    Math.max(
      requestedWidth / sourceWidth,
      requestedHeight / sourceHeight,
    ) * oversample,
  );
  const scaledWidth = sourceWidth * requestedScale;
  const scaledHeight = sourceHeight * requestedScale;
  const ceilStable = (value) =>
    Math.ceil(
      value -
        Math.max(1, Math.abs(value)) * Number.EPSILON * 8,
    );
  return Object.freeze({
    width: Math.min(
      maximum.width,
      Math.max(1, ceilStable(scaledWidth)),
    ),
    height: Math.min(
      maximum.height,
      Math.max(1, ceilStable(scaledHeight)),
    ),
  });
}

export class RasterImageAssetStore {
  constructor({
    decode = globalThis.createImageBitmap?.bind(globalThis),
    onChange = () => {},
    maximumCompressedBytes = DEFAULT_MAXIMUM_COMPRESSED_BYTES,
    maximumImagePixels = DEFAULT_MAXIMUM_IMAGE_PIXELS,
    maximumDecodedPixels = DEFAULT_MAXIMUM_DECODED_PIXELS,
    maximumDecodeDimension = DEFAULT_MAXIMUM_DECODE_DIMENSION,
  } = {}) {
    this.decode = decode;
    this.onChange = onChange;
    this.maximumCompressedBytes = positiveSafeInteger(
      maximumCompressedBytes,
      "compressed image budget",
    );
    this.maximumImagePixels = positiveSafeInteger(
      maximumImagePixels,
      "per-image pixel budget",
    );
    this.maximumDecodedPixels = positiveSafeInteger(
      maximumDecodedPixels,
      "decoded image budget",
    );
    this.maximumDecodeDimension = positiveSafeInteger(
      maximumDecodeDimension,
      "maximum image dimension",
    );
    this.references = new Map();
    this.failures = new Map();
    this.resources = new Map();
    this.compressedBytes = 0;
    this.decodedPixels = 0;
    this.clock = 0;
    this.disposed = false;
  }

  accept(message) {
    if (this.disposed) {
      throw new Error("raster image store is disposed");
    }
    const cacheId =
      typeof message?.cacheId === "string" ? message.cacheId : "";
    const imageIndex = message?.imageIndex;
    const resourceId =
      typeof message?.resourceId === "string" ? message.resourceId : "";
    const mimeType = message?.mimeType;
    const width = message?.width;
    const height = message?.height;
    if (
      !cacheId ||
      !Number.isSafeInteger(imageIndex) ||
      imageIndex < 0 ||
      !/^[a-f0-9]{64}$/u.test(resourceId) ||
      !["image/jpeg", "image/png", "image/bmp", "image/gif"].includes(
        mimeType,
      ) ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      !Number.isSafeInteger(width * height) ||
      width * height > 100_000_000
    ) {
      throw new Error("raster image response metadata is invalid");
    }
    const bytes = normalizedBytes(message.bytes);
    let resource = this.resources.get(resourceId);
    if (!resource) {
      if (!bytes || bytes.byteLength === 0) {
        throw new Error("raster image response references unknown content");
      }
      if (
        bytes.byteLength > 64 * 1024 * 1024 ||
        this.compressedBytes + bytes.byteLength >
          this.maximumCompressedBytes
      ) {
        throw new Error("raster image compressed-memory budget exceeded");
      }
      resource = {
        id: resourceId,
        mimeType,
        sourceWidth: width,
        sourceHeight: height,
        byteLength: bytes.byteLength,
        blob: new Blob([bytes], { type: mimeType }),
        bitmap: null,
        decodedPixels: 0,
        decodePromise: null,
        decodeTarget: null,
        error: null,
        lastUsed: ++this.clock,
      };
      this.resources.set(resourceId, resource);
      this.compressedBytes += bytes.byteLength;
    } else if (
      resource.mimeType !== mimeType ||
      resource.sourceWidth !== width ||
      resource.sourceHeight !== height
    ) {
      throw new Error("raster image resource metadata changed");
    }
    const key = referenceKey(cacheId, imageIndex);
    this.references.set(key, resourceId);
    this.failures.delete(key);
    resource.lastUsed = ++this.clock;
    return Object.freeze({
      resourceId,
      compressedBytes: resource.byteLength,
      deduplicated: !bytes,
    });
  }

  lookup(
    cacheId,
    imageIndex,
    { width: requestedWidth, height: requestedHeight } = {},
  ) {
    if (this.disposed) {
      return Object.freeze({ status: "missing" });
    }
    const key = referenceKey(cacheId, imageIndex);
    const failure = this.failures.get(key);
    if (failure) {
      return Object.freeze({ status: "error", error: failure });
    }
    const resourceId = this.references.get(key);
    const resource = resourceId
      ? this.resources.get(resourceId)
      : undefined;
    if (!resource) {
      return Object.freeze({ status: "missing" });
    }
    resource.lastUsed = ++this.clock;
    const target = requestedBitmapTargetSize(
      resource.sourceWidth,
      resource.sourceHeight,
      requestedWidth,
      requestedHeight,
      this.maximumImagePixels,
      this.maximumDecodeDimension,
    );
    if (resource.bitmap) {
      if (
        target.width >
          resource.bitmap.width * DEFAULT_DECODE_UPGRADE_FACTOR ||
        target.height >
          resource.bitmap.height * DEFAULT_DECODE_UPGRADE_FACTOR
      ) {
        void this.#ensureDecoded(resource, target).catch(() => undefined);
      }
      return Object.freeze({
        status: "ready",
        resourceId,
        bitmap: resource.bitmap,
        width: resource.bitmap.width,
        height: resource.bitmap.height,
      });
    }
    if (resource.error) {
      return Object.freeze({
        status: "error",
        resourceId,
        error: resource.error,
      });
    }
    void this.#ensureDecoded(resource, target).catch(() => undefined);
    return Object.freeze({ status: "decoding", resourceId });
  }

  async prepare(cacheId, imageIndex, target = undefined) {
    const resourceId = this.references.get(
      referenceKey(cacheId, imageIndex),
    );
    const resource = resourceId
      ? this.resources.get(resourceId)
      : undefined;
    if (!resource) {
      throw new Error("raster image content is not registered");
    }
    const normalizedTarget = requestedBitmapTargetSize(
      resource.sourceWidth,
      resource.sourceHeight,
      target?.width,
      target?.height,
      this.maximumImagePixels,
      this.maximumDecodeDimension,
    );
    await this.#ensureDecoded(resource, normalizedTarget);
    const state = this.lookup(cacheId, imageIndex, target);
    if (state.status !== "ready") {
      throw state.error ?? new Error("raster image decode failed");
    }
    return state;
  }

  reject(cacheId, imageIndex, error) {
    if (this.disposed) {
      return;
    }
    if (
      typeof cacheId !== "string" ||
      cacheId.length === 0 ||
      !Number.isSafeInteger(imageIndex) ||
      imageIndex < 0
    ) {
      throw new TypeError("raster image reference is invalid");
    }
    const normalized =
      error instanceof Error
        ? error
        : new Error("도면 이미지를 불러오지 못했습니다.");
    const key = referenceKey(cacheId, imageIndex);
    this.references.delete(key);
    this.failures.set(key, normalized);
  }

  snapshot() {
    let decodedResources = 0;
    for (const resource of this.resources.values()) {
      decodedResources += resource.bitmap ? 1 : 0;
    }
    return Object.freeze({
      resources: this.resources.size,
      references: this.references.size,
      decodedResources,
      failedReferences: this.failures.size,
      compressedBytes: this.compressedBytes,
      decodedPixels: this.decodedPixels,
      decodedBytes: this.decodedPixels * 4,
    });
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const resource of this.resources.values()) {
      resource.bitmap?.close?.();
      resource.bitmap = null;
    }
    this.references.clear();
    this.failures.clear();
    this.resources.clear();
    this.compressedBytes = 0;
    this.decodedPixels = 0;
  }

  async #ensureDecoded(
    resource,
    target = bitmapTargetSize(
      resource.sourceWidth,
      resource.sourceHeight,
      this.maximumImagePixels,
      this.maximumDecodeDimension,
    ),
  ) {
    if (
      resource.bitmap &&
      target.width <=
        resource.bitmap.width * DEFAULT_DECODE_UPGRADE_FACTOR &&
      target.height <=
        resource.bitmap.height * DEFAULT_DECODE_UPGRADE_FACTOR
    ) {
      return resource.bitmap;
    }
    if (resource.error && !resource.bitmap) {
      throw resource.error;
    }
    if (resource.decodePromise) {
      if (
        target.width <= resource.decodeTarget.width &&
        target.height <= resource.decodeTarget.height
      ) {
        return resource.decodePromise;
      }
      return resource.decodePromise.then(() =>
        this.#ensureDecoded(resource, target),
      );
    }
    if (typeof this.decode !== "function") {
      resource.error = new Error(
        "이 환경에서는 도면 이미지를 해석할 수 없습니다.",
      );
      throw resource.error;
    }
    resource.decodeTarget = target;
    resource.decodePromise = Promise.resolve()
      .then(() =>
        this.decode(resource.blob, {
          resizeWidth: target.width,
          resizeHeight: target.height,
          resizeQuality: "high",
          premultiplyAlpha: "premultiply",
          colorSpaceConversion: "default",
        }),
      )
      .then((bitmap) => {
        if (
          this.disposed ||
          !bitmap ||
          !Number.isSafeInteger(bitmap.width) ||
          bitmap.width <= 0 ||
          !Number.isSafeInteger(bitmap.height) ||
          bitmap.height <= 0 ||
          bitmap.width * bitmap.height > this.maximumImagePixels
        ) {
          bitmap?.close?.();
          throw new Error("도면 이미지 해상도가 표시 한도를 초과합니다.");
        }
        const previous = resource.bitmap;
        if (previous) {
          previous.close?.();
          this.decodedPixels -= resource.decodedPixels;
        }
        resource.bitmap = bitmap;
        resource.decodedPixels = bitmap.width * bitmap.height;
        resource.error = null;
        resource.lastUsed = ++this.clock;
        this.decodedPixels += resource.decodedPixels;
        this.#evictDecoded(resource.id);
        if (!this.disposed) {
          this.onChange(
            Object.freeze({
              type: "ready",
              resourceId: resource.id,
            }),
          );
        }
        return bitmap;
      })
      .catch((error) => {
        const normalized =
          error instanceof Error
            ? error
            : new Error("도면 이미지를 해석하지 못했습니다.");
        if (!resource.bitmap) {
          resource.error = normalized;
        }
        if (!this.disposed) {
          this.onChange(
            Object.freeze({
              type: "error",
              resourceId: resource.id,
              error: normalized,
            }),
          );
        }
        throw normalized;
      })
      .finally(() => {
        resource.decodePromise = null;
        resource.decodeTarget = null;
      });
    return resource.decodePromise;
  }

  #evictDecoded(protectedResourceId) {
    if (this.decodedPixels <= this.maximumDecodedPixels) {
      return;
    }
    const candidates = [...this.resources.values()]
      .filter(
        (resource) =>
          resource.bitmap && resource.id !== protectedResourceId,
      )
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const resource of candidates) {
      if (this.decodedPixels <= this.maximumDecodedPixels) {
        break;
      }
      resource.bitmap.close?.();
      resource.bitmap = null;
      this.decodedPixels -= resource.decodedPixels;
      resource.decodedPixels = 0;
    }
  }
}

function imageInstances(ownerBlockIndex, instanceGraph) {
  if (
    ownerBlockIndex === undefined ||
    instanceGraph.modelBlockIndices?.has(ownerBlockIndex)
  ) {
    return instanceGraph.rootInstances ?? IDENTITY_INSTANCES;
  }
  return (
    instanceGraph.instancesByBlock.get(ownerBlockIndex) ??
    Object.freeze({ data: new Float64Array(0), count: 0 })
  );
}

function visibleInInstanceViewport(
  instanceGraph,
  instances,
  instanceIndex,
  layerIndex,
) {
  if (layerIndex === NO_LAYER) {
    return true;
  }
  const rowIndex = instances.visibilityRows?.[instanceIndex] ?? 0;
  const row = instanceGraph.layerVisibilityRows?.[rowIndex];
  return !row || row[layerIndex] !== 0;
}

function worldToScreen(point, camera, width, height) {
  return [
    ((point[0] - camera.origin[0]) / camera.worldWidth + 0.5) * width,
    (0.5 - (point[1] - camera.origin[1]) / camera.worldHeight) * height,
  ];
}

function imageWorldPoint(record, x, y, instanceMatrix) {
  return transformPoint(instanceMatrix, [
    record.insertionPoint[0] +
      record.uVector[0] * x +
      record.vVector[0] * y,
    record.insertionPoint[1] +
      record.uVector[1] * x +
      record.vVector[1] * y,
    record.insertionPoint[2] +
      record.uVector[2] * x +
      record.vVector[2] * y,
  ]);
}

function screenBounds(points) {
  return Object.freeze({
    minX: Math.min(...points.map((point) => point[0])),
    minY: Math.min(...points.map((point) => point[1])),
    maxX: Math.max(...points.map((point) => point[0])),
    maxY: Math.max(...points.map((point) => point[1])),
  });
}

function screenPointInPolygon(point, polygon) {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current, current += 1
  ) {
    const [currentX, currentY] = polygon[current];
    const [previousX, previousY] = polygon[previous];
    const crosses =
      currentY > point[1] !== previousY > point[1] &&
      point[0] <
        ((previousX - currentX) * (point[1] - currentY)) /
          (previousY - currentY) +
          currentX;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

function screenSegmentDistance(point, first, last) {
  const deltaX = last[0] - first[0];
  const deltaY = last[1] - first[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const parameter =
    lengthSquared <= Number.EPSILON
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - first[0]) * deltaX +
              (point[1] - first[1]) * deltaY) /
              lengthSquared,
          ),
        );
  return Math.hypot(
    point[0] - (first[0] + parameter * deltaX),
    point[1] - (first[1] + parameter * deltaY),
  );
}

function screenPolygonDistance(point, polygon) {
  if (polygon.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  if (screenPointInPolygon(point, polygon)) {
    return 0;
  }
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    distance = Math.min(
      distance,
      screenSegmentDistance(
        point,
        polygon[index],
        polygon[(index + 1) % polygon.length],
      ),
    );
  }
  return distance;
}

function drawUnavailableImage(context, polygon) {
  if (
    polygon.length !== 4 ||
    !polygon.flat().every(Number.isFinite)
  ) {
    return;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 0.8;
  context.filter = "none";
  context.strokeStyle = "#d88924";
  context.lineWidth = Math.max(globalThis.devicePixelRatio ?? 1, 1);
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(polygon[0][0], polygon[0][1]);
  for (let index = 1; index < polygon.length; index += 1) {
    context.lineTo(polygon[index][0], polygon[index][1]);
  }
  context.closePath();
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(polygon[0][0], polygon[0][1]);
  context.lineTo(polygon[2][0], polygon[2][1]);
  context.moveTo(polygon[1][0], polygon[1][1]);
  context.lineTo(polygon[3][0], polygon[3][1]);
  context.stroke();
}

function drawImageFrame(context, polygon, color) {
  if (polygon.length < 3 || !polygon.flat().every(Number.isFinite)) {
    return false;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.filter = "none";
  context.strokeStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
  context.lineWidth = Math.max(globalThis.devicePixelRatio ?? 1, 1);
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(polygon[0][0], polygon[0][1]);
  for (let index = 1; index < polygon.length; index += 1) {
    context.lineTo(polygon[index][0], polygon[index][1]);
  }
  context.closePath();
  context.stroke();
  return true;
}

function boundaryPoints(record, imageEntities) {
  if (record.clipVertexCount === 0) {
    return [];
  }
  const points = new Array(record.clipVertexCount);
  for (let index = 0; index < record.clipVertexCount; index += 1) {
    const point = imageEntities.readClipVertex(
      record.firstClipVertex + index,
      [0, 0],
    );
    points[index] = [
      point[0],
      record.size[1] - 1 - point[1],
    ];
  }
  if (record.clipType !== 1 || points.length !== 2) {
    return points;
  }
  const minX = Math.min(points[0][0], points[1][0]);
  const maxX = Math.max(points[0][0], points[1][0]);
  const minY = Math.min(points[0][1], points[1][1]);
  const maxY = Math.max(points[0][1], points[1][1]);
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function fullImageBoundary(record) {
  const left = -0.5;
  const right = record.size[0] - 0.5;
  const bottom = -0.5;
  const top = record.size[1] - 0.5;
  return [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ];
}

function fittedImageBoundary(record, imageEntities) {
  if (
    !record.clippingEnabled ||
    (record.displayProperties & 4) === 0 ||
    record.clipMode === 1
  ) {
    return fullImageBoundary(record);
  }
  const clipped = boundaryPoints(record, imageEntities);
  return clipped.length >= 3 ? clipped : fullImageBoundary(record);
}

export function calculateRasterImageBounds({
  imageEntities,
  blocks,
  instanceGraph,
  maximumSourceImages = DEFAULT_MAXIMUM_SOURCE_IMAGES,
  maximumOccurrences = DEFAULT_MAXIMUM_OCCURRENCES,
}) {
  if (
    !imageEntities ||
    !Number.isSafeInteger(imageEntities.length) ||
    typeof imageEntities.readEntity !== "function" ||
    !Array.isArray(blocks) ||
    !instanceGraph
  ) {
    throw new TypeError("raster image bounds input is inconsistent");
  }
  positiveSafeInteger(maximumSourceImages, "source image limit");
  positiveSafeInteger(maximumOccurrences, "image occurrence limit");
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const bounds = emptyBounds3();
  const record = {
    insertionPoint: [0, 0, 0],
    uVector: [0, 0, 0],
    vVector: [0, 0, 0],
    size: [0, 0],
  };
  let occurrences = 0;
  const sourceCount = Math.min(
    imageEntities.length,
    maximumSourceImages,
  );
  for (let imageIndex = 0; imageIndex < sourceCount; imageIndex += 1) {
    imageEntities.readEntity(imageIndex, record);
    if (
      (record.commonFlags & 1) !== 0 ||
      (record.displayProperties & 1) === 0
    ) {
      continue;
    }
    const ownerBlockIndex = blockIndexByHandle.get(record.ownerHandle);
    const instances = imageInstances(ownerBlockIndex, instanceGraph);
    const boundary = fittedImageBoundary(record, imageEntities);
    for (
      let instanceIndex = 0;
      instanceIndex < instances.count &&
      occurrences < maximumOccurrences;
      instanceIndex += 1
    ) {
      if (!instanceIsVisible(instances, instanceIndex)) {
        continue;
      }
      occurrences += 1;
      const matrixOffset = instanceIndex * 16;
      const matrix =
        instances === IDENTITY_INSTANCES
          ? instances.data
          : instances.data.subarray(matrixOffset, matrixOffset + 16);
      const occurrenceBounds = emptyBounds3();
      for (const [x, y] of boundary) {
        const point = imageWorldPoint(record, x, y, matrix);
        if (point.every(Number.isFinite)) {
          includePoint(occurrenceBounds, point);
        }
      }
      if (!boundsAreFinite(occurrenceBounds)) {
        continue;
      }
      const clipId = instances.clipIds?.[instanceIndex] ?? 0;
      if (clipId > 0) {
        const clipBounds = effectiveClipBounds(
          instanceGraph.clipNodes,
          clipId,
        );
        if (!clipBounds) {
          continue;
        }
        occurrenceBounds.min[0] = Math.max(
          occurrenceBounds.min[0],
          clipBounds.min[0],
        );
        occurrenceBounds.min[1] = Math.max(
          occurrenceBounds.min[1],
          clipBounds.min[1],
        );
        occurrenceBounds.max[0] = Math.min(
          occurrenceBounds.max[0],
          clipBounds.max[0],
        );
        occurrenceBounds.max[1] = Math.min(
          occurrenceBounds.max[1],
          clipBounds.max[1],
        );
      }
      if (!boundsAreFinite(occurrenceBounds)) {
        continue;
      }
      includePoint(bounds, occurrenceBounds.min);
      includePoint(bounds, occurrenceBounds.max);
    }
    if (occurrences >= maximumOccurrences) {
      break;
    }
  }
  if (!boundsAreFinite(bounds)) {
    return null;
  }
  return Object.freeze({
    min: Object.freeze([...bounds.min]),
    max: Object.freeze([...bounds.max]),
  });
}

export class CanvasRasterImageOverlay {
  constructor(
    canvas,
    {
      imageEntities,
      blocks,
      layers,
      instanceGraph,
      cacheId,
      assetStore,
      requestAsset = () => false,
      layerMap = null,
      linetypeMap = null,
      displayLayers = layers,
      sourceId = "root",
      sourceLabel = "현재 도면",
      hitTestingEnabled = false,
      maskOrder = null,
      orderCompositionEnabled = Boolean(maskOrder?.generalOrderEnabled),
      orderDepthBias = -0.25,
      maskBucketScale = 1,
      maximumSourceImages = DEFAULT_MAXIMUM_SOURCE_IMAGES,
      maximumOccurrences = DEFAULT_MAXIMUM_OCCURRENCES,
      minimumScreenDimension = DEFAULT_MINIMUM_SCREEN_DIMENSION,
      imageFrame = 0,
      rasterImageQualityHigh = true,
      externalReferenceOverrides = false,
    },
  ) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      throw new Error("Canvas2D is required for the raster image overlay");
    }
    if (
      !imageEntities ||
      !Number.isSafeInteger(imageEntities.length) ||
      typeof imageEntities.readEntity !== "function" ||
      typeof imageEntities.readPath !== "function" ||
      !assetStore ||
      typeof assetStore.lookup !== "function" ||
      typeof cacheId !== "string" ||
      cacheId.length === 0
    ) {
      throw new TypeError("raster image overlay input is inconsistent");
    }
    this.canvas = canvas;
    this.context = context;
    this.orderCompositionEnabled = Boolean(orderCompositionEnabled);
    this.orderSurface = this.orderCompositionEnabled
      ? drawOrderSurfaceFor(canvas)
      : null;
    this.orderCanvas = this.orderSurface?.canvas ?? null;
    this.orderDepthBias = Number.isFinite(orderDepthBias)
      ? Math.max(-0.5, Math.min(0.5, orderDepthBias))
      : -0.25;
    this.maskBucketScale =
      Number.isFinite(maskBucketScale) &&
      maskBucketScale > 0 &&
      maskBucketScale <= 1
        ? maskBucketScale
        : 1;
    this.orderScratch = this.orderSurface
      ? createDrawOrderScratch(canvas)
      : null;
    this.maskOrder = maskOrder?.enabled ? maskOrder : null;
    this.imageEntities = imageEntities;
    this.blocks = blocks;
    this.layers = layers;
    this.instanceGraph = instanceGraph;
    this.cacheId = cacheId;
    this.assetStore = assetStore;
    this.requestAsset = requestAsset;
    this.layerMap = layerMap instanceof Uint32Array ? layerMap : null;
    this.linetypeMap =
      linetypeMap instanceof Uint16Array ? linetypeMap : null;
    this.displayLayers = displayLayers;
    this.sourceId = sourceId;
    this.sourceLabel = sourceLabel;
    if (!Number.isInteger(imageFrame) || imageFrame < 0 || imageFrame > 2) {
      throw new RangeError("IMAGEFRAME must be 0, 1, or 2");
    }
    this.imageFrame = imageFrame;
    if (typeof rasterImageQualityHigh !== "boolean") {
      throw new TypeError("IMAGEQUALITY must be a boolean");
    }
    this.rasterImageQualityHigh = rasterImageQualityHigh;
    if (typeof externalReferenceOverrides !== "boolean") {
      throw new TypeError("XREFOVERRIDE must be a boolean");
    }
    this.externalReferenceOverrides = externalReferenceOverrides;
    this.renderDeltaTransforms = Object.freeze([]);
    this.renderDeltaStyles = Object.freeze([]);
    this.renderDeltaTransformIndex =
      indexDwgRenderDeltaTransforms([], {
        sourceId: this.sourceId,
        instanceGraph: this.instanceGraph,
      });
    this.renderDeltaStyleIndex = indexDwgRenderDeltaStyles([], {
      sourceId: this.sourceId,
      instanceGraph: this.instanceGraph,
    });
    this.hitTestingEnabled = Boolean(hitTestingEnabled);
    this.hitOccurrences = [];
    this.maximumSourceImages = positiveSafeInteger(
      maximumSourceImages,
      "source image limit",
    );
    this.maximumOccurrences = positiveSafeInteger(
      maximumOccurrences,
      "image occurrence limit",
    );
    this.minimumScreenDimension = minimumScreenDimension;
    this.blockIndexByHandle = new Map(
      blocks.map((block) => [block.handle, block.index]),
    );
    this.renderDeltaInvalidatedDependencyIds = Object.freeze([]);
    this.renderDeltaDependencyIndex =
      indexDwgRenderDeltaDependencies([], {
        scenes: new Map([
          [
            this.sourceId,
            {
              blocks: this.blocks,
              instanceGraph: this.instanceGraph,
            },
          ],
        ]),
      });
    this.sourceLayerZeroIndex = layers.findIndex(
      (layer) =>
        layer.name?.normalize("NFC").toLocaleLowerCase("en-US") === "0",
    );
    this.bounds = calculateRasterImageBounds({
      imageEntities,
      blocks,
      instanceGraph,
      maximumSourceImages: this.maximumSourceImages,
      maximumOccurrences: this.maximumOccurrences,
    });
    this.displayRecord = {
      insertionPoint: [0, 0, 0],
      uVector: [0, 0, 0],
      vVector: [0, 0, 0],
      size: [0, 0],
    };
    this.lastMetrics = Object.freeze({
      sourceImages: imageEntities.length,
      renderDeltaTransforms: 0,
      renderDeltaStyles: 0,
      visitedSourceImages: 0,
      visibleOccurrences: 0,
      loadedOccurrences: 0,
      requestedImages: 0,
      decodingImages: 0,
      failedImages: 0,
      imageFrames: 0,
      clipOperations: 0,
      xclipOperations: 0,
      truncated: false,
    });
  }

  resize(size = null) {
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const width = size
      ? size.width
      : Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = size
      ? size.height
      : Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return { width, height };
  }

  setHitTestingEnabled(enabled) {
    this.hitTestingEnabled = Boolean(enabled);
    if (!this.hitTestingEnabled) {
      this.hitOccurrences = [];
    }
    return this.hitTestingEnabled;
  }

  setRenderDeltaTransforms(entries) {
    const next = indexDwgRenderDeltaTransforms(entries, {
      sourceId: this.sourceId,
      instanceGraph: this.instanceGraph,
    });
    this.renderDeltaTransforms = next.entries;
    this.renderDeltaTransformIndex = next;
    this.hitOccurrences = [];
    return next.entries.length;
  }

  setRenderDeltaStyles(entries) {
    const next = indexDwgRenderDeltaStyles(entries, {
      sourceId: this.sourceId,
      instanceGraph: this.instanceGraph,
    });
    this.renderDeltaStyles = next.entries;
    this.renderDeltaStyleIndex = next;
    this.hitOccurrences = [];
    return next.entries.length;
  }

  setRenderDeltaInvalidations(dependencyIds) {
    const next = indexDwgRenderDeltaDependencies(dependencyIds, {
      scenes: new Map([
        [
          this.sourceId,
          {
            blocks: this.blocks,
            instanceGraph: this.instanceGraph,
          },
        ],
      ]),
      ignoreUnavailableScenes: true,
    });
    this.renderDeltaInvalidatedDependencyIds = next.ids;
    this.renderDeltaDependencyIndex = next;
    this.hitOccurrences = [];
    return next.ids.length;
  }

  setRenderDeltaState({
    transforms = Object.freeze([]),
    styles = Object.freeze([]),
    invalidatedDependencyIds = Object.freeze([]),
  } = {}) {
    const nextTransforms = indexDwgRenderDeltaTransforms(
      transforms,
      {
        sourceId: this.sourceId,
        instanceGraph: this.instanceGraph,
      },
    );
    const nextStyles = indexDwgRenderDeltaStyles(styles, {
      sourceId: this.sourceId,
      instanceGraph: this.instanceGraph,
    });
    const nextDependencies = indexDwgRenderDeltaDependencies(
      invalidatedDependencyIds,
      {
        scenes: new Map([
          [
            this.sourceId,
            {
              blocks: this.blocks,
              instanceGraph: this.instanceGraph,
            },
          ],
        ]),
        ignoreUnavailableScenes: true,
      },
    );
    this.renderDeltaTransforms = nextTransforms.entries;
    this.renderDeltaTransformIndex = nextTransforms;
    this.renderDeltaStyles = nextStyles.entries;
    this.renderDeltaStyleIndex = nextStyles;
    this.renderDeltaInvalidatedDependencyIds =
      nextDependencies.ids;
    this.renderDeltaDependencyIndex = nextDependencies;
    this.hitOccurrences = [];
    return Object.freeze({
      transformRecords: nextTransforms.entries.length,
      styleRecords: nextStyles.entries.length,
      invalidatedDependencies: nextDependencies.ids.length,
    });
  }

  redraw(camera, layerVisibility, { clear = true, size = null } = {}) {
    const { width, height } = this.resize(size);
    this.hitOccurrences = [];
    const context = this.context;
    resizeDrawOrderSurface(this.orderSurface, width, height, { clear });
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.filter = "none";
    if (clear) {
      context.clearRect(0, 0, width, height);
    }
    context.imageSmoothingEnabled = this.rasterImageQualityHigh;
    context.imageSmoothingQuality = this.rasterImageQualityHigh
      ? "high"
      : "low";
    const metrics = {
      sourceImages: this.imageEntities.length,
      renderDeltaTransforms: this.renderDeltaTransforms.length,
      renderDeltaStyles: this.renderDeltaStyles.length,
      visitedSourceImages: 0,
      visibleOccurrences: 0,
      loadedOccurrences: 0,
      requestedImages: 0,
      decodingImages: 0,
      failedImages: 0,
      imageFrames: 0,
      rasterImageQuality:
        this.rasterImageQualityHigh ? "high" : "draft",
      clipOperations: 0,
      xclipOperations: 0,
      truncated: false,
    };
    const sourceCount = Math.min(
      this.imageEntities.length,
      this.maximumSourceImages,
    );
    const orderedOccurrences = [];
    for (let imageIndex = 0; imageIndex < sourceCount; imageIndex += 1) {
      if (!this.orderCompositionEnabled) {
        orderedOccurrences.push({
          imageIndex,
          instanceIndex: null,
          absoluteBucket: 0,
          handle: 0n,
        });
        continue;
      }
      const sourceRecord = this.imageEntities.readEntity(
        imageIndex,
        this.displayRecord,
      );
      const ownerBlockIndex = this.blockIndexByHandle.get(
        sourceRecord.ownerHandle,
      );
      const instances = imageInstances(
        ownerBlockIndex,
        this.instanceGraph,
      );
      const localBucket =
        maskBucketFor(
          this.maskOrder,
          sourceRecord.ownerHandle,
          sourceRecord.handle,
        ) * this.maskBucketScale;
      for (
        let instanceIndex = 0;
        instanceIndex < instances.count;
        instanceIndex += 1
      ) {
        orderedOccurrences.push({
          imageIndex,
          instanceIndex,
          absoluteBucket:
            (instances.maskBases?.[instanceIndex] ?? 0) + localBucket,
          handle: sourceRecord.handle,
        });
      }
    }
    if (this.orderCompositionEnabled) {
      orderedOccurrences.sort(
        (left, right) =>
          left.absoluteBucket - right.absoluteBucket ||
          (left.handle < right.handle
            ? -1
            : left.handle > right.handle
              ? 1
              : left.imageIndex - right.imageIndex ||
                left.instanceIndex - right.instanceIndex),
      );
    }
    const visitedImageIndices = new Set();
    for (const {
      imageIndex,
      instanceIndex: orderedInstanceIndex,
      absoluteBucket: orderedAbsoluteBucket,
    } of orderedOccurrences) {
      if (metrics.visibleOccurrences >= this.maximumOccurrences) {
        metrics.truncated = true;
        break;
      }
      const record = this.imageEntities.readEntity(
        imageIndex,
        this.displayRecord,
      );
      if (!visitedImageIndices.has(imageIndex)) {
        visitedImageIndices.add(imageIndex);
        metrics.visitedSourceImages += 1;
      }
      if (
        isDwgRenderDeltaOwnerInvalidated(
          this.renderDeltaDependencyIndex,
          this.sourceId,
          record.ownerHandle,
          {
            blockIndexByHandle: this.blockIndexByHandle,
            modelBlockIndices:
              this.instanceGraph.modelBlockIndices,
          },
        )
      ) {
        continue;
      }
      if (
        (record.commonFlags & 1) !== 0 ||
        (record.displayProperties & 1) === 0
      ) {
        continue;
      }
      const ownerBlockIndex = this.blockIndexByHandle.get(
        record.ownerHandle,
      );
      const instances = imageInstances(
        ownerBlockIndex,
        this.instanceGraph,
      );
      const firstInstanceIndex = orderedInstanceIndex ?? 0;
      const endInstanceIndex =
        orderedInstanceIndex === null
          ? instances.count
          : Math.min(instances.count, orderedInstanceIndex + 1);
      for (
        let instanceIndex = firstInstanceIndex;
        instanceIndex < endInstanceIndex;
        instanceIndex += 1
      ) {
        if (!instanceIsVisible(instances, instanceIndex)) {
          continue;
        }
        const style = renderDeltaInstanceStyle(
          this.renderDeltaStyleIndex,
          instances,
          instanceIndex,
        );
        if (style?.visible === false) {
          continue;
        }
        const instanceLayerIndex =
          style?.layerIndex ??
          instances.layerIndices?.[instanceIndex] ??
          NO_LAYER;
        const inheritsInstanceLayer =
          record.layerIndex === this.sourceLayerZeroIndex &&
          instanceLayerIndex !== NO_LAYER;
        const layerIndex =
          inheritsInstanceLayer
            ? instanceLayerIndex
            : record.layerIndex === NO_LAYER || !this.layerMap
              ? record.layerIndex
              : record.layerIndex < this.layerMap.length
                ? this.layerMap[record.layerIndex]
              : this.layerMap[0];
        if (
          layerIndex !== NO_LAYER &&
          (layerVisibility[layerIndex] === false ||
            !visibleInInstanceViewport(
              this.instanceGraph,
              instances,
              instanceIndex,
              layerIndex,
            ))
        ) {
          continue;
        }
        const matrix = renderDeltaInstanceMatrix(
          this.renderDeltaTransformIndex,
          instances,
          instanceIndex,
        );
        const left = -0.5;
        const right = record.size[0] - 0.5;
        const bottom = -0.5;
        const top = record.size[1] - 0.5;
        const displayTopLeft = imageWorldPoint(
          record,
          left,
          top,
          matrix,
        );
        const displayTopRight = imageWorldPoint(
          record,
          right,
          top,
          matrix,
        );
        const displayBottomLeft = imageWorldPoint(
          record,
          left,
          bottom,
          matrix,
        );
        const displayBottomRight = imageWorldPoint(
          record,
          right,
          bottom,
          matrix,
        );
        const topLeft = worldToScreen(
          displayTopLeft,
          camera,
          width,
          height,
        );
        const topRight = worldToScreen(
          displayTopRight,
          camera,
          width,
          height,
        );
        const bottomLeft = worldToScreen(
          displayBottomLeft,
          camera,
          width,
          height,
        );
        const bottomRight = worldToScreen(
          displayBottomRight,
          camera,
          width,
          height,
        );
        const points = [topLeft, topRight, bottomLeft, bottomRight];
        if (!points.flat().every(Number.isFinite)) {
          continue;
        }
        const bounds = screenBounds(points);
        if (
          bounds.maxX < 0 ||
          bounds.minX > width ||
          bounds.maxY < 0 ||
          bounds.minY > height ||
          bounds.maxX - bounds.minX < this.minimumScreenDimension ||
          bounds.maxY - bounds.minY < this.minimumScreenDimension
        ) {
          continue;
        }
        metrics.visibleOccurrences += 1;
        if (this.hitTestingEnabled) {
        const measurementMatrix = renderDeltaInstanceMatrix(
          this.renderDeltaTransformIndex,
          instances,
          instanceIndex,
          { measurement: true },
        );
        const displayPolygon = [
          displayTopLeft,
          displayTopRight,
          displayBottomRight,
          displayBottomLeft,
        ];
        const measurementPolygon = [
          imageWorldPoint(record, left, top, measurementMatrix),
          imageWorldPoint(record, right, top, measurementMatrix),
          imageWorldPoint(record, right, bottom, measurementMatrix),
          imageWorldPoint(record, left, bottom, measurementMatrix),
        ];
        const screenPolygon = [
          topLeft,
          topRight,
          bottomRight,
          bottomLeft,
        ];
        const displayPoint = transformPoint(
          matrix,
          record.insertionPoint,
        );
        const measurementPoint = transformPoint(
          measurementMatrix,
          record.insertionPoint,
        );
        const screenInsertion = worldToScreen(
          displayPoint,
          camera,
          width,
          height,
        );
        if (
          measurementPolygon.flat().every(Number.isFinite) &&
          displayPoint.every(Number.isFinite) &&
          measurementPoint.every(Number.isFinite) &&
          screenInsertion.every(Number.isFinite)
        ) {
          this.hitOccurrences.push(
            Object.freeze({
              imageIndex,
              layerIndex,
              record: Object.freeze({
                handle: record.handle,
                ownerHandle: record.ownerHandle,
                color: record.color,
                lineWeight: record.lineWeight,
                linetypeCode: record.linetypeCode,
                brightness: record.brightness,
                contrast: record.contrast,
                fade: record.fade,
                clippingEnabled: record.clippingEnabled,
                size: Object.freeze([...record.size]),
              }),
              displayPoint: Object.freeze(displayPoint),
              measurementPoint: Object.freeze(measurementPoint),
              displayPolygon: Object.freeze(
                displayPolygon.map((point) =>
                  Object.freeze(point),
                ),
              ),
              measurementPolygon: Object.freeze(
                measurementPolygon.map((point) =>
                  Object.freeze(point),
                ),
              ),
              screenPolygon: Object.freeze(
                screenPolygon.map((point) =>
                  Object.freeze(point),
                ),
              ),
              screenInsertion: Object.freeze(screenInsertion),
              coordinateSpace:
                instances.coordinateSpaceIds?.[instanceIndex] ?? 1,
            }),
          );
        }
        }
        const asset = this.assetStore.lookup(
          this.cacheId,
          imageIndex,
          {
            width: Math.max(
              Math.hypot(
                topRight[0] - topLeft[0],
                topRight[1] - topLeft[1],
              ),
              Math.hypot(
                bottomRight[0] - bottomLeft[0],
                bottomRight[1] - bottomLeft[1],
              ),
            ),
            height: Math.max(
              Math.hypot(
                bottomLeft[0] - topLeft[0],
                bottomLeft[1] - topLeft[1],
              ),
              Math.hypot(
                bottomRight[0] - topRight[0],
                bottomRight[1] - topRight[1],
              ),
            ),
          },
        );
        const imagePath = this.imageEntities.readPath(imageIndex);
        const embeddedPresentation = imagePath.startsWith("@embedded/");
        const layerColor = viewportLayerColor(
          this.instanceGraph,
          viewportStyleRow(instances, instanceIndex),
          layerIndex,
          this.displayLayers?.[layerIndex]?.color ?? 0,
        );
        const effectiveColor = this.externalReferenceOverrides
          ? BY_LAYER_ENTITY_COLOR
          : record.color;
        const frameColor = decodeCadColor(effectiveColor, {
          layer: { color: layerColor },
          byBlock: decodeCadColor(
            style?.color ??
              instances.colors?.[instanceIndex] ??
              ((2 << 30) | 7),
          ),
        });
        if (asset.status === "missing") {
          const requested = this.requestAsset({
            cacheId: this.cacheId,
            imageIndex,
            path: imagePath,
          });
          metrics.requestedImages += requested ? 1 : 0;
          if (!embeddedPresentation) {
            this.#drawImageFrame(
              record,
              matrix,
              [topLeft, topRight, bottomRight, bottomLeft],
              instances.clipIds?.[instanceIndex] ?? 0,
              camera,
              width,
              height,
              frameColor,
              metrics,
            );
          }
          continue;
        }
        if (asset.status === "decoding") {
          metrics.decodingImages += 1;
          if (!embeddedPresentation) {
            this.#drawImageFrame(
              record,
              matrix,
              [topLeft, topRight, bottomRight, bottomLeft],
              instances.clipIds?.[instanceIndex] ?? 0,
              camera,
              width,
              height,
              frameColor,
              metrics,
            );
          }
          continue;
        }
        if (asset.status === "error") {
          metrics.failedImages += 1;
          context.save();
          this.#applyXClip(
            instances.clipIds?.[instanceIndex] ?? 0,
            camera,
            width,
            height,
            metrics,
          );
          this.#applyImageClip(
            record,
            matrix,
            camera,
            width,
            height,
            metrics,
          );
          drawUnavailableImage(context, [
            topLeft,
            topRight,
            bottomRight,
            bottomLeft,
          ]);
          context.restore();
          continue;
        }
        context.save();
        const imageQualityHigh =
          embeddedPresentation || this.rasterImageQualityHigh;
        context.imageSmoothingEnabled = imageQualityHigh;
        context.imageSmoothingQuality = imageQualityHigh
          ? "high"
          : "low";
        this.#applyXClip(
          instances.clipIds?.[instanceIndex] ?? 0,
          camera,
          width,
          height,
          metrics,
        );
        this.#applyImageClip(
          record,
          matrix,
          camera,
          width,
          height,
          metrics,
        );
        const occurrenceOpacity =
          style?.opacity ??
          instances.opacities?.[instanceIndex] ??
          1;
        const opacity = Math.max(
          0,
          Math.min(
            1,
            decodeCadOpacity(effectiveColor, {
              layer: decodeCadOpacity(
                viewportLayerColor(
                  this.instanceGraph,
                  viewportStyleRow(instances, instanceIndex),
                  layerIndex,
                  this.displayLayers?.[layerIndex]?.color ?? 0,
                ),
              ),
              byBlock: 1,
            }) *
              occurrenceOpacity *
              (1 - record.fade / 100),
          ),
        );
        context.globalAlpha = opacity;
        context.filter =
          `brightness(${Math.max(record.brightness / 50, 0)}) ` +
          `contrast(${Math.max(record.contrast / 50, 0)})`;
        context.setTransform(
          (topRight[0] - topLeft[0]) / asset.width,
          (topRight[1] - topLeft[1]) / asset.width,
          (bottomLeft[0] - topLeft[0]) / asset.height,
          (bottomLeft[1] - topLeft[1]) / asset.height,
          topLeft[0],
          topLeft[1],
        );
        if (embeddedPresentation) {
          // OLE metafile previews use transparent pixels for their paper.
          context.fillStyle = "#fff";
          context.fillRect(0, 0, asset.width, asset.height);
        }
        context.drawImage(asset.bitmap, 0, 0);
        context.restore();
        if (!embeddedPresentation) {
          this.#drawImageFrame(
            record,
            matrix,
            [topLeft, topRight, bottomRight, bottomLeft],
            instances.clipIds?.[instanceIndex] ?? 0,
            camera,
            width,
            height,
            frameColor,
            metrics,
          );
        }
        if (this.orderSurface && this.orderScratch) {
          const scratch = this.orderScratch.canvas;
          const scratchContext = this.orderScratch.context;
          if (
            scratch.width !== asset.width ||
            scratch.height !== asset.height
          ) {
            scratch.width = asset.width;
            scratch.height = asset.height;
          }
          scratchContext.setTransform(1, 0, 0, 1, 0, 0);
          scratchContext.globalAlpha = 1;
          scratchContext.globalCompositeOperation = "source-over";
          scratchContext.filter = "none";
          scratchContext.imageSmoothingEnabled = imageQualityHigh;
          scratchContext.imageSmoothingQuality = imageQualityHigh
            ? "high"
            : "low";
          scratchContext.clearRect(0, 0, asset.width, asset.height);
          if (embeddedPresentation) {
            scratchContext.fillStyle = "#fff";
            scratchContext.fillRect(0, 0, asset.width, asset.height);
          }
          scratchContext.drawImage(asset.bitmap, 0, 0);
          scratchContext.globalCompositeOperation = "source-in";
          scratchContext.fillStyle = encodedDrawOrderColor(
            orderedInstanceIndex === null
              ? (instances.maskBases?.[instanceIndex] ?? 0) +
                maskBucketFor(
                  this.maskOrder,
                  record.ownerHandle,
                  record.handle,
                ) *
                  this.maskBucketScale
              : orderedAbsoluteBucket,
          );
          scratchContext.fillRect(0, 0, asset.width, asset.height);
          scratchContext.globalCompositeOperation = "source-over";

          const colorContext = this.context;
          this.context = this.orderSurface.context;
          this.context.save();
          try {
            const orderMetrics = {
              clipOperations: 0,
              xclipOperations: 0,
            };
            this.#applyXClip(
              instances.clipIds?.[instanceIndex] ?? 0,
              camera,
              width,
              height,
              orderMetrics,
            );
            this.#applyImageClip(
              record,
              matrix,
              camera,
              width,
              height,
              orderMetrics,
            );
            this.context.globalAlpha = 1;
            this.context.filter = "none";
            this.context.imageSmoothingEnabled = imageQualityHigh;
            this.context.imageSmoothingQuality = imageQualityHigh
              ? "high"
              : "low";
            this.context.setTransform(
              (topRight[0] - topLeft[0]) / asset.width,
              (topRight[1] - topLeft[1]) / asset.width,
              (bottomLeft[0] - topLeft[0]) / asset.height,
              (bottomLeft[1] - topLeft[1]) / asset.height,
              topLeft[0],
              topLeft[1],
            );
            this.context.drawImage(scratch, 0, 0);
          } finally {
            this.context.restore();
            this.context = colorContext;
          }
        }
        metrics.loadedOccurrences += 1;
      }
    }
    if (sourceCount < this.imageEntities.length) {
      metrics.truncated = true;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.filter = "none";
    this.lastMetrics = Object.freeze({
      ...metrics,
      memory: this.assetStore.snapshot(),
    });
    return this.lastMetrics;
  }

  hitTest(
    x,
    y,
    {
      snapKinds = ["entity"],
      tolerancePixels = 6,
    } = {},
  ) {
    const enabled = new Set(snapKinds);
    if (
      (!enabled.has("entity") && !enabled.has("insertion")) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return null;
    }
    const scaleX =
      Math.max(this.canvas.width, 1) /
      Math.max(this.canvas.clientWidth, 1);
    const scaleY =
      Math.max(this.canvas.height, 1) /
      Math.max(this.canvas.clientHeight, 1);
    const scale = Math.max(scaleX, scaleY);
    const point = [x * scaleX, y * scaleY];
    const tolerance = scale * Math.max(tolerancePixels, 0);
    let best = null;
    for (
      let index = this.hitOccurrences.length - 1;
      index >= 0;
      index -= 1
    ) {
      const occurrence = this.hitOccurrences[index];
      const deviceDistance = enabled.has("entity")
        ? screenPolygonDistance(point, occurrence.screenPolygon)
        : Math.hypot(
            point[0] - occurrence.screenInsertion[0],
            point[1] - occurrence.screenInsertion[1],
          );
      if (deviceDistance > tolerance) {
        continue;
      }
      const distancePixels = deviceDistance / scale;
      if (best && distancePixels >= best.distancePixels) {
        continue;
      }
      const fullRecord =
        typeof this.imageEntities.get === "function"
          ? this.imageEntities.get(occurrence.imageIndex)
          : Object.freeze({
              ...occurrence.record,
              path: this.imageEntities.readPath(
                occurrence.imageIndex,
              ),
            });
      best = Object.freeze({
        kind: enabled.has("entity") ? "entity" : "insertion",
        displayPoint: occurrence.displayPoint,
        measurementPoint: occurrence.measurementPoint,
        displayPolygon: occurrence.displayPolygon,
        measurementPolygon: occurrence.measurementPolygon,
        distancePixels,
        coordinateSpace: occurrence.coordinateSpace,
        handle: fullRecord.handle,
        layerIndex: occurrence.layerIndex,
        layerName:
          this.displayLayers[occurrence.layerIndex]?.name ?? "",
        sourceKind: null,
        sourceKindName: "이미지",
        entityType: "image",
        entityRecord: fullRecord,
        color: fullRecord.color,
        lineWeight: fullRecord.lineWeight,
        linetypeCode:
          this.linetypeMap &&
          fullRecord.linetypeCode < this.linetypeMap.length
            ? this.linetypeMap[fullRecord.linetypeCode]
            : fullRecord.linetypeCode,
        approximated: false,
        sourceId: this.sourceId,
        sourceLabel: this.sourceLabel,
      });
    }
    return best;
  }

  #applyImageClip(
    record,
    matrix,
    camera,
    width,
    height,
    metrics,
  ) {
    if (
      !record.clippingEnabled ||
      (record.displayProperties & 4) === 0 ||
      record.clipVertexCount === 0
    ) {
      return;
    }
    const points = boundaryPoints(record, this.imageEntities).map(
      ([x, y]) =>
        worldToScreen(
          imageWorldPoint(record, x, y, matrix),
          camera,
          width,
          height,
        ),
    );
    if (points.length < 3 || !points.flat().every(Number.isFinite)) {
      return;
    }
    this.context.beginPath();
    if (record.clipMode === 1) {
      this.context.rect(0, 0, width, height);
    }
    this.context.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) {
      this.context.lineTo(points[index][0], points[index][1]);
    }
    this.context.closePath();
    this.context.clip(record.clipMode === 1 ? "evenodd" : "nonzero");
    metrics.clipOperations += 1;
  }

  #drawImageFrame(
    record,
    matrix,
    fallbackPolygon,
    clipId,
    camera,
    width,
    height,
    color,
    metrics,
  ) {
    if (this.imageFrame === 0) {
      return;
    }
    let polygon = fallbackPolygon;
    if (
      record.clippingEnabled &&
      (record.displayProperties & 4) !== 0 &&
      record.clipVertexCount > 0
    ) {
      polygon = boundaryPoints(record, this.imageEntities).map(([x, y]) =>
        worldToScreen(
          imageWorldPoint(record, x, y, matrix),
          camera,
          width,
          height,
        ),
      );
    }
    this.context.save();
    this.#applyXClip(clipId, camera, width, height, metrics);
    if (drawImageFrame(this.context, polygon, color)) {
      metrics.imageFrames += 1;
    }
    this.context.restore();
  }

  #applyXClip(clipId, camera, width, height, metrics) {
    if (!clipId) {
      return;
    }
    const chain = [];
    let current = clipId;
    let depth = 0;
    while (current > 0 && depth < 64) {
      const node = this.instanceGraph.clipNodes?.[current - 1];
      if (!node || node.id !== current) {
        return;
      }
      chain.push(node);
      current = node.parentId;
      depth += 1;
    }
    if (current > 0 || chain.length === 0) {
      return;
    }
    for (const node of chain.reverse()) {
      const points = node.points.map((point) =>
        worldToScreen(point, camera, width, height),
      );
      this.context.beginPath();
      if (node.inverted) {
        this.context.rect(0, 0, width, height);
      }
      this.context.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) {
        this.context.lineTo(points[index][0], points[index][1]);
      }
      this.context.closePath();
      this.context.clip(node.inverted ? "evenodd" : "nonzero");
      metrics.xclipOperations += 1;
    }
  }

  dispose() {
    const { width, height } = this.resize();
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, width, height);
    this.renderDeltaTransforms = Object.freeze([]);
    this.renderDeltaTransformIndex =
      indexDwgRenderDeltaTransforms([], {
        sourceId: this.sourceId,
        instanceGraph: this.instanceGraph,
      });
    this.renderDeltaStyles = Object.freeze([]);
    this.renderDeltaStyleIndex = indexDwgRenderDeltaStyles([], {
      sourceId: this.sourceId,
      instanceGraph: this.instanceGraph,
    });
    this.renderDeltaInvalidatedDependencyIds = Object.freeze([]);
    this.renderDeltaDependencyIndex =
      indexDwgRenderDeltaDependencies([], {
        scenes: new Map([
          [
            this.sourceId,
            {
              blocks: this.blocks,
              instanceGraph: this.instanceGraph,
            },
          ],
        ]),
      });
    this.hitOccurrences = [];
  }
}

export class CompositeRasterImageOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.orderCanvas = drawOrderSurfaceFor(canvas)?.canvas ?? null;
    this.overlays = [];
    this.aggregateScratch = createDrawOrderScratch(canvas);
    this.lastOrderedComposition = Object.freeze({
      attempted: false,
      succeeded: false,
      results: Object.freeze([]),
    });
    this.hitTestingEnabled = false;
    this.renderDeltaTransforms = Object.freeze([]);
    this.renderDeltaStyles = Object.freeze([]);
    this.renderDeltaInvalidatedDependencyIds = Object.freeze([]);
  }

  add(overlay, { first = false } = {}) {
    if (!overlay || typeof overlay.redraw !== "function") {
      throw new TypeError(
        "composite raster image overlay requires a drawable overlay",
      );
    }
    overlay.setHitTestingEnabled?.(this.hitTestingEnabled);
    if (typeof overlay.setRenderDeltaState === "function") {
      overlay.setRenderDeltaState({
        transforms: this.renderDeltaTransforms,
        styles: this.renderDeltaStyles,
        invalidatedDependencyIds:
          this.renderDeltaInvalidatedDependencyIds,
      });
    } else {
      overlay.setRenderDeltaTransforms?.(
        this.renderDeltaTransforms,
      );
      overlay.setRenderDeltaStyles?.(this.renderDeltaStyles);
      overlay.setRenderDeltaInvalidations?.(
        this.renderDeltaInvalidatedDependencyIds,
      );
    }
    if (first) {
      this.overlays.unshift(overlay);
    } else {
      this.overlays.push(overlay);
    }
    return overlay;
  }

  redraw(
    camera,
    layerVisibility,
    {
      size = null,
      canDrawOrderedLayer = null,
      drawOrderedLayer = null,
    } = {},
  ) {
    const metrics = {
      sourceImages: 0,
      renderDeltaTransforms: 0,
      renderDeltaStyles: 0,
      visitedSourceImages: 0,
      visibleOccurrences: 0,
      loadedOccurrences: 0,
      requestedImages: 0,
      decodingImages: 0,
      failedImages: 0,
      clipOperations: 0,
      xclipOperations: 0,
      truncated: false,
      memory: null,
    };
    this.lastOrderedComposition = Object.freeze({
      attempted: false,
      succeeded: false,
      results: Object.freeze([]),
    });
    if (this.overlays.length === 0) {
      if (size) {
        this.canvas.width = size.width;
        this.canvas.height = size.height;
      }
      const context = this.canvas.getContext("2d", { alpha: true });
      context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      resizeDrawOrderSurface(
        drawOrderSurfaceFor(this.canvas),
        this.canvas.width,
        this.canvas.height,
        { clear: true },
      );
      return Object.freeze(metrics);
    }
    const accumulate = (current) => {
      for (const name of [
        "sourceImages",
        "renderDeltaTransforms",
        "renderDeltaStyles",
        "visitedSourceImages",
        "visibleOccurrences",
        "loadedOccurrences",
        "requestedImages",
        "decodingImages",
        "failedImages",
        "clipOperations",
        "xclipOperations",
      ]) {
        metrics[name] += current[name] ?? 0;
      }
      metrics.truncated ||= Boolean(current.truncated);
      metrics.memory = current.memory ?? metrics.memory;
    };
    const canStreamLayers =
      this.overlays.length > 1 &&
      this.aggregateScratch &&
      this.overlays.every((overlay) => overlay.orderCanvas) &&
      typeof canDrawOrderedLayer === "function" &&
      typeof drawOrderedLayer === "function";
    const firstOverlay = this.overlays[0];
    accumulate(
      firstOverlay.redraw(camera, layerVisibility, {
        clear: true,
        size,
      }),
    );
    if (canStreamLayers && canDrawOrderedLayer(firstOverlay)) {
      const width = this.canvas.width;
      const height = this.canvas.height;
      const aggregate = this.aggregateScratch;
      if (
        aggregate.canvas.width !== width ||
        aggregate.canvas.height !== height
      ) {
        aggregate.canvas.width = width;
        aggregate.canvas.height = height;
      }
      aggregate.context.setTransform(1, 0, 0, 1, 0, 0);
      aggregate.context.globalAlpha = 1;
      aggregate.context.globalCompositeOperation = "source-over";
      aggregate.context.filter = "none";
      aggregate.context.clearRect(0, 0, width, height);
      const results = [];
      const composeCurrent = (overlay) => {
        results.push(drawOrderedLayer(overlay));
        aggregate.context.drawImage(overlay.canvas, 0, 0);
      };
      composeCurrent(firstOverlay);
      for (let index = 1; index < this.overlays.length; index += 1) {
        const overlay = this.overlays[index];
        accumulate(
          overlay.redraw(camera, layerVisibility, {
            clear: true,
            size,
          }),
        );
        composeCurrent(overlay);
      }
      const context = this.canvas.getContext("2d", { alpha: true });
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.filter = "none";
      context.clearRect(0, 0, width, height);
      context.drawImage(aggregate.canvas, 0, 0);
      this.lastOrderedComposition = Object.freeze({
        attempted: true,
        succeeded: results.every(Boolean),
        results: Object.freeze(results),
      });
    } else {
      for (let index = 1; index < this.overlays.length; index += 1) {
        const overlay = this.overlays[index];
        accumulate(
          overlay.redraw(camera, layerVisibility, {
            clear: false,
            size,
          }),
        );
      }
    }
    return Object.freeze(metrics);
  }

  setHitTestingEnabled(enabled) {
    this.hitTestingEnabled = Boolean(enabled);
    for (const overlay of this.overlays) {
      overlay.setHitTestingEnabled?.(this.hitTestingEnabled);
    }
    return this.hitTestingEnabled;
  }

  setRenderDeltaTransforms(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError(
        "composite image render delta transforms must be an array",
      );
    }
    const next = Object.freeze([...entries]);
    for (const overlay of this.overlays) {
      overlay.setRenderDeltaTransforms?.(next);
    }
    this.renderDeltaTransforms = next;
    return next.length;
  }

  setRenderDeltaStyles(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError(
        "composite image render delta styles must be an array",
      );
    }
    const next = Object.freeze([...entries]);
    for (const overlay of this.overlays) {
      overlay.setRenderDeltaStyles?.(next);
    }
    this.renderDeltaStyles = next;
    return next.length;
  }

  setRenderDeltaInvalidations(dependencyIds) {
    if (!Array.isArray(dependencyIds)) {
      throw new TypeError(
        "composite image render delta invalidations must be an array",
      );
    }
    const next = Object.freeze([...new Set(dependencyIds)].sort());
    for (const overlay of this.overlays) {
      overlay.setRenderDeltaInvalidations?.(next);
    }
    this.renderDeltaInvalidatedDependencyIds = next;
    return next.length;
  }

  setRenderDeltaState({
    transforms = Object.freeze([]),
    styles = Object.freeze([]),
    invalidatedDependencyIds = Object.freeze([]),
  } = {}) {
    if (
      !Array.isArray(transforms) ||
      !Array.isArray(styles) ||
      !Array.isArray(invalidatedDependencyIds)
    ) {
      throw new TypeError(
        "composite image render delta state is invalid",
      );
    }
    const nextTransforms = Object.freeze([...transforms]);
    const nextStyles = Object.freeze([...styles]);
    const nextDependencies = Object.freeze([
      ...new Set(invalidatedDependencyIds),
    ].sort());
    for (const overlay of this.overlays) {
      if (typeof overlay.setRenderDeltaState === "function") {
        overlay.setRenderDeltaState({
          transforms: nextTransforms,
          styles: nextStyles,
          invalidatedDependencyIds: nextDependencies,
        });
      } else {
        overlay.setRenderDeltaTransforms?.(nextTransforms);
        overlay.setRenderDeltaStyles?.(nextStyles);
        overlay.setRenderDeltaInvalidations?.(nextDependencies);
      }
    }
    this.renderDeltaTransforms = nextTransforms;
    this.renderDeltaStyles = nextStyles;
    this.renderDeltaInvalidatedDependencyIds = nextDependencies;
    return Object.freeze({
      transformRecords: nextTransforms.length,
      styleRecords: nextStyles.length,
      invalidatedDependencies: nextDependencies.length,
    });
  }

  hitTest(x, y, options) {
    let best = null;
    for (let index = this.overlays.length - 1; index >= 0; index -= 1) {
      const candidate = this.overlays[index].hitTest?.(x, y, options);
      if (
        candidate &&
        (!best || candidate.distancePixels < best.distancePixels)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  dispose() {
    for (const overlay of this.overlays) {
      overlay.dispose();
    }
    this.overlays.length = 0;
    if (this.aggregateScratch) {
      this.aggregateScratch.canvas.width = 1;
      this.aggregateScratch.canvas.height = 1;
    }
    this.lastOrderedComposition = Object.freeze({
      attempted: false,
      succeeded: false,
      results: Object.freeze([]),
    });
    this.renderDeltaTransforms = Object.freeze([]);
    this.renderDeltaStyles = Object.freeze([]);
    this.renderDeltaInvalidatedDependencyIds = Object.freeze([]);
  }
}

export {
  DEFAULT_MAXIMUM_COMPRESSED_BYTES,
  DEFAULT_MAXIMUM_DECODED_PIXELS,
  DEFAULT_MAXIMUM_DECODE_DIMENSION,
  DEFAULT_MAXIMUM_IMAGE_PIXELS,
  bitmapTargetSize,
  requestedBitmapTargetSize,
};
