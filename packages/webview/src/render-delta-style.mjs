import {
  cadOpacityCode,
  decodeCadOpacity,
} from "./cad-color.mjs";
import {
  walkInstanceDependencyOccurrences,
} from "./instance-dependency.mjs";
import {
  viewportLayerColor,
  viewportLayerLineWeight,
  viewportLayerLinetype,
} from "./viewport-layer-state.mjs";

const DWG_RENDER_DELTA_STYLE_BYTES = 40;
const DEFAULT_MAXIMUM_DERIVED_STYLE_BYTES = 8 * 1024 * 1024;

const DwgRenderDeltaStyleFlag = Object.freeze({
  COLOR: 1 << 0,
  LAYER: 1 << 1,
  OPACITY: 1 << 2,
  LINE_WEIGHT: 1 << 3,
  LINETYPE: 1 << 4,
  VISIBILITY: 1 << 5,
});
const ALL_STYLE_FLAGS = Object.values(
  DwgRenderDeltaStyleFlag,
).reduce((combined, flag) => combined | flag, 0);
const NO_LAYER = 0xffff_ffff;
const NORMALIZED_STYLE_RECORDS = new WeakSet();
const NORMALIZED_STYLE_RECORD_BYTES = new WeakMap();
const DEFAULT_BYBLOCK_COLOR = (2 << 30) | 7;

function mappedStyleLayer(instanceGraph, sourceLayerIndex) {
  const layerMap = instanceGraph.styleLayerMap;
  if (!(layerMap instanceof Uint32Array)) {
    return sourceLayerIndex;
  }
  return sourceLayerIndex < layerMap.length
    ? layerMap[sourceLayerIndex]
    : layerMap[0] ?? NO_LAYER;
}

function mappedStyleLinetype(instanceGraph, sourceLinetypeCode) {
  const linetypeMap = instanceGraph.styleLinetypeMap;
  if (!(linetypeMap instanceof Uint16Array)) {
    return sourceLinetypeCode;
  }
  return sourceLinetypeCode < linetypeMap.length
    ? linetypeMap[sourceLinetypeCode]
    : 2;
}

function baseInstanceStyle(instances, instanceIndex) {
  return {
    color:
      instances.colors?.[instanceIndex] ?? DEFAULT_BYBLOCK_COLOR,
    layerIndex:
      instances.layerIndices?.[instanceIndex] ?? NO_LAYER,
    opacity: instances.opacities?.[instanceIndex] ?? 1,
    lineWeight: instances.lineWeights?.[instanceIndex] ?? -3,
    linetypeCode:
      instances.linetypeCodes?.[instanceIndex] ?? 2,
    visible: true,
    colorInherited:
      instances.colorInherited?.[instanceIndex] === 1,
    layerInherited:
      instances.layerInherited?.[instanceIndex] === 1,
    opacityInherited:
      instances.opacityInherited?.[instanceIndex] === 1,
    lineWeightInherited:
      instances.lineWeightInherited?.[instanceIndex] === 1,
    linetypeInherited:
      instances.linetypeInherited?.[instanceIndex] === 1,
    visibilityRow: instances.visibilityRows?.[instanceIndex] ?? 0,
  };
}

function resolvedNestedStyle(instanceGraph, insert, parent) {
  const layers = instanceGraph.layers ?? [];
  const layerLinetypeCodes =
    instanceGraph.layerLinetypeCodes ?? [];
  const sourceLayerZeroIndex =
    Number.isInteger(instanceGraph.sourceLayerZeroIndex)
      ? instanceGraph.sourceLayerZeroIndex
      : -1;
  const sourceLayerIndex = Number.isInteger(insert.layerIndex)
    ? insert.layerIndex
    : sourceLayerZeroIndex >= 0
      ? sourceLayerZeroIndex
      : NO_LAYER;
  const inheritsLayer =
    sourceLayerZeroIndex >= 0 &&
    sourceLayerIndex === sourceLayerZeroIndex;
  const insertLayerIndex = mappedStyleLayer(
    instanceGraph,
    sourceLayerIndex,
  );
  const layerIndex =
    inheritsLayer && parent.layerIndex !== NO_LAYER
      ? parent.layerIndex
      : insertLayerIndex;
  const layerInherited = inheritsLayer
    ? parent.layerInherited
    : false;
  const insertColor =
    Number.isInteger(insert.color) ? insert.color >>> 0 : 0;
  const colorKind = insertColor >>> 30;
  const layerColor = viewportLayerColor(
    instanceGraph,
    parent.visibilityRow,
    layerIndex,
    layers[layerIndex]?.color ?? DEFAULT_BYBLOCK_COLOR,
  );
  const color =
    colorKind === 0
      ? layerColor
      : colorKind === 1
        ? parent.color
        : insertColor;
  const colorInherited =
    colorKind === 1 ? parent.colorInherited : false;
  const opacityCode = cadOpacityCode(insertColor);
  const opacity = Math.fround(
    decodeCadOpacity(insertColor, {
      layer: decodeCadOpacity(layerColor),
      byBlock: parent.opacity,
    }),
  );
  const opacityInherited =
    opacityCode === 2 ? parent.opacityInherited : false;
  const sourceLineWeight =
    Number.isInteger(insert.lineWeight) ? insert.lineWeight : -1;
  const layerLineWeight = viewportLayerLineWeight(
    instanceGraph,
    parent.visibilityRow,
    layerIndex,
    Number.isInteger(layers[layerIndex]?.lineWeight)
      ? layers[layerIndex].lineWeight
      : -3,
  );
  const lineWeight =
    sourceLineWeight === -1
      ? layerLineWeight >= 0
        ? layerLineWeight
        : -3
      : sourceLineWeight === -2
        ? parent.lineWeight
        : sourceLineWeight;
  const lineWeightInherited =
    sourceLineWeight === -2
      ? parent.lineWeightInherited
      : false;
  const rawLinetypeCode =
    Number.isInteger(insert.linetypeCode) &&
    insert.linetypeCode >= 0 &&
    insert.linetypeCode <= 2047
      ? insert.linetypeCode
      : 0;
  const layerLinetypeCode = viewportLayerLinetype(
    instanceGraph,
    parent.visibilityRow,
    layerIndex,
    Number.isInteger(layerLinetypeCodes[layerIndex]) &&
      layerLinetypeCodes[layerIndex] >= 2
      ? layerLinetypeCodes[layerIndex]
      : 2,
  );
  const linetypeCode =
    rawLinetypeCode === 0
      ? layerLinetypeCode
      : rawLinetypeCode === 1
        ? parent.linetypeCode
        : mappedStyleLinetype(
            instanceGraph,
            rawLinetypeCode,
          );
  const linetypeInherited =
    rawLinetypeCode === 1
      ? parent.linetypeInherited
      : false;
  return {
    color,
    layerIndex,
    opacity,
    lineWeight,
    linetypeCode,
    visible: parent.visible,
    colorInherited,
    layerInherited,
    opacityInherited,
    lineWeightInherited,
    linetypeInherited,
    visibilityRow: parent.visibilityRow,
  };
}

function applyDirectStyle(state, direct) {
  const next = { ...state };
  for (const [property, inheritedProperty] of [
    ["color", "colorInherited"],
    ["layerIndex", "layerInherited"],
    ["opacity", "opacityInherited"],
    ["lineWeight", "lineWeightInherited"],
    ["linetypeCode", "linetypeInherited"],
  ]) {
    if (direct?.[property] !== null && direct?.[property] !== undefined) {
      next[property] = direct[property];
      next[inheritedProperty] = false;
    }
  }
  if (direct?.visible !== null && direct?.visible !== undefined) {
    next.visible = next.visible && direct.visible;
  }
  return next;
}

function replacementStyle(base, effective, direct, instanceIndex, handle) {
  const replacement = {
    blockIndex: direct?.blockIndex ?? null,
    instanceIndex,
    handle,
    handleLow: Number(handle & 0xffff_ffffn),
    handleHigh: Number(handle >> 32n),
  };
  let changed = false;
  for (const property of [
    "color",
    "layerIndex",
    "opacity",
    "lineWeight",
    "linetypeCode",
  ]) {
    const directValue = direct?.[property];
    const value =
      directValue !== null && directValue !== undefined
        ? effective[property]
        : effective[property] !== base[property]
          ? effective[property]
          : null;
    replacement[property] = value;
    changed ||= value !== null;
  }
  const directVisibility = direct?.visible;
  replacement.visible =
    effective.visible !== true ||
    (directVisibility !== null &&
      directVisibility !== undefined)
      ? effective.visible
      : null;
  changed ||= replacement.visible !== null;
  return changed ? Object.freeze(replacement) : null;
}

function normalizeHandle(value, label) {
  let handle;
  try {
    handle =
      typeof value === "bigint"
        ? value
        : BigInt(
            typeof value === "string"
              ? `0x${value.replace(/^0x/iu, "")}`
              : value,
          );
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (handle < 0n || handle > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} exceeds u64`);
  }
  return handle;
}

function active(flags, flag) {
  return (flags & flag) !== 0;
}

export function decodeDwgRenderDeltaStyle(
  buffer,
  { expectedHandle = null } = {},
) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== DWG_RENDER_DELTA_STYLE_BYTES
  ) {
    throw new TypeError("DWG render delta style buffer is invalid");
  }
  const view = new DataView(buffer);
  const blockIndex = view.getUint32(0, true);
  const instanceIndex = view.getUint32(4, true);
  const handleLow = view.getUint32(8, true);
  const handleHigh = view.getUint32(12, true);
  const handle =
    BigInt(handleLow) | (BigInt(handleHigh) << 32n);
  if (
    expectedHandle !== null &&
    handle !==
      normalizeHandle(expectedHandle, "expected DWG style handle")
  ) {
    throw new TypeError(
      "DWG render delta style belongs to another Render ID",
    );
  }
  const flags = view.getUint32(16, true);
  const color = view.getUint32(20, true);
  const layerIndex = view.getUint32(24, true);
  const opacity = view.getFloat32(28, true);
  const lineWeight = view.getInt16(32, true);
  const linetypeCode = view.getUint16(34, true);
  const visible = view.getUint8(36);
  if (
    flags === 0 ||
    (flags & ~ALL_STYLE_FLAGS) !== 0 ||
    (!active(flags, DwgRenderDeltaStyleFlag.COLOR) && color !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.LAYER) &&
      layerIndex !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.OPACITY) &&
      view.getUint32(28, true) !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.LINE_WEIGHT) &&
      lineWeight !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.LINETYPE) &&
      linetypeCode !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.VISIBILITY) &&
      visible !== 0) ||
    view.getUint8(37) !== 0 ||
    view.getUint8(38) !== 0 ||
    view.getUint8(39) !== 0
  ) {
    throw new TypeError(
      "DWG render delta style flags or reserved fields are invalid",
    );
  }
  if (
    (active(flags, DwgRenderDeltaStyleFlag.COLOR) &&
      (color >>> 30) < 2) ||
    (active(flags, DwgRenderDeltaStyleFlag.OPACITY) &&
      (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)) ||
    (active(flags, DwgRenderDeltaStyleFlag.LINE_WEIGHT) &&
      (lineWeight < -3 ||
        lineWeight > 211 ||
        lineWeight === -2 ||
        lineWeight === -1)) ||
    (active(flags, DwgRenderDeltaStyleFlag.LINETYPE) &&
      (linetypeCode < 2 || linetypeCode > 2047)) ||
    (active(flags, DwgRenderDeltaStyleFlag.VISIBILITY) &&
      visible > 1)
  ) {
    throw new RangeError(
      "DWG render delta style value is outside its supported range",
    );
  }
  const record = Object.freeze({
    blockIndex,
    instanceIndex,
    handle,
    handleLow,
    handleHigh,
    color: active(flags, DwgRenderDeltaStyleFlag.COLOR)
      ? color
      : null,
    layerIndex: active(flags, DwgRenderDeltaStyleFlag.LAYER)
      ? layerIndex
      : null,
    opacity: active(flags, DwgRenderDeltaStyleFlag.OPACITY)
      ? opacity
      : null,
    lineWeight: active(
      flags,
      DwgRenderDeltaStyleFlag.LINE_WEIGHT,
    )
      ? lineWeight
      : null,
    linetypeCode: active(flags, DwgRenderDeltaStyleFlag.LINETYPE)
      ? linetypeCode
      : null,
    visible: active(flags, DwgRenderDeltaStyleFlag.VISIBILITY)
      ? visible === 1
      : null,
  });
  NORMALIZED_STYLE_RECORDS.add(record);
  NORMALIZED_STYLE_RECORD_BYTES.set(record, buffer.byteLength);
  return record;
}

export function isNormalizedDwgRenderDeltaStyleRecord(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    NORMALIZED_STYLE_RECORDS.has(value)
  );
}

export function dwgRenderDeltaStyleByteLength(value) {
  return NORMALIZED_STYLE_RECORD_BYTES.get(value) ?? null;
}

export function indexDwgRenderDeltaStyles(
  entries,
  {
    sourceId,
    instanceGraph,
    requireComplete = true,
    deriveDependencies = true,
    maximumDerivedBytes =
      DEFAULT_MAXIMUM_DERIVED_STYLE_BYTES,
  } = {},
) {
  if (
    !Array.isArray(entries) ||
    typeof sourceId !== "string" ||
    sourceId.length === 0 ||
    !(instanceGraph?.instancesByBlock instanceof Map) ||
    typeof deriveDependencies !== "boolean" ||
    !Number.isSafeInteger(maximumDerivedBytes) ||
    maximumDerivedBytes < 0
  ) {
    throw new TypeError(
      "DWG render delta style index input is invalid",
    );
  }
  const selected = [];
  const byInstances = new Map();
  const hiddenInstances = new Set();
  for (const entry of entries) {
    if (entry?.sceneId !== sourceId) {
      continue;
    }
    if (
      entry.resourceKind !== "style" ||
      !isNormalizedDwgRenderDeltaStyleRecord(entry.record) ||
      entry.byteLength !== dwgRenderDeltaStyleByteLength(entry.record)
    ) {
      throw new TypeError("DWG render delta style entry is invalid");
    }
    const { record } = entry;
    if (!(instanceGraph.insertsByOwner instanceof Map)) {
      throw new TypeError(
        "DWG render delta style dependency graph is unavailable",
      );
    }
    const instances = instanceGraph.instancesByBlock.get(
      record.blockIndex,
    );
    if (
      !instances ||
      !Number.isSafeInteger(instances.count) ||
      record.instanceIndex >= instances.count ||
      instances.handles?.[record.instanceIndex] !== record.handle
    ) {
      throw new TypeError("DWG render delta style target is invalid");
    }
    let byIndex = byInstances.get(instances);
    if (!byIndex) {
      byIndex = new Map();
      byInstances.set(instances, byIndex);
    }
    if (byIndex.has(record.instanceIndex)) {
      throw new TypeError(
        "DWG render delta style target is duplicated",
      );
    }
    byIndex.set(record.instanceIndex, record);
    if (record.visible === false) {
      hiddenInstances.add(instances);
    }
    selected.push(entry);
  }
  if (requireComplete) {
    for (const [instances, byIndex] of byInstances) {
      const styledHandles = new Set(
        [...byIndex.values()].map((record) => record.handle),
      );
      for (
        let instanceIndex = 0;
        instanceIndex < instances.count;
        instanceIndex += 1
      ) {
        if (
          styledHandles.has(instances.handles[instanceIndex]) &&
          !byIndex.has(instanceIndex)
        ) {
          throw new TypeError(
            "DWG render delta style occurrence coverage is incomplete",
          );
        }
      }
    }
  }
  let derivedCount = 0;
  let derivedByteLength = 0;
  const hasNestedTarget =
    deriveDependencies &&
    selected.some(
      ({ record }) =>
        (instanceGraph.insertsByOwner.get(record.blockIndex)
          ?.length ?? 0) > 0,
    );
  if (hasNestedTarget) {
    walkInstanceDependencyOccurrences(
      instanceGraph,
      (
        instances,
        instanceIndex,
        _parentInstances,
        _parentInstanceIndex,
        parentState,
        insert,
      ) => {
        const direct =
          byInstances.get(instances)?.get(instanceIndex) ?? null;
        if (!parentState && !direct) {
          return null;
        }
        const base = baseInstanceStyle(instances, instanceIndex);
        const inherited =
          parentState && insert
            ? resolvedNestedStyle(
                instanceGraph,
                insert,
                parentState,
              )
            : base;
        const effective = applyDirectStyle(inherited, direct);
        const replacement = replacementStyle(
          base,
          effective,
          direct,
          instanceIndex,
          instances.handles[instanceIndex],
        );
        if (!parentState && direct) {
          return Object.freeze(effective);
        }
        if (!replacement) {
          return null;
        }
        if (
          derivedByteLength + DWG_RENDER_DELTA_STYLE_BYTES >
          maximumDerivedBytes
        ) {
          throw new RangeError(
            `DWG derived style data exceeds the ${maximumDerivedBytes}-byte limit`,
          );
        }
        let byIndex = byInstances.get(instances);
        if (!byIndex) {
          byIndex = new Map();
          byInstances.set(instances, byIndex);
        }
        byIndex.set(instanceIndex, replacement);
        if (replacement.visible === false) {
          hiddenInstances.add(instances);
        }
        derivedCount += 1;
        derivedByteLength += DWG_RENDER_DELTA_STYLE_BYTES;
        return Object.freeze(effective);
      },
    );
  }
  return Object.freeze({
    entries: Object.freeze(selected),
    byInstances,
    hiddenInstances,
    derivedCount,
    derivedByteLength,
  });
}

export function renderDeltaInstanceStyle(
  index,
  instances,
  instanceIndex,
) {
  return (
    index?.byInstances?.get(instances)?.get(instanceIndex) ?? null
  );
}

export {
  DwgRenderDeltaStyleFlag,
  DEFAULT_MAXIMUM_DERIVED_STYLE_BYTES,
  DWG_RENDER_DELTA_STYLE_BYTES,
  NO_LAYER as DWG_RENDER_DELTA_NO_LAYER,
};
