const MEBIPIXEL = 1024 * 1024;
const MINIMUM_PIXEL_RATIO = 0.5;

export const RenderResolutionMode = Object.freeze({
  AUTO: "auto",
  QUALITY: "quality",
  PERFORMANCE: "performance",
});

const POLICIES = Object.freeze({
  [RenderResolutionMode.AUTO]: Object.freeze({
    steadyRatio: 2,
    steadyPixels: 8 * MEBIPIXEL,
    interactiveRatio: 1,
    interactivePixels: 4 * MEBIPIXEL,
  }),
  [RenderResolutionMode.QUALITY]: Object.freeze({
    steadyRatio: 2,
    steadyPixels: Number.POSITIVE_INFINITY,
    interactiveRatio: 2,
    interactivePixels: Number.POSITIVE_INFINITY,
  }),
  [RenderResolutionMode.PERFORMANCE]: Object.freeze({
    steadyRatio: 1,
    steadyPixels: 4 * MEBIPIXEL,
    interactiveRatio: 0.75,
    interactivePixels: 2 * MEBIPIXEL,
  }),
});

export function normalizeRenderResolutionMode(value) {
  return value === RenderResolutionMode.QUALITY ||
    value === RenderResolutionMode.PERFORMANCE
    ? value
    : RenderResolutionMode.AUTO;
}

export function renderAntialiasingForMode(mode) {
  return (
    normalizeRenderResolutionMode(mode) === RenderResolutionMode.QUALITY
  );
}

function positiveDimension(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? numeric
    : Math.max(1, Number(fallback) || 1);
}

function explicitTargetSize(targetSize) {
  const width = Number(targetSize?.width);
  const height = Number(targetSize?.height);
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    throw new RangeError("render target size must use positive integers");
  }
  return Object.freeze({
    width,
    height,
    pixelRatio: null,
    pixelCount: width * height,
    mode: null,
    interactive: false,
    explicit: true,
  });
}

export function resolveRenderSurfaceSize(
  surface,
  {
    mode = RenderResolutionMode.AUTO,
    interactive = false,
    targetSize = null,
    devicePixelRatio = globalThis.devicePixelRatio ?? 1,
  } = {},
) {
  if (targetSize) {
    return explicitTargetSize(targetSize);
  }
  const resolvedMode = normalizeRenderResolutionMode(mode);
  const policy = POLICIES[resolvedMode];
  const clientWidth = positiveDimension(
    surface?.clientWidth,
    surface?.width,
  );
  const clientHeight = positiveDimension(
    surface?.clientHeight,
    surface?.height,
  );
  const cssPixels = clientWidth * clientHeight;
  const nativeRatio = Math.max(
    MINIMUM_PIXEL_RATIO,
    Number.isFinite(Number(devicePixelRatio))
      ? Number(devicePixelRatio)
      : 1,
  );
  const maximumRatio = interactive
    ? policy.interactiveRatio
    : policy.steadyRatio;
  const pixelBudget = interactive
    ? policy.interactivePixels
    : policy.steadyPixels;
  const budgetRatio = Number.isFinite(pixelBudget)
    ? Math.sqrt(pixelBudget / cssPixels)
    : maximumRatio;
  const pixelRatio = Math.max(
    MINIMUM_PIXEL_RATIO,
    Math.min(nativeRatio, maximumRatio, budgetRatio),
  );
  const width = Math.max(1, Math.round(clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(clientHeight * pixelRatio));
  return Object.freeze({
    width,
    height,
    pixelRatio,
    pixelCount: width * height,
    mode: resolvedMode,
    interactive: Boolean(interactive),
    explicit: false,
  });
}
