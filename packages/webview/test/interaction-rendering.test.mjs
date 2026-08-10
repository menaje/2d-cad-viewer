import assert from "node:assert/strict";
import test from "node:test";

import {
  HYBRID_INTERACTION_REFRESH_MS,
  normalizeInteractionRenderingMode,
} from "../src/interaction-rendering.mjs";

test("interaction rendering defaults to the balanced hybrid mode", () => {
  assert.equal(normalizeInteractionRenderingMode(undefined), "hybrid");
  assert.equal(normalizeInteractionRenderingMode("unknown"), "hybrid");
});

test("interaction rendering accepts both explicit edge modes", () => {
  assert.equal(
    normalizeInteractionRenderingMode("continuous"),
    "continuous",
  );
  assert.equal(
    normalizeInteractionRenderingMode("maximumPerformance"),
    "maximumPerformance",
  );
});

test("hybrid mode periodically replaces its retained frame", () => {
  assert.equal(HYBRID_INTERACTION_REFRESH_MS, 80);
});
