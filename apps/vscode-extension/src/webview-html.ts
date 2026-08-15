export interface WebviewHtmlOptions {
  cspSource: string;
  nonce: string;
  stylesUri: string;
  scriptUri: string;
  locale?: string;
  topToolbarLabels?: MenuLabelMode;
  leftToolbarLabels?: MenuLabelMode;
  renderResolution?: RenderResolutionMode;
  interactionRendering?: InteractionRenderingMode;
  scrollInputMode?: ScrollInputMode;
  mouseWheelZoomSensitivity?: number;
  trackpadPinchZoomSensitivity?: number;
  displayStateQualification?: boolean;
}

export type MenuLabelMode = "hover" | "icons";
export type RenderResolutionMode =
  | "auto"
  | "quality"
  | "performance";
export type InteractionRenderingMode =
  | "continuous"
  | "hybrid"
  | "maximumPerformance";
export type ScrollInputMode = "mouse-zoom" | "trackpad-pan";
export const DEFAULT_SCROLL_INPUT_MODE: ScrollInputMode = "mouse-zoom";
export const DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY = 1;
export const DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY = 1.5;
export const MINIMUM_ZOOM_SENSITIVITY = 0.25;
export const MAXIMUM_ZOOM_SENSITIVITY = 4;

export function normalizeWebviewZoomSensitivity(
  value: number | undefined,
  fallback: number,
): number {
  const resolvedFallback = Number.isFinite(fallback)
    ? fallback
    : DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY;
  const candidate =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : resolvedFallback;
  return Math.min(
    Math.max(
      candidate,
      MINIMUM_ZOOM_SENSITIVITY,
    ),
    MAXIMUM_ZOOM_SENSITIVITY,
  );
}

export function normalizeWebviewScrollInputMode(
  value: unknown,
): ScrollInputMode {
  return value === "trackpad-pan" ? "trackpad-pan" : "mouse-zoom";
}

function normalizeWebviewLocale(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)
  ) {
    return "en";
  }
  try {
    return Intl.getCanonicalLocales(value)[0] ?? "en";
  } catch {
    return "en";
  }
}

function normalizeMenuLabelMode(
  value: MenuLabelMode | undefined,
): MenuLabelMode {
  return value === "icons" ? "icons" : "hover";
}

function normalizeRenderResolutionMode(
  value: RenderResolutionMode | undefined,
): RenderResolutionMode {
  return value === "quality" || value === "performance"
    ? value
    : "auto";
}

function normalizeInteractionRenderingMode(
  value: InteractionRenderingMode | undefined,
): InteractionRenderingMode {
  return value === "continuous" || value === "maximumPerformance"
    ? value
    : "hybrid";
}

export function renderWebviewHtml(
  template: string,
  {
    cspSource,
    nonce,
    stylesUri,
    scriptUri,
    locale,
    topToolbarLabels,
    leftToolbarLabels,
    renderResolution,
    interactionRendering,
    scrollInputMode,
    mouseWheelZoomSensitivity,
    trackpadPinchZoomSensitivity,
    displayStateQualification,
  }: WebviewHtmlOptions,
): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) {
    throw new TypeError("webview nonce is invalid");
  }
  const csp = [
    "default-src 'none'",
    `img-src data: ${cspSource}`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "worker-src blob:",
    `connect-src ${cspSource}`,
  ].join("; ");

  const withoutImportMap = template.replace(
    /\s*<script\s+type=["']importmap["']>[\s\S]*?<\/script>\s*/iu,
    "\n",
  );
  const withCsp = withoutImportMap.replace(
    /(<meta\s+charset=["']utf-8["']\s*\/?>)/iu,
    `$1\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
  );
  const resolvedLocale = normalizeWebviewLocale(locale);
  const withLocale = withCsp.replace(
    /<html\b[^>]*>/iu,
    `<html lang="${resolvedLocale}" data-locale="${resolvedLocale}">`,
  );
  const resolvedTopToolbarLabels = normalizeMenuLabelMode(
    topToolbarLabels,
  );
  const resolvedLeftToolbarLabels = normalizeMenuLabelMode(
    leftToolbarLabels,
  );
  const resolvedRenderResolution = normalizeRenderResolutionMode(
    renderResolution,
  );
  const resolvedInteractionRendering =
    normalizeInteractionRenderingMode(interactionRendering);
  const resolvedScrollInputMode = normalizeWebviewScrollInputMode(
    scrollInputMode,
  );
  const resolvedMouseWheelZoomSensitivity =
    normalizeWebviewZoomSensitivity(
      mouseWheelZoomSensitivity,
      DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
    );
  const resolvedTrackpadPinchZoomSensitivity =
    normalizeWebviewZoomSensitivity(
      trackpadPinchZoomSensitivity,
      DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
    );
  const withHost = withLocale.replace(
    "<body>",
    `<body data-host="vscode" data-top-toolbar-labels="${resolvedTopToolbarLabels}" data-left-toolbar-labels="${resolvedLeftToolbarLabels}" data-render-resolution="${resolvedRenderResolution}" data-interaction-rendering="${resolvedInteractionRendering}" data-scroll-input-mode="${resolvedScrollInputMode}" data-mouse-wheel-zoom-sensitivity="${resolvedMouseWheelZoomSensitivity}" data-trackpad-pinch-zoom-sensitivity="${resolvedTrackpadPinchZoomSensitivity}"${displayStateQualification ? ' data-display-state-qualification="true"' : ""}>`,
  );
  const withStyles = withHost.replace(
    /<link\s+rel=["']stylesheet["']\s+href=["'][^"']+["']\s*\/?>/iu,
    `<link rel="stylesheet" href="${stylesUri}" />`,
  );
  const withScript = withStyles.replace(
    /<script\s+type=["']module["']\s+src=["'][^"']+["']><\/script>/iu,
    `<script nonce="${nonce}" type="module" src="${scriptUri}"></script>`,
  );

  if (
    withScript === template ||
    !withScript.includes("Content-Security-Policy") ||
    !withScript.includes(`nonce="${nonce}"`) ||
    withScript.includes('type="importmap"')
  ) {
    throw new Error("webview template does not match the expected structure");
  }
  return withScript;
}
