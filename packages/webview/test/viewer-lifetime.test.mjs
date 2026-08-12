import assert from "node:assert/strict";
import test from "node:test";

import {
  createDisposableFirstFrameScene,
  makeViewDescriptors,
} from "../src/viewer.mjs";

test("drops first-frame payload immediately when a scene is disposed", () => {
  let cacheClears = 0;
  const renderer = {};
  const metadata = { marker: "metadata" };
  const scene = createDisposableFirstFrameScene({
    reader: {
      cache: {
        clear() {
          cacheClears += 1;
        },
      },
    },
    metadata,
    instanceGraph: { marker: "instances" },
    overview: new Uint8Array(1024),
    imageEntities: { marker: "images" },
    renderer,
    render: { marker: "render" },
    metrics: { marker: "metrics" },
    views: Object.freeze([]),
    activeView: { marker: "view" },
    layerLineTypes: new Uint32Array(1),
  });

  assert.equal(scene.metadata, metadata);
  assert.equal(scene.renderer, renderer);

  scene.dispose();
  scene.dispose();

  assert.equal(cacheClears, 1);
  assert.equal(scene.reader, undefined);
  assert.equal(scene.metadata, undefined);
  assert.equal(scene.instanceGraph, undefined);
  assert.equal(scene.overview, undefined);
  assert.equal(scene.renderer, undefined);
  assert.throws(
    () => scene.buildViewInstanceGraph({ kind: "model" }),
    { name: "AbortError" },
  );
});

test("applies MSLTSCALE and ANNOALLVISIBLE to model and alternate views", () => {
  const metadata = {
    drawing: {
      annotationAllVisible: false,
      modelAnnotationScale: 100,
      modelSpaceLinetypeScale: true,
      paperSpaceLinetypeScale: false,
      modelSpaceActive: true,
    },
    blocks: [
      {
        index: 0,
        handle: 1n,
        name: "*MODEL_SPACE",
        basePoint: [0, 0, 0],
      },
    ],
    inserts: [],
    layers: [],
    insertClips: [],
    layouts: [],
  };
  const scene = createDisposableFirstFrameScene({
    reader: { cache: { clear() {} } },
    metadata,
    layerLineTypes: new Uint16Array(0),
    views: Object.freeze([]),
  });

  const graph = scene.buildViewInstanceGraph({
    kind: "model",
    annotationAllVisible: false,
  });
  assert.deepEqual([...graph.linetypeScalesByVisibilityRow], [100]);
  assert.equal(graph.annotationAllVisible, false);
  scene.dispose();
});

test("keeps model and per-layout ANNOALLVISIBLE independent", () => {
  const layoutGeometry = {
    extents: { min: [0, 0, 0], max: [1, 1, 0] },
    limits: { min: [0, 0], max: [1, 1] },
  };
  const metadata = {
    drawing: {
      annotationAllVisible: false,
      modelSpaceActive: false,
      savedModelView: null,
    },
    blocks: [
      { index: 0, name: "*MODEL_SPACE" },
      { index: 1, name: "*PAPER_SPACE" },
      { index: 2, name: "*PAPER_SPACE1" },
    ],
    layouts: [
      {
        index: 0,
        blockIndex: 0,
        tabOrder: 0,
        name: "Model",
        annotationAllVisible: true,
        viewports: [],
      },
      {
        index: 1,
        blockIndex: 1,
        tabOrder: 1,
        name: "Layout false",
        annotationAllVisible: false,
        viewports: [],
        ...layoutGeometry,
      },
      {
        index: 2,
        blockIndex: 2,
        tabOrder: 2,
        name: "Layout true",
        annotationAllVisible: true,
        viewports: [],
        ...layoutGeometry,
      },
    ],
  };

  const viewSet = makeViewDescriptors(metadata);

  assert.deepEqual(
    viewSet.views.map((view) => [view.label, view.annotationAllVisible]),
    [
      ["Model", false],
      ["Layout false", false],
      ["Layout true", true],
    ],
  );
  assert.equal(viewSet.active.label, "Layout false");
});

test("falls back to the drawing ANNOALLVISIBLE for legacy layouts", () => {
  const layoutGeometry = {
    extents: { min: [0, 0, 0], max: [1, 1, 0] },
    limits: { min: [0, 0], max: [1, 1] },
  };
  const viewSet = makeViewDescriptors({
    drawing: {
      annotationAllVisible: true,
      modelSpaceActive: false,
      savedModelView: null,
    },
    blocks: [
      { index: 0, name: "*MODEL_SPACE" },
      { index: 1, name: "*PAPER_SPACE" },
    ],
    layouts: [
      {
        index: 0,
        blockIndex: 0,
        tabOrder: 0,
        name: "Model",
        viewports: [],
      },
      {
        index: 1,
        blockIndex: 1,
        tabOrder: 1,
        name: "Layout",
        viewports: [],
        ...layoutGeometry,
      },
    ],
  });

  assert.deepEqual(
    viewSet.views.map((view) => view.annotationAllVisible),
    [true, true],
  );
});
