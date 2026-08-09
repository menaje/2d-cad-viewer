import {
  buildInstanceGraph,
  CoordinateSpaceKind,
} from "./instance-graph.mjs";
import {
  arbitraryAxisMat4,
  identityMat4,
  multiplyMat4,
  rotationZMat4,
  scalingMat4,
  translationMat4,
} from "./math.mjs";

const MAX_VISIBILITY_ROWS = 256;

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
    rotationZMat4(-viewport.viewTwist),
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

export function paperViewportForLayout(layout) {
  if (!layout?.viewports?.length) {
    return null;
  }
  return (
    layout.viewports.find((viewport) => viewport.id === 1) ??
    layout.viewports.find(
      (viewport) => viewport.handle === layout.activeViewportHandle,
    ) ??
    layout.viewports[0]
  );
}

function visibilityKey(viewport, paperToModelScale, linetypeScale) {
  const frozenLayers = [...new Set(viewport.frozenLayerIndices ?? [])]
    .sort((left, right) => left - right)
    .join(",");
  return `${frozenLayers}|${paperToModelScale}|${linetypeScale}`;
}

function viewportPaperToModelScale(viewport) {
  return viewport.viewHeight / viewport.height;
}

export function buildLayoutRootPlan(
  blocks,
  layers,
  layout,
  { paperSpaceLinetypeScale = false } = {},
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
  const allVisible = new Uint8Array(layers.length).fill(1);
  const layerVisibilityRows = [allVisible];
  const paperToModelScalesByVisibilityRow = [1];
  const linetypeScalesByVisibilityRow = [1];
  const visibilityRowByKey = new Map([["|1|1", 0]]);
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
  const paperViewport = paperViewportForLayout(layout);
  const hasActiveViewportState = layout.viewports.some(
    (viewport) => viewport !== paperViewport && viewport.id > 0,
  );
  const modelViewports = layout.viewports.filter(
    (viewport) =>
      viewport !== paperViewport &&
      (viewport.flags & 1) === 0 &&
      (!hasActiveViewportState || viewport.on !== 0) &&
      viewport.width > 0 &&
      viewport.height > 0 &&
      viewport.viewHeight > 0,
  );
  for (const viewport of modelViewports) {
    const paperToModelScale = viewportPaperToModelScale(viewport);
    const linetypeScale = paperSpaceLinetypeScale
      ? paperToModelScale
      : 1;
    const key = visibilityKey(
      viewport,
      paperToModelScale,
      linetypeScale,
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
    paperViewport,
    modelViewports: Object.freeze(modelViewports),
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
  return buildInstanceGraph(blocks, inserts, {
    ...options,
    layers,
    rootContexts: plan.rootContexts,
    layerVisibilityRows: plan.layerVisibilityRows,
    paperToModelScalesByVisibilityRow:
      plan.paperToModelScalesByVisibilityRow,
    linetypeScalesByVisibilityRow:
      plan.linetypeScalesByVisibilityRow,
  });
}
