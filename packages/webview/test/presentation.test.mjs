import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerWebGlApi,
  ViewerWebGlVersion,
  mountWebGlPresentation,
} from "../src/public-api.mjs";

function context() {
  return Object.freeze({
    sourceSession: Object.freeze({}),
    snapshot: Object.freeze({}),
    host: Object.freeze({}),
    signal: undefined,
  });
}

function canvas() {
  return Object.freeze({
    getContext() {
      return null;
    },
  });
}

test("publishes a stable Viewer WebGL package identity", () => {
  assert.equal(ViewerWebGlApi, "menaje-viewer-webgl/0.1");
  assert.equal(ViewerWebGlVersion, "0.1.1");
});

test("mounts and idempotently disposes an injected WebGL presentation", async () => {
  const events = [];
  const viewerContext = context();
  const renderer = {
    dispose() {
      events.push("renderer.dispose");
    },
  };
  const presentation = await mountWebGlPresentation(viewerContext, {
    canvas: canvas(),
    renderer,
    async load(input) {
      assert.equal(input.renderer, renderer);
      assert.equal(input.canvas.getContext(), null);
      return {
        renderer,
        render: Object.freeze({ camera: Object.freeze({}) }),
        async dispose() {
          events.push("scene.dispose");
        },
      };
    },
  });

  assert.equal(presentation.context, viewerContext);
  assert.equal(presentation.renderer, renderer);
  assert.equal(presentation.scene.renderer, renderer);
  await presentation.dispose();
  await presentation.dispose();
  assert.deepEqual(events, [
    "scene.dispose",
    "renderer.dispose",
  ]);
});

test("releases an injected renderer when scene loading fails", async () => {
  let disposals = 0;
  const renderer = {
    dispose() {
      disposals += 1;
    },
  };

  await assert.rejects(
    mountWebGlPresentation(context(), {
      canvas: canvas(),
      renderer,
      load() {
        throw new Error("scene rejected");
      },
    }),
    /scene rejected/u,
  );
  assert.equal(disposals, 1);
});
