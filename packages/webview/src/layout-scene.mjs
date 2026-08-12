import {
  buildInstanceGraph,
  CoordinateSpaceKind,
} from "./instance-graph.mjs";
import { ViewportLayerOverrideFlags } from "./scene-cache.mjs?v=1.26.0";
import {
  arbitraryAxisMat4,
  identityMat4,
  multiplyMat4,
  rotationZMat4,
  scalingMat4,
  translationMat4,
} from "./math.mjs";

const MAX_VISIBILITY_ROWS = 256;
const VIEWPORT_PERSPECTIVE = 0x1;
const VIEWPORT_FRONT_CLIP = 0x2;
const VIEWPORT_BACK_CLIP = 0x4;
const VIEWPORT_OFF = 0x20000;

export function layoutLineWeightWorldScale(layout) {
  const paperUnit = Number.isInteger(layout?.paperUnit)
    ? layout.paperUnit
    : 1;
  if (paperUnit === 0) {
    return 1 / 2_540;
  }
  if (paperUnit === 1) {
    return 0.01;
  }
  return 0;
}

export function unsupportedViewportDisplayReasons(viewport) {
  const status = Number.isInteger(viewport?.status) ? viewport.status : 0;
  const renderMode = Number.isInteger(viewport?.renderMode)
    ? viewport.renderMode
    : 0;
  const reasons = [];
  if ((status & VIEWPORT_PERSPECTIVE) !== 0) {
    reasons.push("perspective");
  }
  if ((status & VIEWPORT_FRONT_CLIP) !== 0) {
    reasons.push("front-clipping");
  }
  if ((status & VIEWPORT_BACK_CLIP) !== 0) {
    reasons.push("back-clipping");
  }
  if (renderMode > 1) {
    reasons.push("hidden-or-shaded-render-mode");
  }
  return Object.freeze(reasons);
}

function transposeRotation(matrix) {
  const output = identityMat4();
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      output[column * 4 + row] = matrix[row * 4 + column];
    }
  }
  return output;
}

export function viewportModelToPaperMatrix(viewport) {
  if (
    !viewport ||
    !Number.isFinite(viewport.viewHeight) ||
    viewport.viewHeight <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0
  ) {
    throw new RangeError("viewport requires positive view and paper heights");
  }
  const scale = viewport.height / viewport.viewHeight;
  const worldToDcs = transposeRotation(
    arbitraryAxisMat4(viewport.viewDirection),
  );
  return [
    translationMat4(
      viewport.center[0],
      viewport.center[1],
      viewport.center[2] ?? 0,
    ),
    scalingMat4(scale, scale, scale),
    translationMat4(
      -viewport.viewCenter[0],
      -viewport.viewCenter[1],
      0,
    ),
    // WCS-to-DCS is the inverse of AutoCAD's negative DCS view twist.
    rotationZMat4(viewport.viewTwist),
    worldToDcs,
    translationMat4(
      -viewport.viewTarget[0],
      -viewport.viewTarget[1],
      -viewport.viewTarget[2],
    ),
  ].reduce(multiplyMat4);
}

export function viewportRectangle(viewport) {
  const halfWidth = viewport.width * 0.5;
  const halfHeight = viewport.height * 0.5;
  const x = viewport.center[0];
  const y = viewport.center[1];
  return Object.freeze([
    Object.freeze([x - halfWidth, y - halfHeight, 0]),
    Object.freeze([x + halfWidth, y - halfHeight, 0]),
    Object.freeze([x + halfWidth, y + halfHeight, 0]),
    Object.freeze([x - halfWidth, y + halfHeight, 0]),
  ]);
}

export function paperViewportIdentityError(viewport) {
  if (
    !viewport?.center?.slice(0, 2).every(Number.isFinite) ||
    !viewport?.viewCenter?.every(Number.isFinite) ||
    !viewport?.viewTarget?.every(Number.isFinite) ||
    !viewport?.viewDirection?.every(Number.isFinite) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    !Number.isFinite(viewport.viewHeight) ||
    !Number.isFinite(viewport.viewTwist) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.viewHeight <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const scale = Math.max(
    Math.abs(viewport.width),
    Math.abs(viewport.height),
    Math.abs(viewport.viewHeight),
    1,
  );
  const directionLength = Math.hypot(...viewport.viewDirection);
  if (!Number.isFinite(directionLength) || directionLength <= 1e-12) {
    return Number.POSITIVE_INFINITY;
  }
  return (
    Math.hypot(
      viewport.viewCenter[0] - viewport.center[0],
      viewport.viewCenter[1] - viewport.center[1],
    ) /
      scale +
    Math.abs(viewport.viewHeight - viewport.height) /
      Math.max(viewport.viewHeight, viewport.height, 1) +
    Math.hypot(...viewport.viewTarget) / scale +
    Math.hypot(
      viewport.viewDirection[0] / directionLength,
      viewport.viewDirection[1] / directionLength,
      viewport.viewDirection[2] / directionLength - 1,
    ) +
    2 * Math.abs(Math.sin(viewport.viewTwist * 0.5))
  );
}

export function paperViewportForLayout(layout) {
  if (!layout?.viewports?.length) {
    return null;
  }
  const explicit = layout.viewports.find((viewport) => viewport.id === 1);
  if (explicit) {
    return explicit;
  }
  let inferred = null;
  let inferredError = Number.POSITIVE_INFINITY;
  for (const viewport of layout.viewports) {
    const error = paperViewportIdentityError(viewport);
    if (error < inferredError) {
      inferred = viewport;
      inferredError = error;
    }
  }
  return (
    inferred ??
    layout.viewports.find(
      (viewport) => viewport.handle === layout.activeViewportHandle,
    ) ??
    layout.viewports[0]
  );
}

function visibilityKey(
  viewport,
  paperToModelScale,
  linetypeScale,
  annotationScale,
) {
  const frozenLayers = [...new Set(viewport.frozenLayerIndices ?? [])]
    .sort((left, right) => left - right)
    .join(",");
  const layerOverrides = [...(viewport.layerOverrides ?? [])]
    .sort((left, right) => left.layerIndex - right.layerIndex)
    .map(
      (override) =>
        `${override.layerIndex}:${override.flags}:` +
        `${override.color ?? ""}:${override.transparency ?? ""}:` +
        `${override.linetypeCode ?? ""}:${override.lineWeight ?? ""}`,
    )
    .join(",");
  return (
    `${frozenLayers}|${layerOverrides}|${paperToModelScale}|` +
    `${linetypeScale}|${annotationScale}`
  );
}

function baseLayerStyleRows(layers, layerLinetypeCodes) {
  const colors = Uint32Array.from(
    layers,
    (layer) => layer.color >>> 0,
  );
  const lineWeights = Int16Array.from(layers, (layer) => {
    const value = layer.lineWeight;
    return Number.isInteger(value) && value >= -3 && value <= 211
      ? value
      : -3;
  });
  const linetypes = Uint16Array.from(layers, (_, index) => {
    const value = layerLinetypeCodes?.[index];
    return Number.isInteger(value) && value >= 0 && value <= 2047
      ? value
      : 2;
  });
  return { colors, lineWeights, linetypes };
}

function applyViewportLayerOverrides(
  viewport,
  colors,
  lineWeights,
  linetypes,
) {
  const supportedFlags =
    ViewportLayerOverrideFlags.Color |
    ViewportLayerOverrideFlags.Transparency |
    ViewportLayerOverrideFlags.Linetype |
    ViewportLayerOverrideFlags.LineWeight;
  for (const override of viewport.layerOverrides ?? []) {
    const { layerIndex, flags } = override;
    if (
      !Number.isInteger(layerIndex) ||
      layerIndex < 0 ||
      layerIndex >= colors.length ||
      !Number.isInteger(flags) ||
      flags <= 0 ||
      (flags & ~supportedFlags) !== 0
    ) {
      throw new TypeError("viewport contains an invalid layer override");
    }
    let color = colors[layerIndex];
    if (flags & ViewportLayerOverrideFlags.Color) {
      if (!Number.isInteger(override.color)) {
        throw new TypeError("viewport layer color override is invalid");
      }
      color =
        ((color & 0x3f000000) |
          (override.color & 0xc0ffffff)) >>>
        0;
    }
    if (flags & ViewportLayerOverrideFlags.Transparency) {
      if (!Number.isInteger(override.transparency)) {
        throw new TypeError(
          "viewport layer transparency override is invalid",
        );
      }
      color =
        ((color & 0xc0ffffff) |
          (override.transparency & 0x3f000000)) >>>
        0;
    }
    colors[layerIndex] = color;
    if (flags & ViewportLayerOverrideFlags.Linetype) {
      if (
        !Number.isInteger(override.linetypeCode) ||
        override.linetypeCode < 2 ||
        override.linetypeCode > 2047
      ) {
        throw new TypeError("viewport layer linetype override is invalid");
      }
      linetypes[layerIndex] = override.linetypeCode;
    }
    if (flags & ViewportLayerOverrideFlags.LineWeight) {
      if (
        !Number.isInteger(override.lineWeight) ||
        override.lineWeight < 0 ||
        override.lineWeight > 211
      ) {
        throw new TypeError(
          "viewport layer lineweight override is invalid",
        );
      }
      lineWeights[layerIndex] = override.lineWeight;
    }
  }
}

function viewportPaperToModelScale(viewport) {
  return viewport.viewHeight / viewport.height;
}

function viewportAnnotationScale(viewport, paperToModelScale) {
  return Number.isFinite(viewport?.annotationScale) &&
    viewport.annotationScale > 0
    ? viewport.annotationScale
    : paperToModelScale;
}

export function buildLayoutRootPlan(
  blocks,
  layers,
  layout,
  {
    paperSpaceLinetypeScale = false,
    layerLinetypeCodes = null,
  } = {},
) {
  if (
    !layout ||
    !Number.isInteger(layout.blockIndex) ||
    !blocks[layout.blockIndex]
  ) {
    throw new TypeError("layout references an invalid paper-space block");
  }
  const modelBlockIndices = blocks
    .filter((block) => block.name.toUpperCase() === "*MODEL_SPACE")
    .map((block) => block.index);
  const paperViewport = paperViewportForLayout(layout);
  const paperAnnotationScale = viewportAnnotationScale(paperViewport, 1);
  const allVisible = new Uint8Array(layers.length).fill(1);
  const layerVisibilityRows = [allVisible];
  const paperToModelScalesByVisibilityRow = [1];
  const linetypeScalesByVisibilityRow = [1];
  const annotationScalesByVisibilityRow = [paperAnnotationScale];
  const baseStyles = baseLayerStyleRows(layers, layerLinetypeCodes);
  const layerColorsByVisibilityRow = [baseStyles.colors];
  const layerLineWeightsByVisibilityRow = [baseStyles.lineWeights];
  const layerLinetypesByVisibilityRow = [baseStyles.linetypes];
  const visibilityRowByKey = new Map();
  const rootContexts = [
    Object.freeze({
      blockIndex: layout.blockIndex,
      matrix: identityMat4(),
      measurementMatrix: identityMat4(),
      coordinateSpace: CoordinateSpaceKind.Paper,
      includeRootBatch: true,
      modelSpace: false,
      visibilityRow: 0,
    }),
  ];
  const eligibleModelViewports = layout.viewports
    .filter((viewport) => {
      const on = Number.isInteger(viewport.on) ? viewport.on : 1;
      const status = Number.isInteger(viewport.status)
        ? viewport.status
        : 0;
      return (
        viewport !== paperViewport &&
        (viewport.flags & 1) === 0 &&
        on > 0 &&
        (status & VIEWPORT_OFF) === 0 &&
        viewport.width > 0 &&
        viewport.height > 0 &&
        viewport.viewHeight > 0
      );
    });
  const unsupportedViewports = eligibleModelViewports
    .map((viewport) => ({
      viewport,
      reasons: unsupportedViewportDisplayReasons(viewport),
    }))
    .filter(({ reasons }) => reasons.length > 0)
    .map(({ viewport, reasons }) =>
      Object.freeze({
        handle: viewport.handle,
        id: viewport.id,
        reasons,
      }),
    );
  const modelViewports = eligibleModelViewports
    .filter(
      (viewport) => unsupportedViewportDisplayReasons(viewport).length === 0,
    )
    .sort((left, right) => {
      const leftOrder = Number.isInteger(left.on) ? left.on : 1;
      const rightOrder = Number.isInteger(right.on) ? right.on : 1;
      return rightOrder - leftOrder;
    });
  for (const viewport of modelViewports) {
    const paperToModelScale = viewportPaperToModelScale(viewport);
    const linetypeScale = paperSpaceLinetypeScale
      ? paperToModelScale
      : 1;
    const annotationScale = viewportAnnotationScale(
      viewport,
      paperToModelScale,
    );
    const key = visibilityKey(
      viewport,
      paperToModelScale,
      linetypeScale,
      annotationScale,
    );
    let visibilityRow = visibilityRowByKey.get(key);
    if (visibilityRow === undefined) {
      if (layerVisibilityRows.length >= MAX_VISIBILITY_ROWS) {
        throw new RangeError(
          `layout ${layout.name} has too many unique viewport layer states`,
        );
      }
      const row = new Uint8Array(allVisible);
      for (const layerIndex of viewport.frozenLayerIndices ?? []) {
        if (layerIndex < row.length) {
          row[layerIndex] = 0;
        }
      }
      visibilityRow = layerVisibilityRows.length;
      visibilityRowByKey.set(key, visibilityRow);
      layerVisibilityRows.push(row);
      paperToModelScalesByVisibilityRow.push(paperToModelScale);
      linetypeScalesByVisibilityRow.push(linetypeScale);
      annotationScalesByVisibilityRow.push(annotationScale);
      const colors = new Uint32Array(baseStyles.colors);
      const lineWeights = new Int16Array(baseStyles.lineWeights);
      const linetypes = new Uint16Array(baseStyles.linetypes);
      applyViewportLayerOverrides(
        viewport,
        colors,
        lineWeights,
        linetypes,
      );
      layerColorsByVisibilityRow.push(colors);
      layerLineWeightsByVisibilityRow.push(lineWeights);
      layerLinetypesByVisibilityRow.push(linetypes);
    }
    const matrix = viewportModelToPaperMatrix(viewport);
    const clipPoints =
      viewport.clipBoundaryVertices?.length >= 3
        ? viewport.clipBoundaryVertices
        : viewportRectangle(viewport);
    for (const blockIndex of modelBlockIndices) {
      rootContexts.push(
        Object.freeze({
          blockIndex,
          matrix,
          measurementMatrix: identityMat4(),
          coordinateSpace: CoordinateSpaceKind.Model,
          clipPoints,
          modelSpace: true,
          includeRootBatch: false,
          visibilityRow,
          viewportHandle: viewport.handle,
        }),
      );
    }
  }
  return Object.freeze({
    rootContexts: Object.freeze(rootContexts),
    layerVisibilityRows: Object.freeze(layerVisibilityRows),
    paperToModelScalesByVisibilityRow: Object.freeze(
      paperToModelScalesByVisibilityRow,
    ),
    linetypeScalesByVisibilityRow: Object.freeze(
      linetypeScalesByVisibilityRow,
    ),
    annotationScalesByVisibilityRow: Object.freeze(
      annotationScalesByVisibilityRow,
    ),
    layerColorsByVisibilityRow: Object.freeze(
      layerColorsByVisibilityRow,
    ),
    layerLineWeightsByVisibilityRow: Object.freeze(
      layerLineWeightsByVisibilityRow,
    ),
    layerLinetypesByVisibilityRow: Object.freeze(
      layerLinetypesByVisibilityRow,
    ),
    paperViewport,
    modelViewports: Object.freeze(modelViewports),
    unsupportedViewports: Object.freeze(unsupportedViewports),
    lineWeightWorldScale: layoutLineWeightWorldScale(layout),
  });
}

export function buildLayoutInstanceGraph(
  blocks,
  inserts,
  layers,
  layout,
  options = {},
) {
  const plan = buildLayoutRootPlan(blocks, layers, layout, options);
  const graph = buildInstanceGraph(blocks, inserts, {
    ...options,
    layers,
    rootContexts: plan.rootContexts,
    layerVisibilityRows: plan.layerVisibilityRows,
    paperToModelScalesByVisibilityRow:
      plan.paperToModelScalesByVisibilityRow,
    linetypeScalesByVisibilityRow:
      plan.linetypeScalesByVisibilityRow,
    annotationScalesByVisibilityRow:
      plan.annotationScalesByVisibilityRow,
    layerColorsByVisibilityRow: plan.layerColorsByVisibilityRow,
    layerLineWeightsByVisibilityRow:
      plan.layerLineWeightsByVisibilityRow,
    layerLinetypesByVisibilityRow:
      plan.layerLinetypesByVisibilityRow,
  });
  return Object.freeze({
    ...graph,
    unsupportedViewports: plan.unsupportedViewports,
    lineWeightWorldScale: plan.lineWeightWorldScale,
  });
}
