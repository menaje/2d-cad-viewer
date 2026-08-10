import {
  ViewerWebGlComparisonStrategy,
  WebGlLineRenderer,
  mountWebGlPresentation,
  mountWebGlRevisionComparison,
} from "@menaje/viewer-webgl";

import {
  GpuLineBatchKind,
} from "../src/scene-cache.mjs";

const BASE_REVISION = "revision:qualification-base";
const TARGET_REVISION = "revision:qualification-target";
const PREVIEW_ID = "preview:qualification";
const HANDLE = 0x2a;
const WIDTH = 640;
const HEIGHT = 360;

function lineVertices(first, second) {
  const buffer = new ArrayBuffer(72);
  const view = new DataView(buffer);
  for (const [index, point] of [first, second].entries()) {
    const offset = index * 36;
    view.setFloat32(offset, point[0], true);
    view.setFloat32(offset + 4, point[1], true);
    view.setFloat32(offset + 8, 0, true);
    view.setUint32(offset + 12, 0, true);
    view.setUint32(offset + 16, 7, true);
    view.setUint32(offset + 20, HANDLE, true);
    view.setUint32(offset + 24, 0, true);
    view.setUint32(offset + 28, 0, true);
    view.setFloat32(offset + 32, 0, true);
  }
  return Object.freeze({
    buffer,
    byteLength: buffer.byteLength,
    vertexCount: 2,
    recordSize: 36,
  });
}

function batch(id, bounds) {
  return Object.freeze({
    id,
    kind: GpuLineBatchKind.ModelOverview,
    lodLevel: 0,
    firstVertex: 0,
    vertexCount: 2,
    blockIndex: null,
    origin: Object.freeze([0, 0, 0]),
    bounds,
  });
}

function renderState(revisionId, resource = null) {
  const target = resource !== null;
  return Object.freeze({
    revisionId,
    pickIdentities: target
      ? Object.freeze([
          Object.freeze({
            status: "upsert",
            aspect: "geometry",
            revisionId,
            layerId: "layer:qualification",
            renderId: "dwg:root:2a",
            sceneId: "root",
            handleLow: HANDLE,
            handleHigh: 0,
            externalIdentityToken: null,
          }),
        ])
      : Object.freeze([]),
    lines: target ? Object.freeze([resource]) : Object.freeze([]),
    fills: Object.freeze([]),
    points: Object.freeze([]),
    texts: Object.freeze([]),
    transforms: Object.freeze([]),
    styles: Object.freeze([]),
    baseSuppressions: target
      ? Object.freeze([
          Object.freeze({
            sceneId: "root",
            handleLow: HANDLE,
            handleHigh: 0,
          }),
        ])
      : Object.freeze([]),
    invalidatedDependencyIds: Object.freeze([]),
    affectedWorldBounds: target
      ? Object.freeze({
          min: Object.freeze([-40, -20, 0]),
          max: Object.freeze([40, 20, 0]),
        })
      : null,
  });
}

function changedEntry() {
  return Object.freeze({
    status: "modified",
    operationId: "operation:qualification",
    aspect: "geometry",
    layerId: "layer:qualification",
    sourceId: "source:qualification",
    renderId: "dwg:root:2a",
    affectedWorldBounds: Object.freeze({
      min: Object.freeze([-40, -20, 0]),
      max: Object.freeze([40, 20, 0]),
    }),
    externalIdentityToken: null,
  });
}

function diffSnapshot() {
  return Object.freeze({
    protocolVersion: "0.1.0",
    sessionId: "session:qualification",
    sourceId: "source:qualification",
    baseSnapshotId: "snapshot:qualification",
    baseRevisionId: BASE_REVISION,
    committedRevisionId: BASE_REVISION,
    revisionId: TARGET_REVISION,
    sequence: 1,
    previewId: PREVIEW_ID,
    affectedWorldBounds: Object.freeze({
      min: Object.freeze([-40, -20, 0]),
      max: Object.freeze([40, 20, 0]),
    }),
    counts: Object.freeze({
      added: 0,
      removed: 0,
      modified: 1,
      unchanged: 0,
    }),
    changedEntries: Object.freeze([changedEntry()]),
  });
}

function pixelEvidence(canvas) {
  const context = canvas.getContext("2d", { alpha: false });
  const data = context.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  ).data;
  let nonWhite = 0;
  let blue = 0;
  let warm = 0;
  let checksum = 2_166_136_261;
  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset];
    const green = data[offset + 1];
    const valueBlue = data[offset + 2];
    if (red < 248 || green < 248 || valueBlue < 248) {
      nonWhite += 1;
    }
    if (valueBlue > 180 && valueBlue > red * 1.25) {
      blue += 1;
    }
    if (red > 130 && green > 70 && valueBlue < 100) {
      warm += 1;
    }
    checksum ^= red;
    checksum = Math.imul(checksum, 16_777_619);
    checksum ^= green;
    checksum = Math.imul(checksum, 16_777_619);
    checksum ^= valueBlue;
    checksum = Math.imul(checksum, 16_777_619);
  }
  return Object.freeze({
    width: canvas.width,
    height: canvas.height,
    nonWhite,
    blue,
    warm,
    checksum: (checksum >>> 0).toString(16).padStart(8, "0"),
  });
}

class QualificationDeltaAdapter {
  constructor(renderer, candidateResource) {
    this.renderer = renderer;
    this.candidateResource = candidateResource;
    this.base = renderState(BASE_REVISION);
    this.candidate = renderState(
      TARGET_REVISION,
      candidateResource,
    );
  }

  snapshot() {
    return Object.freeze({
      baseRevisionId: BASE_REVISION,
      committedRevisionId: BASE_REVISION,
      revisionId: TARGET_REVISION,
      presentedRevisionId:
        this.renderer.renderDeltaSnapshot().revisionId,
      previewId: PREVIEW_ID,
    });
  }

  presentRevision(revisionId) {
    if (revisionId === BASE_REVISION) {
      this.renderer.activateRenderDelta(this.base);
    } else if (revisionId === TARGET_REVISION) {
      this.renderer.activateRenderDelta(this.candidate);
    } else {
      throw new DOMException(
        "qualification revision is not retained",
        "InvalidStateError",
      );
    }
    return this.snapshot();
  }

  restoreActivePresentation() {
    this.renderer.activateRenderDelta(this.candidate);
    return this.snapshot();
  }

  applyDiffOverlay(presentation) {
    return this.renderer.activateRenderDiffOverlay({
      revisionId: presentation.revisionId,
      previewId: presentation.previewId,
      visibilityRule: presentation.visibilityRule,
      statusStyles: presentation.statusStyles,
      entries: Object.freeze([
        Object.freeze({
          status: "modified",
          identity: Object.freeze({
            sceneId: "root",
            handleLow: HANDLE,
            handleHigh: 0,
          }),
          lines: Object.freeze([this.candidateResource]),
          fills: Object.freeze([]),
          points: Object.freeze([]),
          texts: Object.freeze([]),
          transforms: Object.freeze([]),
          styles: Object.freeze([]),
        }),
      ]),
    });
  }

  clearDiffOverlay() {
    return this.renderer.clearRenderDiffOverlay();
  }

  dispose() {
    this.renderer.activateRenderDelta(this.base);
    this.renderer.releaseRenderDeltaResources([
      this.candidateResource,
    ]);
  }
}

async function qualify() {
  const comparisonStartedAt = performance.now();
  const renderCanvas = document.querySelector("#render-canvas");
  const container = document.querySelector("#comparison");
  const renderer = new WebGlLineRenderer(renderCanvas);
  const baseBatch = batch(
    1,
    Object.freeze({
      min: Object.freeze([-40, -20, 0]),
      max: Object.freeze([40, 20, 0]),
    }),
  );
  const baseVertices = lineVertices([-40, -20], [40, 20]);
  const first = renderer.renderOverview({
    batches: Object.freeze([baseBatch]),
    layers: Object.freeze([
      Object.freeze({
        name: "Qualification",
        color: 7,
        flags: 0,
        lineWeight: -3,
      }),
    ]),
    instanceGraph: Object.freeze({
      instancesByBlock: new Map(),
    }),
    vertices: baseVertices,
    preferredView: Object.freeze({
      center: Object.freeze([0, 0, 0]),
      height: 100,
    }),
  });
  const candidateResource = renderer.stageRenderDeltaLine({
    key: "qualification:candidate",
    sceneId: "root",
    batch: batch(
      2,
      Object.freeze({
        min: Object.freeze([-40, -20, 0]),
        max: Object.freeze([40, 20, 0]),
      }),
    ),
    vertices: lineVertices([-40, 20], [40, -20]),
  });
  const adapter = new QualificationDeltaAdapter(
    renderer,
    candidateResource,
  );
  adapter.restoreActivePresentation();
  const context = Object.freeze({
    sourceSession: Object.freeze({}),
    snapshot: Object.freeze({
      sessionId: "session:qualification",
      sourceId: "source:qualification",
      snapshotId: "snapshot:qualification",
      revisionId: BASE_REVISION,
    }),
    host: Object.freeze({}),
  });
  const presentation = await mountWebGlPresentation(context, {
    canvas: renderCanvas,
    renderer,
    load() {
      return Object.freeze({
        renderer,
        render: first,
        dispose() {},
      });
    },
  });
  const comparison = mountWebGlRevisionComparison({
    presentation,
    renderDeltaAdapter: adapter,
    renderDiffController: Object.freeze({
      snapshot: diffSnapshot,
    }),
    container,
    camera: Object.freeze({
      origin: Object.freeze([0, 0, 0]),
      worldHeight: 100,
    }),
    getSurfaceSize() {
      return Object.freeze({ width: WIDTH, height: HEIGHT });
    },
  });
  const comparisonFirstFrameMs = Math.max(
    0,
    Math.round(performance.now() - comparisonStartedAt),
  );

  const initial = Object.freeze({
    before: pixelEvidence(comparison.beforeSurface),
    after: pixelEvidence(comparison.afterSurface),
  });
  if (
    initial.before.nonWhite < 100 ||
    initial.after.nonWhite < 100 ||
    initial.before.checksum === initial.after.checksum ||
    initial.after.warm < 50
  ) {
    throw new Error("actual WebGL before/after pixels are not distinct");
  }

  comparison.select("before", {
    revisionId: BASE_REVISION,
    layerId: "layer:qualification",
    renderId: "dwg:root:2a",
  });
  const highlighted = Object.freeze({
    before: pixelEvidence(comparison.beforeSurface),
    after: pixelEvidence(comparison.afterSurface),
  });
  if (highlighted.before.blue < 20 || highlighted.after.blue < 20) {
    throw new Error("corresponding highlight pixels are missing");
  }

  let stalePickRejected = false;
  try {
    comparison.select("after", {
      revisionId: BASE_REVISION,
      layerId: "layer:qualification",
      renderId: "dwg:root:2a",
    });
  } catch (error) {
    stalePickRejected =
      error?.name === "InvalidStateError" &&
      /stale pick/u.test(error.message);
  }
  if (!stalePickRejected) {
    throw new Error("stale pick was not rejected");
  }

  comparison.clearSelection();
  const lastGood = Object.freeze({
    before: pixelEvidence(comparison.beforeSurface),
    after: pixelEvidence(comparison.afterSurface),
    camera: comparison.snapshot().camera.camera,
  });
  const originalCapture = renderer.captureRaster.bind(renderer);
  let failCandidate = true;
  renderer.captureRaster = (camera, options) => {
    if (
      failCandidate &&
      renderer.renderDeltaSnapshot().revisionId === TARGET_REVISION
    ) {
      failCandidate = false;
      throw new Error("qualification candidate capture failure");
    }
    return originalCapture(camera, options);
  };
  let rollbackRejected = false;
  try {
    comparison.setCamera({
      origin: [8, 4, 0],
      worldHeight: 70,
    });
  } catch (error) {
    rollbackRejected = /candidate capture failure/u.test(error.message);
  }
  const rolledBack = Object.freeze({
    before: pixelEvidence(comparison.beforeSurface),
    after: pixelEvidence(comparison.afterSurface),
    camera: comparison.snapshot().camera.camera,
  });
  const rollbackRendererState = renderer.renderDeltaSnapshot();
  if (
    !rollbackRejected ||
    rolledBack.before.checksum !== lastGood.before.checksum ||
    rolledBack.after.checksum !== lastGood.after.checksum ||
    JSON.stringify(rolledBack.camera) !==
      JSON.stringify(lastGood.camera) ||
    rollbackRendererState.revisionId !== TARGET_REVISION ||
    rollbackRendererState.pickIdentities !== 1
  ) {
    throw new Error("failed candidate did not restore last-good pixels");
  }
  renderer.captureRaster = originalCapture;

  comparison.setSideVisibility({ before: false, after: true });
  const visibility = comparison.snapshot().ui;
  if (visibility.beforeVisible || !visibility.afterVisible) {
    throw new Error("candidate-only visibility did not apply");
  }
  comparison.setSideVisibility({ before: true, after: true });

  const comparisonSnapshot = comparison.snapshot();
  const beforeSurface = comparison.beforeSurface;
  const afterSurface = comparison.afterSurface;
  comparison.dispose();
  const comparisonDisposed = comparison.disposed;
  const surfacesReleased =
    beforeSurface.width === 1 && afterSurface.width === 1;
  const repeatLifecycleCount = 8;
  let repeatLifecycleReleased = true;
  for (let index = 0; index < repeatLifecycleCount; index += 1) {
    const repeated = mountWebGlRevisionComparison({
      presentation,
      renderDeltaAdapter: adapter,
      renderDiffController: Object.freeze({
        snapshot: diffSnapshot,
      }),
      container,
      camera: Object.freeze({
        origin: Object.freeze([index, -index, 0]),
        worldHeight: 100 - index,
      }),
      getSurfaceSize() {
        return Object.freeze({ width: WIDTH, height: HEIGHT });
      },
    });
    const repeatedBefore = repeated.beforeSurface;
    const repeatedAfter = repeated.afterSurface;
    repeated.dispose();
    repeatLifecycleReleased &&=
      repeated.disposed &&
      repeatedBefore.width === 1 &&
      repeatedAfter.width === 1 &&
      renderCanvas.hidden === false &&
      renderCanvas.getAttribute("aria-hidden") === null &&
      container.childElementCount === 0 &&
      renderer.renderDeltaSnapshot().allocatedResourceBytes ===
        candidateResource.byteLength;
  }
  adapter.dispose();
  const deltaAfterDispose = renderer.renderDeltaSnapshot();
  await presentation.dispose();

  return Object.freeze({
    schema: "viewer-webgl-comparison-qualification/1",
    strategy: comparisonSnapshot.strategy,
    webgl2: true,
    initial,
    highlighted,
    stalePickRejected,
    rollbackPreservedPixels: true,
    rollbackPreservedPickRevision: true,
    visibilityToggle: true,
    comparisonFirstFrameMs,
    retainedPixelBytes: comparisonSnapshot.retainedPixelBytes,
    surfacePixelBudget:
      comparisonSnapshot.maximumSurfacePixels,
    comparisonDisposed,
    surfacesReleased,
    repeatLifecycleCount,
    repeatLifecycleReleased,
    deltaAllocatedBytesAfterDispose:
      deltaAfterDispose.allocatedResourceBytes,
    pass:
      comparisonSnapshot.strategy ===
        ViewerWebGlComparisonStrategy
          .SINGLE_RENDERER_SERIAL_SNAPSHOT &&
      comparisonFirstFrameMs <= 5_000 &&
      comparisonDisposed &&
      repeatLifecycleReleased &&
      deltaAfterDispose.allocatedResourceBytes === 0,
  });
}

function reportToHost(result) {
  if (typeof globalThis.acquireVsCodeApi !== "function") {
    return;
  }
  const vscode = globalThis.acquireVsCodeApi();
  vscode.postMessage({
    type: "dwg-comparison-qualification/1",
    result,
  });
}

try {
  const result = await qualify();
  globalThis.__comparisonQualification = result;
  document.querySelector("#result").textContent = JSON.stringify(
    result,
    null,
    2,
  );
  document.body.setAttribute(
    "data-qualification",
    result.pass ? "pass" : "fail",
  );
  reportToHost(result);
} catch (error) {
  const result = Object.freeze({
    schema: "viewer-webgl-comparison-qualification/1",
    pass: false,
    error: `${error?.name ?? "Error"}: ${error?.message ?? error}`,
  });
  globalThis.__comparisonQualification = result;
  document.querySelector("#result").textContent = JSON.stringify(
    result,
    null,
    2,
  );
  document.body.setAttribute("data-qualification", "fail");
  reportToHost(result);
}
