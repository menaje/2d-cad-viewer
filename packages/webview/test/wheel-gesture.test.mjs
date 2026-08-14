import assert from "node:assert/strict";
import test from "node:test";

import { WHEEL_ZOOM_RATE } from "../../viewer-core/src/viewport-interaction.mjs";
import {
  DEFAULT_SCROLL_INPUT_MODE,
  DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
  DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  MAXIMUM_ZOOM_SENSITIVITY,
  MAXIMUM_PINCH_ZOOM_PIXELS,
  MINIMUM_ZOOM_SENSITIVITY,
  PINCH_ZOOM_RATE,
  SCROLL_INPUT_MODE_MOUSE_ZOOM,
  SCROLL_INPUT_MODE_TRACKPAD_PAN,
  WHEEL_LINE_PIXELS,
  normalizeWheelGesture,
  normalizeScrollInputMode,
  normalizeZoomSensitivity,
} from "../src/wheel-gesture.mjs";

test("uses deterministic mouse zoom for every unmodified scroll by default", () => {
  assert.equal(DEFAULT_SCROLL_INPUT_MODE, SCROLL_INPUT_MODE_MOUSE_ZOOM);
  for (const [deltaX, deltaY] of [
    [0, 1],
    [0, 7.5],
    [1, 4],
    [0, 53],
    [0, 120],
  ]) {
    const wheel = normalizeWheelGesture({
      ctrlKey: false,
      deltaMode: 0,
      deltaX,
      deltaY,
      timeStamp: 10,
    });
    assert.equal(wheel.kind, "wheel-zoom");
    assert.equal(wheel.panX, 0);
    assert.equal(wheel.panY, 0);
    assert.notEqual(wheel.zoomFactor, 1);
  }
});

test("keeps slow, fast and line-mode input in explicit trackpad pan mode", () => {
  for (const [deltaMode, deltaX, deltaY, expectedX, expectedY] of [
    [0, 0, 1, 0, -1],
    [0, -12, 24, 12, -24],
    [0, 0, 140, 0, -140],
    [1, 0, 3, 0, -3 * WHEEL_LINE_PIXELS],
  ]) {
    const gesture = normalizeWheelGesture(
      {
        ctrlKey: false,
        deltaMode,
        deltaX,
        deltaY,
        timeStamp: 20,
      },
      { scrollInputMode: SCROLL_INPUT_MODE_TRACKPAD_PAN },
    );
    assert.equal(gesture.kind, "trackpad-pan");
    assert.equal(gesture.panX, expectedX);
    assert.equal(gesture.panY, expectedY);
    assert.equal(gesture.zoomFactor, 1);
  }
});

test("does not expose an automatic input mode", () => {
  assert.equal(
    normalizeScrollInputMode(SCROLL_INPUT_MODE_TRACKPAD_PAN),
    SCROLL_INPUT_MODE_TRACKPAD_PAN,
  );
  for (const value of [undefined, null, "auto", "wheel", 1]) {
    assert.equal(
      normalizeScrollInputMode(value),
      SCROLL_INPUT_MODE_MOUSE_ZOOM,
    );
  }
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
  }, {
    scrollInputMode: SCROLL_INPUT_MODE_TRACKPAD_PAN,
  });
  assert.equal(pinch.kind, "pinch");
  assert.ok(
    Math.abs(
      pinch.zoomFactor -
        Math.exp(
          -10 *
            PINCH_ZOOM_RATE *
            DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
        ),
    ) <
      1e-12,
  );
  assert.equal(DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY, 1.5);
  assert.ok(PINCH_ZOOM_RATE > WHEEL_ZOOM_RATE);

  const bounded = normalizeWheelGesture({
    ctrlKey: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 10_000,
    timeStamp: 20,
  }, {
    scrollInputMode: SCROLL_INPUT_MODE_TRACKPAD_PAN,
  });
  assert.ok(
    Math.abs(
      bounded.zoomFactor -
        Math.exp(
          MAXIMUM_PINCH_ZOOM_PIXELS *
            PINCH_ZOOM_RATE *
            DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
        ),
    ) < 1e-12,
  );
});

test("applies independent bounded mouse and trackpad zoom sensitivity", () => {
  const mouse = normalizeWheelGesture(
    {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -53,
      timeStamp: 10,
    },
    { mouseWheelZoomSensitivity: 2 },
  );
  assert.ok(
    Math.abs(
      mouse.zoomFactor - Math.exp(-53 * WHEEL_ZOOM_RATE * 2),
    ) < 1e-12,
  );

  const trackpad = normalizeWheelGesture(
    {
      ctrlKey: true,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -10,
      timeStamp: 20,
    },
    {
      scrollInputMode: SCROLL_INPUT_MODE_TRACKPAD_PAN,
      trackpadPinchZoomSensitivity: 0.5,
    },
  );
  assert.ok(
    Math.abs(
      trackpad.zoomFactor - Math.exp(-10 * PINCH_ZOOM_RATE * 0.5),
    ) < 1e-12,
  );

  assert.equal(
    normalizeZoomSensitivity(-10, DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY),
    MINIMUM_ZOOM_SENSITIVITY,
  );
  assert.equal(
    normalizeZoomSensitivity(10, DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY),
    MAXIMUM_ZOOM_SENSITIVITY,
  );
  assert.equal(
    normalizeZoomSensitivity("2.25"),
    2.25,
  );
  assert.equal(
    normalizeZoomSensitivity("", DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY),
    DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  );
});
