export const ViewerWebGlApi = "menaje-viewer-webgl/0.1";
export const ViewerWebGlVersion = "0.1.1";

export {
  WebGlLineRenderer,
} from "./renderer.mjs";
export {
  mountWebGlPresentation,
} from "./presentation.mjs";
export {
  mountDwgWebGlPresentation,
} from "./dwg-presentation.mjs";
export {
  MAXIMUM_COMPARISON_SURFACE_PIXELS,
  ViewerWebGlComparisonStrategy,
  ViewerWebGlRevisionComparisonController,
  mountWebGlRevisionComparison,
} from "./revision-comparison.mjs";
export {
  DwgRenderDeltaAdapter,
  DWG_FILL_VERTEX_STRIDE,
  DWG_LINE_VERTEX_STRIDE,
  DWG_POINT_VERTEX_STRIDE,
  DWG_RENDER_DELTA_MEDIA_TYPE,
} from "./render-delta-adapter.mjs";
