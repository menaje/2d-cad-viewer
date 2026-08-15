import { buildHatchFillMesh } from "./hatch-fill.mjs";
import {
  buildHatchPatternBlockBounds,
  buildHatchPatternMesh,
} from "./hatch-pattern.mjs";
import { buildInstanceGraph } from "./instance-graph.mjs";
import { buildLayoutInstanceGraph } from "./layout-scene.mjs";
import {
  BlobRangeSource,
  TrackedRangeSource,
} from "./range-source.mjs";
import {
  createWorkerHostRangeSource,
  WORKER_RANGE_RESPONSE,
} from "./host-range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

let patternState = null;

function viewKey(view) {
  return view?.kind === "layout" &&
    Number.isSafeInteger(view.layoutIndex)
    ? `layout:${view.layoutIndex}`
    : "model";
}

function patternInstanceGraph(state, view) {
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
      throw new Error(`HATCH layout ${view.layoutIndex} was not found`);
    }
    instanceGraph = buildLayoutInstanceGraph(
      state.blocks,
      state.inserts,
      state.layers,
      layout,
      {
        maskOrder: state.maskOrder,
        insertClips: state.insertClips,
      },
    );
  }
  state.instanceGraphKey = key;
  state.instanceGraph = Object.freeze({
    ...instanceGraph,
    blockBoundsByIndex: state.blockBoundsByIndex,
  });
  return state.instanceGraph;
}

self.addEventListener("message", async (event) => {
  const { requestId, type } = event.data;
  if (type === WORKER_RANGE_RESPONSE) {
    return;
  }
  let messageSource;
  try {
    if (type === "render-pattern") {
      if (!patternState) {
        throw new Error("HATCH pattern worker is not initialized");
      }
      const pattern = buildHatchPatternMesh(
        patternState.source,
        patternState.blocks,
        patternInstanceGraph(patternState, event.data.view),
        event.data.camera,
        {
          maskOrder: patternState.maskOrder,
          fillMode: patternState.fillMode,
        },
      );
      self.postMessage(
        { requestId, ok: true, pattern },
        [
          pattern.vertices.buffer,
          pattern.identityRanges.data.buffer,
        ],
      );
      return;
    }
    if (type !== "initialize") {
      throw new Error("unsupported HATCH worker request");
    }

    const {
      file,
      hostSource,
      camera,
      maskOrder = null,
      fillMode = true,
      view = null,
      externalInstanceGraph = null,
    } = event.data;
    messageSource = hostSource
      ? createWorkerHostRangeSource(hostSource)
      : new BlobRangeSource(file);
    const rangeSource = new TrackedRangeSource(messageSource);
    const reader = await SceneCacheReader.open(rangeSource);
    const [
      source,
      layers,
      blocks,
      inserts,
      insertClips,
      batches,
      layouts,
    ] = await Promise.all([
      reader.readHatchSource(),
      reader.readLayers(),
      reader.readBlocks(),
      reader.readInserts(),
      reader.readInsertClips(),
      reader.readGpuLineBatches(),
      reader.readLayouts(),
    ]);
    const baseInstanceGraph = buildInstanceGraph(blocks, inserts, {
      layers,
      maskOrder,
      insertClips,
    });
    const blockBoundsByIndex = buildHatchPatternBlockBounds(
      batches,
      blocks.length,
    );
    const modelInstanceGraph = Object.freeze({
      ...(externalInstanceGraph ?? baseInstanceGraph),
      blockBoundsByIndex,
    });
    const fill = buildHatchFillMesh(source, blocks, modelInstanceGraph, {
      maskOrder,
      fillMode,
    });
    patternState = {
      source,
      layers,
      blocks,
      inserts,
      insertClips,
      layouts,
      blockBoundsByIndex,
      modelInstanceGraph,
      instanceGraphKey: "model",
      instanceGraph: modelInstanceGraph,
      maskOrder,
      fillMode,
      external: Boolean(externalInstanceGraph),
    };
    const instanceGraph = patternInstanceGraph(patternState, view);
    const pattern = camera
      ? buildHatchPatternMesh(
          source,
          blocks,
          instanceGraph,
          camera,
          { maskOrder, fillMode },
        )
      : null;
    const transfers = [
      fill.vertices.buffer,
      fill.identityRanges.data.buffer,
    ];
    if (pattern) {
      transfers.push(pattern.vertices.buffer);
      transfers.push(pattern.identityRanges.data.buffer);
    }
    self.postMessage(
      {
        requestId,
        ok: true,
        fill,
        pattern,
        supportsPatterns: true,
        reads: rangeSource.snapshot(),
      },
      transfers,
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
