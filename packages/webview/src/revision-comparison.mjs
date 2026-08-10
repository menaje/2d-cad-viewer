import {
  ViewerDiffOverlayVisibilityRule,
  ViewerDiffStatus,
  ViewerSplitViewCameraController,
  ViewerSplitViewDiffController,
  ViewerSplitViewSide,
  createViewerDiffOverlayPolicy,
} from "@menaje/viewer-core";
import {
  ViewerSplitViewOrientation,
  ViewerSplitViewUiController,
} from "@menaje/viewer-ui";

const MAXIMUM_SURFACE_PIXELS = 16_777_216;
const SPLIT_VIEW_DIVIDER_SIZE_PX = 6;
const SIDES = Object.freeze([
  ViewerSplitViewSide.BEFORE,
  ViewerSplitViewSide.AFTER,
]);

export const ViewerWebGlComparisonStrategy = Object.freeze({
  SINGLE_RENDERER_SERIAL_SNAPSHOT:
    "single-renderer-serial-snapshot",
});

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function boundedIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024
  ) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
  return value;
}

function requireMethod(value, method, label) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`${label} must implement ${method}()`);
  }
  return value;
}

function requireElement(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    !value.ownerDocument ||
    typeof value.ownerDocument.createElement !== "function"
  ) {
    throw new TypeError(`${label} must be a DOM element`);
  }
  return value;
}

function requireCanvas(value, label) {
  const canvas = requireElement(value, label);
  if (typeof canvas.getContext !== "function") {
    throw new TypeError(`${label} must be a canvas`);
  }
  return canvas;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeCamera(value) {
  if (
    !value ||
    !Array.isArray(value.origin) ||
    value.origin.length < 2 ||
    !value.origin.every(Number.isFinite) ||
    !Number.isFinite(value.worldHeight) ||
    value.worldHeight <= 0
  ) {
    throw new TypeError(
      "Viewer WebGL comparison requires a finite camera",
    );
  }
  return Object.freeze({
    origin: Object.freeze([...value.origin]),
    worldHeight: value.worldHeight,
  });
}

function sameCamera(left, right) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.worldHeight === right.worldHeight &&
      left.origin.length === right.origin.length &&
      left.origin.every(
        (value, axis) => value === right.origin[axis],
      ))
  );
}

function sameHighlight(left, right) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.layerId === right.layerId &&
      left.renderId === right.renderId)
  );
}

function sameSplitPresentation(left, right) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.side === right.side &&
      left.revisionId === right.revisionId &&
      left.counterpartRevisionId ===
        right.counterpartRevisionId &&
      left.comparison.sequence === right.comparison.sequence &&
      left.comparison.previewId === right.comparison.previewId &&
      sameHighlight(left.highlight, right.highlight))
  );
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value;
}

function comparisonBinding(diff) {
  return Object.freeze({
    sessionId: boundedIdentifier(
      diff?.sessionId,
      "comparison session ID",
    ),
    sourceId: boundedIdentifier(
      diff?.sourceId,
      "comparison source ID",
    ),
    baseSnapshotId: boundedIdentifier(
      diff?.baseSnapshotId,
      "comparison base snapshot ID",
    ),
    baseRevisionId: boundedIdentifier(
      diff?.baseRevisionId,
      "comparison base revision ID",
    ),
    committedRevisionId: boundedIdentifier(
      diff?.committedRevisionId,
      "comparison committed revision ID",
    ),
    revisionId: boundedIdentifier(
      diff?.revisionId,
      "comparison target revision ID",
    ),
    previewId:
      diff?.previewId === null
        ? null
        : boundedIdentifier(
            diff?.previewId,
            "comparison preview ID",
          ),
    sequence: Number.isSafeInteger(diff?.sequence)
      ? diff.sequence
      : (() => {
          throw new TypeError(
            "comparison sequence must be a safe integer",
          );
        })(),
  });
}

function requirePresentation(value) {
  const presentation = requireMethod(
    value,
    "dispose",
    "Viewer WebGL presentation",
  );
  if (
    !presentation.context?.snapshot ||
    presentation.scene?.renderer !== presentation.renderer
  ) {
    throw new TypeError(
      "Viewer WebGL comparison requires a mounted presentation",
    );
  }
  requireMethod(
    presentation.renderer,
    "captureRaster",
    "Viewer WebGL comparison renderer",
  );
  return presentation;
}

function requireAdapter(value, renderer) {
  for (const method of [
    "snapshot",
    "presentRevision",
    "restoreActivePresentation",
    "applyDiffOverlay",
    "clearDiffOverlay",
  ]) {
    requireMethod(
      value,
      method,
      "Viewer WebGL comparison delta adapter",
    );
  }
  if (value.renderer !== renderer) {
    throw new TypeError(
      "Viewer WebGL comparison adapter must own the mounted renderer",
    );
  }
  return value;
}

function defaultSurfaceSize(surface) {
  const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
  const clientWidth = Number(surface.clientWidth);
  const clientHeight = Number(surface.clientHeight);
  return Object.freeze({
    width:
      Number.isFinite(clientWidth) && clientWidth > 0
        ? Math.max(1, Math.round(clientWidth * ratio))
        : Math.max(1, Math.round(Number(surface.width) || 300)),
    height:
      Number.isFinite(clientHeight) && clientHeight > 0
        ? Math.max(1, Math.round(clientHeight * ratio))
        : Math.max(1, Math.round(Number(surface.height) || 150)),
  });
}

function normalizeSurfaceSize(value) {
  return Object.freeze({
    width: positiveSafeInteger(
      value?.width,
      "comparison surface width",
    ),
    height: positiveSafeInteger(
      value?.height,
      "comparison surface height",
    ),
  });
}

function presentOnSide(side, status) {
  if (status === ViewerDiffStatus.MODIFIED) {
    return true;
  }
  if (status === ViewerDiffStatus.ADDED) {
    return side === ViewerSplitViewSide.AFTER;
  }
  return side === ViewerSplitViewSide.BEFORE;
}

function paintBoundsHighlight({
  side,
  highlight,
  camera,
  canvas,
  context,
}) {
  if (
    !highlight ||
    !presentOnSide(side, highlight.status) ||
    !highlight.affectedWorldBounds
  ) {
    return;
  }
  const bounds = highlight.affectedWorldBounds;
  const scale = canvas.height / camera.worldHeight;
  const left =
    canvas.width * 0.5 +
    (bounds.min[0] - camera.origin[0]) * scale;
  const right =
    canvas.width * 0.5 +
    (bounds.max[0] - camera.origin[0]) * scale;
  const top =
    canvas.height * 0.5 -
    (bounds.max[1] - camera.origin[1]) * scale;
  const bottom =
    canvas.height * 0.5 -
    (bounds.min[1] - camera.origin[1]) * scale;
  if (![left, right, top, bottom].every(Number.isFinite)) {
    return;
  }
  const x = Math.max(0, Math.min(left, right));
  const y = Math.max(0, Math.min(top, bottom));
  const width =
    Math.min(canvas.width, Math.max(left, right)) - x;
  const height =
    Math.min(canvas.height, Math.max(top, bottom)) - y;
  if (width <= 0 || height <= 0) {
    return;
  }
  context.save?.();
  context.strokeStyle = "#58a6ff";
  context.lineWidth = Math.max(2, canvas.height / 600);
  context.setLineDash?.([6, 3]);
  context.strokeRect?.(x, y, width, height);
  context.restore?.();
}

function releaseCanvas(canvas) {
  if (!canvas) {
    return;
  }
  try {
    canvas.width = 1;
    canvas.height = 1;
  } catch {
    // A host-supplied immutable test surface has no retained bitmap.
  }
}

function captureSurfaceState(surface) {
  return Object.freeze({
    width: surface.width,
    height: surface.height,
    comparisonAttribute:
      surface.getAttribute?.("data-viewer-webgl-comparison") ??
      null,
    style:
      surface.style === undefined
        ? null
        : Object.freeze({
            display: surface.style.display ?? "",
            width: surface.style.width ?? "",
            height: surface.style.height ?? "",
          }),
  });
}

function restoreSurfaceState(surface, state) {
  surface.width = state.width;
  surface.height = state.height;
  if (state.comparisonAttribute === null) {
    surface.removeAttribute?.("data-viewer-webgl-comparison");
  } else {
    surface.setAttribute?.(
      "data-viewer-webgl-comparison",
      state.comparisonAttribute,
    );
  }
  if (state.style !== null && surface.style !== undefined) {
    surface.style.display = state.style.display;
    surface.style.width = state.style.width;
    surface.style.height = state.style.height;
  }
}

function transitionFailure(error, cleanupErrors, message) {
  if (cleanupErrors.length === 0) {
    return error;
  }
  return new AggregateError(
    [error, ...cleanupErrors],
    message,
    { cause: error },
  );
}

export class ViewerWebGlRevisionComparisonController {
  #presentation;
  #renderer;
  #adapter;
  #renderDiffController;
  #container;
  #surfaces;
  #createdSurfaces;
  #surfaceStates;
  #uiController;
  #cameraController;
  #diffController;
  #states;
  #frames;
  #policy;
  #getSurfaceSize;
  #paintHighlight;
  #onFrame;
  #maximumSurfacePixels;
  #renderCanvasState;
  #sideVisibility = Object.freeze({
    beforeVisible: true,
    afterVisible: true,
  });
  #backups = new Map();
  #frameSequence = 0;
  #transitioning = false;
  #disposing = false;
  #disposed = false;

  constructor({
    presentation: inputPresentation,
    renderDeltaAdapter,
    renderDiffController,
    container: inputContainer,
    beforeSurface = null,
    afterSurface = null,
    camera,
    policy = {},
    maximumSurfacePixels = MAXIMUM_SURFACE_PIXELS,
    getSurfaceSize = defaultSurfaceSize,
    paintHighlight = paintBoundsHighlight,
    onFrame = () => {},
    onRatioChange = () => {},
    label = "Revision comparison",
    beforeLabel = "Current",
    afterLabel = "Candidate",
    orientation,
    ratio,
  } = {}) {
    this.#presentation = requirePresentation(inputPresentation);
    this.#renderer = this.#presentation.renderer;
    this.#adapter = requireAdapter(
      renderDeltaAdapter,
      this.#renderer,
    );
    this.#renderDiffController = requireMethod(
      renderDiffController,
      "snapshot",
      "Viewer WebGL comparison render diff controller",
    );
    this.#container = requireElement(
      inputContainer,
      "Viewer WebGL comparison container",
    );
    if (
      this.#container.ownerDocument !==
      this.#renderer.canvas?.ownerDocument
    ) {
      throw new TypeError(
        "Viewer WebGL comparison elements must share one document",
      );
    }
    if (typeof getSurfaceSize !== "function") {
      throw new TypeError(
        "Viewer WebGL comparison getSurfaceSize must be a function",
      );
    }
    if (typeof paintHighlight !== "function") {
      throw new TypeError(
        "Viewer WebGL comparison paintHighlight must be a function",
      );
    }
    if (
      typeof onFrame !== "function" ||
      typeof onRatioChange !== "function"
    ) {
      throw new TypeError(
        "Viewer WebGL comparison callbacks must be functions",
      );
    }
    this.#maximumSurfacePixels = positiveSafeInteger(
      maximumSurfacePixels,
      "maximum comparison surface pixels",
    );
    this.#getSurfaceSize = getSurfaceSize;
    this.#paintHighlight = paintHighlight;
    this.#onFrame = onFrame;
    this.#policy = createViewerDiffOverlayPolicy(policy);
    const initialCamera = normalizeCamera(camera);

    const document = this.#container.ownerDocument;
    const createdBefore = beforeSurface === null;
    const createdAfter = afterSurface === null;
    const before = requireCanvas(
      beforeSurface ?? document.createElement("canvas"),
      "Viewer WebGL before surface",
    );
    const after = requireCanvas(
      afterSurface ?? document.createElement("canvas"),
      "Viewer WebGL after surface",
    );
    if (
      before === after ||
      before === this.#renderer.canvas ||
      after === this.#renderer.canvas
    ) {
      throw new TypeError(
        "Viewer WebGL comparison surfaces must be distinct",
      );
    }
    for (const surface of [before, after]) {
      if (surface.ownerDocument !== document) {
        throw new TypeError(
          "Viewer WebGL comparison surfaces must share one document",
        );
      }
    }
    this.#surfaces = new Map([
      [ViewerSplitViewSide.BEFORE, before],
      [ViewerSplitViewSide.AFTER, after],
    ]);
    this.#createdSurfaces = new Set([
      ...(createdBefore ? [before] : []),
      ...(createdAfter ? [after] : []),
    ]);
    this.#surfaceStates = new Map([
      [before, captureSurfaceState(before)],
      [after, captureSurfaceState(after)],
    ]);

    const binding = this.#validateBinding();
    this.#states = new Map([
      [
        ViewerSplitViewSide.BEFORE,
        {
          camera: null,
          presentation: null,
          revisionId: binding.baseRevisionId,
        },
      ],
      [
        ViewerSplitViewSide.AFTER,
        {
          camera: null,
          presentation: null,
          revisionId: binding.revisionId,
        },
      ],
    ]);
    this.#frames = new Map([
      [ViewerSplitViewSide.BEFORE, null],
      [ViewerSplitViewSide.AFTER, null],
    ]);

    const renderCanvas = requireCanvas(
      this.#renderer.canvas,
      "Viewer WebGL render canvas",
    );
    this.#renderCanvasState = Object.freeze({
      hidden: Boolean(renderCanvas.hidden),
      ariaHidden: renderCanvas.getAttribute?.("aria-hidden") ?? null,
    });
    const target = (side) =>
      Object.freeze({
        setCamera: (nextCamera) =>
          this.#setTargetCamera(side, nextCamera),
        applySplitDiff: (nextPresentation) =>
          this.#setTargetPresentation(side, nextPresentation),
        clearSplitDiff: () => this.#clearTargetDiff(side),
      });
    const beforeTarget = target(ViewerSplitViewSide.BEFORE);
    const afterTarget = target(ViewerSplitViewSide.AFTER);
    this.#cameraController =
      new ViewerSplitViewCameraController({
        camera: initialCamera,
        before: beforeTarget,
        after: afterTarget,
      });
    this.#diffController = new ViewerSplitViewDiffController({
      renderDiffController: this.#renderDiffController,
      before: beforeTarget,
      after: afterTarget,
    });
    this.#uiController = new ViewerSplitViewUiController({
      container: this.#container,
      beforeSurface: before,
      afterSurface: after,
      label,
      beforeLabel,
      afterLabel,
      ...(orientation === undefined ? {} : { orientation }),
      ...(ratio === undefined ? {} : { ratio }),
      onRatioChange: (change) => {
        this.#applySideVisibility();
        if (!this.#disposing && !this.#disposed) {
          this.resize();
        }
        synchronous(
          onRatioChange(change),
          "Viewer WebGL comparison onRatioChange",
        );
      },
    });
    for (const [side, surface] of [
      [ViewerSplitViewSide.BEFORE, before],
      [ViewerSplitViewSide.AFTER, after],
    ]) {
      surface.setAttribute?.("data-viewer-webgl-comparison", side);
      if (surface.style) {
        surface.style.display = "block";
        surface.style.width = "100%";
        surface.style.height = "100%";
      }
    }
    renderCanvas.hidden = true;
    renderCanvas.setAttribute?.("aria-hidden", "true");
  }

  #uiSnapshot() {
    return Object.freeze({
      ...this.#uiController.snapshot(),
      ...this.#sideVisibility,
    });
  }

  #splitPanel(side) {
    const root = this.#uiController.element;
    const surface = this.#surfaces.get(side);
    const panel = surface?.parentNode?.parentNode;
    if (
      panel?.parentNode !== root ||
      panel.getAttribute?.("data-viewer-split-panel") !== side
    ) {
      throw invalidState(
        `Viewer WebGL comparison ${side} panel is unavailable`,
      );
    }
    return panel;
  }

  #applySideVisibility() {
    const root = this.#uiController.element;
    const divider = this.#uiController.divider;
    const beforePanel = this.#splitPanel(
      ViewerSplitViewSide.BEFORE,
    );
    const afterPanel = this.#splitPanel(
      ViewerSplitViewSide.AFTER,
    );
    const { beforeVisible, afterVisible } =
      this.#sideVisibility;
    beforePanel.hidden = !beforeVisible;
    afterPanel.hidden = !afterVisible;
    divider.hidden = !beforeVisible || !afterVisible;
    root.setAttribute(
      "data-viewer-split-before-visible",
      String(beforeVisible),
    );
    root.setAttribute(
      "data-viewer-split-after-visible",
      String(afterVisible),
    );
    if (!beforeVisible || !afterVisible) {
      root.style.gridTemplateColumns = "minmax(0, 1fr)";
      root.style.gridTemplateRows = "minmax(0, 1fr)";
      return;
    }

    const { orientation, ratio } =
      this.#uiController.snapshot();
    const before = String(ratio);
    const after = String(1 - ratio);
    root.setAttribute(
      "data-viewer-split-orientation",
      orientation,
    );
    divider.setAttribute(
      "aria-valuenow",
      String(Math.round(ratio * 100)),
    );
    if (orientation === ViewerSplitViewOrientation.HORIZONTAL) {
      root.style.gridTemplateColumns =
        `${before}fr ${SPLIT_VIEW_DIVIDER_SIZE_PX}px ${after}fr`;
      root.style.gridTemplateRows = "minmax(0, 1fr)";
      divider.setAttribute("aria-orientation", "vertical");
      divider.style.cursor = "col-resize";
    } else {
      root.style.gridTemplateColumns = "minmax(0, 1fr)";
      root.style.gridTemplateRows =
        `${before}fr ${SPLIT_VIEW_DIVIDER_SIZE_PX}px ${after}fr`;
      divider.setAttribute("aria-orientation", "horizontal");
      divider.style.cursor = "row-resize";
    }
  }

  get disposed() {
    return this.#disposed;
  }

  get beforeSurface() {
    this.#assertOpen();
    return this.#surfaces.get(ViewerSplitViewSide.BEFORE);
  }

  get afterSurface() {
    this.#assertOpen();
    return this.#surfaces.get(ViewerSplitViewSide.AFTER);
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState(
        "Viewer WebGL revision comparison is disposed",
      );
    }
  }

  #assertIdle() {
    if (this.#transitioning) {
      throw invalidState(
        "Viewer WebGL comparison transition is already active",
      );
    }
  }

  #validateBinding() {
    const diff = synchronous(
      this.#renderDiffController.snapshot(),
      "Viewer WebGL comparison render diff snapshot",
    );
    const binding = comparisonBinding(diff);
    const snapshot = this.#presentation.context.snapshot;
    const adapter = this.#adapter.snapshot();
    const mismatches = [
      [snapshot.sessionId, binding.sessionId],
      [snapshot.sourceId, binding.sourceId],
      [snapshot.snapshotId, binding.baseSnapshotId],
      [snapshot.revisionId, binding.baseRevisionId],
      [adapter.baseRevisionId, binding.baseRevisionId],
      [
        adapter.committedRevisionId,
        binding.committedRevisionId,
      ],
      [adapter.revisionId, binding.revisionId],
      [adapter.previewId, binding.previewId],
    ];
    if (mismatches.some(([left, right]) => left !== right)) {
      throw invalidState(
        "Viewer WebGL comparison revision binding is stale",
      );
    }
    return binding;
  }

  #overlayPresentation(presentation) {
    return Object.freeze({
      revisionId: presentation.revisionId,
      previewId: presentation.comparison.previewId,
      visibilityRule:
        ViewerDiffOverlayVisibilityRule.INTERSECT_SOURCE,
      statusStyles: this.#policy,
      changedEntries: presentation.comparison.changedEntries,
    });
  }

  #applyPhysicalPresentation(side, presentation, revisionId) {
    this.#adapter.presentRevision(revisionId);
    if (
      side === ViewerSplitViewSide.AFTER &&
      presentation !== null &&
      presentation.comparison.changedEntries.length > 0
    ) {
      this.#adapter.applyDiffOverlay(
        this.#overlayPresentation(presentation),
      );
    } else {
      this.#adapter.clearDiffOverlay();
    }
  }

  #requestedSurfaceSize(side) {
    const surface = this.#surfaces.get(side);
    return normalizeSurfaceSize(
      synchronous(
        this.#getSurfaceSize(
          surface,
          side,
          this.#uiSnapshot(),
        ),
        "Viewer WebGL comparison getSurfaceSize",
      ),
    );
  }

  #validateSurfaceBudget() {
    const sizes = SIDES.map((side) =>
      this.#requestedSurfaceSize(side),
    );
    const pixels = sizes.reduce(
      (total, size) => total + size.width * size.height,
      0,
    );
    if (pixels > this.#maximumSurfacePixels) {
      throw new RangeError(
        "Viewer WebGL comparison surfaces exceed their pixel budget",
      );
    }
    return Object.freeze(sizes);
  }

  #surfaceSize(side) {
    const size = this.#requestedSurfaceSize(side);
    const other = this.#frames.get(
      side === ViewerSplitViewSide.BEFORE
        ? ViewerSplitViewSide.AFTER
        : ViewerSplitViewSide.BEFORE,
    );
    if (
      size.width * size.height +
        (other?.width ?? 0) * (other?.height ?? 0) >
      this.#maximumSurfacePixels
    ) {
      throw new RangeError(
        "Viewer WebGL comparison surfaces exceed their pixel budget",
      );
    }
    return size;
  }

  #captureBackup(side) {
    if (this.#backups.has(side)) {
      return;
    }
    const frame = this.#frames.get(side);
    if (!frame) {
      return;
    }
    const surface = this.#surfaces.get(side);
    const backup = surface.ownerDocument.createElement("canvas");
    backup.width = surface.width;
    backup.height = surface.height;
    const context = backup.getContext?.("2d", { alpha: false });
    if (!context) {
      throw new Error(
        "cannot allocate a comparison rollback surface",
      );
    }
    context.drawImage(surface, 0, 0);
    const state = this.#states.get(side);
    this.#backups.set(
      side,
      Object.freeze({
        canvas: backup,
        camera: state.camera,
        presentation: state.presentation,
        revisionId: state.revisionId,
        frame,
      }),
    );
  }

  #restoreBackup(side) {
    const backup = this.#backups.get(side);
    if (!backup) {
      return false;
    }
    const surface = this.#surfaces.get(side);
    surface.width = backup.canvas.width;
    surface.height = backup.canvas.height;
    const context = surface.getContext?.("2d", { alpha: false });
    if (!context) {
      throw new Error(
        "cannot restore a comparison rollback surface",
      );
    }
    context.drawImage(backup.canvas, 0, 0);
    const state = this.#states.get(side);
    state.camera = backup.camera;
    state.presentation = backup.presentation;
    state.revisionId = backup.revisionId;
    this.#frames.set(side, backup.frame);
    return true;
  }

  #releaseBackups() {
    for (const backup of this.#backups.values()) {
      releaseCanvas(backup.canvas);
    }
    this.#backups.clear();
  }

  #renderSide(
    side,
    { camera, presentation, revisionId },
  ) {
    if (!camera || !revisionId) {
      return null;
    }
    const size = this.#surfaceSize(side);
    this.#applyPhysicalPresentation(
      side,
      presentation,
      revisionId,
    );
    const captured = this.#renderer.captureRaster(camera, {
      ...size,
      background: "#ffffff",
    });
    const source = requireCanvas(
      captured?.canvas,
      "Viewer WebGL captured comparison frame",
    );
    const surface = this.#surfaces.get(side);
    try {
      surface.width = size.width;
      surface.height = size.height;
      const context = surface.getContext?.("2d", { alpha: false });
      if (!context) {
        throw new Error(
          "cannot draw a Viewer WebGL comparison frame",
        );
      }
      context.clearRect?.(0, 0, size.width, size.height);
      context.drawImage(source, 0, 0, size.width, size.height);
      synchronous(
        this.#paintHighlight({
          side,
          highlight: presentation?.highlight ?? null,
          camera,
          canvas: surface,
          context,
        }),
        "Viewer WebGL comparison paintHighlight",
      );
      const frame = Object.freeze({
        sequence: ++this.#frameSequence,
        side,
        revisionId,
        previewId: presentation?.comparison.previewId ?? null,
        camera,
        width: size.width,
        height: size.height,
        pixelBytes: size.width * size.height * 4,
        highlight: presentation?.highlight ?? null,
        metrics: captured.metrics ?? null,
      });
      synchronous(
        this.#onFrame(frame),
        "Viewer WebGL comparison onFrame",
      );
      return frame;
    } finally {
      if (
        source !== surface &&
        source !== this.#renderer.canvas
      ) {
        releaseCanvas(source);
      }
    }
  }

  #matchesBackup(side, next) {
    const backup = this.#backups.get(side);
    return (
      backup &&
      sameCamera(backup.camera, next.camera) &&
      sameSplitPresentation(
        backup.presentation,
        next.presentation,
      ) &&
      backup.revisionId === next.revisionId
    );
  }

  #updateTarget(side, next) {
    const state = this.#states.get(side);
    if (
      sameCamera(state.camera, next.camera) &&
      sameSplitPresentation(
        state.presentation,
        next.presentation,
      ) &&
      state.revisionId === next.revisionId &&
      this.#frames.get(side)
    ) {
      state.camera = next.camera;
      state.presentation = next.presentation;
      return this.#frames.get(side);
    }
    if (this.#matchesBackup(side, next)) {
      this.#restoreBackup(side);
      state.camera = next.camera;
      state.presentation = next.presentation;
      state.revisionId = next.revisionId;
      return this.#frames.get(side);
    }
    this.#captureBackup(side);
    try {
      const frame = this.#renderSide(side, next);
      state.camera = next.camera;
      state.presentation = next.presentation;
      state.revisionId = next.revisionId;
      if (frame) {
        this.#frames.set(side, frame);
      }
      return frame;
    } catch (error) {
      try {
        this.#restoreBackup(side);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Viewer WebGL comparison frame and rollback failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  #setTargetCamera(side, camera) {
    const state = this.#states.get(side);
    return this.#updateTarget(side, {
      camera,
      presentation: state.presentation,
      revisionId: state.revisionId,
    });
  }

  #setTargetPresentation(side, presentation) {
    if (
      presentation?.side !== side ||
      presentation.revisionId !==
        (side === ViewerSplitViewSide.BEFORE
          ? presentation.comparison.baseRevisionId
          : presentation.comparison.revisionId)
    ) {
      throw invalidState(
        "Viewer WebGL split presentation has a stale side binding",
      );
    }
    const state = this.#states.get(side);
    return this.#updateTarget(side, {
      camera: state.camera,
      presentation,
      revisionId: presentation.revisionId,
    });
  }

  #clearTargetDiff(side) {
    const state = this.#states.get(side);
    if (this.#disposing) {
      state.presentation = null;
      return null;
    }
    return this.#updateTarget(side, {
      camera: state.camera,
      presentation: null,
      revisionId: state.revisionId,
    });
  }

  #restoreActiveRenderer() {
    this.#adapter.restoreActivePresentation();
    const after = this.#states.get(
      ViewerSplitViewSide.AFTER,
    ).presentation;
    if (after?.comparison.changedEntries.length > 0) {
      this.#adapter.applyDiffOverlay(
        this.#overlayPresentation(after),
      );
    } else {
      this.#adapter.clearDiffOverlay();
    }
  }

  #runTransition(action) {
    this.#assertOpen();
    this.#assertIdle();
    this.#transitioning = true;
    let result;
    let failure = null;
    const cleanupErrors = [];
    try {
      result = action();
    } catch (error) {
      failure = error;
      for (const side of [...SIDES].reverse()) {
        try {
          this.#restoreBackup(side);
        } catch (rollbackError) {
          cleanupErrors.push(rollbackError);
        }
      }
    }
    try {
      this.#restoreActiveRenderer();
    } catch (error) {
      cleanupErrors.push(error);
    }
    this.#releaseBackups();
    this.#transitioning = false;
    if (failure) {
      throw transitionFailure(
        failure,
        cleanupErrors,
        "Viewer WebGL comparison transition and rollback failed",
      );
    }
    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "Viewer WebGL comparison cleanup failed",
      );
    }
    return result;
  }

  #redrawVisible() {
    const visibility = this.#sideVisibility;
    for (const side of SIDES) {
      if (
        (side === ViewerSplitViewSide.BEFORE &&
          !visibility.beforeVisible) ||
        (side === ViewerSplitViewSide.AFTER &&
          !visibility.afterVisible)
      ) {
        continue;
      }
      const state = this.#states.get(side);
      this.#captureBackup(side);
      const frame = this.#renderSide(side, state);
      if (frame) {
        this.#frames.set(side, frame);
      }
    }
  }

  synchronize() {
    return this.#runTransition(() => {
      this.#validateBinding();
      this.#validateSurfaceBudget();
      const diff = this.#diffController.synchronize();
      const camera = this.#cameraController.synchronize();
      return Object.freeze({ diff, camera });
    });
  }

  setCamera(camera, { interactive = false } = {}) {
    return this.#runTransition(() =>
      this.#cameraController.setCamera(camera, { interactive }),
    );
  }

  setCameraFrom(side, camera, { interactive = false } = {}) {
    return this.#runTransition(() => {
      if (!SIDES.includes(side)) {
        throw new TypeError(
          "Viewer WebGL comparison side must be before or after",
        );
      }
      const nextCamera = normalizeCamera(camera);
      this.#setTargetCamera(side, nextCamera);
      return this.#cameraController.setCameraFrom(
        side,
        nextCamera,
        { interactive },
      );
    });
  }

  select(side, pick) {
    return this.#runTransition(() => {
      if (!SIDES.includes(side)) {
        throw new TypeError(
          "Viewer WebGL comparison side must be before or after",
        );
      }
      const binding = this.#validateBinding();
      const expectedRevision =
        side === ViewerSplitViewSide.BEFORE
          ? binding.baseRevisionId
          : binding.revisionId;
      if (pick?.revisionId !== expectedRevision) {
        throw invalidState(
          "Viewer WebGL comparison rejected a stale pick revision",
        );
      }
      const layerId = boundedIdentifier(
        pick?.layerId,
        "comparison pick layer ID",
      );
      const renderId = boundedIdentifier(
        pick?.renderId,
        "comparison pick Render ID",
      );
      const comparison =
        this.#diffController.snapshot().comparison;
      const entry = comparison.changedEntries.find(
        (candidate) =>
          candidate.layerId === layerId &&
          candidate.renderId === renderId,
      );
      if (!entry || !presentOnSide(side, entry.status)) {
        this.#diffController.clearHighlight();
        return Object.freeze({
          mapped: false,
          corresponding: false,
          highlight: null,
        });
      }
      const highlighted = this.#diffController.highlight(
        layerId,
        renderId,
      );
      return Object.freeze({
        mapped: true,
        corresponding:
          entry.status === ViewerDiffStatus.MODIFIED,
        highlight: highlighted.highlight,
      });
    });
  }

  clearSelection() {
    return this.#runTransition(() =>
      this.#diffController.clearHighlight(),
    );
  }

  setDiffPolicy(policy) {
    const next = createViewerDiffOverlayPolicy(policy);
    return this.#runTransition(() => {
      const previous = this.#policy;
      this.#policy = next;
      try {
        this.#redrawVisible();
      } catch (error) {
        this.#policy = previous;
        throw error;
      }
      return this.snapshot();
    });
  }

  setStatusVisible(status, visible) {
    if (typeof visible !== "boolean") {
      throw new TypeError(
        "Viewer WebGL diff visibility must be a boolean",
      );
    }
    return this.setDiffPolicy({
      ...this.#policy,
      [status]: {
        ...this.#policy[status],
        visible,
      },
    });
  }

  setSideVisibility(visibility) {
    this.#assertOpen();
    if (
      visibility !== undefined &&
      (visibility === null || typeof visibility !== "object")
    ) {
      throw new TypeError(
        "Viewer WebGL side visibility must be an object",
      );
    }
    const value = visibility ?? {};
    const previous = this.#sideVisibility;
    const beforeVisible =
      value.before === undefined
        ? previous.beforeVisible
        : value.before;
    const afterVisible =
      value.after === undefined
        ? previous.afterVisible
        : value.after;
    if (
      typeof beforeVisible !== "boolean" ||
      typeof afterVisible !== "boolean"
    ) {
      throw new TypeError(
        "Viewer WebGL side visibility must use booleans",
      );
    }
    if (!beforeVisible && !afterVisible) {
      throw new RangeError(
        "Viewer WebGL comparison must keep at least one side visible",
      );
    }
    if (
      beforeVisible === previous.beforeVisible &&
      afterVisible === previous.afterVisible
    ) {
      return this.snapshot();
    }
    this.#sideVisibility = Object.freeze({
      beforeVisible,
      afterVisible,
    });
    this.#applySideVisibility();
    try {
      return this.resize();
    } catch (error) {
      this.#sideVisibility = previous;
      this.#applySideVisibility();
      throw error;
    }
  }

  setRatio(ratio) {
    this.#assertOpen();
    this.#uiController.setRatio(ratio);
    this.#applySideVisibility();
    return this.snapshot();
  }

  setOrientation(orientation) {
    this.#assertOpen();
    const previous = this.#uiController.snapshot().orientation;
    this.#uiController.setOrientation(orientation);
    this.#applySideVisibility();
    try {
      this.resize();
    } catch (error) {
      this.#uiController.setOrientation(previous);
      this.#applySideVisibility();
      throw error;
    }
    return this.snapshot();
  }

  resize() {
    return this.#runTransition(() => {
      this.#redrawVisible();
      return this.snapshot();
    });
  }

  snapshot() {
    this.#assertOpen();
    const before = this.#frames.get(ViewerSplitViewSide.BEFORE);
    const after = this.#frames.get(ViewerSplitViewSide.AFTER);
    return Object.freeze({
      strategy:
        ViewerWebGlComparisonStrategy
          .SINGLE_RENDERER_SERIAL_SNAPSHOT,
      binding: comparisonBinding(
        this.#diffController.snapshot().comparison,
      ),
      camera: this.#cameraController.snapshot(),
      diff: this.#diffController.snapshot(),
      ui: this.#uiSnapshot(),
      frames: Object.freeze({ before, after }),
      retainedPixelBytes:
        (before?.pixelBytes ?? 0) +
        (after?.pixelBytes ?? 0),
      maximumSurfacePixels: this.#maximumSurfacePixels,
    });
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    this.#assertIdle();
    this.#disposing = true;
    const errors = [];
    for (const operation of [
      () => this.#diffController.dispose(),
      () => this.#cameraController.dispose(),
      () => this.#adapter.restoreActivePresentation(),
      () => this.#adapter.clearDiffOverlay(),
      () => this.#uiController.dispose(),
    ]) {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#releaseBackups();
    for (const surface of this.#surfaces.values()) {
      try {
        releaseCanvas(surface);
        if (this.#createdSurfaces.has(surface)) {
          surface.remove?.();
        } else {
          restoreSurfaceState(
            surface,
            this.#surfaceStates.get(surface),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    const renderCanvas = this.#renderer.canvas;
    renderCanvas.hidden = this.#renderCanvasState.hidden;
    if (this.#renderCanvasState.ariaHidden === null) {
      renderCanvas.removeAttribute?.("aria-hidden");
    } else {
      renderCanvas.setAttribute?.(
        "aria-hidden",
        this.#renderCanvasState.ariaHidden,
      );
    }
    this.#frames.clear();
    this.#states.clear();
    this.#surfaceStates.clear();
    this.#disposing = false;
    this.#disposed = true;
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Viewer WebGL comparison disposal failed",
      );
    }
    return true;
  }
}

export function mountWebGlRevisionComparison(options) {
  const controller =
    new ViewerWebGlRevisionComparisonController(options);
  try {
    controller.synchronize();
    return controller;
  } catch (error) {
    try {
      controller.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Viewer WebGL comparison mount and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

export {
  MAXIMUM_SURFACE_PIXELS as MAXIMUM_COMPARISON_SURFACE_PIXELS,
};
