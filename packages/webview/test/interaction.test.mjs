import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  ViewportInteraction,
  WHEEL_ZOOM_RATE,
} from "../src/interaction.mjs";
import { DEFAULT_MINIMUM_PIXEL_HEIGHT } from "../src/text-overlay.mjs";

test("streams bounded detail while zooming out and retains legible text", () => {
  assert.equal(DETAIL_ZOOM_THRESHOLD, 0);
  assert.equal(DETAIL_DEBOUNCE_MS, 650);
  assert.equal(VIEW_COMMIT_DEBOUNCE_MS, 220);
  assert.equal(DEFAULT_MINIMUM_PIXEL_HEIGHT, 0.5);
});

test("injects DWG detail streaming and intercepts platform wheel gestures", () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let observed = false;
  let disconnected = false;
  let nextFrame = 1;
  const listeners = new Map();
  globalThis.ResizeObserver = class {
    observe() {
      observed = true;
    }

    disconnect() {
      disconnected = true;
    }
  };
  globalThis.requestAnimationFrame = () => nextFrame++;
  globalThis.cancelAnimationFrame = () => {};
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    addEventListener(name, listener) {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
    },
    classList: {
      add() {},
      remove() {},
    },
  };
  const renderer = {
    addDetailBatch() {},
    cameraForView(camera) {
      return camera;
    },
    deleteDetailBatch() {},
    redraw(camera) {
      return { camera };
    },
    setDetailSelections() {},
  };
  try {
    const interaction = new ViewportInteraction(
      {
        reader: {
          async readBatchVertices() {
            return { byteLength: 0 };
          },
        },
        renderer,
        metadata: { batches: [] },
        instanceGraph: {},
        render: {
          camera: {
            origin: [0, 0, 0],
            worldHeight: 100,
          },
        },
      },
      canvas,
      {
        keyboardTarget: {
          addEventListener() {},
        },
      },
    );
    assert.equal(observed, true);
    assert.equal(interaction.snapshot().zoom, 1);
    assert.equal(listeners.get("wheel").length, 2);

    let prevented = false;
    let stopped = false;
    listeners.get("wheel")[0]({
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 12,
      deltaY: 24,
      offsetX: 400,
      offsetY: 300,
      timeStamp: 10,
      preventDefault() {
        prevented = true;
      },
      stopImmediatePropagation() {
        stopped = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(interaction.snapshot().zoom, 1);
    assert.ok(
      Math.abs(interaction.snapshot().camera.origin[0] - 2) < 1e-9,
    );
    assert.ok(
      Math.abs(interaction.snapshot().camera.origin[1] + 4) < 1e-9,
    );

    listeners.get("wheel")[0]({
      ctrlKey: true,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -10,
      offsetX: 400,
      offsetY: 300,
      timeStamp: 300,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
    assert.equal(DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY, 1.5);
    assert.ok(interaction.snapshot().zoom > 1.12);

    const pinchZoom = interaction.snapshot().zoom;
    assert.deepEqual(
      interaction.setZoomSensitivity({
        mouseWheelZoomSensitivity: 2,
        trackpadPinchZoomSensitivity: 0.5,
      }),
      {
        mouseWheelZoomSensitivity: 2,
        trackpadPinchZoomSensitivity: 0.5,
      },
    );
    listeners.get("wheel")[0]({
      ctrlKey: true,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -10,
      offsetX: 400,
      offsetY: 300,
      timeStamp: 600,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
    assert.ok(
      Math.abs(
        interaction.snapshot().zoom / pinchZoom - Math.exp(0.04),
      ) < 1e-9,
    );

    const customPinchZoom = interaction.snapshot().zoom;
    listeners.get("wheel")[0]({
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -53,
      offsetX: 400,
      offsetY: 300,
      timeStamp: 900,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
    assert.ok(
      Math.abs(
        interaction.snapshot().zoom / customPinchZoom -
          Math.exp(53 * WHEEL_ZOOM_RATE * 2),
      ) < 1e-9,
    );
    interaction.dispose();
    assert.equal(disconnected, true);
  } finally {
    globalThis.ResizeObserver = OriginalResizeObserver;
    globalThis.requestAnimationFrame = originalAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});
