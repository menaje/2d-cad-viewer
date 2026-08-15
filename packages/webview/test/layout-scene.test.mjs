import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLayoutInstanceGraph,
  buildLayoutRootPlan,
  layoutLineWeightWorldScale,
  paperViewportForLayout,
  paperViewportIdentityError,
  unsupportedViewportDisplayReasons,
  viewportModelToPaperMatrix,
} from "../src/layout-scene.mjs";
import { transformPoint } from "../src/math.mjs";
import { ViewportLayerOverrideFlags } from "../src/scene-cache.mjs";

const blocks = [
  {
    index: 0,
    handle: 100n,
    name: "*MODEL_SPACE",
    basePoint: [0, 0, 0],
  },
  {
    index: 1,
    handle: 101n,
    name: "*PAPER_SPACE",
    basePoint: [0, 0, 0],
  },
  {
    index: 2,
    handle: 102n,
    name: "CHAIR",
    basePoint: [0, 0, 0],
  },
];

const viewport = {
  handle: 202n,
  id: 2,
  center: [210, 148.5, 0],
  width: 380,
  height: 200,
  viewTarget: [1_000, 2_000, 0],
  viewDirection: [0, 0, 1],
  viewTwist: 0,
  viewHeight: 1_000,
  annotationScale: 50,
  viewCenter: [50, -25],
  frozenLayerIndices: [1],
  clipBoundaryVertices: [
    [20, 30, 0],
    [400, 30, 0],
    [380, 260, 0],
    [40, 260, 0],
  ],
};

const layout = {
  name: "배치1",
  blockIndex: 1,
  activeViewportHandle: 201n,
  viewports: [
    {
      ...viewport,
      handle: 201n,
      id: 1,
      center: [210, 148.5, 0],
      width: 420,
      height: 297,
      viewTarget: [0, 0, 0],
      viewHeight: 297,
      viewCenter: [210, 148.5],
      annotationScale: 1,
      frozenLayerIndices: [],
    },
    viewport,
  ],
};

test("maps the model view center to the paper viewport center", () => {
  const matrix = viewportModelToPaperMatrix(viewport);
  assert.deepEqual(
    transformPoint(matrix, [1_050, 1_975, 0]).map((value) =>
      Number(value.toFixed(6)),
    ),
    [210, 148.5, 0],
  );
  assert.deepEqual(
    transformPoint(matrix, [1_550, 1_975, 0]).map((value) =>
      Number(value.toFixed(6)),
    ),
    [310, 148.5, 0],
  );
});

test("subtracts a rotated DCS view center after applying view twist", () => {
  const twisted = {
    ...viewport,
    center: [300, 200, 0],
    viewTarget: [1_000, 2_000, 0],
    viewCenter: [50, -25],
    viewTwist: Math.PI / 2,
  };
  const matrix = viewportModelToPaperMatrix(twisted);
  const worldViewCenter = [975, 1_950, 0];

  assert.deepEqual(
    transformPoint(matrix, worldViewCenter).map((value) =>
      Number(value.toFixed(6)),
    ),
    twisted.center,
  );
});

test("builds paper and clipped model roots with frozen layer rows", () => {
  const plan = buildLayoutRootPlan(blocks, [{}, {}], layout);
  assert.equal(plan.rootContexts.length, 2);
  assert.equal(plan.rootContexts[0].includeRootBatch, true);
  assert.equal(plan.rootContexts[1].modelSpace, true);
  assert.equal(plan.layerVisibilityRows.length, 2);
  assert.deepEqual([...plan.layerVisibilityRows[1]], [1, 0]);
  assert.deepEqual(
    plan.rootContexts[1].clipPoints,
    viewport.clipBoundaryVertices,
  );

  const graph = buildLayoutInstanceGraph(
    blocks,
    [],
    [{ name: "0" }, { name: "VP-FROZEN" }],
    layout,
  );
  assert.equal(graph.modelInstances.count, 1);
  assert.equal(graph.modelInstances.clipIds[0], 1);
  assert.equal(graph.modelInstances.visibilityRows[0], 1);
  assert.deepEqual(
    transformPoint(graph.modelInstances.measurementData, [1_050, 1_975, 0]),
    [1_050, 1_975, 0],
  );
  assert.equal(graph.modelInstances.coordinateSpaceIds[0], 1);
  assert.deepEqual([...graph.paperToModelScalesByVisibilityRow], [1, 5]);
  assert.deepEqual([...graph.linetypeScalesByVisibilityRow], [1, 1]);
  assert.deepEqual([...graph.annotationScalesByVisibilityRow], [1, 50]);
  assert.equal(graph.instancesByBlock.get(1).count, 1);
  assert.equal(graph.instancesByBlock.get(1).coordinateSpaceIds[0], 0);
});

test("normalizes paper-space linetypes by each viewport scale", () => {
  const plan = buildLayoutRootPlan(blocks, [{}, {}], layout, {
    paperSpaceLinetypeScale: true,
  });
  assert.deepEqual(plan.paperToModelScalesByVisibilityRow, [1, 5]);
  assert.deepEqual(plan.linetypeScalesByVisibilityRow, [1, 5]);
  assert.deepEqual(plan.annotationScalesByVisibilityRow, [1, 50]);

  const graph = buildLayoutInstanceGraph(
    blocks,
    [],
    [{ name: "0" }, { name: "VP-FROZEN" }],
    layout,
    { paperSpaceLinetypeScale: true },
  );
  assert.equal(graph.modelInstances.visibilityRows[0], 1);
  assert.deepEqual([...graph.paperToModelScalesByVisibilityRow], [1, 5]);
  assert.deepEqual([...graph.linetypeScalesByVisibilityRow], [1, 5]);
  assert.deepEqual([...graph.annotationScalesByVisibilityRow], [1, 50]);
});

test("uses each layout's saved PSLTSCALE instead of the current header value", () => {
  const enabled = buildLayoutRootPlan(
    blocks,
    [{}, {}],
    { ...layout, flags: 1 },
    { paperSpaceLinetypeScale: false },
  );
  const disabled = buildLayoutRootPlan(
    blocks,
    [{}, {}],
    { ...layout, flags: 0 },
    { paperSpaceLinetypeScale: true },
  );

  assert.deepEqual(enabled.linetypeScalesByVisibilityRow, [1, 5]);
  assert.deepEqual(disabled.linetypeScalesByVisibilityRow, [1, 1]);
});

test("maps layout paper units to zoom-sensitive lineweight world units", () => {
  assert.equal(layoutLineWeightWorldScale({ paperUnit: 1 }), 0.01);
  assert.equal(layoutLineWeightWorldScale({ paperUnit: 0 }), 1 / 2_540);
  assert.equal(layoutLineWeightWorldScale({ paperUnit: 2 }), 0);
  assert.equal(buildLayoutRootPlan(blocks, [{}, {}], layout).lineWeightWorldScale, 0.01);
  assert.equal(
    buildLayoutInstanceGraph(
      blocks,
      [],
      [{ name: "0" }, { name: "VP-FROZEN" }],
      layout,
    ).lineWeightWorldScale,
    0.01,
  );
});

test("builds viewport-specific layer color, opacity, linetype and weight rows", () => {
  const styledLayout = {
    ...layout,
    viewports: [
      layout.viewports[0],
      {
        ...viewport,
        layerOverrides: [
          {
            layerIndex: 0,
            flags:
              ViewportLayerOverrideFlags.Color |
              ViewportLayerOverrideFlags.Transparency |
              ViewportLayerOverrideFlags.Linetype |
              ViewportLayerOverrideFlags.LineWeight,
            color: (3 << 30) | 0x112233,
            transparency: 39 << 24,
            linetypeCode: 4,
            lineWeight: 70,
          },
        ],
      },
    ],
  };
  const layers = [
    { name: "0", color: (2 << 30) | 1, lineWeight: 13 },
    { name: "VP-FROZEN", color: (2 << 30) | 2, lineWeight: 25 },
  ];
  const graph = buildLayoutInstanceGraph(
    blocks,
    [],
    layers,
    styledLayout,
    { layerLinetypeCodes: new Uint16Array([2, 3]) },
  );

  assert.deepEqual(
    [...graph.layerColorsByVisibilityRow[0]],
    [((2 << 30) | 1) >>> 0, ((2 << 30) | 2) >>> 0],
  );
  assert.equal(
    graph.layerColorsByVisibilityRow[1][0],
    (((3 << 30) | 0x112233 | (39 << 24)) >>> 0),
  );
  assert.deepEqual(
    [...graph.layerLineWeightsByVisibilityRow[1]],
    [70, 25],
  );
  assert.deepEqual(
    [...graph.layerLinetypesByVisibilityRow[1]],
    [4, 3],
  );
});

test("keeps a 1:1 model viewport distinct from the paper-space row", () => {
  const oneToOneViewport = {
    ...viewport,
    frozenLayerIndices: [],
    viewHeight: viewport.height,
    annotationScale: 1,
  };
  const oneToOneLayout = {
    ...layout,
    viewports: [layout.viewports[0], oneToOneViewport],
  };
  const plan = buildLayoutRootPlan(blocks, [{}, {}], oneToOneLayout);

  assert.equal(plan.rootContexts[1].visibilityRow, 1);
  assert.deepEqual(plan.paperToModelScalesByVisibilityRow, [1, 1]);
  assert.deepEqual(plan.annotationScalesByVisibilityRow, [1, 1]);
});

test("uses the paper viewport annotation scale for paper-space text", () => {
  const paperScaleLayout = {
    ...layout,
    viewports: [
      { ...layout.viewports[0], annotationScale: 20 },
      viewport,
    ],
  };

  const plan = buildLayoutRootPlan(
    blocks,
    [{}, {}],
    paperScaleLayout,
  );

  assert.deepEqual(plan.annotationScalesByVisibilityRow, [20, 50]);
});

test("defaults paper-space annotation scale to 1:1 without a viewport", () => {
  const plan = buildLayoutRootPlan(blocks, [{}, {}], {
    ...layout,
    viewports: [],
  });

  assert.deepEqual(plan.annotationScalesByVisibilityRow, [1]);
});

test("excludes off and invisible model viewports from an active layout", () => {
  const activeLayout = {
    ...layout,
    viewports: [
      layout.viewports[0],
      { ...viewport, handle: 401n, on: 0, status: 0x20000 },
      { ...viewport, handle: 402n, id: 3, on: 1, flags: 1 },
      {
        ...viewport,
        handle: 403n,
        id: 4,
        on: 1,
        center: [610, 148.5, 0],
      },
      { ...viewport, handle: 404n, id: 5, on: -1 },
      {
        ...viewport,
        handle: 405n,
        id: 6,
        on: 1,
        status: 0x20000,
      },
    ],
  };

  const plan = buildLayoutRootPlan(blocks, [{}, {}], activeLayout);
  assert.deepEqual(
    plan.modelViewports.map(({ handle }) => handle),
    [403n],
  );
  assert.equal(plan.rootContexts.length, 2);
});

test("orders active model viewports so stacking order one is composed last", () => {
  const activeLayout = {
    ...layout,
    viewports: [
      layout.viewports[0],
      { ...viewport, handle: 411n, id: 2, on: 1 },
      { ...viewport, handle: 412n, id: 3, on: 3 },
      { ...viewport, handle: 413n, id: 4, on: 2 },
    ],
  };

  const plan = buildLayoutRootPlan(blocks, [{}, {}], activeLayout);
  assert.deepEqual(
    plan.modelViewports.map(({ handle }) => handle),
    [412n, 413n, 411n],
  );
});

test("renders inactive-layout viewports whose persistent off bit is clear", () => {
  const inactiveLayout = {
    ...layout,
    name: "저장된 비활성 배치",
    activeViewportHandle: 301n,
    viewports: [
      {
        ...layout.viewports[0],
        handle: 301n,
        id: 0,
        on: 0,
      },
      {
        ...viewport,
        handle: 302n,
        id: 0,
        on: 0,
      },
      {
        ...viewport,
        handle: 303n,
        id: 0,
        on: 0,
        center: [610, 148.5, 0],
      },
    ],
  };

  const plan = buildLayoutRootPlan(blocks, [{}, {}], inactiveLayout);
  assert.equal(plan.paperViewport.handle, 301n);
  assert.deepEqual(
    plan.modelViewports.map(({ handle }) => handle),
    [302n, 303n],
  );
  assert.equal(plan.rootContexts.length, 3);
});

test("infers an id-zero paper viewport instead of the active model viewport", () => {
  const missingIdsLayout = {
    ...layout,
    activeViewportHandle: 502n,
    viewports: [
      {
        ...layout.viewports[0],
        handle: 501n,
        id: 0,
        on: 0,
      },
      {
        ...viewport,
        handle: 502n,
        id: 0,
        on: 0,
        center: [420.5, 297, 0],
        width: 841,
        height: 594,
        viewCenter: [126_150, 29_700],
        viewHeight: 59_400,
      },
    ],
  };

  assert.equal(paperViewportForLayout(missingIdsLayout).handle, 501n);
  assert.equal(
    paperViewportIdentityError(missingIdsLayout.viewports[0]),
    0,
  );
  assert.ok(
    paperViewportIdentityError(missingIdsLayout.viewports[1]) > 1,
  );
  const plan = buildLayoutRootPlan(blocks, [{}, {}], missingIdsLayout);
  assert.equal(plan.paperViewport.handle, 501n);
  assert.deepEqual(
    plan.modelViewports.map(({ handle }) => handle),
    [502n],
  );
  assert.equal(plan.rootContexts.length, 2);
});

test("fails closed with explicit diagnostics for unsupported 3D viewport modes", () => {
  const perspective = { ...viewport, status: 0x1 | 0x2 | 0x4 };
  assert.deepEqual(unsupportedViewportDisplayReasons(perspective), [
    "perspective",
    "front-clipping",
    "back-clipping",
  ]);

  const unsupportedLayout = {
    ...layout,
    viewports: [
      layout.viewports[0],
      { ...viewport, handle: 601n, on: 1, status: 1 },
      { ...viewport, handle: 602n, id: 3, on: 2, renderMode: 2 },
      { ...viewport, handle: 603n, id: 4, on: 3, renderMode: 1 },
    ],
  };
  const plan = buildLayoutRootPlan(blocks, [{}, {}], unsupportedLayout);
  assert.deepEqual(
    plan.modelViewports.map(({ handle }) => handle),
    [603n],
  );
  assert.deepEqual(plan.unsupportedViewports, [
    { handle: 601n, id: 2, reasons: ["perspective"] },
    {
      handle: 602n,
      id: 3,
      reasons: ["hidden-or-shaded-render-mode"],
    },
  ]);

  const graph = buildLayoutInstanceGraph(
    blocks,
    [],
    [{ name: "0" }, { name: "VP-FROZEN" }],
    unsupportedLayout,
  );
  assert.equal(graph.unsupportedViewports.length, 2);
});

test("keeps the explicit paper viewport ahead of identity inference", () => {
  const explicitLayout = {
    ...layout,
    viewports: [
      {
        ...layout.viewports[0],
        viewCenter: [0, 0],
        viewHeight: 1,
      },
      {
        ...viewport,
        id: 2,
        center: [10, 20, 0],
        viewCenter: [10, 20],
        viewTarget: [0, 0, 0],
        viewHeight: viewport.height,
      },
    ],
  };

  assert.equal(paperViewportForLayout(explicitLayout).id, 1);
});
