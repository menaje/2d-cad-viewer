import assert from "node:assert/strict";
import test from "node:test";

import { WHEEL_ZOOM_RATE } from "../../viewer-core/src/viewport-interaction.mjs";
import {
  MAXIMUM_PINCH_ZOOM_PIXELS,
  PINCH_ZOOM_RATE,
  WHEEL_GESTURE_IDLE_MS,
  WHEEL_LINE_PIXELS,
  normalizeWheelGesture,
} from "../src/wheel-gesture.mjs";

test("keeps a macOS smooth-scroll sequence in trackpad pan mode", () => {
  const first = normalizeWheelGesture({
    ctrlKey: false,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 7.5,
    timeStamp: 10,
  });
  assert.equal(first.kind, "trackpad-pan");
  assert.equal(first.panX, 0);
  assert.equal(first.panY, -7.5);
  assert.equal(first.zoomFactor, 1);

  const inertia = normalizeWheelGesture(
    {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 140,
      timeStamp: 80,
    },
    first,
  );
  assert.equal(inertia.kind, "trackpad-pan");
  assert.equal(inertia.panY, -140);

  const nextGesture = normalizeWheelGesture(
    {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 100,
      timeStamp: 80 + WHEEL_GESTURE_IDLE_MS + 1,
    },
    inertia,
  );
  assert.equal(nextGesture.kind, "wheel-zoom");
  assert.equal(nextGesture.panY, 0);
});

test("normalizes Windows precision touchpad and mouse-wheel deltas", () => {
  const touchpad = normalizeWheelGesture({
    ctrlKey: false,
    deltaMode: 0,
    deltaX: -12,
    deltaY: 24,
    timeStamp: 20,
  });
  assert.equal(touchpad.kind, "trackpad-pan");
  assert.equal(touchpad.panX, 12);
  assert.equal(touchpad.panY, -24);

  const wheel = normalizeWheelGesture({
    ctrlKey: false,
    deltaMode: 1,
    deltaX: 0,
    deltaY: 3,
    timeStamp: 40,
  });
  assert.equal(wheel.kind, "wheel-zoom");
  assert.ok(
    Math.abs(
      wheel.zoomFactor -
        Math.exp(3 * WHEEL_LINE_PIXELS * WHEEL_ZOOM_RATE),
    ) < 1e-12,
  );
});

test("zooms an unmodified physical mouse wheel on macOS and Windows", () => {
  for (const deltaY of [-120, -53, 53, 120]) {
    const wheel = normalizeWheelGesture({
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY,
      timeStamp: 20,
    });
    assert.equal(wheel.kind, "wheel-zoom");
    assert.equal(wheel.panX, 0);
    assert.equal(wheel.panY, 0);
    assert.ok(
      Math.abs(
        wheel.zoomFactor - Math.exp(deltaY * WHEEL_ZOOM_RATE),
      ) < 1e-12,
    );
  }
});

test("uses a stronger bounded zoom curve for trackpad pinch", () => {
  const pinch = normalizeWheelGesture({
    ctrlKey: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY: -10,
    timeStamp: 10,
  });
  assert.equal(pinch.kind, "pinch");
  assert.ok(
    Math.abs(pinch.zoomFactor - Math.exp(-10 * PINCH_ZOOM_RATE)) <
      1e-12,
  );
  assert.ok(PINCH_ZOOM_RATE > WHEEL_ZOOM_RATE);

  const bounded = normalizeWheelGesture({
    ctrlKey: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 10_000,
    timeStamp: 20,
  });
  assert.ok(
    Math.abs(
      bounded.zoomFactor -
        Math.exp(MAXIMUM_PINCH_ZOOM_PIXELS * PINCH_ZOOM_RATE),
    ) < 1e-12,
  );
});
