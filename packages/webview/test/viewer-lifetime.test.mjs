import assert from "node:assert/strict";
import test from "node:test";

import { createDisposableFirstFrameScene } from "../src/viewer.mjs";

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
