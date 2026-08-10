export const COMPARISON_QUALIFICATION_MESSAGE_TYPE =
  "dwg-comparison-qualification/1";
export const COMPARISON_QUALIFICATION_SCHEMA =
  "viewer-webgl-comparison-qualification/1";
export const COMPARISON_QUALIFICATION_STRATEGY =
  "single-renderer-serial-snapshot";

type QualificationFields = Readonly<
  Record<string, boolean | number | string | null>
>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RangeError(`${label} is outside the supported range`);
  }
  return value as number;
}

function requiredTrue(value: unknown, label: string): true {
  if (value !== true) {
    throw new TypeError(`${label} must be true`);
  }
  return true;
}

function pixelEvidence(value: unknown, label: string) {
  const evidence = record(value, label);
  const width = boundedInteger(
    evidence.width,
    `${label} width`,
    1,
    4_096,
  );
  const height = boundedInteger(
    evidence.height,
    `${label} height`,
    1,
    4_096,
  );
  const pixels = width * height;
  const checksum = evidence.checksum;
  if (
    typeof checksum !== "string" ||
    !/^[a-f0-9]{8}$/u.test(checksum)
  ) {
    throw new TypeError(`${label} checksum is invalid`);
  }
  return Object.freeze({
    width,
    height,
    nonWhite: boundedInteger(
      evidence.nonWhite,
      `${label} non-white pixels`,
      1,
      pixels,
    ),
    blue: boundedInteger(
      evidence.blue,
      `${label} blue pixels`,
      0,
      pixels,
    ),
    warm: boundedInteger(
      evidence.warm,
      `${label} warm pixels`,
      0,
      pixels,
    ),
    checksum,
  });
}

export function comparisonQualificationFields(
  value: unknown,
): QualificationFields {
  const result = record(value, "comparison qualification result");
  if (result.schema !== COMPARISON_QUALIFICATION_SCHEMA) {
    throw new TypeError("comparison qualification schema is invalid");
  }
  if (result.strategy !== COMPARISON_QUALIFICATION_STRATEGY) {
    throw new TypeError("comparison qualification strategy is invalid");
  }
  requiredTrue(result.webgl2, "WebGL2 result");
  requiredTrue(result.pass, "comparison qualification result");
  requiredTrue(result.stalePickRejected, "stale-pick result");
  requiredTrue(
    result.rollbackPreservedPixels,
    "rollback preservation result",
  );
  requiredTrue(
    result.rollbackPreservedPickRevision,
    "rollback pick-revision result",
  );
  requiredTrue(result.visibilityToggle, "visibility result");
  requiredTrue(result.comparisonDisposed, "comparison cleanup result");
  requiredTrue(result.surfacesReleased, "surface cleanup result");
  requiredTrue(
    result.repeatLifecycleReleased,
    "repeated lifecycle cleanup result",
  );

  const initial = record(result.initial, "initial pixel evidence");
  const highlighted = record(
    result.highlighted,
    "highlighted pixel evidence",
  );
  const before = pixelEvidence(initial.before, "initial before pixels");
  const after = pixelEvidence(initial.after, "initial after pixels");
  const highlightedBefore = pixelEvidence(
    highlighted.before,
    "highlighted before pixels",
  );
  const highlightedAfter = pixelEvidence(
    highlighted.after,
    "highlighted after pixels",
  );
  if (
    before.width !== after.width ||
    before.height !== after.height ||
    before.width !== highlightedBefore.width ||
    before.height !== highlightedBefore.height ||
    before.width !== highlightedAfter.width ||
    before.height !== highlightedAfter.height ||
    before.checksum === after.checksum ||
    highlightedBefore.checksum === before.checksum ||
    highlightedAfter.checksum === after.checksum ||
    highlightedBefore.blue <= before.blue ||
    highlightedAfter.blue <= after.blue ||
    after.warm === 0
  ) {
    throw new TypeError("comparison pixel evidence is not distinct");
  }

  const retainedPixelBytes = boundedInteger(
    result.retainedPixelBytes,
    "retained pixel bytes",
    1,
    256 * 1024 * 1024,
  );
  const comparisonFirstFrameMs = boundedInteger(
    result.comparisonFirstFrameMs,
    "comparison first-frame time",
    0,
    5_000,
  );
  const surfacePixelBudget = boundedInteger(
    result.surfacePixelBudget,
    "surface pixel budget",
    1,
    64 * 1024 * 1024,
  );
  if (retainedPixelBytes > surfacePixelBudget * 4) {
    throw new RangeError("retained pixels exceed the surface budget");
  }
  const deltaAllocatedBytesAfterDispose = boundedInteger(
    result.deltaAllocatedBytesAfterDispose,
    "post-dispose delta bytes",
    0,
    256 * 1024 * 1024,
  );
  if (deltaAllocatedBytesAfterDispose !== 0) {
    throw new TypeError("comparison delta resources were not released");
  }
  const repeatLifecycleCount = boundedInteger(
    result.repeatLifecycleCount,
    "repeated lifecycle count",
    5,
    100,
  );

  return Object.freeze({
    strategy: COMPARISON_QUALIFICATION_STRATEGY,
    webgl2: true,
    before_checksum: before.checksum,
    after_checksum: after.checksum,
    before_nonwhite_pixels: before.nonWhite,
    after_nonwhite_pixels: after.nonWhite,
    highlighted_before_blue_pixels: highlightedBefore.blue,
    highlighted_after_blue_pixels: highlightedAfter.blue,
    stale_pick_rejected: true,
    rollback_preserved_pixels: true,
    rollback_preserved_pick_revision: true,
    visibility_toggle: true,
    comparison_first_frame_ms: comparisonFirstFrameMs,
    retained_pixel_bytes: retainedPixelBytes,
    surface_pixel_budget: surfacePixelBudget,
    comparison_disposed: true,
    surfaces_released: true,
    repeat_lifecycle_count: repeatLifecycleCount,
    repeat_lifecycle_released: true,
    delta_allocated_bytes_after_dispose: 0,
  });
}
