import {
  identityMat4,
  insertCellMatrix,
  multiplyMat4Into,
  transformPoint,
} from "./math.mjs?v=1.25.0";
import {
  MAX_GLOBAL_MASK_BUCKET,
  maskBucketBefore,
  maskSpanForBlock,
} from "./mask-order.mjs";
import {
  cadOpacityCode,
  decodeCadOpacity,
} from "./cad-color.mjs";

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_INSTANCES = 1_000_000;
const MATRIX_VALUES = 16;
const MAX_MATRICES_PER_CHUNK = 256;
const NO_LAYER_OVERRIDE = 0xffffffff;
const DEFAULT_BYBLOCK_COLOR = (2 << 30) | 7;
export const CoordinateSpaceKind = Object.freeze({
  Paper: 0,
  Model: 1,
});
const ROOT_INSTANCES = Object.freeze({
  data: identityMat4(),
  measurementData: identityMat4(),
  coordinateSpaceIds: new Uint8Array([CoordinateSpaceKind.Model]),
  maskBases: new Uint32Array([0]),
  clipIds: new Uint32Array([0]),
  colors: new Uint32Array([DEFAULT_BYBLOCK_COLOR]),
  layerIndices: new Uint32Array([NO_LAYER_OVERRIDE]),
  colorInherited: new Uint8Array([1]),
  layerInherited: new Uint8Array([1]),
  opacities: new Float32Array([1]),
  opacityInherited: new Uint8Array([1]),
  lineWeights: new Int16Array([-3]),
  lineWeightInherited: new Uint8Array([1]),
  linetypeCodes: new Uint16Array([2]),
  linetypeInherited: new Uint8Array([1]),
  visibilityRows: new Uint32Array([0]),
  handles: new BigUint64Array([0n]),
  count: 1,
  length: 1,
});

class MatrixCollectionBuilder {
  constructor(includeMaskBases, initialCapacity = 0) {
    if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 0) {
      throw new RangeError("instance capacity must be non-negative");
    }
    this.includeMaskBases = includeMaskBases;
    this.initialCapacity = initialCapacity;
    this.chunks = [];
    this.measurementChunks = [];
    this.coordinateSpaceChunks = [];
    this.maskBaseChunks = [];
    this.clipIdChunks = [];
    this.colorChunks = [];
    this.layerIndexChunks = [];
    this.colorInheritedChunks = [];
    this.layerInheritedChunks = [];
    this.opacityChunks = [];
    this.opacityInheritedChunks = [];
    this.lineWeightChunks = [];
    this.lineWeightInheritedChunks = [];
    this.linetypeCodeChunks = [];
    this.linetypeInheritedChunks = [];
    this.visibilityRowChunks = [];
    this.handleChunks = [];
    this.chunkCapacities = [];
    this.chunkCounts = [];
    this.count = 0;
  }

  add(
    matrix,
    maskBase,
    clipId,
    color,
    layerIndex,
    colorInherited,
    layerInherited,
    opacity,
    opacityInherited,
    lineWeight,
    lineWeightInherited,
    linetypeCode,
    linetypeInherited,
    visibilityRow = 0,
    measurementMatrix = matrix,
    coordinateSpace = CoordinateSpaceKind.Model,
    handle = 0n,
  ) {
    const instanceIndex = this.count;
    let chunkIndex = this.chunks.length - 1;
    let chunkCapacity = this.chunkCapacities[chunkIndex] ?? 0;
    let indexInChunk = this.chunkCounts[chunkIndex] ?? 0;
    if (chunkIndex < 0 || indexInChunk >= chunkCapacity) {
      if (this.initialCapacity > 0 && this.chunks.length > 0) {
        throw new RangeError(
          "precomputed instance capacity was exceeded",
        );
      }
      const previousCapacity = chunkCapacity;
      chunkCapacity =
        previousCapacity === 0
          ? this.initialCapacity || 16
          : Math.min(
              previousCapacity * 4,
              MAX_MATRICES_PER_CHUNK,
            );
      chunkIndex = this.chunks.length;
      indexInChunk = 0;
      this.chunkCapacities[chunkIndex] = chunkCapacity;
      this.chunkCounts[chunkIndex] = 0;
      this.chunks[chunkIndex] = new Float64Array(
        chunkCapacity * MATRIX_VALUES,
      );
      this.measurementChunks[chunkIndex] = new Float64Array(
        chunkCapacity * MATRIX_VALUES,
      );
      this.coordinateSpaceChunks[chunkIndex] = new Uint8Array(
        chunkCapacity,
      );
      if (this.includeMaskBases) {
        this.maskBaseChunks[chunkIndex] = new Uint32Array(
          chunkCapacity,
        );
      }
      this.clipIdChunks[chunkIndex] = new Uint32Array(
        chunkCapacity,
      );
      this.colorChunks[chunkIndex] = new Uint32Array(chunkCapacity);
      this.layerIndexChunks[chunkIndex] = new Uint32Array(
        chunkCapacity,
      );
      this.colorInheritedChunks[chunkIndex] = new Uint8Array(
        chunkCapacity,
      );
      this.layerInheritedChunks[chunkIndex] = new Uint8Array(
        chunkCapacity,
      );
      this.opacityChunks[chunkIndex] = new Float32Array(
        chunkCapacity,
      );
      this.opacityInheritedChunks[chunkIndex] = new Uint8Array(
        chunkCapacity,
      );
      this.lineWeightChunks[chunkIndex] = new Int16Array(
        chunkCapacity,
      );
      this.lineWeightInheritedChunks[chunkIndex] = new Uint8Array(
        chunkCapacity,
      );
      this.linetypeCodeChunks[chunkIndex] = new Uint16Array(
        chunkCapacity,
      );
      this.linetypeInheritedChunks[chunkIndex] = new Uint8Array(
        chunkCapacity,
      );
      this.visibilityRowChunks[chunkIndex] = new Uint32Array(
        chunkCapacity,
      );
      this.handleChunks[chunkIndex] = new BigUint64Array(
        chunkCapacity,
      );
    }
    this.chunks[chunkIndex].set(matrix, indexInChunk * MATRIX_VALUES);
    this.measurementChunks[chunkIndex].set(
      measurementMatrix,
      indexInChunk * MATRIX_VALUES,
    );
    this.coordinateSpaceChunks[chunkIndex][indexInChunk] = coordinateSpace;
    if (this.includeMaskBases) {
      this.maskBaseChunks[chunkIndex][indexInChunk] = maskBase;
    }
    this.clipIdChunks[chunkIndex][indexInChunk] = clipId;
    this.colorChunks[chunkIndex][indexInChunk] = color;
    this.layerIndexChunks[chunkIndex][indexInChunk] = layerIndex;
    this.colorInheritedChunks[chunkIndex][indexInChunk] =
      colorInherited ? 1 : 0;
    this.layerInheritedChunks[chunkIndex][indexInChunk] =
      layerInherited ? 1 : 0;
    this.opacityChunks[chunkIndex][indexInChunk] = opacity;
    this.opacityInheritedChunks[chunkIndex][indexInChunk] =
      opacityInherited ? 1 : 0;
    this.lineWeightChunks[chunkIndex][indexInChunk] = lineWeight;
    this.lineWeightInheritedChunks[chunkIndex][indexInChunk] =
      lineWeightInherited ? 1 : 0;
    this.linetypeCodeChunks[chunkIndex][indexInChunk] = linetypeCode;
    this.linetypeInheritedChunks[chunkIndex][indexInChunk] =
      linetypeInherited ? 1 : 0;
    this.visibilityRowChunks[chunkIndex][indexInChunk] = visibilityRow;
    this.handleChunks[chunkIndex][indexInChunk] =
      typeof handle === "bigint" && handle >= 0n ? handle : 0n;
    this.chunkCounts[chunkIndex] = indexInChunk + 1;
    this.count += 1;
    return instanceIndex;
  }

  finish() {
    const exactSingleChunk =
      this.chunks.length === 1 &&
      this.count === this.chunkCapacities[0];
    const data = exactSingleChunk
      ? this.chunks[0]
      : new Float64Array(this.count * MATRIX_VALUES);
    const measurementData = exactSingleChunk
      ? this.measurementChunks[0]
      : new Float64Array(this.count * MATRIX_VALUES);
    const coordinateSpaceIds = exactSingleChunk
      ? this.coordinateSpaceChunks[0]
      : new Uint8Array(this.count);
    const maskBases = this.includeMaskBases
      ? exactSingleChunk
        ? this.maskBaseChunks[0]
        : new Uint32Array(this.count)
      : null;
    const clipIds = exactSingleChunk
      ? this.clipIdChunks[0]
      : new Uint32Array(this.count);
    const colors = exactSingleChunk
      ? this.colorChunks[0]
      : new Uint32Array(this.count);
    const layerIndices = exactSingleChunk
      ? this.layerIndexChunks[0]
      : new Uint32Array(this.count);
    const colorInherited = exactSingleChunk
      ? this.colorInheritedChunks[0]
      : new Uint8Array(this.count);
    const layerInherited = exactSingleChunk
      ? this.layerInheritedChunks[0]
      : new Uint8Array(this.count);
    const opacities = exactSingleChunk
      ? this.opacityChunks[0]
      : new Float32Array(this.count);
    const opacityInherited = exactSingleChunk
      ? this.opacityInheritedChunks[0]
      : new Uint8Array(this.count);
    const lineWeights = exactSingleChunk
      ? this.lineWeightChunks[0]
      : new Int16Array(this.count);
    const lineWeightInherited = exactSingleChunk
      ? this.lineWeightInheritedChunks[0]
      : new Uint8Array(this.count);
    const linetypeCodes = exactSingleChunk
      ? this.linetypeCodeChunks[0]
      : new Uint16Array(this.count);
    const linetypeInherited = exactSingleChunk
      ? this.linetypeInheritedChunks[0]
      : new Uint8Array(this.count);
    const visibilityRows = exactSingleChunk
      ? this.visibilityRowChunks[0]
      : new Uint32Array(this.count);
    const handles = exactSingleChunk
      ? this.handleChunks[0]
      : new BigUint64Array(this.count);
    let matrixDestination = 0;
    let instanceDestination = 0;
    for (
      let index = 0;
      !exactSingleChunk && index < this.chunks.length;
      index += 1
    ) {
      const chunk = this.chunks[index];
      const instanceLength = this.chunkCounts[index];
      const matrixLength = instanceLength * MATRIX_VALUES;
      data.set(chunk.subarray(0, matrixLength), matrixDestination);
      measurementData.set(
        this.measurementChunks[index].subarray(0, matrixLength),
        matrixDestination,
      );
      coordinateSpaceIds.set(
        this.coordinateSpaceChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      if (this.includeMaskBases) {
        const maskChunk = this.maskBaseChunks[index];
        maskBases.set(
          maskChunk.subarray(0, instanceLength),
          instanceDestination,
        );
      }
      clipIds.set(
        this.clipIdChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      colors.set(
        this.colorChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      layerIndices.set(
        this.layerIndexChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      colorInherited.set(
        this.colorInheritedChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      layerInherited.set(
        this.layerInheritedChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      opacities.set(
        this.opacityChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      opacityInherited.set(
        this.opacityInheritedChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      lineWeights.set(
        this.lineWeightChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      lineWeightInherited.set(
        this.lineWeightInheritedChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      linetypeCodes.set(
        this.linetypeCodeChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      linetypeInherited.set(
        this.linetypeInheritedChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      visibilityRows.set(
        this.visibilityRowChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      handles.set(
        this.handleChunks[index].subarray(0, instanceLength),
        instanceDestination,
      );
      matrixDestination += matrixLength;
      instanceDestination += instanceLength;
    }
    const result = {
      data,
      measurementData,
      coordinateSpaceIds,
      count: this.count,
      length: this.count,
      clipIds,
      colors,
      layerIndices,
      colorInherited,
      layerInherited,
      opacities,
      opacityInherited,
      lineWeights,
      lineWeightInherited,
      linetypeCodes,
      linetypeInherited,
      visibilityRows,
      handles,
    };
    if (maskBases) {
      result.maskBases = maskBases;
    }
    return Object.freeze(result);
  }
}

function rectanglePoints(points) {
  const minimumX = Math.min(points[0][0], points[1][0]);
  const maximumX = Math.max(points[0][0], points[1][0]);
  const minimumY = Math.min(points[0][1], points[1][1]);
  const maximumY = Math.max(points[0][1], points[1][1]);
  return [
    [minimumX, minimumY, 0],
    [maximumX, minimumY, 0],
    [maximumX, maximumY, 0],
    [minimumX, maximumY, 0],
  ];
}

export function createClipNode(
  id,
  parentId,
  points,
  inverted = false,
  {
    frame = false,
    color = DEFAULT_BYBLOCK_COLOR,
    layerIndex = NO_LAYER_OVERRIDE,
  } = {},
) {
  const minimum = [Infinity, Infinity];
  const maximum = [-Infinity, -Infinity];
  for (const point of points) {
    minimum[0] = Math.min(minimum[0], point[0]);
    minimum[1] = Math.min(minimum[1], point[1]);
    maximum[0] = Math.max(maximum[0], point[0]);
    maximum[1] = Math.max(maximum[1], point[1]);
  }
  return Object.freeze({
    id,
    parentId,
    inverted: Boolean(inverted),
    frame: Boolean(frame),
    color: Number.isInteger(color)
      ? color >>> 0
      : DEFAULT_BYBLOCK_COLOR,
    layerIndex:
      Number.isInteger(layerIndex) && layerIndex >= 0
        ? layerIndex
        : NO_LAYER_OVERRIDE,
    points: Object.freeze(
      points.map((point) => Object.freeze([...point])),
    ),
    bounds: Object.freeze({
      min: Object.freeze(minimum),
      max: Object.freeze(maximum),
    }),
  });
}

export function effectiveClipBounds(clipNodes, clipId) {
  let minimumX = -Infinity;
  let minimumY = -Infinity;
  let maximumX = Infinity;
  let maximumY = Infinity;
  let current = clipId;
  let depth = 0;
  while (current > 0 && depth < DEFAULT_MAX_DEPTH) {
    const node = clipNodes?.[current - 1];
    if (!node || node.id !== current) {
      return null;
    }
    if (!node.inverted) {
      minimumX = Math.max(minimumX, node.bounds.min[0]);
      minimumY = Math.max(minimumY, node.bounds.min[1]);
      maximumX = Math.min(maximumX, node.bounds.max[0]);
      maximumY = Math.min(maximumY, node.bounds.max[1]);
    }
    current = node.parentId;
    depth += 1;
  }
  if (current > 0 || minimumX > maximumX || minimumY > maximumY) {
    return null;
  }
  return Object.freeze({
    min: Object.freeze([minimumX, minimumY]),
    max: Object.freeze([maximumX, maximumY]),
  });
}

function normalizeLayerStyleRows(
  rows,
  rowCount,
  baseRow,
  TypedArray,
  label,
) {
  const sourceRows =
    rows === null
      ? Array.from({ length: rowCount }, () => baseRow)
      : rows;
  if (!Array.isArray(sourceRows) || sourceRows.length !== rowCount) {
    throw new TypeError(`${label} must match the layer visibility rows`);
  }
  return Object.freeze(
    sourceRows.map((row, index) => {
      if (
        !(row instanceof TypedArray) ||
        row.length !== baseRow.length
      ) {
        throw new TypeError(`${label} row ${index} has an invalid size`);
      }
      return new TypedArray(row);
    }),
  );
}

export function buildInstanceGraph(
  blocks,
  inserts,
  {
    layers = Object.freeze([]),
    maximumDepth = DEFAULT_MAX_DEPTH,
    maximumInstances = DEFAULT_MAX_INSTANCES,
    maskOrder = null,
    insertClips = Object.freeze([]),
    layerLinetypeCodes = Object.freeze([]),
    rootContexts = null,
    layerVisibilityRows = null,
    paperToModelScalesByVisibilityRow = null,
    linetypeScalesByVisibilityRow = null,
    annotationScalesByVisibilityRow = null,
    layerColorsByVisibilityRow = null,
    layerLineWeightsByVisibilityRow = null,
    layerLinetypesByVisibilityRow = null,
  } = {},
) {
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const modelBlockIndices = new Set(
    blocks
      .filter((block) => block.name.toUpperCase() === "*MODEL_SPACE")
      .map((block) => block.index),
  );
  const layerZeroIndex = layers.findIndex(
    (layer) => layer.name?.normalize("NFC").toLocaleLowerCase("en-US") === "0",
  );
  const insertsByOwner = new Map();
  const insertClipByHandle = new Map(
    insertClips.map((clip) => [clip.insertHandle, clip]),
  );
  const clipNodes = [];
  const visibilityRows =
    Array.isArray(layerVisibilityRows) && layerVisibilityRows.length > 0
      ? Object.freeze(
          layerVisibilityRows.map((row, index) => {
            if (
              !(row instanceof Uint8Array) ||
              row.length !== layers.length
            ) {
              throw new TypeError(
                `layer visibility row ${index} has an invalid size`,
              );
            }
            return new Uint8Array(row);
          }),
        )
      : Object.freeze([
          new Uint8Array(layers.length).fill(1),
        ]);
  const viewportLinetypeScales =
    linetypeScalesByVisibilityRow === null
      ? new Float64Array(visibilityRows.length).fill(1)
      : Float64Array.from(linetypeScalesByVisibilityRow);
  if (
    viewportLinetypeScales.length !== visibilityRows.length ||
    !viewportLinetypeScales.every(
      (scale) => Number.isFinite(scale) && scale > 0,
    )
  ) {
    throw new TypeError(
      "viewport linetype scales must match the layer visibility rows",
    );
  }
  const viewportPaperToModelScales =
    paperToModelScalesByVisibilityRow === null
      ? new Float64Array(visibilityRows.length).fill(1)
      : Float64Array.from(paperToModelScalesByVisibilityRow);
  if (
    viewportPaperToModelScales.length !== visibilityRows.length ||
    !viewportPaperToModelScales.every(
      (scale) => Number.isFinite(scale) && scale > 0,
    )
  ) {
    throw new TypeError(
      "viewport paper-to-model scales must match the layer visibility rows",
    );
  }
  const viewportAnnotationScales =
    annotationScalesByVisibilityRow === null
      ? new Float64Array(visibilityRows.length)
      : Float64Array.from(annotationScalesByVisibilityRow);
  if (
    viewportAnnotationScales.length !== visibilityRows.length ||
    !viewportAnnotationScales.every(
      (scale) => Number.isFinite(scale) && scale >= 0,
    )
  ) {
    throw new TypeError(
      "viewport annotation scales must match the layer visibility rows",
    );
  }
  const baseLayerColors = Uint32Array.from(
    layers,
    (layer) => layer.color >>> 0,
  );
  const baseLayerLineWeights = Int16Array.from(layers, (layer) => {
    const value = layer.lineWeight;
    return Number.isInteger(value) && value >= -3 && value <= 211
      ? value
      : -3;
  });
  const baseLayerLinetypes = Uint16Array.from(layers, (_, index) => {
    const value = layerLinetypeCodes[index];
    return Number.isInteger(value) && value >= 0 && value <= 2047
      ? value
      : 2;
  });
  const viewportLayerColors = normalizeLayerStyleRows(
    layerColorsByVisibilityRow,
    visibilityRows.length,
    baseLayerColors,
    Uint32Array,
    "viewport layer colors",
  );
  const viewportLayerLineWeights = normalizeLayerStyleRows(
    layerLineWeightsByVisibilityRow,
    visibilityRows.length,
    baseLayerLineWeights,
    Int16Array,
    "viewport layer lineweights",
  );
  const viewportLayerLinetypes = normalizeLayerStyleRows(
    layerLinetypesByVisibilityRow,
    visibilityRows.length,
    baseLayerLinetypes,
    Uint16Array,
    "viewport layer linetypes",
  );
  const diagnostics = {
    invalidOwner: 0,
    invalidTarget: 0,
    cycles: 0,
    depthLimit: 0,
    instanceLimit: 0,
    invalidClip: 0,
  };

  for (const insert of inserts) {
    const ownerIndex = blockIndexByHandle.get(insert.ownerHandle);
    if (ownerIndex === undefined) {
      diagnostics.invalidOwner += 1;
      continue;
    }
    let owned = insertsByOwner.get(ownerIndex);
    if (!owned) {
      owned = [];
      insertsByOwner.set(ownerIndex, owned);
    }
    owned.push(insert);
  }

  const inputContexts =
    rootContexts === null
      ? [...modelBlockIndices].map((blockIndex) => ({
          blockIndex,
          matrix: identityMat4(),
          modelSpace: true,
        }))
      : rootContexts;
  if (!Array.isArray(inputContexts)) {
    throw new TypeError("instance root contexts must be an array");
  }
  const contexts = Object.freeze(
    inputContexts.map((context, contextIndex) => {
      const block = blocks[context?.blockIndex];
      const matrix = context?.matrix;
      const measurementMatrix =
        context?.measurementMatrix ??
        (context?.modelSpace ? identityMat4() : matrix);
      const coordinateSpace =
        context?.coordinateSpace ??
        (context?.modelSpace
          ? CoordinateSpaceKind.Model
          : CoordinateSpaceKind.Paper);
      const visibilityRow = context?.visibilityRow ?? 0;
      if (
        !block ||
        !(matrix instanceof Float64Array) ||
        matrix.length !== MATRIX_VALUES ||
        !(measurementMatrix instanceof Float64Array) ||
        measurementMatrix.length !== MATRIX_VALUES ||
        !Object.values(CoordinateSpaceKind).includes(coordinateSpace) ||
        !Number.isInteger(visibilityRow) ||
        visibilityRow < 0 ||
        visibilityRow >= visibilityRows.length
      ) {
        throw new TypeError(
          `instance root context ${contextIndex} is invalid`,
        );
      }
      if (
        context.clipPoints &&
        (!Array.isArray(context.clipPoints) ||
          context.clipPoints.length < 3 ||
          !context.clipPoints.every(
            (point) =>
              Array.isArray(point) &&
              point.length >= 2 &&
              point.every(Number.isFinite),
          ))
      ) {
        throw new TypeError(
          `instance root context ${contextIndex} has an invalid clip`,
        );
      }
      return Object.freeze({
        ...context,
        blockIndex: block.index,
        matrix,
        measurementMatrix,
        coordinateSpace,
        visibilityRow,
      });
    }),
  );

  const expectedInstanceCounts = new Map();
  let expectedInstanceCount = 0;
  let expectedStopped = false;
  const countInstance = (blockIndex) => {
    expectedInstanceCounts.set(
      blockIndex,
      (expectedInstanceCounts.get(blockIndex) ?? 0) + 1,
    );
    expectedInstanceCount += 1;
    if (expectedInstanceCount >= maximumInstances) {
      expectedStopped = true;
    }
  };
  const countInsert = (insert, parentMaskBase, path, depth) => {
    if (expectedStopped || depth > maximumDepth) {
      return;
    }
    const target = blocks[insert.blockIndex];
    if (!target || path.has(target.index)) {
      return;
    }
    const ownerBlockIndex = blockIndexByHandle.get(insert.ownerHandle);
    const ownerHandle =
      ownerBlockIndex === undefined
        ? insert.ownerHandle
        : blocks[ownerBlockIndex].handle;
    const prefix = maskBucketBefore(
      maskOrder,
      ownerHandle,
      insert.handle,
    );
    const targetSpan = maskSpanForBlock(maskOrder, target.index);
    const columns = Math.max(insert.columnCount, 1);
    const rows = Math.max(insert.rowCount, 1);
    for (let row = 0; row < rows && !expectedStopped; row += 1) {
      for (
        let column = 0;
        column < columns && !expectedStopped;
        column += 1
      ) {
        const cellIndex = row * columns + column;
        const maskBase =
          parentMaskBase + prefix + cellIndex * targetSpan;
        if (
          !Number.isSafeInteger(maskBase) ||
          maskBase < 0 ||
          maskBase > MAX_GLOBAL_MASK_BUCKET
        ) {
          expectedStopped = true;
          break;
        }
        countInstance(target.index);
        const nested = insertsByOwner.get(target.index);
        if (!nested || expectedStopped) {
          continue;
        }
        path.add(target.index);
        for (const child of nested) {
          countInsert(child, maskBase, path, depth + 1);
          if (expectedStopped) {
            break;
          }
        }
        path.delete(target.index);
      }
    }
  };
  for (const context of contexts) {
    if (context.includeRootBatch) {
      countInstance(context.blockIndex);
    }
    if (expectedStopped) {
      break;
    }
    const roots = insertsByOwner.get(context.blockIndex) ?? [];
    const rootPath = new Set([context.blockIndex]);
    for (const insert of roots) {
      countInsert(insert, 0, rootPath, 1);
      if (expectedStopped) {
        break;
      }
    }
    if (expectedStopped) {
      break;
    }
  }

  const instanceBuilders = new Map();
  const traversalRoots = [];
  const localMatrixScratch = [];
  const worldMatrixScratch = [];
  const measurementMatrixScratch = [];
  let instanceCount = 0;
  let stopped = false;

  const addInstance = (
    blockIndex,
    matrix,
    maskBase,
    clipId,
    color,
    layerIndex,
    colorInherited,
    layerInherited,
    opacity,
    opacityInherited,
    lineWeight,
    lineWeightInherited,
    linetypeCode,
    linetypeInherited,
    visibilityRow,
    measurementMatrix,
    coordinateSpace,
    handle,
  ) => {
    let builder = instanceBuilders.get(blockIndex);
    if (!builder) {
      builder = new MatrixCollectionBuilder(
        Boolean(maskOrder?.enabled),
        expectedInstanceCounts.get(blockIndex) ?? 0,
      );
      instanceBuilders.set(blockIndex, builder);
    }
    const instanceIndex = builder.add(
      matrix,
      maskBase,
      clipId,
      color,
      layerIndex,
      colorInherited,
      layerInherited,
      opacity,
      opacityInherited,
      lineWeight,
      lineWeightInherited,
      linetypeCode,
      linetypeInherited,
      visibilityRow,
      measurementMatrix,
      coordinateSpace,
      handle,
    );
    instanceCount += 1;
    if (instanceCount >= maximumInstances) {
      diagnostics.instanceLimit += 1;
      stopped = true;
    }
    return instanceIndex;
  };

  const visitInsert = (
    insert,
    parentMatrix,
    parentMeasurementMatrix,
    parentCoordinateSpace,
    parentMaskBase,
    parentClipId,
    parentColor,
    parentLayerIndex,
    parentColorInherited,
    parentLayerInherited,
    parentOpacity,
    parentOpacityInherited,
    parentLineWeight,
    parentLineWeightInherited,
    parentLinetypeCode,
    parentLinetypeInherited,
    parentVisibilityRow,
    path,
    depth,
  ) => {
    if (stopped) {
      return;
    }
    if (depth > maximumDepth) {
      diagnostics.depthLimit += 1;
      return;
    }
    const target = blocks[insert.blockIndex];
    if (!target) {
      diagnostics.invalidTarget += 1;
      return;
    }
    if (path.has(target.index)) {
      diagnostics.cycles += 1;
      return;
    }

    const columns = Math.max(insert.columnCount, 1);
    const rows = Math.max(insert.rowCount, 1);
    const ownerBlockIndex = blockIndexByHandle.get(insert.ownerHandle);
    const ownerHandle =
      ownerBlockIndex === undefined
        ? insert.ownerHandle
        : blocks[ownerBlockIndex].handle;
    const insertLayerIndex =
      Number.isInteger(insert.layerIndex)
        ? insert.layerIndex
        : layerZeroIndex >= 0
          ? layerZeroIndex
          : NO_LAYER_OVERRIDE;
    const inheritsLayer = insertLayerIndex === layerZeroIndex;
    const layerIndex =
      inheritsLayer && parentLayerIndex !== NO_LAYER_OVERRIDE
        ? parentLayerIndex
        : insertLayerIndex;
    const layerInherited = inheritsLayer
      ? parentLayerInherited
      : false;
    const insertColor =
      Number.isInteger(insert.color) ? insert.color >>> 0 : 0;
    const colorKind = insertColor >>> 30;
    const effectiveLayerColor =
      viewportLayerColors[parentVisibilityRow]?.[layerIndex] ??
      layers[layerIndex]?.color ??
      DEFAULT_BYBLOCK_COLOR;
    const color =
      colorKind === 0
        ? effectiveLayerColor
        : colorKind === 1
          ? parentColor
          : insertColor;
    const colorInherited =
      colorKind === 1 ? parentColorInherited : false;
    const opacityCode = cadOpacityCode(insertColor);
    const layerOpacity = decodeCadOpacity(effectiveLayerColor);
    const opacity = decodeCadOpacity(insertColor, {
      layer: layerOpacity,
      byBlock: parentOpacity,
    });
    const opacityInherited =
      opacityCode === 2 ? parentOpacityInherited : false;
    const sourceLineWeight =
      Number.isInteger(insert.lineWeight) ? insert.lineWeight : -1;
    const layerLineWeight =
      viewportLayerLineWeights[parentVisibilityRow]?.[layerIndex] ??
      (Number.isInteger(layers[layerIndex]?.lineWeight)
        ? layers[layerIndex].lineWeight
        : -3);
    const lineWeight =
      sourceLineWeight === -1
        ? layerLineWeight >= 0
          ? layerLineWeight
          : -3
        : sourceLineWeight === -2
          ? parentLineWeight
          : sourceLineWeight;
    const lineWeightInherited =
      sourceLineWeight === -2 ? parentLineWeightInherited : false;
    const sourceLinetypeCode =
      Number.isInteger(insert.linetypeCode) &&
      insert.linetypeCode >= 0 &&
      insert.linetypeCode <= 2047
        ? insert.linetypeCode
        : 0;
    const layerLinetypeCode =
      viewportLayerLinetypes[parentVisibilityRow]?.[layerIndex] ??
      (Number.isInteger(layerLinetypeCodes[layerIndex]) &&
        layerLinetypeCodes[layerIndex] >= 2
        ? layerLinetypeCodes[layerIndex]
        : 2);
    const linetypeCode =
      sourceLinetypeCode === 0
        ? layerLinetypeCode
        : sourceLinetypeCode === 1
          ? parentLinetypeCode
          : sourceLinetypeCode;
    const linetypeInherited =
      sourceLinetypeCode === 1 ? parentLinetypeInherited : false;
    const prefix = maskBucketBefore(
      maskOrder,
      ownerHandle,
      insert.handle,
    );
    const targetSpan = maskSpanForBlock(maskOrder, target.index);
    const local =
      localMatrixScratch[depth] ??=
        new Float64Array(MATRIX_VALUES);
    const world =
      worldMatrixScratch[depth] ??=
        new Float64Array(MATRIX_VALUES);
    const measurement =
      measurementMatrixScratch[depth] ??=
        new Float64Array(MATRIX_VALUES);
    for (let row = 0; row < rows && !stopped; row += 1) {
      for (let column = 0; column < columns && !stopped; column += 1) {
        insertCellMatrix(
          insert,
          target.basePoint,
          column,
          row,
          local,
        );
        multiplyMat4Into(parentMatrix, local, world);
        multiplyMat4Into(
          parentMeasurementMatrix,
          local,
          measurement,
        );
        const cellIndex = row * columns + column;
        const maskBase =
          parentMaskBase + prefix + cellIndex * targetSpan;
        if (
          !Number.isSafeInteger(maskBase) ||
          maskBase < 0 ||
          maskBase > MAX_GLOBAL_MASK_BUCKET
        ) {
          diagnostics.instanceLimit += 1;
          stopped = true;
          break;
        }
        let clipId = parentClipId;
        const clip = insertClipByHandle.get(insert.handle);
        if (clip) {
          const sourcePoints = clip.rectangular
            ? rectanglePoints(clip.vertices)
            : clip.vertices;
          const worldPoints = sourcePoints.map((point) =>
            transformPoint(world, point),
          );
          if (
            worldPoints.length < 3 ||
            !worldPoints.every((point) =>
              point.every(Number.isFinite),
            )
          ) {
            diagnostics.invalidClip += 1;
          } else {
            clipId = clipNodes.length + 1;
            clipNodes.push(
              createClipNode(
                clipId,
                parentClipId,
                worldPoints,
                clip.inverted,
                {
                  frame: true,
                  color,
                  layerIndex,
                },
              ),
            );
          }
        }
        addInstance(
          target.index,
          world,
          maskBase,
          clipId,
          color,
          layerIndex,
          colorInherited,
          layerInherited,
          opacity,
          opacityInherited,
          lineWeight,
          lineWeightInherited,
          linetypeCode,
          linetypeInherited,
          parentVisibilityRow,
          measurement,
          parentCoordinateSpace,
          insert.handle,
        );

        const nested = insertsByOwner.get(target.index);
        if (!nested || stopped) {
          continue;
        }
        path.add(target.index);
        for (const child of nested) {
          visitInsert(
            child,
            world,
            measurement,
            parentCoordinateSpace,
            maskBase,
            clipId,
            color,
            layerIndex,
            colorInherited,
            layerInherited,
            opacity,
            opacityInherited,
            lineWeight,
            lineWeightInherited,
            linetypeCode,
            linetypeInherited,
            parentVisibilityRow,
            path,
            depth + 1,
          );
          if (stopped) {
            break;
          }
        }
        path.delete(target.index);
      }
    }
  };

  const modelInstanceBuilder = new MatrixCollectionBuilder(
    Boolean(maskOrder?.enabled),
    contexts.filter((context) => context.modelSpace).length,
  );
  for (const context of contexts) {
    const block = blocks[context.blockIndex];
    const { matrix, measurementMatrix, coordinateSpace, visibilityRow } =
      context;
    let clipId = 0;
    if (context.clipPoints) {
      clipId = clipNodes.length + 1;
      clipNodes.push(
        createClipNode(
          clipId,
          0,
          context.clipPoints,
          Boolean(context.clipInverted),
        ),
      );
    }
    const rootValues = [
      matrix,
      0,
      clipId,
      DEFAULT_BYBLOCK_COLOR,
      NO_LAYER_OVERRIDE,
      true,
      true,
      1,
      true,
      -3,
      true,
      2,
      true,
      visibilityRow,
      measurementMatrix,
      coordinateSpace,
      0n,
    ];
    const modelInstanceIndex = context.modelSpace
      ? modelInstanceBuilder.add(...rootValues)
      : null;
    const rootInstanceIndex = context.includeRootBatch
      ? addInstance(block.index, ...rootValues)
      : null;
    traversalRoots.push(
      Object.freeze({
        blockIndex: block.index,
        includeRootBatch: Boolean(context.includeRootBatch),
        rootInstanceBlockIndex: context.includeRootBatch
          ? block.index
          : null,
        rootInstanceIndex,
        modelInstanceIndex,
      }),
    );
    const roots = insertsByOwner.get(block.index) ?? [];
    const rootPath = new Set([block.index]);
    for (const insert of roots) {
      visitInsert(
        insert,
        matrix,
        measurementMatrix,
        coordinateSpace,
        0,
        clipId,
        DEFAULT_BYBLOCK_COLOR,
        NO_LAYER_OVERRIDE,
        true,
        true,
        1,
        true,
        -3,
        true,
        2,
        true,
        visibilityRow,
        rootPath,
        1,
      );
      if (stopped) {
        break;
      }
    }
    if (stopped) {
      break;
    }
  }

  const instancesByBlock = new Map(
    [...instanceBuilders].map(([blockIndex, builder]) => [
      blockIndex,
      builder.finish(),
    ]),
  );
  const modelInstances = modelInstanceBuilder.finish();

  return Object.freeze({
    instancesByBlock,
    insertsByOwner,
    traversalRoots: Object.freeze(traversalRoots),
    dependencyBlockIndices: new Set(instancesByBlock.keys()),
    maximumDepth,
    layers,
    layerLinetypeCodes,
    sourceLayerZeroIndex: layerZeroIndex,
    styleLayerMap: null,
    styleLinetypeMap: null,
    modelBlockIndices,
    modelInstances,
    rootInstances: modelInstances,
    clipNodes: Object.freeze(clipNodes),
    layerVisibilityRows: visibilityRows,
    paperToModelScalesByVisibilityRow: viewportPaperToModelScales,
    linetypeScalesByVisibilityRow: viewportLinetypeScales,
    annotationScalesByVisibilityRow: viewportAnnotationScales,
    layerColorsByVisibilityRow: viewportLayerColors,
    layerLineWeightsByVisibilityRow: viewportLayerLineWeights,
    layerLinetypesByVisibilityRow: viewportLayerLinetypes,
    instanceCount,
    diagnostics: Object.freeze(diagnostics),
    layerZeroIndex:
      layerZeroIndex >= 0 ? layerZeroIndex : NO_LAYER_OVERRIDE,
    truncated: stopped,
    maskOrderEnabled:
      Boolean(maskOrder?.enabled) &&
      !stopped &&
      diagnostics.invalidOwner === 0 &&
      diagnostics.invalidTarget === 0 &&
      diagnostics.cycles === 0 &&
      diagnostics.depthLimit === 0,
  });
}

export function applyMaskOrderToInstanceGraph(
  instanceGraph,
  blocks,
  maskOrder,
  { maximumDepth = DEFAULT_MAX_DEPTH } = {},
) {
  if (!maskOrder?.enabled) {
    return instanceGraph;
  }
  if (
    instanceGraph.truncated ||
    Object.values(instanceGraph.diagnostics).some((value) => value !== 0)
  ) {
    return Object.freeze({
      ...instanceGraph,
      maskOrderEnabled: false,
    });
  }
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const cursors = new Uint32Array(blocks.length);
  const maskBasesByBlock = new Map(
    [...instanceGraph.instancesByBlock].map(([blockIndex, instances]) => [
      blockIndex,
      new Uint32Array(instances.count),
    ]),
  );
  let valid = true;

  const visitInsert = (insert, parentMaskBase, path, depth) => {
    if (!valid) {
      return;
    }
    if (depth > maximumDepth) {
      valid = false;
      return;
    }
    const target = blocks[insert.blockIndex];
    if (!target || path.has(target.index)) {
      valid = false;
      return;
    }
    const ownerBlockIndex = blockIndexByHandle.get(insert.ownerHandle);
    const ownerHandle =
      ownerBlockIndex === undefined
        ? insert.ownerHandle
        : blocks[ownerBlockIndex].handle;
    const prefix = maskBucketBefore(
      maskOrder,
      ownerHandle,
      insert.handle,
    );
    const targetSpan = maskSpanForBlock(maskOrder, target.index);
    const columns = Math.max(insert.columnCount, 1);
    const rows = Math.max(insert.rowCount, 1);
    for (let row = 0; row < rows && valid; row += 1) {
      for (let column = 0; column < columns && valid; column += 1) {
        const cellIndex = row * columns + column;
        const maskBase =
          parentMaskBase + prefix + cellIndex * targetSpan;
        const destination = maskBasesByBlock.get(target.index);
        const cursor = cursors[target.index];
        if (
          !destination ||
          cursor >= destination.length ||
          !Number.isSafeInteger(maskBase) ||
          maskBase < 0 ||
          maskBase > MAX_GLOBAL_MASK_BUCKET
        ) {
          valid = false;
          break;
        }
        destination[cursor] = maskBase;
        cursors[target.index] = cursor + 1;

        const nested = instanceGraph.insertsByOwner.get(target.index);
        if (!nested) {
          continue;
        }
        const nestedPath = new Set(path);
        nestedPath.add(target.index);
        for (const child of nested) {
          visitInsert(child, maskBase, nestedPath, depth + 1);
          if (!valid) {
            break;
          }
        }
      }
    }
  };

  const traversalRoots =
    Array.isArray(instanceGraph.traversalRoots) &&
    instanceGraph.traversalRoots.length > 0
      ? instanceGraph.traversalRoots
      : [...instanceGraph.modelBlockIndices].map((blockIndex) => ({
          blockIndex,
          includeRootBatch: false,
          rootInstanceBlockIndex: null,
          rootInstanceIndex: null,
        }));
  for (const root of traversalRoots) {
    if (root.includeRootBatch) {
      const blockIndex = root.rootInstanceBlockIndex;
      const destination = maskBasesByBlock.get(blockIndex);
      const cursor = cursors[blockIndex];
      if (
        !destination ||
        cursor !== root.rootInstanceIndex ||
        cursor >= destination.length
      ) {
        valid = false;
        break;
      }
      destination[cursor] = 0;
      cursors[blockIndex] = cursor + 1;
    }
    for (const insert of
      instanceGraph.insertsByOwner.get(root.blockIndex) ?? []) {
      visitInsert(insert, 0, new Set([root.blockIndex]), 1);
      if (!valid) {
        break;
      }
    }
    if (!valid) {
      break;
    }
  }
  for (const [blockIndex, instances] of instanceGraph.instancesByBlock) {
    if (cursors[blockIndex] !== instances.count) {
      valid = false;
      break;
    }
  }
  if (!valid) {
    return Object.freeze({
      ...instanceGraph,
      maskOrderEnabled: false,
    });
  }
  const instancesByBlock = new Map(
    [...instanceGraph.instancesByBlock].map(([blockIndex, instances]) => [
      blockIndex,
      Object.freeze({
        ...instances,
        maskBases: maskBasesByBlock.get(blockIndex),
      }),
    ]),
  );
  const modelInstances = Object.freeze({
    ...instanceGraph.modelInstances,
    maskBases: new Uint32Array(instanceGraph.modelInstances.count),
  });
  return Object.freeze({
    ...instanceGraph,
    instancesByBlock,
    modelInstances,
    rootInstances:
      instanceGraph.rootInstances === instanceGraph.modelInstances
        ? modelInstances
        : instanceGraph.rootInstances,
    maskOrderEnabled: true,
  });
}

export { DEFAULT_MAX_DEPTH, DEFAULT_MAX_INSTANCES };
