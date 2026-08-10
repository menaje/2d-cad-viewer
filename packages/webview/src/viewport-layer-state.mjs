export function viewportStyleRow(instances, instanceIndex) {
  const row = instances?.visibilityRows?.[instanceIndex] ?? 0;
  return Number.isInteger(row) && row >= 0 ? row : 0;
}

export function viewportLayerColor(
  instanceGraph,
  row,
  layerIndex,
  fallback = 0,
) {
  const value =
    instanceGraph?.layerColorsByVisibilityRow?.[row]?.[layerIndex];
  return Number.isInteger(value) ? value >>> 0 : fallback >>> 0;
}

export function viewportLayerLineWeight(
  instanceGraph,
  row,
  layerIndex,
  fallback = -3,
) {
  const value =
    instanceGraph?.layerLineWeightsByVisibilityRow?.[row]?.[layerIndex];
  return Number.isInteger(value) ? value : fallback;
}

export function viewportLayerLinetype(
  instanceGraph,
  row,
  layerIndex,
  fallback = 2,
) {
  const value =
    instanceGraph?.layerLinetypesByVisibilityRow?.[row]?.[layerIndex];
  return Number.isInteger(value) ? value : fallback;
}
