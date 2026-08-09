import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLayoutInstanceGraph,
  buildLayoutRootPlan,
  viewportModelToPaperMatrix,
} from "../src/layout-scene.mjs";
import { transformPoint } from "../src/math.mjs";

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
  const worldViewCenter = [1_025, 2_050, 0];

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
  assert.equal(graph.instancesByBlock.get(1).count, 1);
  assert.equal(graph.instancesByBlock.get(1).coordinateSpaceIds[0], 0);
});

test("normalizes paper-space linetypes by each viewport scale", () => {
  const plan = buildLayoutRootPlan(blocks, [{}, {}], layout, {
    paperSpaceLinetypeScale: true,
  });
  assert.deepEqual(plan.paperToModelScalesByVisibilityRow, [1, 5]);
  assert.deepEqual(plan.linetypeScalesByVisibilityRow, [1, 5]);

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
});

test("excludes off and invisible model viewports from an active layout", () => {
  const activeLayout = {
    ...layout,
    viewports: [
      layout.viewports[0],
      { ...viewport, handle: 401n, on: 0 },
      { ...viewport, handle: 402n, id: 3, on: 1, flags: 1 },
      {
        ...viewport,
        handle: 403n,
        id: 4,
        on: 1,
        center: [610, 148.5, 0],
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

test("treats an inactive layout's active id-zero viewport as paper space", () => {
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
  assert.equal(plan.rootContexts[1].modelSpace, true);
  assert.equal(plan.rootContexts[2].modelSpace, true);
});
