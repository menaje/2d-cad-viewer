import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRenderResolutionMode,
  renderAntialiasingForMode,
  resolveRenderSurfaceSize,
} from "../src/render-resolution.mjs";

const fiveKLogicalSurface = Object.freeze({
  clientWidth: 2560,
  clientHeight: 1440,
  width: 300,
  height: 150,
});

test("auto mode bounds steady high-DPI backing pixels", () => {
  const size = resolveRenderSurfaceSize(fiveKLogicalSurface, {
    devicePixelRatio: 2,
  });
  assert.equal(size.mode, "auto");
  assert.equal(size.interactive, false);
  assert.ok(size.pixelRatio > 1 && size.pixelRatio < 2);
  assert.ok(size.pixelCount <= 8 * 1024 * 1024 + 10_000);
  assert.ok(size.pixelCount < 5120 * 2880);
});

test("auto mode renders interactive 5K frames at CSS resolution", () => {
  const size = resolveRenderSurfaceSize(fiveKLogicalSurface, {
    interactive: true,
    devicePixelRatio: 2,
  });
  assert.deepEqual(
    { width: size.width, height: size.height, ratio: size.pixelRatio },
    { width: 2560, height: 1440, ratio: 1 },
  );
});

test("quality mode preserves the previous two-pixel ratio", () => {
  const size = resolveRenderSurfaceSize(fiveKLogicalSurface, {
    mode: "quality",
    interactive: true,
    devicePixelRatio: 2,
  });
  assert.equal(size.width, 5120);
  assert.equal(size.height, 2880);
  assert.equal(size.pixelRatio, 2);
});

test("performance mode lowers interactive resolution further", () => {
  const size = resolveRenderSurfaceSize(fiveKLogicalSurface, {
    mode: "performance",
    interactive: true,
    devicePixelRatio: 2,
  });
  assert.equal(size.width, 1920);
  assert.equal(size.height, 1080);
  assert.equal(size.pixelRatio, 0.75);
});

test("explicit raster targets bypass display resolution policy", () => {
  const size = resolveRenderSurfaceSize(fiveKLogicalSurface, {
    mode: "performance",
    interactive: true,
    targetSize: { width: 6000, height: 4000 },
    devicePixelRatio: 2,
  });
  assert.equal(size.width, 6000);
  assert.equal(size.height, 4000);
  assert.equal(size.explicit, true);
  assert.equal(size.pixelRatio, null);
});

test("invalid modes normalize to auto", () => {
  assert.equal(normalizeRenderResolutionMode("unknown"), "auto");
  assert.equal(normalizeRenderResolutionMode("quality"), "quality");
  assert.equal(
    normalizeRenderResolutionMode("performance"),
    "performance",
  );
});

test("MSAA is reserved for explicit quality mode", () => {
  assert.equal(renderAntialiasingForMode("auto"), false);
  assert.equal(renderAntialiasingForMode("performance"), false);
  assert.equal(renderAntialiasingForMode("quality"), true);
});
