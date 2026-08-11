import { DetailStreamer } from "./detail-streamer.mjs";
import {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  ViewportInteraction as CoreViewportInteraction,
  WHEEL_ZOOM_RATE,
} from "@menaje/viewer-core/interaction";
import {
  DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
  DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  MAXIMUM_ZOOM_SENSITIVITY,
  MINIMUM_ZOOM_SENSITIVITY,
  normalizeWheelGesture,
  normalizeZoomSensitivity,
} from "./wheel-gesture.mjs";

function createDetailStreamer(...arguments_) {
  return new DetailStreamer(...arguments_);
}

export class ViewportInteraction extends CoreViewportInteraction {
  constructor(scene, canvas, options = {}) {
    const {
      mouseWheelZoomSensitivity =
        DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
      trackpadPinchZoomSensitivity =
        DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
      ...coreOptions
    } = options;
    const wheelAbortController = new AbortController();
    let interaction = null;
    const handleWheel = (event) => interaction?.handleWheel(event);
    canvas.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
      signal: wheelAbortController.signal,
    });

    try {
      super(scene, canvas, {
        ...coreOptions,
        createDetailStreamer,
      });
    } catch (error) {
      wheelAbortController.abort();
      throw error;
    }

    interaction = this;
    this.wheelAbortController = wheelAbortController;
    this.wheelGesture = null;
    this.setZoomSensitivity({
      mouseWheelZoomSensitivity,
      trackpadPinchZoomSensitivity,
    });
  }

  setZoomSensitivity({
    mouseWheelZoomSensitivity,
    trackpadPinchZoomSensitivity,
  } = {}) {
    const nextMouse = normalizeZoomSensitivity(
      mouseWheelZoomSensitivity,
      this.mouseWheelZoomSensitivity ??
        DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
    );
    const nextTrackpad = normalizeZoomSensitivity(
      trackpadPinchZoomSensitivity,
      this.trackpadPinchZoomSensitivity ??
        DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
    );
    if (
      nextMouse !== this.mouseWheelZoomSensitivity ||
      nextTrackpad !== this.trackpadPinchZoomSensitivity
    ) {
      this.wheelGesture = null;
    }
    this.mouseWheelZoomSensitivity = nextMouse;
    this.trackpadPinchZoomSensitivity = nextTrackpad;
    return Object.freeze({
      mouseWheelZoomSensitivity: nextMouse,
      trackpadPinchZoomSensitivity: nextTrackpad,
    });
  }

  handleWheel(event) {
    event.preventDefault();
    event.stopImmediatePropagation?.();

    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const gesture = normalizeWheelGesture(
      event,
      this.wheelGesture,
      {
        width,
        height,
        mouseWheelZoomSensitivity:
          this.mouseWheelZoomSensitivity,
        trackpadPinchZoomSensitivity:
          this.trackpadPinchZoomSensitivity,
      },
    );
    this.wheelGesture = gesture;

    if (gesture.kind === "trackpad-pan") {
      if (gesture.panX === 0 && gesture.panY === 0) {
        return;
      }
      this.camera.panByPixels(
        gesture.panX,
        gesture.panY,
        width,
        height,
      );
    } else {
      if (gesture.zoomFactor === 1) {
        return;
      }
      const offsetX = Number.isFinite(event.offsetX)
        ? event.offsetX
        : width * 0.5;
      const offsetY = Number.isFinite(event.offsetY)
        ? event.offsetY
        : height * 0.5;
      this.camera.zoomAt(
        gesture.zoomFactor,
        offsetX,
        offsetY,
        width,
        height,
      );
    }

    this.scheduleRender();
    this.scheduleDetail();
    this.scheduleViewCommit();
  }

  dispose() {
    this.wheelAbortController?.abort();
    this.wheelGesture = null;
    super.dispose();
  }
}

export {
  DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
  DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  MAXIMUM_ZOOM_SENSITIVITY,
  MINIMUM_ZOOM_SENSITIVITY,
  VIEW_COMMIT_DEBOUNCE_MS,
  WHEEL_ZOOM_RATE,
  normalizeZoomSensitivity,
};
