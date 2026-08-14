const TERMINAL_REFERENCE_STATES = new Set([
  "ready",
  "unloaded",
  "unresolved",
  "missing",
  "ambiguous",
  "cycle",
  "limit",
  "unsupported",
  "error",
]);

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateVisualCompletion({
  firstFrame = false,
  rootText = false,
  rootImages = false,
  detailLoading = -1,
  imageDecoding = -1,
  pendingFontRequests = -1,
  pendingEmbeddedImages = -1,
  postprocessBusy = true,
  fonts = [],
  references = [],
} = {}) {
  const safeFonts = Array.isArray(fonts) ? fonts : [];
  const safeReferences = Array.isArray(references) ? references : [];
  const xrefs = safeReferences.filter((entry) => entry?.kind !== "image");
  const images = safeReferences.filter((entry) => entry?.kind === "image");
  const terminalReferences = safeReferences.every((entry) =>
    TERMINAL_REFERENCE_STATES.has(entry?.status),
  );
  const terminalFonts = safeFonts.every(
    (entry) => typeof entry?.state === "string" && entry.state !== "loading",
  );
  const countsValid = [
    detailLoading,
    imageDecoding,
    pendingFontRequests,
    pendingEmbeddedImages,
  ].every(isNonNegativeSafeInteger);

  return Object.freeze({
    complete:
      firstFrame === true &&
      rootText === true &&
      rootImages === true &&
      countsValid &&
      imageDecoding === 0 &&
      pendingFontRequests === 0 &&
      pendingEmbeddedImages === 0 &&
      postprocessBusy === false &&
      terminalReferences &&
      terminalFonts,
    detailLoading,
    xrefCount: xrefs.length,
    xrefIssueCount: xrefs.filter((entry) => entry.status !== "ready").length,
    imageCount: images.length,
    imageIssueCount: images.filter((entry) => entry.status !== "ready").length,
    fontCount: safeFonts.length,
    fontIssueCount: safeFonts.filter(
      (entry) => !["loaded", "mapped"].includes(entry?.state),
    ).length,
  });
}
