import {
  identityMat4,
  insertCellMatrix,
  multiplyMat4,
  transformPoint,
} from "./math.mjs";
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
const MATRICES_PER_CHUNK = 256;
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
  constructor(includeMaskBases) {
    this.includeMaskBases = includeMaskBases;
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
    const chunkIndex = Math.floor(this.count / MATRICES_PER_CHUNK);
    const indexInChunk = this.count % MATRICES_PER_CHUNK;
    if (!this.chunks[chunkIndex]) {
      this.chunks[chunkIndex] = new Float64Array(
        MATRICES_PER_CHUNK * MATRIX_VALUES,
      );
      this.measurementChunks[chunkIndex] = new Float64Array(
        MATRICES_PER_CHUNK * MATRIX_VALUES,
      );
      this.coordinateSpaceChunks[chunkIndex] = new Uint8Array(
        MATRICES_PER_CHUNK,
      );
      if (this.includeMaskBases) {
        this.maskBaseChunks[chunkIndex] = new Uint32Array(
          MATRICES_PER_CHUNK,
        );
      }
      this.clipIdChunks[chunkIndex] = new Uint32Array(
        MATRICES_PER_CHUNK,
      );
      this.colorChunks[chunkIndex] = new Uint32Array(MATRICES_PER_CHUNK);
      this.layerIndexChunks[chunkIndex] = new Uint32Array(
        MATRICES_PER_CHUNK,
      );
      this.colorInheritedChunks[chunkIndex] = new Uint8Array(
        MATRICES_PER_CHUNK,
      );
      this.layerInheritedChunks[chunkIndex] = new Uint8Array(
        MATRICES_PER_CHUNK,
      );
      this.opacityChunks[chunkIndex] = new Float32Array(
        MATRICES_PER_CHUNK,
      );
      this.opacityInheritedChunks[chunkIndex] = new Uint8Array(
        MATRICES_PER_CHUNK,
      );
      this.lineWeightChunks[chunkIndex] = new Int16Array(
        MATRICES_PER_CHUNK,
      );
      this.lineWeightInheritedChunks[chunkIndex] = new Uint8Array(
        MATRICES_PER_CHUNK,
      );
      this.linetypeCodeChunks[chunkIndex] = new Uint16Array(
        MATRICES_PER_CHUNK,
      );
      this.linetypeInheritedChunks[chunkIndex] = new Uint8Array(
        MATRICES_PER_CHUNK,
      );
      this.visibilityRowChunks[chunkIndex] = new Uint32Array(
        MATRICES_PER_CHUNK,
      );
      this.handleChunks[chunkIndex] = new BigUint64Array(
        MATRICES_PER_CHUNK,
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
    this.count += 1;
    return instanceIndex;
  }

  finish() {
    const data = new Float64Array(this.count * MATRIX_VALUES);
    const measurementData = new Float64Array(this.count * MATRIX_VALUES);
    const coordinateSpaceIds = new Uint8Array(this.count);
    const maskBases = this.includeMaskBases
      ? new Uint32Array(this.count)
      : null;
    const clipIds = new Uint32Array(this.count);
    const colors = new Uint32Array(this.count);
    const layerIndices = new Uint32Array(this.count);
    const colorInherited = new Uint8Array(this.count);
    const layerInherited = new Uint8Array(this.count);
    const opacities = new Float32Array(this.count);
    const opacityInherited = new Uint8Array(this.count);
    const lineWeights = new Int16Array(this.count);
    const lineWeightInherited = new Uint8Array(this.count);
    const linetypeCodes = new Uint16Array(this.count);
    const linetypeInherited = new Uint8Array(this.count);
    const visibilityRows = new Uint32Array(this.count);
    const handles = new BigUint64Array(this.count);
    let destination = 0;
    let maskDestination = 0;
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      const remaining = data.length - destination;
      const length = Math.min(chunk.length, remaining);
      data.set(chunk.subarray(0, length), destination);
      measurementData.set(
        this.measurementChunks[index].subarray(0, length),
        destination,
      );
      coordinateSpaceIds.set(
        this.coordinateSpaceChunks[index].subarray(
          0,
          Math.min(
            this.coordinateSpaceChunks[index].length,
            coordinateSpaceIds.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      destination += length;
      if (this.includeMaskBases) {
        const maskChunk = this.maskBaseChunks[index];
        const maskLength = Math.min(
          maskChunk.length,
          maskBases.length - maskDestination,
        );
        maskBases.set(maskChunk.subarray(0, maskLength), maskDestination);
        maskDestination += maskLength;
      }
      clipIds.set(
        this.clipIdChunks[index].subarray(
          0,
          Math.min(
            this.clipIdChunks[index].length,
            clipIds.length - (index * MATRICES_PER_CHUNK),
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      colors.set(
        this.colorChunks[index].subarray(
          0,
          Math.min(
            this.colorChunks[index].length,
            colors.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      layerIndices.set(
        this.layerIndexChunks[index].subarray(
          0,
          Math.min(
            this.layerIndexChunks[index].length,
            layerIndices.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      colorInherited.set(
        this.colorInheritedChunks[index].subarray(
          0,
          Math.min(
            this.colorInheritedChunks[index].length,
            colorInherited.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      layerInherited.set(
        this.layerInheritedChunks[index].subarray(
          0,
          Math.min(
            this.layerInheritedChunks[index].length,
            layerInherited.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      opacities.set(
        this.opacityChunks[index].subarray(
          0,
          Math.min(
            this.opacityChunks[index].length,
            opacities.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      opacityInherited.set(
        this.opacityInheritedChunks[index].subarray(
          0,
          Math.min(
            this.opacityInheritedChunks[index].length,
            opacityInherited.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      lineWeights.set(
        this.lineWeightChunks[index].subarray(
          0,
          Math.min(
            this.lineWeightChunks[index].length,
            lineWeights.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      lineWeightInherited.set(
        this.lineWeightInheritedChunks[index].subarray(
          0,
          Math.min(
            this.lineWeightInheritedChunks[index].length,
            lineWeightInherited.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      linetypeCodes.set(
        this.linetypeCodeChunks[index].subarray(
          0,
          Math.min(
            this.linetypeCodeChunks[index].length,
            linetypeCodes.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      linetypeInherited.set(
        this.linetypeInheritedChunks[index].subarray(
          0,
          Math.min(
            this.linetypeInheritedChunks[index].length,
            linetypeInherited.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      visibilityRows.set(
        this.visibilityRowChunks[index].subarray(
          0,
          Math.min(
            this.visibilityRowChunks[index].length,
            visibilityRows.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
      handles.set(
        this.handleChunks[index].subarray(
          0,
          Math.min(
            this.handleChunks[index].length,
            handles.length - index * MATRICES_PER_CHUNK,
          ),
        ),
        index * MATRICES_PER_CHUNK,
      );
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

  const instanceBuilders = new Map();
  const traversalRoots = [];
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
      builder = new MatrixCollectionBuilder(Boolean(maskOrder?.enabled));
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
    const color =
      colorKind === 0
        ? layers[layerIndex]?.color ?? DEFAULT_BYBLOCK_COLOR
        : colorKind === 1
          ? parentColor
          : insertColor;
    const colorInherited =
      colorKind === 1 ? parentColorInherited : false;
    const opacityCode = cadOpacityCode(insertColor);
    const layerOpacity = decodeCadOpacity(
      layers[layerIndex]?.color ?? 0,
    );
    const opacity = decodeCadOpacity(insertColor, {
      layer: layerOpacity,
      byBlock: parentOpacity,
    });
    const opacityInherited =
      opacityCode === 2 ? parentOpacityInherited : false;
    const sourceLineWeight =
      Number.isInteger(insert.lineWeight) ? insert.lineWeight : -1;
    const layerLineWeight = Number.isInteger(layers[layerIndex]?.lineWeight)
      ? layers[layerIndex].lineWeight
      : -3;
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
      Number.isInteger(layerLinetypeCodes[layerIndex]) &&
      layerLinetypeCodes[layerIndex] >= 2
        ? layerLinetypeCodes[layerIndex]
        : 2;
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
    for (let row = 0; row < rows && !stopped; row += 1) {
      for (let column = 0; column < columns && !stopped; column += 1) {
        const local = insertCellMatrix(insert, target.basePoint, column, row);
        const world = multiplyMat4(parentMatrix, local);
        const measurement = multiplyMat4(parentMeasurementMatrix, local);
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
        const nestedPath = new Set(path);
        nestedPath.add(target.index);
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
            nestedPath,
            depth + 1,
          );
          if (stopped) {
            break;
          }
        }
      }
    }
  };

  const modelInstanceBuilder = new MatrixCollectionBuilder(
    Boolean(maskOrder?.enabled),
  );
  const contexts =
    rootContexts === null
      ? [...modelBlockIndices].map((blockIndex) => ({
          blockIndex,
          matrix: identityMat4(),
          modelSpace: true,
        }))
      : rootContexts;
  if (!Array.isArray(contexts)) {
    throw new TypeError("instance root contexts must be an array");
  }
  for (const [contextIndex, context] of contexts.entries()) {
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
    let clipId = 0;
    if (context.clipPoints) {
      if (
        !Array.isArray(context.clipPoints) ||
        context.clipPoints.length < 3 ||
        !context.clipPoints.every(
          (point) =>
            Array.isArray(point) &&
            point.length >= 2 &&
            point.every(Number.isFinite),
        )
      ) {
        throw new TypeError(
          `instance root context ${contextIndex} has an invalid clip`,
        );
      }
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
        new Set([block.index]),
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

  for (const modelIndex of instanceGraph.modelBlockIndices) {
    for (const insert of instanceGraph.insertsByOwner.get(modelIndex) ?? []) {
      visitInsert(insert, 0, new Set([modelIndex]), 1);
      if (!valid) {
        break;
      }
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
  return Object.freeze({
    ...instanceGraph,
    instancesByBlock,
    maskOrderEnabled: true,
  });
}

export { DEFAULT_MAX_DEPTH, DEFAULT_MAX_INSTANCES };
