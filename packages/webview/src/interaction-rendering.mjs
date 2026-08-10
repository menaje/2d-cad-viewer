export const InteractionRenderingMode = Object.freeze({
  CONTINUOUS: "continuous",
  HYBRID: "hybrid",
  MAXIMUM_PERFORMANCE: "maximumPerformance",
});

export const HYBRID_INTERACTION_REFRESH_MS = 80;

export function normalizeInteractionRenderingMode(value) {
  return value === InteractionRenderingMode.CONTINUOUS ||
    value === InteractionRenderingMode.MAXIMUM_PERFORMANCE
    ? value
    : InteractionRenderingMode.HYBRID;
}
