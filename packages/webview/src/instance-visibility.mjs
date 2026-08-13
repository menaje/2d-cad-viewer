const NO_LAYER_OVERRIDE = 0xffffffff;

export class InstanceVisibilityBuilder {
  constructor(initialCapacity = 16) {
    if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 1) {
      throw new RangeError("visibility node capacity must be positive");
    }
    this.capacity = initialCapacity;
    this.parentIds = new Uint32Array(initialCapacity);
    this.layerIndices = new Uint32Array(initialCapacity);
    this.layerInherited = new Uint8Array(initialCapacity);
    this.visibilityRows = new Uint32Array(initialCapacity);
    this.sourceVisible = new Uint8Array(initialCapacity);
    this.count = 1;
    this.layerIndices[0] = NO_LAYER_OVERRIDE;
    this.sourceVisible[0] = 1;
  }

  #grow() {
    const capacity = Math.max(this.capacity + 1, this.capacity * 2);
    const parentIds = new Uint32Array(capacity);
    const layerIndices = new Uint32Array(capacity);
    const layerInherited = new Uint8Array(capacity);
    const visibilityRows = new Uint32Array(capacity);
    const sourceVisible = new Uint8Array(capacity);
    parentIds.set(this.parentIds);
    layerIndices.set(this.layerIndices);
    layerInherited.set(this.layerInherited);
    visibilityRows.set(this.visibilityRows);
    sourceVisible.set(this.sourceVisible);
    this.capacity = capacity;
    this.parentIds = parentIds;
    this.layerIndices = layerIndices;
    this.layerInherited = layerInherited;
    this.visibilityRows = visibilityRows;
    this.sourceVisible = sourceVisible;
  }

  add(
    parentId,
    layerIndex,
    visibilityRow,
    { inherited = false, visible = true } = {},
  ) {
    if (
      !Number.isSafeInteger(parentId) ||
      parentId < 0 ||
      parentId >= this.count
    ) {
      throw new RangeError("visibility parent node is invalid");
    }
    if (
      !Number.isInteger(layerIndex) ||
      layerIndex < 0 ||
      layerIndex > NO_LAYER_OVERRIDE
    ) {
      throw new RangeError("visibility layer index is invalid");
    }
    if (!Number.isSafeInteger(visibilityRow) || visibilityRow < 0) {
      throw new RangeError("visibility row is invalid");
    }
    if (this.count >= this.capacity) {
      this.#grow();
    }
    const nodeId = this.count;
    this.parentIds[nodeId] = parentId;
    this.layerIndices[nodeId] = layerIndex;
    this.layerInherited[nodeId] = inherited ? 1 : 0;
    this.visibilityRows[nodeId] = visibilityRow;
    this.sourceVisible[nodeId] = visible ? 1 : 0;
    this.count += 1;
    return nodeId;
  }

  finish() {
    return Object.freeze({
      parentIds: this.parentIds.slice(0, this.count),
      layerIndices: this.layerIndices.slice(0, this.count),
      layerInherited: this.layerInherited.slice(0, this.count),
      visibilityRows: this.visibilityRows.slice(0, this.count),
      sourceVisible: this.sourceVisible.slice(0, this.count),
      values: new Uint8Array(this.count).fill(1),
      count: this.count,
    });
  }
}

export function instanceIsVisible(instances, instanceIndex) {
  const nodeIds = instances?.visibilityNodeIds;
  const values = instances?.visibilityValues;
  if (!(nodeIds instanceof Uint32Array) || !(values instanceof Uint8Array)) {
    return true;
  }
  const nodeId = nodeIds[instanceIndex];
  return nodeId < values.length && values[nodeId] !== 0;
}

export function visibilityNodeIsVisible(instanceGraph, nodeId) {
  const values = instanceGraph?.visibilityGraph?.values;
  return (
    !(values instanceof Uint8Array) ||
    !Number.isInteger(nodeId) ||
    nodeId < 0 ||
    (nodeId < values.length && values[nodeId] !== 0)
  );
}

export function refreshInstanceVisibility(instanceGraph, layerVisibility) {
  const graph = instanceGraph?.visibilityGraph;
  if (
    !graph ||
    !(graph.parentIds instanceof Uint32Array) ||
    !(graph.layerIndices instanceof Uint32Array) ||
    !(graph.visibilityRows instanceof Uint32Array) ||
    !(graph.sourceVisible instanceof Uint8Array) ||
    !(graph.values instanceof Uint8Array) ||
    graph.count !== graph.values.length
  ) {
    return instanceGraph;
  }
  const rows = instanceGraph.layerVisibilityRows;
  graph.values[0] = 1;
  for (let nodeId = 1; nodeId < graph.count; nodeId += 1) {
    const parentId = graph.parentIds[nodeId];
    const layerIndex = graph.layerIndices[nodeId];
    const rowIndex = graph.visibilityRows[nodeId];
    const viewportRow = rows?.[rowIndex];
    const baseVisible =
      layerIndex === NO_LAYER_OVERRIDE ||
      !layerVisibility ||
      layerVisibility[layerIndex] !== false;
    const viewportVisible =
      layerIndex === NO_LAYER_OVERRIDE ||
      !viewportRow ||
      layerIndex >= viewportRow.length ||
      viewportRow[layerIndex] !== 0;
    graph.values[nodeId] =
      parentId < nodeId &&
      graph.values[parentId] !== 0 &&
      graph.sourceVisible[nodeId] !== 0 &&
      baseVisible &&
      viewportVisible
        ? 1
        : 0;
  }
  const collections = new Set(instanceGraph.instancesByBlock?.values?.() ?? []);
  if (instanceGraph.modelInstances) {
    collections.add(instanceGraph.modelInstances);
  }
  if (instanceGraph.rootInstances) {
    collections.add(instanceGraph.rootInstances);
  }
  for (const instances of collections) {
    const selection = instances?.visibilitySelection;
    if (!selection || !(instances.visibilityNodeIds instanceof Uint32Array)) {
      continue;
    }
    let visibleCount = 0;
    for (
      let instanceIndex = 0;
      instanceIndex < instances.count;
      instanceIndex += 1
    ) {
      if (instanceIsVisible(instances, instanceIndex)) {
        visibleCount += 1;
      }
    }
    if (visibleCount === instances.count) {
      selection.instanceIndices = null;
      continue;
    }
    const visible = new Uint32Array(visibleCount);
    let destination = 0;
    for (
      let instanceIndex = 0;
      instanceIndex < instances.count;
      instanceIndex += 1
    ) {
      if (instanceIsVisible(instances, instanceIndex)) {
        visible[destination] = instanceIndex;
        destination += 1;
      }
    }
    selection.instanceIndices = visible;
  }
  return instanceGraph;
}

export function initialLayerVisibility(layers) {
  return Array.from(
    layers ?? [],
    (layer) => ((layer?.flags ?? 0) & 0b11) === 0,
  );
}

export { NO_LAYER_OVERRIDE };
