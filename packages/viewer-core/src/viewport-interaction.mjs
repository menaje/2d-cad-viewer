import { CameraController2D } from "./camera.mjs";
import { ViewerRendererController } from "./renderer-controller.mjs";

const DETAIL_DEBOUNCE_MS = 650;
const DETAIL_ZOOM_THRESHOLD = 0;
const WHEEL_ZOOM_RATE = 0.0015;
const VIEW_COMMIT_DEBOUNCE_MS = 220;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function requireDetailStreamerFactory(value) {
  if (typeof value !== "function") {
    throw new TypeError(
      "ViewportInteraction requires a detail streamer factory",
    );
  }
  return value;
}

export class ViewportInteraction {
  constructor(
    scene,
    canvas,
    {
      detailZoomThreshold = DETAIL_ZOOM_THRESHOLD,
      onUpdate = () => {},
      onError = () => {},
      onReviewBatch = () => false,
      onReviewBatchEvicted = () => {},
      onReviewSelection = () => {},
      onViewCommit = () => {},
      onViewReplace = () => {},
      onWindowZoomModeChange = () => {},
      windowZoomGuide = null,
      createDetailStreamer,
      keyboardTarget = globalThis.document,
    } = {},
  ) {
    this.scene = scene;
    this.canvas = canvas;
    this.camera = new CameraController2D(scene.render.camera);
    this.detailZoomThreshold = detailZoomThreshold;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onReviewBatch = onReviewBatch;
    this.onReviewBatchEvicted = onReviewBatchEvicted;
    this.onReviewSelection = onReviewSelection;
    this.onViewCommit = onViewCommit;
    this.onViewReplace = onViewReplace;
    this.onWindowZoomModeChange = onWindowZoomModeChange;
    this.windowZoomGuide = windowZoomGuide;
    this.createDetailStreamer = requireDetailStreamerFactory(
      createDetailStreamer,
    );
    if (typeof keyboardTarget?.addEventListener !== "function") {
      throw new TypeError(
        "ViewportInteraction requires a keyboard event target",
      );
    }
    this.keyboardTarget = keyboardTarget;
    this.rendererController = new ViewerRendererController(
      scene.renderer,
    );
    this.reviewEnabled = false;
    this.lastRender = scene.render;
    this.frameRequest = null;
    this.frameInteractive = false;
    this.detailTimer = null;
    this.drag = null;
    this.windowDrag = null;
    this.windowZoomEnabled = false;
    this.viewCommitTimer = null;
    this.abortController = new AbortController();
    this.detailStreamer = this.createDetailStreamer(
      scene.reader,
      this.rendererController.createDetailTarget("root"),
      scene.metadata.batches,
      scene.instanceGraph,
      {
        onUpdate: (detail) => {
          if (detail.render) {
            this.lastRender = detail.render;
          }
          this.emit(this.detailSnapshot());
        },
        onError: (error) => {
          this.onError(error);
        },
        onReviewBatch: (batch, vertices, candidate) =>
          this.onReviewBatch("root", batch, vertices, candidate),
        onReviewBatchEvicted: (batchId) =>
          this.onReviewBatchEvicted("root", batchId),
        onReviewSelection: (candidates) =>
          this.onReviewSelection("root", candidates),
      },
    );
    this.externalDetailStreamers = new Map();
    this.detailStreamingPaused = false;
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleRender({ interactive: false });
      this.scheduleDetail();
    });
    this.resizeObserver.observe(canvas);
  }

  bindEvents() {
    const signal = this.abortController.signal;
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const delta = Math.min(Math.max(event.deltaY, -1_000), 1_000);
        this.camera.zoomAt(
          Math.exp(delta * WHEEL_ZOOM_RATE),
          event.offsetX,
          event.offsetY,
          this.canvas.clientWidth,
          this.canvas.clientHeight,
        );
        this.scheduleRender();
        this.scheduleDetail();
        this.scheduleViewCommit();
      },
      { passive: false, signal },
    );
    this.canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) {
          return;
        }
        this.pauseDetailStreaming();
        this.flushViewCommit();
        if (this.windowZoomEnabled) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const point = this.canvasPoint(event);
          this.canvas.setPointerCapture(event.pointerId);
          this.windowDrag = {
            pointerId: event.pointerId,
            start: point,
            current: point,
          };
          this.updateWindowZoomGuide();
          return;
        }
        this.canvas.setPointerCapture(event.pointerId);
        this.drag = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          changed: false,
        };
        this.canvas.classList.add("panning");
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointermove",
      (event) => {
        if (
          this.windowDrag &&
          this.windowDrag.pointerId === event.pointerId
        ) {
          event.preventDefault();
          this.windowDrag.current = this.canvasPoint(event);
          this.updateWindowZoomGuide();
          return;
        }
        if (!this.drag || this.drag.pointerId !== event.pointerId) {
          return;
        }
        const deltaX = event.clientX - this.drag.x;
        const deltaY = event.clientY - this.drag.y;
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        this.drag.changed ||= deltaX !== 0 || deltaY !== 0;
        this.camera.panByPixels(
          deltaX,
          deltaY,
          this.canvas.clientWidth,
          this.canvas.clientHeight,
        );
        this.scheduleRender();
        this.scheduleDetail();
      },
      { signal },
    );
    for (const eventName of ["pointerup", "pointercancel"]) {
      this.canvas.addEventListener(
        eventName,
        (event) => {
          if (
            this.windowDrag &&
            this.windowDrag.pointerId === event.pointerId
          ) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const drag = this.windowDrag;
            this.windowDrag = null;
            this.hideWindowZoomGuide();
            if (this.canvas.hasPointerCapture(event.pointerId)) {
              this.canvas.releasePointerCapture(event.pointerId);
            }
            const view =
              eventName === "pointerup"
                ? this.camera.focusScreenRect(
                    drag.start.x,
                    drag.start.y,
                    drag.current.x,
                    drag.current.y,
                    drag.start.width,
                    drag.start.height,
                  )
                : null;
            if (view) {
              this.cancelScheduledRender();
              this.lastRender =
                this.rendererController.redraw(view);
              this.syncDetailRenderCamera(this.lastRender.camera);
              this.scheduleDetail(0);
              this.emit(this.detailSnapshot());
              this.commitView();
              this.setWindowZoomEnabled(false, {
                reason: "completed",
              });
            } else {
              this.setWindowZoomEnabled(false, {
                reason:
                  eventName === "pointercancel"
                    ? "cancelled"
                    : "too-small",
              });
              this.scheduleDetail(0);
            }
            return;
          }
          if (!this.drag || this.drag.pointerId !== event.pointerId) {
            return;
          }
          const changed = this.drag.changed;
          this.drag = null;
          this.canvas.classList.remove("panning");
          if (this.canvas.hasPointerCapture(event.pointerId)) {
            this.canvas.releasePointerCapture(event.pointerId);
          }
          this.scheduleDetail(0);
          if (changed) {
            this.commitView();
          }
        },
        { signal },
      );
    }
    this.canvas.addEventListener(
      "dblclick",
      (event) => {
        event.preventDefault();
        this.reset();
      },
      { signal },
    );
    this.keyboardTarget.addEventListener(
      "keydown",
      (event) => {
        if (!this.windowZoomEnabled || event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        this.setWindowZoomEnabled(false, { reason: "cancelled" });
      },
      { capture: true, signal },
    );
  }

  reset() {
    this.flushViewCommit();
    const fitCamera = this.rendererController.fitAllCamera();
    if (fitCamera) {
      this.camera.updateFit(fitCamera, {
        resetIfFitted: false,
      });
    }
    this.camera.reset();
    this.scheduleRender({ interactive: false });
    this.scheduleDetail(0);
    this.commitView();
  }

  zoomBy(factor) {
    this.flushViewCommit();
    this.camera.zoomAt(
      factor,
      this.canvas.clientWidth * 0.5,
      this.canvas.clientHeight * 0.5,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    this.scheduleRender();
    this.scheduleDetail();
    this.commitView();
  }

  focusAt(point, worldHeight, { commit = true } = {}) {
    if (commit) {
      this.flushViewCommit();
    }
    this.camera.focus(point, worldHeight);
    this.cancelScheduledRender();
    this.lastRender = this.rendererController.redraw(
      this.camera.view(),
    );
    this.syncDetailRenderCamera(this.lastRender.camera);
    this.scheduleDetail(0);
    this.emit(this.detailSnapshot());
    if (commit) {
      this.commitView();
    }
    return this.snapshot();
  }

  restoreView(view) {
    this.setWindowZoomEnabled(false);
    return this.focusAt(view?.origin, view?.worldHeight, {
      commit: false,
    });
  }

  refresh() {
    const interactive =
      this.drag !== null ||
      this.detailTimer !== null ||
      (this.frameRequest !== null && this.frameInteractive);
    this.cancelScheduledRender();
    this.lastRender = this.rendererController.redraw(
      this.camera.view(),
      { interactive },
    );
    this.syncDetailRenderCamera(this.lastRender.camera, {
      interactive,
    });
    this.emit(this.detailSnapshot());
    return this.snapshot();
  }

  updateFit(fitCamera) {
    this.flushViewCommit();
    this.cancelScheduledRender();
    this.camera.updateFit(fitCamera);
    this.lastRender = this.rendererController.redraw(
      this.camera.view(),
    );
    this.syncDetailRenderCamera(this.lastRender.camera);
    this.scheduleDetail(0);
    this.emit(this.detailSnapshot());
    this.onViewReplace(this.camera.view());
    return this.snapshot();
  }

  canvasPoint(event) {
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    return Object.freeze({
      x: clamp(
        ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) *
          width,
        0,
        width,
      ),
      y: clamp(
        ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) *
          height,
        0,
        height,
      ),
      width,
      height,
    });
  }

  updateWindowZoomGuide() {
    if (!this.windowZoomGuide || !this.windowDrag) {
      return;
    }
    const canvasBounds = this.canvas.getBoundingClientRect();
    const parentBounds =
      this.windowZoomGuide.parentElement?.getBoundingClientRect() ??
      canvasBounds;
    const scaleX = canvasBounds.width / this.windowDrag.start.width;
    const scaleY = canvasBounds.height / this.windowDrag.start.height;
    const left =
      canvasBounds.left -
      parentBounds.left +
      Math.min(this.windowDrag.start.x, this.windowDrag.current.x) *
        scaleX;
    const top =
      canvasBounds.top -
      parentBounds.top +
      Math.min(this.windowDrag.start.y, this.windowDrag.current.y) *
        scaleY;
    const width =
      Math.abs(this.windowDrag.current.x - this.windowDrag.start.x) *
      scaleX;
    const height =
      Math.abs(this.windowDrag.current.y - this.windowDrag.start.y) *
      scaleY;
    Object.assign(this.windowZoomGuide.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    this.windowZoomGuide.hidden = false;
  }

  hideWindowZoomGuide() {
    if (this.windowZoomGuide) {
      this.windowZoomGuide.hidden = true;
    }
  }

  setWindowZoomEnabled(enabled, { reason = "" } = {}) {
    const next = Boolean(enabled);
    const changed = this.windowZoomEnabled !== next;
    this.windowZoomEnabled = next;
    if (!next) {
      if (this.windowDrag) {
        const pointerId = this.windowDrag.pointerId;
        this.windowDrag = null;
        if (this.canvas.hasPointerCapture(pointerId)) {
          this.canvas.releasePointerCapture(pointerId);
        }
      }
      this.hideWindowZoomGuide();
    } else {
      this.flushViewCommit();
      this.drag = null;
      this.canvas.classList.remove("panning");
    }
    this.canvas.classList.toggle("zoom-window", next);
    if (changed || reason) {
      this.onWindowZoomModeChange(next, reason);
    }
    return next;
  }

  scheduleViewCommit() {
    if (this.viewCommitTimer !== null) {
      clearTimeout(this.viewCommitTimer);
    }
    this.viewCommitTimer = setTimeout(() => {
      this.viewCommitTimer = null;
      this.commitView();
    }, VIEW_COMMIT_DEBOUNCE_MS);
  }

  flushViewCommit() {
    if (this.viewCommitTimer === null) {
      return false;
    }
    clearTimeout(this.viewCommitTimer);
    this.viewCommitTimer = null;
    this.commitView();
    return true;
  }

  commitView() {
    this.onViewCommit(this.camera.view());
  }

  addExternalDetailSource(id, reader, batches, instanceGraph) {
    this.externalDetailStreamers.get(id)?.dispose();
    const renderer =
      this.rendererController.createDetailTarget(id);
    const streamer = this.createDetailStreamer(
      reader,
      renderer,
      batches,
      instanceGraph,
      {
        maximumCacheBytes: 24 * 1024 * 1024,
        maximumVisibleBytes: 8 * 1024 * 1024,
        concurrency: 1,
        onUpdate: (detail) => {
          if (detail.render) {
            this.lastRender = detail.render;
          }
          this.emit(this.detailSnapshot());
        },
        onError: (error) => this.onError(error),
        onReviewBatch: (batch, vertices, candidate) =>
          this.onReviewBatch(id, batch, vertices, candidate),
        onReviewBatchEvicted: (batchId) =>
          this.onReviewBatchEvicted(id, batchId),
        onReviewSelection: (candidates) =>
          this.onReviewSelection(id, candidates),
      },
    );
    this.externalDetailStreamers.set(id, streamer);
    streamer.setRenderCamera(this.camera.view());
    streamer.setReviewEnabled(this.reviewEnabled);
    if (this.detailStreamingPaused) {
      streamer.pause();
    }
    this.scheduleDetail(0);
    return streamer;
  }

  setReviewEnabled(enabled) {
    this.reviewEnabled = Boolean(enabled);
    this.detailStreamer.setReviewEnabled(this.reviewEnabled);
    for (const streamer of this.externalDetailStreamers.values()) {
      streamer.setReviewEnabled(this.reviewEnabled);
    }
    return this.reviewEnabled;
  }

  syncDetailRenderCamera(camera, renderOptions = {}) {
    this.detailStreamer.setRenderCamera(camera, renderOptions);
    for (const streamer of this.externalDetailStreamers.values()) {
      streamer.setRenderCamera(camera, renderOptions);
    }
  }

  pauseDetailStreaming() {
    if (this.detailStreamingPaused) {
      return false;
    }
    this.detailStreamingPaused = true;
    this.detailStreamer.pause();
    for (const streamer of this.externalDetailStreamers.values()) {
      streamer.pause();
    }
    return true;
  }

  resumeDetailStreaming(camera, options) {
    const wasPaused = this.detailStreamingPaused;
    this.detailStreamingPaused = false;
    this.detailStreamer.resume(camera, options);
    for (const streamer of this.externalDetailStreamers.values()) {
      streamer.resume(camera, options);
    }
    return wasPaused;
  }

  cancelScheduledRender() {
    if (this.frameRequest === null) {
      return false;
    }
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.frameInteractive = false;
    return true;
  }

  scheduleRender({ interactive = true } = {}) {
    const camera = this.camera.view();
    this.syncDetailRenderCamera(camera, { interactive });
    if (this.frameRequest !== null) {
      this.frameInteractive &&= Boolean(interactive);
      return;
    }
    this.frameInteractive = Boolean(interactive);
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = null;
      const renderInteractive = this.frameInteractive;
      this.frameInteractive = false;
      try {
        this.lastRender = this.rendererController.redraw(
          this.camera.view(),
          { interactive: renderInteractive },
        );
        this.syncDetailRenderCamera(this.lastRender.camera, {
          interactive: renderInteractive,
        });
        this.emit(this.detailSnapshot());
      } catch (error) {
        this.onError(error);
      }
    });
  }

  scheduleDetail(delay = DETAIL_DEBOUNCE_MS) {
    this.pauseDetailStreaming();
    if (this.detailTimer !== null) {
      clearTimeout(this.detailTimer);
    }
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null;
      try {
        this.cancelScheduledRender();
        const camera = this.rendererController.cameraForView(
          this.camera.view(),
        );
        const enabled = this.camera.zoom >= this.detailZoomThreshold;
        this.syncDetailRenderCamera(camera);
        this.resumeDetailStreaming(camera, {
          enabled,
          redraw: false,
          emit: false,
        });
        this.lastRender = this.rendererController.redraw(camera);
        this.syncDetailRenderCamera(this.lastRender.camera);
        this.emit(this.detailSnapshot());
      } catch (error) {
        this.onError(error);
      }
    }, delay);
  }

  detailSnapshot() {
    const snapshots = [
      this.detailStreamer.snapshot(),
      ...[...this.externalDetailStreamers.values()].map((streamer) =>
        streamer.snapshot(),
      ),
    ];
    return Object.freeze({
      revision: Math.max(...snapshots.map((value) => value.revision)),
      selectedBatches: snapshots.reduce(
        (total, value) => total + value.selectedBatches,
        0,
      ),
      selectedBytes: snapshots.reduce(
        (total, value) => total + value.selectedBytes,
        0,
      ),
      selectedInstances: snapshots.reduce(
        (total, value) => total + value.selectedInstances,
        0,
      ),
      loading: snapshots.reduce(
        (total, value) => total + value.loading,
        0,
      ),
      paused:
        this.detailStreamingPaused ||
        snapshots.some((value) => value.paused),
      cache: Object.freeze({
        entries: snapshots.reduce(
          (total, value) => total + value.cache.entries,
          0,
        ),
        bytes: snapshots.reduce(
          (total, value) => total + value.cache.bytes,
          0,
        ),
      }),
      render: this.lastRender,
      error: snapshots.find((value) => value.error)?.error ?? null,
      metrics: Object.freeze({
        interactionPauses: snapshots.reduce(
          (total, value) =>
            total + value.metrics.interactionPauses,
          0,
        ),
        interactionResumes: snapshots.reduce(
          (total, value) =>
            total + value.metrics.interactionResumes,
          0,
        ),
        coalescedUpdates: snapshots.reduce(
          (total, value) =>
            total + value.metrics.coalescedUpdates,
          0,
        ),
        loadStarts: snapshots.reduce(
          (total, value) => total + value.metrics.loadStarts,
          0,
        ),
        interactionLoadStarts: snapshots.reduce(
          (total, value) =>
            total + value.metrics.interactionLoadStarts,
          0,
        ),
        cancellationRequests: snapshots.reduce(
          (total, value) =>
            total + value.metrics.cancellationRequests,
          0,
        ),
        staleCompletions: snapshots.reduce(
          (total, value) =>
            total + value.metrics.staleCompletions,
          0,
        ),
        staleMounts: snapshots.reduce(
          (total, value) => total + value.metrics.staleMounts,
          0,
        ),
        gpuUploads: snapshots.reduce(
          (total, value) => total + value.metrics.gpuUploads,
          0,
        ),
        settledUpdates: snapshots.reduce(
          (total, value) =>
            total + value.metrics.settledUpdates,
          0,
        ),
        settledDetailLatencyMs: Math.max(
          0,
          ...snapshots.map(
            (value) =>
              value.metrics.settledDetailLatencyMs ?? 0,
          ),
        ),
      }),
    });
  }

  snapshot(detail = this.detailSnapshot()) {
    return Object.freeze({
      zoom: this.camera.zoom,
      camera: this.camera.view(),
      render: this.lastRender,
      detail,
    });
  }

  emit(detail) {
    this.onUpdate(this.snapshot(detail));
  }

  dispose() {
    this.abortController.abort();
    this.resizeObserver.disconnect();
    this.cancelScheduledRender();
    if (this.detailTimer !== null) {
      clearTimeout(this.detailTimer);
      this.detailTimer = null;
    }
    if (this.viewCommitTimer !== null) {
      clearTimeout(this.viewCommitTimer);
      this.viewCommitTimer = null;
    }
    this.detailStreamer.dispose();
    for (const streamer of this.externalDetailStreamers.values()) {
      streamer.dispose();
    }
    this.externalDetailStreamers.clear();
    this.detailStreamingPaused = true;
    this.rendererController.dispose();
    this.reviewEnabled = false;
    this.windowDrag = null;
    this.windowZoomEnabled = false;
    this.hideWindowZoomGuide();
    this.canvas.classList.remove("panning", "zoom-window");
  }
}

export {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  WHEEL_ZOOM_RATE,
};
