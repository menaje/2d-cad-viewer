import { buildInstanceGraph } from "./instance-graph.mjs";
import { buildPrimitiveMeshes } from "./primitive-mesh.mjs";
import {
  BlobRangeSource,
  TrackedRangeSource,
} from "./range-source.mjs";
import {
  createWorkerHostRangeSource,
  WORKER_RANGE_RESPONSE,
} from "./host-range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

self.addEventListener(
  "message",
  async (event) => {
    const {
      requestId,
      type,
      file,
      hostSource,
      wipeoutFrame,
      fillMode,
      splineFrame,
      maskOrder = null,
    } = event.data;
    if (type === WORKER_RANGE_RESPONSE) {
      return;
    }
    let messageSource;
    try {
      if (type !== "initialize") {
        throw new Error("unsupported primitive worker request");
      }
      messageSource = hostSource
        ? createWorkerHostRangeSource(hostSource)
        : new BlobRangeSource(file);
      const rangeSource = new TrackedRangeSource(messageSource);
      const reader = await SceneCacheReader.open(rangeSource);
      const [source, layers, blocks, inserts, insertClips] = await Promise.all([
        reader.readPrimitiveSource(),
        reader.readLayers(),
        reader.readBlocks(),
        reader.readInserts(),
        reader.readInsertClips(),
      ]);
      const instanceGraph = buildInstanceGraph(blocks, inserts, {
        layers,
        maskOrder,
        insertClips,
      });
      const primitives = buildPrimitiveMeshes(
        source,
        blocks,
        instanceGraph,
        { wipeoutFrame, fillMode, splineFrame, maskOrder },
      );
      self.postMessage(
        {
          requestId,
          ok: true,
          primitives,
          reads: rangeSource.snapshot(),
        },
        [
          primitives.points.vertices.buffer,
          primitives.points.identityRanges.data.buffer,
          primitives.solidFills.vertices.buffer,
          primitives.solidFills.identityRanges.data.buffer,
          primitives.solidOutlines.vertices.buffer,
          primitives.solidOutlines.identityRanges.data.buffer,
          primitives.wipeoutMasks.vertices.buffer,
          primitives.wipeoutMasks.identityRanges.data.buffer,
          primitives.lineReplacementHandleWords.buffer,
        ],
      );
    } catch (error) {
      self.postMessage({
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      messageSource?.dispose?.();
      self.close();
    }
  },
  { once: true },
);
