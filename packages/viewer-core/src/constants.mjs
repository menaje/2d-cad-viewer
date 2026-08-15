export const ViewerCoreVersion = "0.1.3";
export const ViewerCoreApi = "menaje-viewer-core/0.1";

export const ViewerHostEventType = Object.freeze({
  REVISION_CHANGED: "revision.changed",
  SELECTION_CHANGED: "selection.changed",
  VIEWPORT_CHANGED: "viewport.changed",
  CONTEXT_REQUEST: "context.request",
  SOURCE_REVEAL: "source.reveal",
  DIAGNOSTICS_CHANGED: "diagnostics.changed",
  DIFF_OPEN: "diff.open",
  HUMAN_ACTION_REQUEST: "humanAction.request",
});

export const AllViewerHostEventTypes = Object.freeze(
  Object.values(ViewerHostEventType).sort(),
);
