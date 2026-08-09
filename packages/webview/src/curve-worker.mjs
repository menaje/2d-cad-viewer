import { layerLinetypeCodes } from "./cad-linetype.mjs";
import {
  buildCurveRefinementMesh,
  curveRefinementTransferables,
} from "./curve-refinement.mjs";
import {
  createWorkerHostRangeSource,
  WORKER_RANGE_RESPONSE,
} from "./host-range-source.mjs";
import { buildInstanceGraph } from "./instance-graph.mjs";
import { buildLayoutInstanceGraph } from "./layout-scene.mjs";
import {
  BlobRangeSource,
  TrackedRangeSource,
} from "./range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

let curveState = null;

function viewKey(view) {
  return view?.kind === "layout" &&
    Number.isSafeInteger(view.layoutIndex)
    ? `layout:${view.layoutIndex}`
    : "model";
}

function instanceGraphForView(state, view) {
  if (state.external) {
    return state.modelInstanceGraph;
  }
  const key = viewKey(view);
  if (state.instanceGraphKey === key) {
    return state.instanceGraph;
  }
  let instanceGraph;
  if (key === "model") {
    instanceGraph = state.modelInstanceGraph;
  } else {
    const layout = state.layouts.find(
      (candidate) => candidate.index === view.layoutIndex,
    );
    if (!layout) {
      throw new Error(`curve layout ${view.layoutIndex} was not found`);
    }
    instanceGraph = buildLayoutInstanceGraph(
      state.blocks,
      state.inserts,
      state.layers,
      layout,
      {
        maskOrder: state.maskOrder,
        insertClips: state.insertClips,
        layerLinetypeCodes: state.layerLinetypeCodes,
      },
    );
  }
  state.instanceGraphKey = key;
  state.instanceGraph = instanceGraph;
  return instanceGraph;
}

function renderRefinement(state, camera, view) {
  return buildCurveRefinementMesh(
    state.source,
    state.blocks,
    instanceGraphForView(state, view),
    camera,
    { maskOrder: state.maskOrder },
  );
}

self.addEventListener("message", async (event) => {
  const { requestId, type } = event.data;
  if (type === WORKER_RANGE_RESPONSE) {
    return;
  }
  let messageSource;
  try {
    if (type === "render") {
      if (!curveState) {
        throw new Error("curve refinement worker is not initialized");
      }
      const refinement = renderRefinement(
        curveState,
        event.data.camera,
        event.data.view,
      );
      self.postMessage(
        {
          requestId,
          ok: true,
          refinement,
          cameraKey: event.data.cameraKey,
        },
        curveRefinementTransferables(refinement),
      );
      return;
    }
    if (type !== "initialize") {
      throw new Error("unsupported curve refinement worker request");
    }
    const {
      file,
      hostSource,
      camera,
      cameraKey,
      maskOrder = null,
      view = null,
      metadata,
      externalInstanceGraph = null,
    } = event.data;
    messageSource = hostSource
      ? createWorkerHostRangeSource(hostSource)
      : new BlobRangeSource(file);
    const rangeSource = new TrackedRangeSource(messageSource);
    const reader = await SceneCacheReader.open(rangeSource);
    if (
      !metadata ||
      !Array.isArray(metadata.layers) ||
      !Array.isArray(metadata.linetypes) ||
      !Array.isArray(metadata.blocks) ||
      !Array.isArray(metadata.inserts) ||
      !Array.isArray(metadata.insertClips) ||
      !Array.isArray(metadata.layouts)
    ) {
      throw new Error("curve refinement metadata is invalid");
    }
    const source = await reader.readCurveRefinementSource();
    const {
      layers,
      linetypes,
      blocks,
      inserts,
      insertClips,
      layouts,
    } = metadata;
    const lineTypes = layerLinetypeCodes(layers, linetypes);
    const modelInstanceGraph =
      externalInstanceGraph ??
      buildInstanceGraph(blocks, inserts, {
        layers,
        maskOrder,
        insertClips,
        layerLinetypeCodes: lineTypes,
      });
    curveState = {
      source,
      layers,
      blocks,
      inserts,
      insertClips,
      layouts,
      layerLinetypeCodes: lineTypes,
      modelInstanceGraph,
      instanceGraphKey: "model",
      instanceGraph: modelInstanceGraph,
      maskOrder,
      external: Boolean(externalInstanceGraph),
    };
    const refinement = renderRefinement(curveState, camera, view);
    self.postMessage(
      {
        requestId,
        ok: true,
        refinement,
        cameraKey,
        reads: rangeSource.snapshot(),
        source: Object.freeze({
          byteLength: source.byteLength,
          requests: source.requestCount,
          maximumReadBytes: source.maximumReadBytes,
        }),
      },
      curveRefinementTransferables(refinement),
    );
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    messageSource?.dispose?.();
  }
});
