import {
  DEFAULT_CONCURRENCY,
  DetailStreamingController,
} from "@menaje/viewer-core/detail-streaming";
import { cameraViewportBounds } from "./camera.mjs";
import {
  boundsIntersect2D,
  packedBoundsIntersect2D,
  transformedBounds2D,
} from "./math.mjs";
import {
  GPU_LINE_VERTEX_RECORD_SIZE,
  GpuLineBatchKind,
} from "./scene-cache.mjs";
import { effectiveClipBounds } from "./instance-graph.mjs";
import { instanceIsVisible } from "./instance-visibility.mjs";

const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_VISIBLE_BYTES = 256 * 1024 * 1024;

function sameInstanceSelection(left, right) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function squaredDistance(x, y, centerX, centerY) {
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  return deltaX * deltaX + deltaY * deltaY;
}

function candidateForModel(batch, viewport, centerX, centerY) {
  if (!boundsIntersect2D(batch.bounds, viewport)) {
    return null;
  }
  const batchCenterX =
    batch.bounds.min[0] * 0.5 + batch.bounds.max[0] * 0.5;
  const batchCenterY =
    batch.bounds.min[1] * 0.5 + batch.bounds.max[1] * 0.5;
  return {
    batch,
    instanceIndices: null,
    distance: squaredDistance(
      batchCenterX,
      batchCenterY,
      centerX,
      centerY,
    ),
  };
}

function candidateForInstances(
  batch,
  instances,
  instanceGraph,
  viewport,
  centerX,
  centerY,
) {
  if (!instances || instances.count === 0) {
    return null;
  }
  const visible = [];
  const transformed = new Float64Array(4);
  const clipBoundsCache = new Map();
  let distance = Infinity;
  for (let index = 0; index < instances.count; index += 1) {
    if (!instanceIsVisible(instances, index)) {
      continue;
    }
    transformedBounds2D(
      batch.bounds,
      instances.data,
      index * 16,
      transformed,
    );
    const clipId = instances.clipIds?.[index] ?? 0;
    if (clipId > 0) {
      let clipBounds = clipBoundsCache.get(clipId);
      if (clipBounds === undefined) {
        clipBounds = effectiveClipBounds(
          instanceGraph.clipNodes,
          clipId,
        );
        clipBoundsCache.set(clipId, clipBounds);
      }
      if (!clipBounds) {
        continue;
      }
      transformed[0] = Math.max(
        transformed[0],
        clipBounds.min[0],
      );
      transformed[1] = Math.max(
        transformed[1],
        clipBounds.min[1],
      );
      transformed[2] = Math.min(
        transformed[2],
        clipBounds.max[0],
      );
      transformed[3] = Math.min(
        transformed[3],
        clipBounds.max[1],
      );
      if (
        transformed[0] > transformed[2] ||
        transformed[1] > transformed[3]
      ) {
        continue;
      }
    }
    if (!packedBoundsIntersect2D(transformed, viewport)) {
      continue;
    }
    visible.push(index);
    distance = Math.min(
      distance,
      squaredDistance(
        transformed[0] * 0.5 + transformed[2] * 0.5,
        transformed[1] * 0.5 + transformed[3] * 0.5,
        centerX,
        centerY,
      ),
    );
  }
  if (visible.length === 0) {
    return null;
  }
  return {
    batch,
    instanceIndices: Uint32Array.from(visible),
    distance,
  };
}

function candidateForBlock(
  batch,
  instanceGraph,
  viewport,
  centerX,
  centerY,
) {
  return candidateForInstances(
    batch,
    instanceGraph.instancesByBlock.get(batch.blockIndex),
    instanceGraph,
    viewport,
    centerX,
    centerY,
  );
}

export function selectVisibleDetailBatches(
  batches,
  instanceGraph,
  camera,
  { maximumBytes = DEFAULT_VISIBLE_BYTES } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError(
      "visible detail byte budget must be positive",
    );
  }
  const viewport = cameraViewportBounds(camera);
  const centerX = camera.origin[0];
  const centerY = camera.origin[1];
  const candidates = [];

  for (const batch of batches) {
    if (batch.lodLevel !== 1) {
      continue;
    }
    const candidate =
      batch.kind === GpuLineBatchKind.BlockDefinition
        ? candidateForBlock(
            batch,
            instanceGraph,
            viewport,
            centerX,
            centerY,
          )
        : instanceGraph.modelInstances
          ? candidateForInstances(
              batch,
              instanceGraph.modelInstances,
              instanceGraph,
              viewport,
              centerX,
              centerY,
            )
          : candidateForModel(
              batch,
              viewport,
              centerX,
              centerY,
            );
    if (!candidate) {
      continue;
    }
    candidate.byteLength =
      batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE;
    candidates.push(candidate);
  }

  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.batch.id - right.batch.id,
  );
  const selected = [];
  let selectedBytes = 0;
  for (const candidate of candidates) {
    if (candidate.byteLength > maximumBytes - selectedBytes) {
      continue;
    }
    selectedBytes += candidate.byteLength;
    selected.push(
      Object.freeze({
        ...candidate,
        id: candidate.batch.id,
        selectedInstanceCount:
          candidate.instanceIndices?.length ?? 1,
      }),
    );
  }
  Object.defineProperty(selected, "byteLength", {
    value: selectedBytes,
    enumerable: false,
  });
  return Object.freeze(selected);
}

export class DetailStreamer extends DetailStreamingController {
  constructor(
    reader,
    renderer,
    batches,
    instanceGraph,
    {
      maximumCacheBytes = DEFAULT_CACHE_BYTES,
      maximumVisibleBytes = DEFAULT_VISIBLE_BYTES,
      concurrency = DEFAULT_CONCURRENCY,
      onUpdate = () => {},
      onError = () => {},
      onReviewBatch = () => false,
      onReviewBatchEvicted = () => {},
      onReviewSelection = () => {},
    } = {},
  ) {
    super(
      {
        selectCandidates(camera, { maximumBytes }) {
          return selectVisibleDetailBatches(
            batches,
            instanceGraph,
            camera,
            { maximumBytes },
          );
        },
        loadCandidate(candidate, { signal } = {}) {
          return reader.readBatchVertices(candidate.batch, { signal });
        },
        mountCandidate(candidate, vertices) {
          return renderer.addDetailBatch(
            candidate.batch,
            vertices,
          );
        },
        unmountCandidate(candidate) {
          return renderer.deleteDetailBatch(candidate.id);
        },
        setSelection(candidates) {
          return renderer.setDetailSelections(candidates);
        },
        redraw(camera, options) {
          return renderer.redraw(camera, options);
        },
        sameSelection(left, right) {
          return sameInstanceSelection(
            left.instanceIndices,
            right.instanceIndices,
          );
        },
        ...(typeof renderer?.sourceId === "string" &&
        typeof renderer.dispose === "function"
          ? {
              dispose() {
                renderer.dispose();
              },
            }
          : {}),
      },
      {
        maximumCacheBytes,
        maximumVisibleBytes,
        concurrency,
        onUpdate,
        onError,
        onReviewCandidate(candidate, vertices) {
          return onReviewBatch(
            candidate.batch,
            vertices,
            candidate,
          );
        },
        onReviewCandidateEvicted: onReviewBatchEvicted,
        onReviewSelection,
      },
    );
    this.reader = reader;
    this.renderer = renderer;
    this.batches = batches;
    this.instanceGraph = instanceGraph;
  }
}

export {
  DEFAULT_CACHE_BYTES,
  DEFAULT_CONCURRENCY,
  DEFAULT_VISIBLE_BYTES,
};
