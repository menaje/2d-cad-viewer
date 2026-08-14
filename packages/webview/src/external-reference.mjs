import { GpuLineBatchKind } from "./scene-cache.mjs?v=1.26.0";
import {
  multiplyMat4,
  transformPoint,
} from "./math.mjs";
import { createClipNode } from "./instance-graph.mjs?v=1.26.0";
import {
  initialLayerVisibility,
  InstanceVisibilityBuilder,
  refreshInstanceVisibility,
} from "./instance-visibility.mjs";

const MATRIX_VALUES = 16;
const MODEL_BLOCK_INDEX = -1;
const NO_LAYER_OVERRIDE = 0xffffffff;
const BY_LAYER_ENTITY_COLOR = 1 << 24;
const LINE_WEIGHT_MASK = 0x1f;
const LINETYPE_MASK = 0x7ff << 5;
const BY_LAYER_LINE_WEIGHT_CODE = 2;
const EXTERNAL_DEPENDENT_LAYER_FLAG = 1 << 4;
const RELOADABLE_LAYER_FLAGS = 0x0f;

function visibilityGraphIsValid(graph) {
  return (
    graph?.parentIds instanceof Uint32Array &&
    graph.layerIndices instanceof Uint32Array &&
    graph.layerInherited instanceof Uint8Array &&
    graph.visibilityRows instanceof Uint32Array &&
    graph.sourceVisible instanceof Uint8Array
  );
}

function mappedLayerIndex(layerIndex, layerMap) {
  if (
    layerIndex === NO_LAYER_OVERRIDE ||
    !(layerMap instanceof Uint32Array) ||
    layerMap.length === 0
  ) {
    return layerIndex;
  }
  return layerIndex < layerMap.length ? layerMap[layerIndex] : layerMap[0];
}

function externalVisibilityComposer(
  parentInstanceGraph,
  childInstanceGraph,
  outer,
  layerMap,
) {
  const builder = new InstanceVisibilityBuilder();
  const parentGraph = parentInstanceGraph.visibilityGraph;
  const childGraph = childInstanceGraph.visibilityGraph;
  const parentNodesValid = visibilityGraphIsValid(parentGraph);
  const childNodesValid = visibilityGraphIsValid(childGraph);
  const importedParentNodes = new Map([[0, 0]]);
  const composedChildNodes = new Array(outer.count);

  const parentNode = (sourceNodeId) => {
    if (
      !parentNodesValid ||
      !Number.isInteger(sourceNodeId) ||
      sourceNodeId <= 0
    ) {
      return 0;
    }
    const cached = importedParentNodes.get(sourceNodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (sourceNodeId >= parentGraph.parentIds.length) {
      return 0;
    }
    const parentId = parentNode(parentGraph.parentIds[sourceNodeId]);
    const nodeId = builder.add(
      parentId,
      parentGraph.layerIndices[sourceNodeId],
      parentGraph.visibilityRows[sourceNodeId],
      {
        inherited: parentGraph.layerInherited[sourceNodeId] !== 0,
        visible: parentGraph.sourceVisible[sourceNodeId] !== 0,
      },
    );
    importedParentNodes.set(sourceNodeId, nodeId);
    return nodeId;
  };

  const outerNode = (outerIndex) =>
    parentNode(outer.visibilityNodeIds?.[outerIndex] ?? 0);

  const nodeFor = (outerIndex, childNodeId) => {
    const outerRootNode = outerNode(outerIndex);
    if (
      !childNodesValid ||
      !Number.isInteger(childNodeId) ||
      childNodeId <= 0
    ) {
      return outerRootNode;
    }
    const nodesForOuter =
      composedChildNodes[outerIndex] ??=
        new Map();
    const cached = nodesForOuter.get(childNodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (childNodeId >= childGraph.parentIds.length) {
      return outerRootNode;
    }
    const childParentId = childGraph.parentIds[childNodeId];
    const parentId =
      childParentId === 0
        ? outerRootNode
        : nodeFor(outerIndex, childParentId);
    const inheritsLayer = childGraph.layerInherited[childNodeId] !== 0;
    const outerLayer =
      outer.layerIndices?.[outerIndex] ?? NO_LAYER_OVERRIDE;
    const childLayer = childGraph.layerIndices[childNodeId];
    const layerIndex =
      inheritsLayer && outerLayer !== NO_LAYER_OVERRIDE
        ? outerLayer
        : mappedLayerIndex(childLayer, layerMap);
    const nodeId = builder.add(
      parentId,
      layerIndex,
      outer.visibilityRows?.[outerIndex] ?? 0,
      {
        inherited:
          inheritsLayer &&
          outer.layerInherited?.[outerIndex] === 1,
        visible: childGraph.sourceVisible[childNodeId] !== 0,
      },
    );
    nodesForOuter.set(childNodeId, nodeId);
    return nodeId;
  };

  return Object.freeze({
    parentNode,
    nodeFor,
    finish: () => builder.finish(),
  });
}

export function blockExternalReferenceIsDiscoverable(block) {
  return Boolean(block && (block.flags & (1 << 2)) !== 0);
}

export function blockExternalReferenceSavedState(block) {
  if (!blockExternalReferenceIsDiscoverable(block)) {
    return "not-xref";
  }
  if (block.xrefLoaded === false) {
    return "unloaded";
  }
  if (block.xrefResolved === false) {
    return "unresolved";
  }
  return "enabled";
}

export function blockExternalReferenceIsDisplayable(block) {
  return blockExternalReferenceSavedState(block) === "enabled";
}

function layerKey(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
}

export function buildExternalLinetypeMap(
  rootLinetypes,
  childLinetypes,
  prefix = "",
) {
  const rootByName = new Map(
    (rootLinetypes ?? []).map((linetype) => [
      layerKey(linetype.name),
      linetype.code,
    ]),
  );
  let maximumChildCode = 2;
  for (const linetype of childLinetypes ?? []) {
    maximumChildCode = Math.max(maximumChildCode, linetype.code);
  }
  const output = new Uint16Array(maximumChildCode + 1);
  const normalizedPrefix = String(prefix ?? "")
    .normalize("NFC")
    .replace(/\|+$/u, "");
  output.fill(2);
  output[0] = 0;
  output[1] = 1;
  output[2] = 2;
  for (const linetype of childLinetypes ?? []) {
    const rootCode =
      (normalizedPrefix
        ? rootByName.get(
            layerKey(`${normalizedPrefix}|${linetype.name}`),
          )
        : undefined) ?? rootByName.get(layerKey(linetype.name));
    output[linetype.code] =
      Number.isInteger(rootCode) && rootCode >= 0 ? rootCode : 2;
  }
  return output;
}

function childClipChain(childClipNodes, clipId) {
  const chain = [];
  let current = clipId;
  let depth = 0;
  while (current > 0 && depth < 64) {
    const node = childClipNodes[current - 1];
    if (!node || node.id !== current) {
      return null;
    }
    chain.push(node);
    current = node.parentId;
    depth += 1;
  }
  return current === 0 ? chain.reverse() : null;
}

function composeCollections(
  outer,
  inner,
  childClipNodes,
  outputClipNodes,
  layerMap,
  linetypeMap,
  maskBucketScale,
  externalReferenceOverrides,
  visibilityNodeFor,
) {
  const count = outer.count * inner.count;
  const data = new Float64Array(count * MATRIX_VALUES);
  const measurementData = new Float64Array(count * MATRIX_VALUES);
  const coordinateSpaceIds = new Uint8Array(count);
  const maskBases = new Float32Array(count);
  const clipIds = new Uint32Array(count);
  const colors = new Uint32Array(count);
  const layerIndices = new Uint32Array(count);
  const colorInherited = new Uint8Array(count);
  const layerInherited = new Uint8Array(count);
  const opacities = new Float32Array(count);
  const opacityInherited = new Uint8Array(count);
  const lineWeights = new Int16Array(count);
  const lineWeightInherited = new Uint8Array(count);
  const linetypeCodes = new Uint16Array(count);
  const linetypeInherited = new Uint8Array(count);
  const visibilityRows = new Uint32Array(count);
  const visibilityNodeIds = new Uint32Array(count);
  const handles = new BigUint64Array(count);
  const clipCache = new Map();
  let cursor = 0;
  for (let outerIndex = 0; outerIndex < outer.count; outerIndex += 1) {
    const outerMatrix = outer.data.subarray(
      outerIndex * MATRIX_VALUES,
      (outerIndex + 1) * MATRIX_VALUES,
    );
    for (let innerIndex = 0; innerIndex < inner.count; innerIndex += 1) {
      const innerMatrix = inner.data.subarray(
        innerIndex * MATRIX_VALUES,
        (innerIndex + 1) * MATRIX_VALUES,
      );
      data.set(
        multiplyMat4(outerMatrix, innerMatrix),
        cursor * MATRIX_VALUES,
      );
      const outerMeasurement = (
        outer.measurementData ?? outer.data
      ).subarray(
        outerIndex * MATRIX_VALUES,
        (outerIndex + 1) * MATRIX_VALUES,
      );
      const innerMeasurement = (
        inner.measurementData ?? inner.data
      ).subarray(
        innerIndex * MATRIX_VALUES,
        (innerIndex + 1) * MATRIX_VALUES,
      );
      measurementData.set(
        multiplyMat4(outerMeasurement, innerMeasurement),
        cursor * MATRIX_VALUES,
      );
      coordinateSpaceIds[cursor] =
        outer.coordinateSpaceIds?.[outerIndex] ?? 1;
      maskBases[cursor] =
        (outer.maskBases?.[outerIndex] ?? 0) +
        (inner.maskBases?.[innerIndex] ?? 0) * maskBucketScale;
      const outerClipId = outer.clipIds?.[outerIndex] ?? 0;
      const innerClipId = inner.clipIds?.[innerIndex] ?? 0;
      const cacheKey = `${outerIndex}:${innerClipId}`;
      let composedClipId = clipCache.get(cacheKey);
      if (composedClipId === undefined) {
        composedClipId = outerClipId;
        const chain = childClipChain(childClipNodes, innerClipId);
        if (chain) {
          for (const node of chain) {
            const id = outputClipNodes.length + 1;
            outputClipNodes.push(
              createClipNode(
                id,
                composedClipId,
                node.points.map((point) =>
                  transformPoint(outerMatrix, point),
                ),
                node.inverted,
                {
                  frame: node.frame,
                  color: node.color,
                  layerIndex:
                    layerMap instanceof Uint32Array &&
                    node.layerIndex < layerMap.length
                      ? layerMap[node.layerIndex]
                      : node.layerIndex,
                  visibilityNodeId: visibilityNodeFor(
                    outerIndex,
                    node.visibilityNodeId ?? 0,
                  ),
                },
              ),
            );
            composedClipId = id;
          }
        }
        clipCache.set(cacheKey, composedClipId);
      }
      clipIds[cursor] = composedClipId;
      const inheritsColor = inner.colorInherited?.[innerIndex] === 1;
      const inheritsLayer = inner.layerInherited?.[innerIndex] === 1;
      const outerColor =
        outer.colors?.[outerIndex] ?? ((2 << 30) | 7);
      const outerLayer =
        outer.layerIndices?.[outerIndex] ?? NO_LAYER_OVERRIDE;
      colors[cursor] = externalReferenceOverrides
        ? outerColor
        : inheritsColor
          ? outerColor
          : inner.colors?.[innerIndex] ?? outerColor;
      const innerLayer =
        inner.layerIndices?.[innerIndex] ?? NO_LAYER_OVERRIDE;
      layerIndices[cursor] = inheritsLayer
        ? outerLayer
        : innerLayer === NO_LAYER_OVERRIDE
          ? outerLayer
          : layerMap instanceof Uint32Array
            ? innerLayer < layerMap.length
              ? layerMap[innerLayer]
              : layerMap[0]
            : innerLayer;
      colorInherited[cursor] = externalReferenceOverrides
        ? outer.colorInherited?.[outerIndex] ?? 0
        : inheritsColor && outer.colorInherited?.[outerIndex] === 1
          ? 1
          : 0;
      layerInherited[cursor] =
        inheritsLayer && outer.layerInherited?.[outerIndex] === 1 ? 1 : 0;
      const inheritsOpacity =
        inner.opacityInherited?.[innerIndex] === 1;
      opacities[cursor] = externalReferenceOverrides
        ? outer.opacities?.[outerIndex] ?? 1
        : inheritsOpacity
          ? outer.opacities?.[outerIndex] ?? 1
          : inner.opacities?.[innerIndex] ?? 1;
      opacityInherited[cursor] = externalReferenceOverrides
        ? outer.opacityInherited?.[outerIndex] ?? 0
        : inheritsOpacity &&
            outer.opacityInherited?.[outerIndex] === 1
          ? 1
          : 0;
      const inheritsLineWeight =
        inner.lineWeightInherited?.[innerIndex] === 1;
      lineWeights[cursor] = inheritsLineWeight
        ? outer.lineWeights?.[outerIndex] ?? -3
        : inner.lineWeights?.[innerIndex] ?? -3;
      lineWeightInherited[cursor] =
        inheritsLineWeight &&
        outer.lineWeightInherited?.[outerIndex] === 1
          ? 1
          : 0;
      const inheritsLinetype =
        inner.linetypeInherited?.[innerIndex] === 1;
      linetypeCodes[cursor] = inheritsLinetype
        ? outer.linetypeCodes?.[outerIndex] ?? 2
        : linetypeMap instanceof Uint16Array
          ? linetypeMap[inner.linetypeCodes?.[innerIndex] ?? 2] ?? 2
          : inner.linetypeCodes?.[innerIndex] ?? 2;
      linetypeInherited[cursor] =
        inheritsLinetype &&
        outer.linetypeInherited?.[outerIndex] === 1
          ? 1
          : 0;
      visibilityRows[cursor] =
        outer.visibilityRows?.[outerIndex] ?? 0;
      visibilityNodeIds[cursor] = visibilityNodeFor(
        outerIndex,
        inner.visibilityNodeIds?.[innerIndex] ?? 0,
      );
      handles[cursor] =
        inner.handles?.[innerIndex] ??
        outer.handles?.[outerIndex] ??
        0n;
      cursor += 1;
    }
  }
  return {
    data,
    measurementData,
    coordinateSpaceIds,
    maskBases,
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
    visibilityNodeIds,
    handles,
    count,
    length: count,
  };
}

export function composeExternalInstanceGraph(
  parentInstanceGraph,
  parentBlockIndex,
  childInstanceGraph,
  childBatches,
  layerMap = null,
  linetypeMap = null,
  maskBucketScale = 1,
  externalReferenceOverrides = false,
) {
  if (
    !Number.isFinite(maskBucketScale) ||
    maskBucketScale <= 0 ||
    maskBucketScale > 1
  ) {
    throw new RangeError(
      "external draw-order scale must be greater than zero and at most one",
    );
  }
  if (typeof externalReferenceOverrides !== "boolean") {
    throw new TypeError("XREFOVERRIDE must be a boolean");
  }
  const outer = parentInstanceGraph.instancesByBlock.get(parentBlockIndex);
  if (!outer || outer.count === 0) {
    return Object.freeze({
      batches: Object.freeze([]),
      instanceGraph: Object.freeze({
        instancesByBlock: new Map(),
        rootInstances: Object.freeze({
          data: new Float64Array(0),
          measurementData: new Float64Array(0),
          coordinateSpaceIds: new Uint8Array(0),
          maskBases: new Uint32Array(0),
          clipIds: new Uint32Array(0),
          colors: new Uint32Array(0),
          layerIndices: new Uint32Array(0),
          colorInherited: new Uint8Array(0),
          layerInherited: new Uint8Array(0),
          opacities: new Float32Array(0),
          opacityInherited: new Uint8Array(0),
          lineWeights: new Int16Array(0),
          lineWeightInherited: new Uint8Array(0),
          linetypeCodes: new Uint16Array(0),
          linetypeInherited: new Uint8Array(0),
          visibilityRows: new Uint32Array(0),
          handles: new BigUint64Array(0),
          count: 0,
          length: 0,
        }),
        clipNodes: Object.freeze([]),
        layerVisibilityRows:
          parentInstanceGraph.layerVisibilityRows,
        paperToModelScalesByVisibilityRow:
          parentInstanceGraph.paperToModelScalesByVisibilityRow,
        linetypeScalesByVisibilityRow:
          parentInstanceGraph.linetypeScalesByVisibilityRow,
        annotationScalesByVisibilityRow:
          parentInstanceGraph.annotationScalesByVisibilityRow,
        lineWeightWorldScale:
          parentInstanceGraph.lineWeightWorldScale ?? 0,
        annotationAllVisible:
          childInstanceGraph.annotationAllVisible ?? true,
        layerColorsByVisibilityRow:
          parentInstanceGraph.layerColorsByVisibilityRow,
        layerLineWeightsByVisibilityRow:
          parentInstanceGraph.layerLineWeightsByVisibilityRow,
        layerLinetypesByVisibilityRow:
          parentInstanceGraph.layerLinetypesByVisibilityRow,
        instanceCount: 0,
        localClipNodeStartIndex: 0,
        maskBucketScale,
      }),
    });
  }
  const visibilityComposer = externalVisibilityComposer(
    parentInstanceGraph,
    childInstanceGraph,
    outer,
    layerMap,
  );
  const instancesByBlock = new Map();
  const clipNodes = (parentInstanceGraph.clipNodes ?? []).map((node) =>
    Object.freeze({
      ...node,
      visibilityNodeId: visibilityComposer.parentNode(
        node.visibilityNodeId ?? 0,
      ),
    }),
  );
  const localClipNodeStartIndex = clipNodes.length;
  let modelInstances = {
    data: outer.data,
    measurementData: outer.measurementData ?? outer.data,
    coordinateSpaceIds:
      outer.coordinateSpaceIds ?? new Uint8Array(outer.count).fill(1),
    maskBases: outer.maskBases ?? new Uint32Array(outer.count),
    clipIds: outer.clipIds ?? new Uint32Array(outer.count),
    colors:
      outer.colors ??
      new Uint32Array(outer.count).fill((2 << 30) | 7),
    layerIndices:
      outer.layerIndices ??
      new Uint32Array(outer.count).fill(NO_LAYER_OVERRIDE),
    colorInherited:
      outer.colorInherited ?? new Uint8Array(outer.count),
    layerInherited:
      outer.layerInherited ?? new Uint8Array(outer.count),
    opacities:
      outer.opacities ?? new Float32Array(outer.count).fill(1),
    opacityInherited:
      outer.opacityInherited ?? new Uint8Array(outer.count),
    lineWeights:
      outer.lineWeights ?? new Int16Array(outer.count).fill(-3),
    lineWeightInherited:
      outer.lineWeightInherited ?? new Uint8Array(outer.count),
    linetypeCodes:
      outer.linetypeCodes ?? new Uint16Array(outer.count).fill(2),
    linetypeInherited:
      outer.linetypeInherited ?? new Uint8Array(outer.count),
    visibilityRows:
      outer.visibilityRows ?? new Uint32Array(outer.count),
    visibilityNodeIds: Uint32Array.from(
      { length: outer.count },
      (_, outerIndex) => visibilityComposer.nodeFor(outerIndex, 0),
    ),
    handles:
      outer.handles ?? new BigUint64Array(outer.count),
    count: outer.count,
    length: outer.count,
  };
  instancesByBlock.set(
    MODEL_BLOCK_INDEX,
    modelInstances,
  );
  let instanceCount = outer.count;
  for (const modelBlockIndex of childInstanceGraph.modelBlockIndices ?? []) {
    instancesByBlock.set(modelBlockIndex, instancesByBlock.get(MODEL_BLOCK_INDEX));
  }
  for (const [blockIndex, inner] of childInstanceGraph.instancesByBlock) {
    const composed = composeCollections(
      outer,
      inner,
      childInstanceGraph.clipNodes ?? [],
      clipNodes,
      layerMap,
      linetypeMap,
      maskBucketScale,
      externalReferenceOverrides,
      visibilityComposer.nodeFor,
    );
    instancesByBlock.set(blockIndex, composed);
    instanceCount += composed.count;
  }
  const visibilityGraph = visibilityComposer.finish();
  const finalizedCollections = new Map();
  for (const [blockIndex, instances] of instancesByBlock) {
    let finalized = finalizedCollections.get(instances);
    if (!finalized) {
      finalized = Object.freeze({
        ...instances,
        visibilityValues: visibilityGraph.values,
        visibilitySelection: { instanceIndices: null },
      });
      finalizedCollections.set(instances, finalized);
    }
    instancesByBlock.set(blockIndex, finalized);
  }
  modelInstances = instancesByBlock.get(MODEL_BLOCK_INDEX);
  const traversalRoots = [];
  for (let outerIndex = 0; outerIndex < outer.count; outerIndex += 1) {
    for (const root of childInstanceGraph.traversalRoots ?? []) {
      let rootInstanceBlockIndex = root.rootInstanceBlockIndex;
      let rootInstanceIndex = null;
      if (root.includeRootBatch) {
        const inner =
          childInstanceGraph.instancesByBlock.get(
            root.rootInstanceBlockIndex,
          );
        if (inner) {
          rootInstanceIndex =
            outerIndex * inner.count + root.rootInstanceIndex;
        }
      } else if (
        instancesByBlock.has(root.blockIndex)
      ) {
        rootInstanceBlockIndex = root.blockIndex;
        rootInstanceIndex = outerIndex;
      }
      traversalRoots.push(
        Object.freeze({
          blockIndex: root.blockIndex,
          includeRootBatch: root.includeRootBatch,
          rootInstanceBlockIndex:
            Number.isSafeInteger(rootInstanceBlockIndex)
              ? rootInstanceBlockIndex
              : null,
          rootInstanceIndex,
          modelInstanceIndex: outerIndex,
        }),
      );
    }
  }
  const batches = childBatches
    .map((batch) =>
      batch.kind === GpuLineBatchKind.BlockDefinition
        ? batch
        : Object.freeze({
            ...batch,
            kind: GpuLineBatchKind.BlockDefinition,
            blockIndex: MODEL_BLOCK_INDEX,
          }),
    )
    .filter(
      (batch) =>
        (instancesByBlock.get(batch.blockIndex)?.count ?? 0) > 0,
    );
  const result = Object.freeze({
    batches: Object.freeze(batches),
    instanceGraph: Object.freeze({
      instancesByBlock,
      insertsByOwner:
        childInstanceGraph.insertsByOwner ?? new Map(),
      traversalRoots: Object.freeze(traversalRoots),
      dependencyBlockIndices: new Set(
        childInstanceGraph.dependencyBlockIndices ??
          childInstanceGraph.instancesByBlock.keys(),
      ),
      maximumDepth: childInstanceGraph.maximumDepth,
      layers: parentInstanceGraph.layers ?? Object.freeze([]),
      layerLinetypeCodes:
        parentInstanceGraph.layerLinetypeCodes ??
        new Uint16Array(0),
      sourceLayerZeroIndex:
        childInstanceGraph.sourceLayerZeroIndex ?? -1,
      styleLayerMap:
        layerMap instanceof Uint32Array ? layerMap : null,
      styleLinetypeMap:
        linetypeMap instanceof Uint16Array ? linetypeMap : null,
      modelBlockIndices: new Set(
        childInstanceGraph.modelBlockIndices ?? [],
      ),
      rootInstances: modelInstances,
      visibilityGraph,
      clipNodes: Object.freeze(clipNodes),
      localClipNodeStartIndex,
      layerVisibilityRows:
        parentInstanceGraph.layerVisibilityRows,
      paperToModelScalesByVisibilityRow:
        parentInstanceGraph.paperToModelScalesByVisibilityRow,
      linetypeScalesByVisibilityRow:
        parentInstanceGraph.linetypeScalesByVisibilityRow,
      annotationScalesByVisibilityRow:
        parentInstanceGraph.annotationScalesByVisibilityRow,
      lineWeightWorldScale:
        parentInstanceGraph.lineWeightWorldScale ?? 0,
      annotationAllVisible:
        childInstanceGraph.annotationAllVisible ?? true,
      layerColorsByVisibilityRow:
        parentInstanceGraph.layerColorsByVisibilityRow,
      layerLineWeightsByVisibilityRow:
        parentInstanceGraph.layerLineWeightsByVisibilityRow,
      layerLinetypesByVisibilityRow:
        parentInstanceGraph.layerLinetypesByVisibilityRow,
      instanceCount,
      maskBucketScale,
      diagnostics: childInstanceGraph.diagnostics,
      truncated:
        parentInstanceGraph.truncated === true ||
        childInstanceGraph.truncated === true,
      layerZeroIndex:
        parentInstanceGraph.layerZeroIndex ?? NO_LAYER_OVERRIDE,
    }),
  });
  refreshInstanceVisibility(
    result.instanceGraph,
    initialLayerVisibility(parentInstanceGraph.layers),
  );
  return result;
}

export function buildExternalLayerMap(
  rootLayers,
  childLayers,
  prefix,
) {
  const rootByName = new Map(
    rootLayers.map((layer, index) => [layerKey(layer.name), index]),
  );
  const normalizedPrefix = String(prefix ?? "")
    .normalize("NFC")
    .replace(/\|+$/u, "");
  const fallback = rootByName.get("0") ?? 0;
  return Uint32Array.from(
    childLayers.map((layer) => {
      const childName = String(layer.name ?? "");
      if (layerKey(childName) === "0") {
        return fallback;
      }
      return (
        rootByName.get(
          layerKey(
            normalizedPrefix
              ? `${normalizedPrefix}|${childName}`
              : childName,
          ),
        ) ??
        rootByName.get(layerKey(childName)) ??
        fallback
      );
    }),
  );
}

export function synchronizeExternalLayerProperties(
  displayLayers,
  childLayers,
  prefix,
) {
  if (
    !Array.isArray(displayLayers) ||
    !Array.isArray(childLayers) ||
    typeof prefix !== "string" ||
    prefix.length === 0 ||
    prefix.length > 1_024
  ) {
    throw new TypeError("external layer synchronization input is invalid");
  }
  const normalizedPrefix = prefix
    .normalize("NFC")
    .replace(/\|+$/u, "");
  if (!normalizedPrefix) {
    throw new TypeError("external layer prefix is empty");
  }
  const rootByName = new Map(
    displayLayers.map((layer, index) => [layerKey(layer?.name), index]),
  );
  const next = [...displayLayers];
  const changed = [];
  for (const child of childLayers) {
    const childName = String(child?.name ?? "");
    if (!childName) {
      continue;
    }
    const targetIndex = rootByName.get(
      layerKey(`${normalizedPrefix}|${childName}`),
    );
    if (targetIndex === undefined) {
      continue;
    }
    const current = next[targetIndex];
    if (
      !current ||
      ((current.flags ?? 0) & EXTERNAL_DEPENDENT_LAYER_FLAG) === 0
    ) {
      continue;
    }
    const color = child.color >>> 0;
    const flags =
      (((current.flags ?? 0) & ~RELOADABLE_LAYER_FLAGS) |
        ((child.flags ?? 0) & RELOADABLE_LAYER_FLAGS)) >>>
      0;
    const lineWeight =
      Number.isInteger(child.lineWeight) &&
      child.lineWeight >= -3 &&
      child.lineWeight <= 211
        ? child.lineWeight
        : -3;
    const linetype = String(child.linetype ?? "Continuous");
    if (
      current.color === color &&
      current.flags === flags &&
      current.lineWeight === lineWeight &&
      current.linetype === linetype
    ) {
      continue;
    }
    next[targetIndex] = Object.freeze({
      ...current,
      color,
      flags,
      lineWeight,
      linetype,
    });
    changed.push(targetIndex);
  }
  return Object.freeze({
    layers: Object.freeze(next),
    changedIndices: Uint32Array.from(changed),
  });
}

export function applyDisplayLayerProperties(
  instanceGraph,
  baselineLayers,
  displayLayers,
  linetypes,
) {
  if (
    !instanceGraph ||
    !Array.isArray(baselineLayers) ||
    !Array.isArray(displayLayers) ||
    baselineLayers.length !== displayLayers.length ||
    !Array.isArray(instanceGraph.layerVisibilityRows) ||
    !Array.isArray(instanceGraph.layerColorsByVisibilityRow) ||
    !Array.isArray(instanceGraph.layerLineWeightsByVisibilityRow) ||
    !Array.isArray(instanceGraph.layerLinetypesByVisibilityRow)
  ) {
    throw new TypeError("display layer presentation input is inconsistent");
  }
  const codeByName = new Map([
    ["bylayer", 0],
    ["byblock", 1],
    ["continuous", 2],
  ]);
  for (const linetype of linetypes ?? []) {
    if (
      Number.isInteger(linetype?.code) &&
      linetype.code >= 0 &&
      linetype.code <= 2047
    ) {
      codeByName.set(layerKey(linetype.name), linetype.code);
    }
  }
  const linetypeCodeForLayer = (layer) => {
    const name = String(layer?.linetype ?? "Continuous");
    const exact = codeByName.get(layerKey(name));
    if (exact !== undefined) {
      return exact;
    }
    const layerName = String(layer?.name ?? "");
    const separator = layerName.lastIndexOf("|");
    return separator > 0
      ? codeByName.get(
          layerKey(`${layerName.slice(0, separator)}|${name}`),
        ) ?? 2
      : 2;
  };
  const layerLinetypeCodes = Uint16Array.from(
    displayLayers,
    linetypeCodeForLayer,
  );
  const baselineLinetypeCodes = Uint16Array.from(
    baselineLayers,
    linetypeCodeForLayer,
  );
  const colors = instanceGraph.layerColorsByVisibilityRow.map(
    (source, rowIndex) => {
      if (
        !(source instanceof Uint32Array) ||
        source.length !== displayLayers.length
      ) {
        throw new TypeError(`layer color row ${rowIndex} is invalid`);
      }
      const row = new Uint32Array(source);
      for (let index = 0; index < row.length; index += 1) {
        if (row[index] === (baselineLayers[index].color >>> 0)) {
          row[index] = displayLayers[index].color >>> 0;
        }
      }
      return row;
    },
  );
  const lineWeights = instanceGraph.layerLineWeightsByVisibilityRow.map(
    (source, rowIndex) => {
      if (
        !(source instanceof Int16Array) ||
        source.length !== displayLayers.length
      ) {
        throw new TypeError(`layer lineweight row ${rowIndex} is invalid`);
      }
      const row = new Int16Array(source);
      for (let index = 0; index < row.length; index += 1) {
        if (row[index] === baselineLayers[index].lineWeight) {
          row[index] = displayLayers[index].lineWeight;
        }
      }
      return row;
    },
  );
  const linetypeRows = instanceGraph.layerLinetypesByVisibilityRow.map(
    (source, rowIndex) => {
      if (
        !(source instanceof Uint16Array) ||
        source.length !== displayLayers.length
      ) {
        throw new TypeError(`layer linetype row ${rowIndex} is invalid`);
      }
      const row = new Uint16Array(source);
      for (let index = 0; index < row.length; index += 1) {
        if (row[index] === baselineLinetypeCodes[index]) {
          row[index] = layerLinetypeCodes[index];
        }
      }
      return row;
    },
  );
  return Object.freeze({
    instanceGraph: Object.freeze({
      ...instanceGraph,
      layerColorsByVisibilityRow: Object.freeze(colors),
      layerLineWeightsByVisibilityRow: Object.freeze(lineWeights),
      layerLinetypesByVisibilityRow: Object.freeze(linetypeRows),
      layerLinetypeCodes,
    }),
    layerLinetypeCodes,
  });
}

export function remapLineVertexLayers(buffer, layerMap, stride = 36) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    !Number.isInteger(stride) ||
    stride < 32 ||
    buffer.byteLength % stride !== 0
  ) {
    throw new TypeError("line vertex buffer is inconsistent");
  }
  if (!(layerMap instanceof Uint32Array) || layerMap.length === 0) {
    throw new TypeError("external layer map is empty");
  }
  const view = new DataView(buffer);
  for (let offset = 0; offset < buffer.byteLength; offset += stride) {
    const sourceLayer = view.getUint32(offset + 12, true);
    view.setUint32(
      offset + 12,
      sourceLayer < layerMap.length ? layerMap[sourceLayer] : layerMap[0],
      true,
    );
  }
  return buffer;
}

export function remapLineVertexLinetypes(
  buffer,
  linetypeMap,
  stride = 36,
) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    !(linetypeMap instanceof Uint16Array) ||
    !Number.isInteger(stride) ||
    stride < 32 ||
    buffer.byteLength % stride !== 0
  ) {
    throw new TypeError("line linetype remapping input is inconsistent");
  }
  const view = new DataView(buffer);
  const linetypeMask = 0x7ff << 5;
  for (let offset = 0; offset < buffer.byteLength; offset += stride) {
    const style = view.getUint32(offset + 28, true);
    const sourceCode = (style >>> 5) & 0x7ff;
    const targetCode =
      sourceCode < linetypeMap.length
        ? linetypeMap[sourceCode]
        : 2;
    view.setUint32(
      offset + 28,
      ((style & ~linetypeMask) | (targetCode << 5)) >>> 0,
      true,
    );
  }
  return buffer;
}

export function overrideExternalVertexProperties(
  buffer,
  {
    stride = 36,
    lineStyle = true,
    secondaryColor = false,
  } = {},
) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    !Number.isInteger(stride) ||
    stride < 32 ||
    buffer.byteLength % stride !== 0 ||
    typeof lineStyle !== "boolean" ||
    typeof secondaryColor !== "boolean"
  ) {
    throw new TypeError("external ByLayer override input is inconsistent");
  }
  const view = new DataView(buffer);
  for (let offset = 0; offset < buffer.byteLength; offset += stride) {
    view.setUint32(offset + 16, BY_LAYER_ENTITY_COLOR, true);
    if (secondaryColor) {
      view.setUint32(offset + 20, BY_LAYER_ENTITY_COLOR, true);
    }
    if (lineStyle) {
      const style = view.getUint32(offset + 28, true);
      view.setUint32(
        offset + 28,
        ((style & ~(LINE_WEIGHT_MASK | LINETYPE_MASK)) |
          BY_LAYER_LINE_WEIGHT_CODE) >>>
          0,
        true,
      );
    }
  }
  return buffer;
}

export function remapTextEntityLayers(
  textEntities,
  layerMap,
  linetypeMap = null,
  { externalReferenceOverrides = false } = {},
) {
  if (
    !textEntities ||
    !Number.isSafeInteger(textEntities.length) ||
    !(layerMap instanceof Uint32Array) ||
    layerMap.length === 0
  ) {
    throw new TypeError("text layer remapping requires a bounded source");
  }
  const mapLayer = (layerIndex) =>
    layerIndex === 0xffffffff
      ? layerIndex
      : layerIndex < layerMap.length
        ? layerMap[layerIndex]
        : layerMap[0];
  const mapLinetype = (linetypeCode) =>
    linetypeMap instanceof Uint16Array &&
    linetypeCode < linetypeMap.length
      ? linetypeMap[linetypeCode]
      : linetypeCode;
  return Object.freeze({
    length: textEntities.length,
    readDisplayRecord(index, target) {
      const record = textEntities.readDisplayRecord(index, target);
      record.layerIndex = mapLayer(record.layerIndex);
      record.color = externalReferenceOverrides
        ? BY_LAYER_ENTITY_COLOR
        : record.color;
      record.lineWeight = externalReferenceOverrides
        ? -1
        : record.lineWeight;
      record.linetypeCode = externalReferenceOverrides
        ? 0
        : mapLinetype(record.linetypeCode);
      return record;
    },
    readValue(index) {
      return typeof textEntities.readValue === "function"
        ? textEntities.readValue(index)
        : textEntities.get(index).value;
    },
    get(index) {
      const record = textEntities.get(index);
      return Object.freeze({
        ...record,
        layerIndex: mapLayer(record.layerIndex),
        color: externalReferenceOverrides
          ? BY_LAYER_ENTITY_COLOR
          : record.color,
        lineWeight: externalReferenceOverrides
          ? -1
          : record.lineWeight,
        linetypeCode: externalReferenceOverrides
          ? 0
          : mapLinetype(record.linetypeCode),
      });
    },
  });
}

export { MODEL_BLOCK_INDEX };
