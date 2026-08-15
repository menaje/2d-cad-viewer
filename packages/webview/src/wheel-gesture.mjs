import { WHEEL_ZOOM_RATE } from "@menaje/viewer-core/interaction";

const PINCH_ZOOM_RATE = 0.008;
const DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY = 1;
const DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY = 1.5;
const SCROLL_INPUT_MODE_MOUSE_ZOOM = "mouse-zoom";
const SCROLL_INPUT_MODE_TRACKPAD_PAN = "trackpad-pan";
const DEFAULT_SCROLL_INPUT_MODE = SCROLL_INPUT_MODE_MOUSE_ZOOM;
const MINIMUM_ZOOM_SENSITIVITY = 0.25;
const MAXIMUM_ZOOM_SENSITIVITY = 4;
const WHEEL_LINE_PIXELS = 32;
const WHEEL_PAGE_PIXELS = 240;
const MAXIMUM_TRACKPAD_PAN_PIXELS = 160;
const MAXIMUM_WHEEL_ZOOM_PIXELS = 240;
const MAXIMUM_PINCH_ZOOM_PIXELS = 60;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function sensitivityNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return Number.NaN;
}

export function normalizeZoomSensitivity(
  value,
  fallback = DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
) {
  const fallbackNumber = sensitivityNumber(fallback);
  const resolvedFallback = Number.isFinite(fallbackNumber)
    ? fallbackNumber
    : DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY;
  const candidate = sensitivityNumber(value);
  return clamp(
    Number.isFinite(candidate) ? candidate : resolvedFallback,
    MINIMUM_ZOOM_SENSITIVITY,
    MAXIMUM_ZOOM_SENSITIVITY,
  );
}

export function normalizeScrollInputMode(value) {
  return value === SCROLL_INPUT_MODE_TRACKPAD_PAN
    ? SCROLL_INPUT_MODE_TRACKPAD_PAN
    : SCROLL_INPUT_MODE_MOUSE_ZOOM;
}

function finiteWheelDelta(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalizedDeltaMode(value) {
  return value === 1 || value === 2 ? value : 0;
}

function pixelDelta(value, mode, viewportExtent) {
  if (mode === 1) {
    return value * WHEEL_LINE_PIXELS;
  }
  if (mode === 2) {
    return value * Math.min(Math.max(viewportExtent, 1), WHEEL_PAGE_PIXELS);
  }
  return value;
}

function boundedPanDelta(value) {
  const bounded = clamp(
    value,
    -MAXIMUM_TRACKPAD_PAN_PIXELS,
    MAXIMUM_TRACKPAD_PAN_PIXELS,
  );
  return bounded === 0 ? 0 : -bounded;
}

export function normalizeWheelGesture(
  event,
  {
    width = 1,
    height = 1,
    scrollInputMode = DEFAULT_SCROLL_INPUT_MODE,
    mouseWheelZoomSensitivity =
      DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
    trackpadPinchZoomSensitivity =
      DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  } = {},
) {
  if (event === null || typeof event !== "object") {
    throw new TypeError("Wheel gesture requires an event object");
  }

  const mode = normalizedDeltaMode(event.deltaMode);
  const rawDeltaX = finiteWheelDelta(event.deltaX);
  const rawDeltaY = finiteWheelDelta(event.deltaY);
  const timeStamp = Number.isFinite(event.timeStamp)
    ? event.timeStamp
    : 0;
  const resolvedScrollInputMode = normalizeScrollInputMode(
    scrollInputMode,
  );

  let kind;
  if (event.ctrlKey && mode === 0) {
    kind = "pinch";
  } else if (
    resolvedScrollInputMode === SCROLL_INPUT_MODE_TRACKPAD_PAN
  ) {
    kind = "trackpad-pan";
  } else {
    kind = "wheel-zoom";
  }

  const deltaX = pixelDelta(rawDeltaX, mode, width);
  const deltaY = pixelDelta(rawDeltaY, mode, height);
  if (kind === "trackpad-pan") {
    return Object.freeze({
      kind,
      timeStamp,
      panX: boundedPanDelta(deltaX),
      panY: boundedPanDelta(deltaY),
      zoomFactor: 1,
    });
  }

  const maximum =
    kind === "pinch"
      ? MAXIMUM_PINCH_ZOOM_PIXELS
      : MAXIMUM_WHEEL_ZOOM_PIXELS;
  const rate =
    kind === "pinch" ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
  const sensitivity =
    kind === "pinch"
      ? normalizeZoomSensitivity(
          trackpadPinchZoomSensitivity,
          DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
        )
      : normalizeZoomSensitivity(
          mouseWheelZoomSensitivity,
          DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
        );
  const boundedDelta = clamp(deltaY, -maximum, maximum);
  return Object.freeze({
    kind,
    timeStamp,
    panX: 0,
    panY: 0,
    zoomFactor: Math.exp(boundedDelta * rate * sensitivity),
  });
}

export {
  DEFAULT_SCROLL_INPUT_MODE,
  DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
  DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  MAXIMUM_ZOOM_SENSITIVITY,
  MAXIMUM_PINCH_ZOOM_PIXELS,
  MAXIMUM_TRACKPAD_PAN_PIXELS,
  MAXIMUM_WHEEL_ZOOM_PIXELS,
  MINIMUM_ZOOM_SENSITIVITY,
  PINCH_ZOOM_RATE,
  SCROLL_INPUT_MODE_MOUSE_ZOOM,
  SCROLL_INPUT_MODE_TRACKPAD_PAN,
  WHEEL_LINE_PIXELS,
  WHEEL_PAGE_PIXELS,
};
