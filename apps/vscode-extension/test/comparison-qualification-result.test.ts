import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPARISON_QUALIFICATION_SCHEMA,
  comparisonQualificationFields,
} from "../src/comparison-qualification-result";

function pixels(overrides: Record<string, unknown> = {}) {
  return {
    width: 640,
    height: 360,
    nonWhite: 576,
    blue: 0,
    warm: 0,
    checksum: "d34df0c5",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema: COMPARISON_QUALIFICATION_SCHEMA,
    strategy: "single-renderer-serial-snapshot",
    webgl2: true,
    initial: {
      before: pixels(),
      after: pixels({ checksum: "417787a1", warm: 288 }),
    },
    highlighted: {
      before: pixels({ checksum: "a6d58fc5", blue: 1_152 }),
      after: pixels({
        checksum: "3b67cbd1",
        blue: 1_152,
        warm: 284,
      }),
    },
    stalePickRejected: true,
    rollbackPreservedPixels: true,
    rollbackPreservedPickRevision: true,
    visibilityToggle: true,
    comparisonFirstFrameMs: 17,
    retainedPixelBytes: 1_843_200,
    surfacePixelBudget: 16_777_216,
    comparisonDisposed: true,
    surfacesReleased: true,
    repeatLifecycleCount: 8,
    repeatLifecycleReleased: true,
    deltaAllocatedBytesAfterDispose: 0,
    pass: true,
    ...overrides,
  };
}

test("accepts path-free actual-pixel comparison evidence", () => {
  assert.deepEqual(comparisonQualificationFields(result()), {
    strategy: "single-renderer-serial-snapshot",
    webgl2: true,
    before_checksum: "d34df0c5",
    after_checksum: "417787a1",
    before_nonwhite_pixels: 576,
    after_nonwhite_pixels: 576,
    highlighted_before_blue_pixels: 1_152,
    highlighted_after_blue_pixels: 1_152,
    stale_pick_rejected: true,
    rollback_preserved_pixels: true,
    rollback_preserved_pick_revision: true,
    visibility_toggle: true,
    comparison_first_frame_ms: 17,
    retained_pixel_bytes: 1_843_200,
    surface_pixel_budget: 16_777_216,
    comparison_disposed: true,
    surfaces_released: true,
    repeat_lifecycle_count: 8,
    repeat_lifecycle_released: true,
    delta_allocated_bytes_after_dispose: 0,
  });
});

test("rejects failed, indistinct, stale, or unreleased evidence", () => {
  assert.throws(
    () => comparisonQualificationFields(result({ pass: false })),
    /must be true/u,
  );
  assert.throws(
    () =>
      comparisonQualificationFields(
        result({
          initial: {
            before: pixels(),
            after: pixels({ warm: 288 }),
          },
        }),
      ),
    /not distinct/u,
  );
  assert.throws(
    () =>
      comparisonQualificationFields(
        result({ stalePickRejected: false }),
      ),
    /must be true/u,
  );
  assert.throws(
    () =>
      comparisonQualificationFields(
        result({ rollbackPreservedPickRevision: false }),
      ),
    /must be true/u,
  );
  assert.throws(
    () =>
      comparisonQualificationFields(
        result({ deltaAllocatedBytesAfterDispose: 1 }),
      ),
    /not released/u,
  );
  assert.throws(
    () =>
      comparisonQualificationFields(
        result({ repeatLifecycleReleased: false }),
      ),
    /must be true/u,
  );
  assert.throws(
    () =>
      comparisonQualificationFields(
        result({ comparisonFirstFrameMs: 5_001 }),
      ),
    /outside the supported range/u,
  );
});
