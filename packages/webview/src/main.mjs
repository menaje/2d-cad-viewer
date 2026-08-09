import {
  DwgSceneCacheSource,
  createSceneCacheRevisionId,
} from "@menaje/dwg-scene-source";
import {
  openViewerRuntime,
} from "@menaje/viewer-core";
import {
  mountDwgWebGlPresentation,
  WebGlLineRenderer,
} from "@menaje/viewer-webgl";

import { ViewportInteraction } from "./interaction.mjs?v=1.18.12";
import {
  buildExternalLayerMap,
  buildExternalLinetypeMap,
  composeExternalInstanceGraph,
  remapLineVertexLayers,
  remapLineVertexLinetypes,
  remapTextEntityLayers,
} from "./external-reference.mjs?v=1.18.8";
import {
  createVsCodeRangeSource,
  installWorkerRangeProxy,
  WORKER_RANGE_REQUEST,
} from "./host-range-source.mjs";
import { applyMaskOrderToInstanceGraph } from "./instance-graph.mjs?v=1.18.8";
import {
  buildLayerGroups,
  isolateLayerGroup,
  layerGroupVisibility,
  setLayerGroupVisibility,
} from "./layer-groups.mjs?v=1.18.11";
import {
  buildMaskOrderPlan,
  DRAW_ORDER_SUBDIVISIONS,
} from "./mask-order.mjs";
import { WebviewMemoryTelemetry } from "./memory-telemetry.mjs";
import { BlobRangeSource, TrackedRangeSource } from "./range-source.mjs";
import {
  calculateRasterImageBounds,
  CanvasRasterImageOverlay,
  CompositeRasterImageOverlay,
  RasterImageAssetStore,
} from "./raster-image-overlay.mjs?v=1.18.14";
import {
  makePlotStyleLineWeights,
  makePlotStylePalette,
  plotStyleDiagnostics,
  plotStyleShownInLayout,
} from "./cad-plot-style.mjs";
import {
  bytesToBase64,
  fitCameraView,
  makeLayoutPngZipEntries,
  makeRasterPdf,
  makeStoredZip,
  pixelsForPage,
  resolvePageGeometry,
  sanitizeExportStem,
  scaleCameraView,
} from "./drawing-export.mjs?v=1.18.13";
import {
  MAX_REVIEW_FILLED_OCCURRENCES,
  MAX_REVIEW_FILLED_RINGS,
  MAX_REVIEW_FILLED_VERTICES,
} from "./filled-object-review.mjs?v=1.18.1";
import { createMeasurementFormat } from "./measurement-format.mjs";
import { ComplexLinetypeOverlay } from "./complex-linetype-overlay.mjs?v=1.18.14";
import { curveRefinementCameraKey } from "./curve-contract.mjs";
import { ReviewTools } from "./review-tools.mjs?v=1.18.16";
import {
  isOutlineFontReference,
  isShxFontReference,
  normalizeShxFontName,
  ShxGlyphCache,
} from "./shx-glyph-cache.mjs";
import {
  CanvasTextOverlay,
  CompositeTextOverlay,
  registerLocalOutlineFont,
  unregisterLocalOutlineFont,
} from "./text-overlay.mjs?v=1.18.16";
import {
  loadExternalFirstFrame,
} from "./viewer.mjs?v=1.18.8";
import {
  addViewBookmark,
  CameraViewHistory,
  MAXIMUM_BOOKMARKS_PER_SCOPE,
  normalizeViewBookmarks,
  removeViewBookmark,
  renameViewBookmark,
} from "./view-navigation.mjs?v=1.18.12";
import {
  createI18n,
  environmentLocales,
} from "./i18n.mjs?v=1.0.0";

const i18n = createI18n({
  requestedLocales: environmentLocales(document, navigator),
});
const t = i18n.t;
i18n.localize(document);

function normalizeMenuLabelMode(value) {
  return value === "icons" ? "icons" : "hover";
}

function applyMenuDisplaySettings({
  topToolbarLabels,
  leftToolbarLabels,
} = {}) {
  document.body.dataset.topToolbarLabels = normalizeMenuLabelMode(
    topToolbarLabels,
  );
  document.body.dataset.leftToolbarLabels = normalizeMenuLabelMode(
    leftToolbarLabels,
  );
}

applyMenuDisplaySettings({
  topToolbarLabels: document.body.dataset.topToolbarLabels,
  leftToolbarLabels: document.body.dataset.leftToolbarLabels,
});

function setViewerToolMessage(element, key, values) {
  const message = t(key, values);
  const label = element?.querySelector(".viewer-tool-label");
  if (label) {
    label.textContent = message;
  } else if (element) {
    element.textContent = message;
  }
  element?.setAttribute("aria-label", message);
  return message;
}

const fileInput = document.querySelector("#cache-file");
const cachePicker = document.querySelector("#cache-picker");
const fontInput = document.querySelector("#font-files");
const fontFileButton = document.querySelector("#font-file-button");
const fontsToggle = document.querySelector("#fonts-toggle");
const fontPanel = document.querySelector("#font-panel");
const fontSummary = document.querySelector("#font-summary");
const fontPanelHelp = document.querySelector("#font-panel-help");
const fontStatusList = document.querySelector("#font-status-list");
const hostFontFolder = document.querySelector("#host-font-folder");
const dropZone = document.querySelector("#drop-zone");
const status = document.querySelector("#status");
const metrics = document.querySelector("#metrics");
const canvas = document.querySelector("#drawing");
const imageCanvas = document.querySelector("#image-overlay");
const textCanvas = document.querySelector("#text-overlay");
const reviewCanvas = document.querySelector("#review-overlay");
const windowZoomGuide = document.querySelector("#window-zoom-guide");
const reviewToolbar = document.querySelector("#review-toolbar");
const reviewResult = document.querySelector("#review-result");
const windowZoomButton = document.querySelector("#window-zoom");
const viewHistoryBack = document.querySelector("#view-history-back");
const viewHistoryForward = document.querySelector("#view-history-forward");
const viewBookmarksToggle = document.querySelector(
  "#view-bookmarks-toggle",
);
const viewBookmarkPanel = document.querySelector("#view-bookmark-panel");
const viewBookmarkClose = document.querySelector("#view-bookmark-close");
const viewBookmarkForm = document.querySelector("#view-bookmark-form");
const viewBookmarkName = document.querySelector("#view-bookmark-name");
const viewBookmarkSummary = document.querySelector(
  "#view-bookmark-summary",
);
const viewBookmarkEmpty = document.querySelector("#view-bookmark-empty");
const viewBookmarkList = document.querySelector("#view-bookmark-list");
const layoutTabs = document.querySelector("#layout-tabs");
const viewControls = [...document.querySelectorAll("[data-view-action]")];
const layersToggle = document.querySelector("#layers-toggle");
const layerPanel = document.querySelector("#layer-panel");
const layerSearch = document.querySelector("#layer-search");
const layerList = document.querySelector("#layer-list");
const layerSummary = document.querySelector("#layer-summary");
const layersShowAll = document.querySelector("#layers-show-all");
const layersHideAll = document.querySelector("#layers-hide-all");
const layersInvert = document.querySelector("#layers-invert");
const layersRestore = document.querySelector("#layers-restore");
const hostRetry = document.querySelector("#host-retry");
const hostRebuild = document.querySelector("#host-rebuild");
const hostAdapterSetup = document.querySelector("#host-adapter-setup");
const xrefsToggle = document.querySelector("#xrefs-toggle");
const wipeoutToggle = document.querySelector("#wipeout-toggle");
const plotStyleToggle = document.querySelector("#plot-style-toggle");
const exportToggle = document.querySelector("#export-toggle");
const exportPanel = document.querySelector("#export-panel");
const exportClose = document.querySelector("#export-close");
const exportForm = document.querySelector("#export-form");
const exportTarget = document.querySelector("#export-target");
const exportFormat = document.querySelector("#export-format");
const exportPaper = document.querySelector("#export-paper");
const exportOrientation = document.querySelector("#export-orientation");
const exportDpi = document.querySelector("#export-dpi");
const exportScale = document.querySelector("#export-scale");
const exportPlotStyle = document.querySelector("#export-plot-style");
const exportHelp = document.querySelector("#export-help");
const exportSummary = document.querySelector("#export-summary");
const exportProgress = document.querySelector("#export-progress");
const exportProgressBar = document.querySelector("#export-progress-bar");
const exportProgressLabel = document.querySelector(
  "#export-progress-label",
);
const exportStart = document.querySelector("#export-start");
const exportCancel = document.querySelector("#export-cancel");
const xrefPanel = document.querySelector("#xref-panel");
const xrefSummary = document.querySelector("#xref-summary");
const xrefStatusList = document.querySelector("#xref-status-list");
const pageHeader = document.querySelector("header");
const viewerToolsTrigger = document.querySelector(
  "#viewer-tools-trigger",
);
let activeScene;
let activeInteraction;
let activeReviewTools;
let activeViewHistory;
let activeViewDocumentKey = "";
let activeTextStatus;
let activeTextComposite;
let activeImageComposite;
let activeImageAssetStore;
let activeHatchStatus;
let activeHatchWorker;
let activePrimitiveStatus;
let activePrimitiveWorker;
let activeCurveStatus;
let activeCurveWorker;
let activeCurveWorkerSource;
let curveWorkerReady = false;
let curveRequestInFlight = false;
let pendingCurveRequest;
let curveRefinementTimer;
let curveRequestRevision = 0;
const externalPrimitiveWorkers = new Set();
const externalHatchContexts = new Map();
const externalCurveContexts = new Map();
let externalCurveRequestInFlight = false;
let pendingExternalCurveRequest;
let externalCurveRefinementTimer;
let externalCurveRequestRevision = 0;
let activeMaskOrder;
let activeRenderInstanceGraph;
let activeMaskStatus;
let activeWipeoutMasksVisible = false;
let activeViewId;
let viewSwitchRevision = 0;
let activePlotStyleName = "";
let activePlotStyleEnabled = false;
let activeDocumentName = "drawing";
let activeExportController;
let nextExportSaveRequestId = 1;
const pendingExportSaves = new Map();
let previousLayerVisibility = null;
let activeLayerGroups = Object.freeze([]);
let pendingTextReveal;
let nextPlotStyleRequestId = 1;
let activeMemoryTelemetry;
let viewControlsEnabled = false;
let hatchPatternTimer;
let fontRefreshTimer;
let lastPatternCameraKey;
let patternRequestRevision = 0;
let openRevision = 0;
let sourceOpenRequestRevision = 0;
const glyphCache = new ShxGlyphCache();
const fontDiagnostics = new Map();
const pendingHostFontRequests = new Map();
const attemptedHostFontKeys = new Set();
const hostLoadedFontKeys = new Set();
const localOutlineFaces = new Map();
let activeTextStyles = Object.freeze([]);
let activeHostCacheId;
let nextHostFontRequestId = 1;
const HATCH_PATTERN_DEBOUNCE_MS = 160;
const CURVE_REFINEMENT_DEBOUNCE_MS = 80;
const CURVE_REFINEMENT_ZOOM_THRESHOLD = 4;
const vscodeApi =
  typeof globalThis.acquireVsCodeApi === "function"
    ? globalThis.acquireVsCodeApi()
    : null;
const initialWebviewState = vscodeApi?.getState?.();
let storedViewBookmarks = normalizeViewBookmarks(
  initialWebviewState &&
    typeof initialWebviewState === "object" &&
    initialWebviewState.viewBookmarks,
);
let nextViewBookmarkId = 1;
let activeMeasurementPreferences =
  initialWebviewState &&
  typeof initialWebviewState === "object" &&
  initialWebviewState.measurementPreferences
    ? initialWebviewState.measurementPreferences
    : {};
let activeViewerRuntime;
let activeRangeMetricsSource;
const externalHostSources = new Map();
const externalRangeSources = new Map();
const externalCacheData = new Map();
const externalAttachmentsByCache = new Map();
const externalMaskCounts = new Map();
const xrefDiagnostics = new Map();
const pendingImageRequests = new Map();
let nextImageRequestId = 1;
const discoveredXrefCaches = new Set();
const readyExternalMessages = new Map();
const plotStyleTables = new Map();
const plotStylePreferences = new Map();
const pendingPlotStyleRequests = new Map();
const plotStyleWaiters = new Map();
const MAX_EXTERNAL_SOURCE_OVERVIEW_BYTES = 32 * 1024 * 1024;
let externalSourceOverviewBytes = 0;
let externalLoadQueue = Promise.resolve();
const LOCAL_CACHE_FINGERPRINT_SAMPLE_BYTES = 64 * 1024;
const MAX_DWG_SESSION_READ_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

function bytesToHex(bytes) {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function localCacheSessionDigest(file) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("이 브라우저는 캐시 session fingerprint를 지원하지 않습니다.");
  }
  const sampleBytes = LOCAL_CACHE_FINGERPRINT_SAMPLE_BYTES;
  const tailOffset = Math.max(0, file.size - sampleBytes);
  const [head, tail] = await Promise.all([
    file.slice(0, Math.min(file.size, sampleBytes)).arrayBuffer(),
    file.slice(tailOffset, file.size).arrayBuffer(),
  ]);
  const metadata = new TextEncoder().encode(
    JSON.stringify([
      String(file.name ?? "").normalize("NFC").slice(0, 240),
      Number(file.size) || 0,
      Number(file.lastModified) || 0,
      file.type || "application/octet-stream",
    ]),
  );
  const fingerprint = new Uint8Array(
    metadata.byteLength + head.byteLength + tail.byteLength,
  );
  fingerprint.set(metadata);
  fingerprint.set(new Uint8Array(head), metadata.byteLength);
  fingerprint.set(
    new Uint8Array(tail),
    metadata.byteLength + head.byteLength,
  );
  return bytesToHex(
    new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", fingerprint),
    ),
  );
}

function dwgSessionReadBudget(size) {
  const multiplied =
    size <= Number.MAX_SAFE_INTEGER / 8
      ? size * 8
      : Number.MAX_SAFE_INTEGER;
  return Math.max(
    size,
    Math.min(multiplied, MAX_DWG_SESSION_READ_BUDGET_BYTES),
  );
}

function createWebviewViewerHost() {
  let disposed = false;
  return Object.freeze({
    handleEvent(event) {
      if (disposed) {
        throw new DOMException(
          "Viewer host is disposed",
          "InvalidStateError",
        );
      }
      window.dispatchEvent(
        new CustomEvent("dwg-viewer-core-event", {
          detail: event,
        }),
      );
    },
    dispose() {
      disposed = true;
    },
  });
}

function createDwgRenderSource(rangeSource, cacheSha256) {
  const scope = cacheSha256.slice(0, 24);
  const resourceBudgetBytes = dwgSessionReadBudget(rangeSource.size);
  return new DwgSceneCacheSource({
    rangeSource,
    sessionId: `session:dwg:${scope}`,
    sourceId: `source:dwg:${scope}`,
    revisionId: createSceneCacheRevisionId(cacheSha256),
    cacheSha256,
    resourceBudgetBytes,
    readBudgetBytes: resourceBudgetBytes,
  });
}

function dwgSelectionHandle(value) {
  if (typeof value === "bigint") {
    return value.toString(16).toUpperCase();
  }
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value)
    .trim()
    .replace(/^0x/iu, "")
    .slice(0, 128);
  return text || null;
}

function dwgSelectionPoint(candidate) {
  const point =
    candidate?.measurementPoint ?? candidate?.displayPoint;
  if (
    !Array.isArray(point) ||
    point.length < 2 ||
    !point.slice(0, 3).every(Number.isFinite)
  ) {
    return null;
  }
  return Object.freeze([
    point[0],
    point[1],
    Number.isFinite(point[2]) ? point[2] : 0,
  ]);
}

function projectDwgSelection(candidate) {
  const nativeHandle = dwgSelectionHandle(candidate?.handle);
  const sourceId = String(candidate?.sourceId ?? "root").slice(
    0,
    240,
  );
  const mappedRenderId =
    typeof candidate?.renderPick?.renderId === "string"
      ? candidate.renderPick.renderId.slice(0, 512)
      : null;
  return Object.freeze({
    renderId:
      mappedRenderId ||
      (nativeHandle ? `dwg:${sourceId}:${nativeHandle}` : null),
    renderRevisionId:
      typeof candidate?.renderPick?.revisionId === "string"
        ? candidate.renderPick.revisionId.slice(0, 512)
        : null,
    renderLayerId:
      typeof candidate?.renderPick?.layerId === "string"
        ? candidate.renderPick.layerId.slice(0, 512)
        : null,
    externalIdentityToken:
      typeof candidate?.renderPick?.externalIdentityToken ===
      "string"
        ? candidate.renderPick.externalIdentityToken.slice(0, 512)
        : null,
    sourceId,
    nativeReference: nativeHandle
      ? Object.freeze({
          scheme: "dwg-handle",
          value: nativeHandle,
        })
      : null,
    layerIndex: Number.isSafeInteger(candidate?.layerIndex)
      ? candidate.layerIndex
      : null,
    kind: String(
      candidate?.sourceKindName ??
        candidate?.entityType ??
        candidate?.kind ??
        "entity",
    ).slice(0, 128),
    coordinateSpace: Number.isSafeInteger(
      candidate?.coordinateSpace,
    )
      ? candidate.coordinateSpace
      : null,
    position: dwgSelectionPoint(candidate),
    approximated: Boolean(candidate?.approximated),
  });
}

function saveMeasurementPreferences(preferences) {
  activeMeasurementPreferences = preferences;
  if (!vscodeApi?.setState) {
    return;
  }
  const current = vscodeApi.getState?.();
  vscodeApi.setState({
    ...(current && typeof current === "object" ? current : {}),
    measurementPreferences: preferences,
  });
}

function saveStoredViewBookmarks(bookmarks) {
  storedViewBookmarks = normalizeViewBookmarks(bookmarks);
  if (!vscodeApi?.setState) {
    return;
  }
  const current = vscodeApi.getState?.();
  vscodeApi.setState({
    ...(current && typeof current === "object" ? current : {}),
    viewBookmarks: storedViewBookmarks,
  });
}

function activeViewBookmarkScope() {
  if (!activeViewDocumentKey || !activeViewId) {
    return "";
  }
  return (
    `${activeViewDocumentKey.slice(0, 160)}::` +
    String(activeViewId).slice(0, 90)
  );
}

function currentViewBookmarks() {
  const scope = activeViewBookmarkScope();
  if (!scope) {
    return [];
  }
  return storedViewBookmarks
    .filter((bookmark) => bookmark.scope === scope)
    .sort((left, right) => right.createdAt - left.createdAt);
}

function currentViewLabel() {
  return (
    activeScene?.views.find(({ id }) => id === activeViewId)?.label ??
    "현재 화면"
  );
}

function nextAutomaticBookmarkName(bookmarks) {
  const names = new Set(bookmarks.map(({ name }) => name));
  for (let index = 1; index <= MAXIMUM_BOOKMARKS_PER_SCOPE + 1; index += 1) {
    const candidate = `화면 ${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  return `화면 ${bookmarks.length + 1}`;
}

function createViewBookmarkId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return randomId;
  }
  const id = `view-${Date.now().toString(36)}-${nextViewBookmarkId.toString(36)}`;
  nextViewBookmarkId += 1;
  return id;
}

function renderViewBookmarks() {
  const bookmarks = currentViewBookmarks();
  const scope = activeViewBookmarkScope();
  viewBookmarkList.replaceChildren();
  viewBookmarkSummary.textContent = scope
    ? `${currentViewLabel()} · ${bookmarks.length.toLocaleString()}개`
    : "";
  viewBookmarkEmpty.hidden = bookmarks.length > 0;
  const saveButton = viewBookmarkForm.querySelector("button[type='submit']");
  if (saveButton) {
    saveButton.disabled =
      !scope ||
      !activeInteraction ||
      bookmarks.length >= MAXIMUM_BOOKMARKS_PER_SCOPE;
  }
  const fragment = document.createDocumentFragment();
  for (const bookmark of bookmarks) {
    const item = document.createElement("li");
    const input = document.createElement("input");
    const open = document.createElement("button");
    const remove = document.createElement("button");
    item.className = "view-bookmark-item";
    item.dataset.bookmarkId = bookmark.id;
    input.type = "text";
    input.maxLength = 64;
    input.value = bookmark.name;
    input.title = "이름을 수정한 뒤 Enter 또는 바깥을 선택하면 저장됩니다.";
    input.setAttribute("aria-label", `${bookmark.name} 북마크 이름`);
    const saveName = () => {
      if (input.value.trim() === bookmark.name) {
        input.value = bookmark.name;
        return;
      }
      try {
        saveStoredViewBookmarks(
          renameViewBookmark(
            storedViewBookmarks,
            bookmark.id,
            input.value,
          ),
        );
        const renamed = storedViewBookmarks.find(
          ({ id }) => id === bookmark.id,
        );
        input.value = renamed?.name ?? bookmark.name;
        input.setAttribute(
          "aria-label",
          `${input.value} 북마크 이름`,
        );
        status.textContent = "화면 북마크 이름을 변경했습니다.";
      } catch {
        input.value = bookmark.name;
        status.textContent = "북마크 이름은 한 글자 이상 입력하세요.";
      }
    };
    input.addEventListener("blur", saveName);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = bookmark.name;
        input.blur();
      }
    });
    open.type = "button";
    open.dataset.bookmarkAction = "open";
    open.textContent = "이동";
    open.title = `${bookmark.name} 화면으로 이동`;
    open.addEventListener("click", () => {
      if (!activeInteraction || bookmark.scope !== activeViewBookmarkScope()) {
        return;
      }
      activeInteraction.flushViewCommit();
      activeInteraction.focusAt(
        bookmark.view.origin,
        bookmark.view.worldHeight,
      );
      status.textContent = `${bookmark.name} 북마크 화면으로 이동했습니다.`;
    });
    remove.type = "button";
    remove.dataset.bookmarkAction = "delete";
    remove.textContent = "삭제";
    remove.title = `${bookmark.name} 북마크 삭제`;
    remove.addEventListener("click", () => {
      saveStoredViewBookmarks(
        removeViewBookmark(storedViewBookmarks, bookmark.id),
      );
      renderViewBookmarks();
      status.textContent = `${bookmark.name} 북마크를 삭제했습니다.`;
    });
    item.append(input, open, remove);
    fragment.append(item);
  }
  viewBookmarkList.append(fragment);
}

function setViewBookmarkPanelOpen(open) {
  const next = Boolean(open) && Boolean(activeInteraction);
  viewBookmarkPanel.hidden = !next;
  viewBookmarksToggle.setAttribute("aria-expanded", String(next));
  if (next) {
    setViewerToolsOpen(false);
    reviewResult.hidden = true;
    renderViewBookmarks();
    viewBookmarkName.focus();
  }
}

function updateViewNavigationControls() {
  const ready = viewControlsEnabled && Boolean(activeInteraction);
  windowZoomButton.disabled = !ready;
  windowZoomButton.setAttribute(
    "aria-pressed",
    String(Boolean(activeInteraction?.windowZoomEnabled)),
  );
  viewHistoryBack.disabled = !ready || !activeViewHistory?.canBack;
  viewHistoryForward.disabled =
    !ready || !activeViewHistory?.canForward;
  viewBookmarksToggle.disabled = !ready;
  if (!ready) {
    setViewBookmarkPanelOpen(false);
  }
}

function navigateViewHistory(direction) {
  if (!activeInteraction || !activeViewHistory) {
    return false;
  }
  activeInteraction.flushViewCommit();
  const view =
    direction === "back"
      ? activeViewHistory.back()
      : activeViewHistory.forward();
  if (!view) {
    updateViewNavigationControls();
    return false;
  }
  activeInteraction.restoreView(view);
  updateViewNavigationControls();
  status.textContent =
    direction === "back"
      ? "이전 화면으로 이동했습니다."
      : "다음 화면으로 이동했습니다.";
  return true;
}

function handleWindowZoomModeChange(enabled, reason) {
  updateViewNavigationControls();
  if (enabled) {
    setViewBookmarkPanelOpen(false);
    status.textContent =
      "확대할 영역의 한쪽 모서리에서 반대쪽 모서리까지 드래그하세요. Esc로 취소합니다.";
  } else if (reason === "completed") {
    status.textContent = "선택한 영역을 화면에 맞춰 확대했습니다.";
  } else if (reason === "too-small") {
    status.textContent =
      "영역이 너무 작아 확대하지 않았습니다. 다시 영역 확대를 선택하세요.";
  } else if (reason === "cancelled") {
    status.textContent = "영역 확대를 취소했습니다.";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function displayFontName(value) {
  if (typeof value !== "string") {
    return "(이름 없음)";
  }
  return value.split(/[\\/]/).at(-1)?.slice(0, 120) || "(이름 없음)";
}

function normalizePlotStyleName(value) {
  if (typeof value !== "string") {
    return "";
  }
  const name = value
    .trim()
    .replace(/^["']|["']$/gu, "")
    .split(/[\\/]/u)
    .at(-1)
    ?.trim();
  return name?.toLocaleLowerCase("en-US").endsWith(".ctb")
    ? name.normalize("NFC").toLocaleLowerCase("en-US")
    : "";
}

function resetPlotStyleSession() {
  activePlotStyleName = "";
  activePlotStyleEnabled = false;
  plotStyleTables.clear();
  plotStylePreferences.clear();
  pendingPlotStyleRequests.clear();
  for (const waiters of plotStyleWaiters.values()) {
    for (const resolve of waiters) {
      resolve(null);
    }
  }
  plotStyleWaiters.clear();
  plotStyleToggle.disabled = true;
  setViewerToolMessage(plotStyleToggle, "toolbar.plotStyle");
  plotStyleToggle.setAttribute("aria-pressed", "false");
  plotStyleToggle.title = t("toolbar.plotStyle.title");
}

function setPlotStyleUnavailable(name, state) {
  const messageKey =
    {
      ambiguous: "toolbar.plotStyle.unavailable.ambiguous",
      invalid: "toolbar.plotStyle.unavailable.invalid",
      missing: "toolbar.plotStyle.unavailable.missing",
      unavailable: "toolbar.plotStyle.unavailable.unavailable",
    }[state] ?? "toolbar.plotStyle.unavailable.fallback";
  const label = t(messageKey);
  const canSelect =
    Boolean(vscodeApi) &&
    Boolean(activeHostCacheId) &&
    Boolean(activePlotStyleName) &&
    ["ambiguous", "missing"].includes(state);
  plotStyleToggle.disabled = !canSelect;
  setViewerToolMessage(
    plotStyleToggle,
    canSelect ? "toolbar.plotStyle.select" : "toolbar.plotStyle.none",
  );
  plotStyleToggle.setAttribute("aria-pressed", "false");
  plotStyleToggle.title = `${name} · ${label}${
    canSelect ? t("toolbar.plotStyle.selectHint") : ""
  }`;
}

function clearPlotStyleForView(scene) {
  scene.renderer.clearPlotStyle();
  activeTextComposite?.setPalette(scene.renderer.aciPalette);
}

function applyPlotStyleEntry(scene, key, entry, enabled) {
  if (activeScene !== scene || entry?.status !== "loaded") {
    return;
  }
  try {
    if (enabled) {
      const palette = makePlotStylePalette(entry.table);
      scene.renderer.setPlotStyle(
        palette,
        makePlotStyleLineWeights(entry.table),
      );
      activeTextComposite?.setPalette(palette);
    } else {
      clearPlotStyleForView(scene);
    }
    activePlotStyleName = key;
    activePlotStyleEnabled = enabled;
    plotStylePreferences.set(key, enabled);
    plotStyleToggle.disabled = false;
    setViewerToolMessage(
      plotStyleToggle,
      enabled ? "toolbar.plotStyle.on" : "toolbar.plotStyle.off",
    );
    plotStyleToggle.setAttribute("aria-pressed", String(enabled));
    const details = plotStyleDiagnostics(entry.table);
    plotStyleToggle.title = t("toolbar.plotStyle.details", {
      name: entry.resolvedName || entry.requestedName || key,
      colors: i18n.formatNumber(details.colorOverrides),
      weights: i18n.formatNumber(details.lineWeightOverrides),
    });
    activeInteraction?.refresh();
  } catch (error) {
    console.error(error);
    setPlotStyleUnavailable(key, "invalid");
  }
}

function configurePlotStyleForView(scene, view, revision) {
  clearPlotStyleForView(scene);
  activePlotStyleName = "";
  activePlotStyleEnabled = false;
  plotStyleToggle.setAttribute("aria-pressed", "false");
  if (view?.kind !== "layout") {
    plotStyleToggle.disabled = true;
    setViewerToolMessage(plotStyleToggle, "toolbar.plotStyle");
    plotStyleToggle.title = t("toolbar.plotStyle.modelTitle");
    return;
  }
  const requestedName = view.layout?.styleSheet ?? "";
  const key = normalizePlotStyleName(requestedName);
  if (!key) {
    setPlotStyleUnavailable("이 배치", "missing");
    return;
  }
  activePlotStyleName = key;
  activePlotStyleEnabled =
    plotStylePreferences.get(key) ??
    plotStyleShownInLayout(view.layout);
  const cached = plotStyleTables.get(key);
  if (cached?.status === "loaded") {
    applyPlotStyleEntry(
      scene,
      key,
      cached,
      activePlotStyleEnabled,
    );
    return;
  }
  if (cached) {
    setPlotStyleUnavailable(requestedName, cached.status);
    return;
  }
  if (!vscodeApi || !activeHostCacheId) {
    setPlotStyleUnavailable(requestedName, "unavailable");
    return;
  }
  const alreadyPending = [...pendingPlotStyleRequests.values()].some(
    (request) =>
      request.cacheId === activeHostCacheId && request.key === key,
  );
  plotStyleToggle.disabled = true;
  setViewerToolMessage(plotStyleToggle, "toolbar.plotStyle.searching");
  plotStyleToggle.title = t("toolbar.plotStyle.searchingTitle", {
    name: requestedName,
  });
  if (alreadyPending) {
    return;
  }
  const requestId = nextPlotStyleRequestId++;
  pendingPlotStyleRequests.set(requestId, {
    cacheId: activeHostCacheId,
    key,
    requestedName,
    revision,
  });
  vscodeApi.postMessage({
    type: "dwg-plot-style-read/1",
    cacheId: activeHostCacheId,
    requestId,
    name: requestedName,
  });
}

function handleHostPlotStyleResponse(message) {
  const pending = pendingPlotStyleRequests.get(message?.requestId);
  if (
    !pending ||
    pending.cacheId !== activeHostCacheId ||
    message.cacheId !== activeHostCacheId
  ) {
    return;
  }
  pendingPlotStyleRequests.delete(message.requestId);
  const statusValue = ["loaded", "missing", "ambiguous", "invalid"].includes(
    message.status,
  )
    ? message.status
    : "invalid";
  const entry = Object.freeze({
    status: statusValue,
    requestedName: pending.requestedName,
    resolvedName:
      typeof message.resolvedName === "string"
        ? message.resolvedName.slice(0, 512)
        : "",
    table: message.table,
  });
  plotStyleTables.set(pending.key, entry);
  const waiters = plotStyleWaiters.get(pending.key);
  if (waiters) {
    plotStyleWaiters.delete(pending.key);
    for (const resolve of waiters) {
      resolve(entry);
    }
  }
  if (
    pending.revision !== openRevision ||
    activePlotStyleName !== pending.key ||
    !activeScene
  ) {
    return;
  }
  if (entry.status === "loaded") {
    applyPlotStyleEntry(
      activeScene,
      pending.key,
      entry,
      activePlotStyleEnabled,
    );
  } else {
    setPlotStyleUnavailable(pending.requestedName, entry.status);
  }
}

function abortError() {
  return new DOMException("Export cancelled", "AbortError");
}

function throwIfExportCancelled(signal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

function activeViewDescriptor() {
  return (
    activeScene?.views.find((view) => view.id === activeViewId) ??
    activeScene?.activeView ??
    null
  );
}

function waitForPlotStyleEntry(view, signal, timeoutMs = 5_000) {
  const key = normalizePlotStyleName(view?.layout?.styleSheet ?? "");
  if (!key) {
    return Promise.resolve(null);
  }
  const cached = plotStyleTables.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  if (!vscodeApi || !activeHostCacheId) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const waiters = plotStyleWaiters.get(key) ?? new Set();
    const finish = (entry) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waiters.delete(finish);
      if (waiters.size === 0 && plotStyleWaiters.get(key) === waiters) {
        plotStyleWaiters.delete(key);
      }
      resolve(entry);
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      waiters.delete(finish);
      if (waiters.size === 0 && plotStyleWaiters.get(key) === waiters) {
        plotStyleWaiters.delete(key);
      }
      reject(abortError());
    };
    waiters.add(finish);
    plotStyleWaiters.set(key, waiters);
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

function exportViewsForTarget(target) {
  const current = activeViewDescriptor();
  if (!current || !activeScene) {
    return [];
  }
  if (target !== "layouts") {
    return [current];
  }
  const layouts = activeScene.views.filter(
    (view) => view.kind === "layout",
  );
  return layouts.length > 0 ? layouts : [current];
}

function exportSettingsFromForm() {
  return Object.freeze({
    target: exportTarget.value,
    format: exportFormat.value,
    paper: exportPaper.value,
    orientation: exportOrientation.value,
    dpi: Number(exportDpi.value),
    scale: exportScale.value,
    plotStyle: exportPlotStyle.checked,
  });
}

function pageGeometryFor(view, settings) {
  const screenAspect = Math.max(canvas.width, 1) / Math.max(canvas.height, 1);
  return resolvePageGeometry({
    layout: view?.kind === "layout" ? view.layout : null,
    paper: settings.target === "screen" ? "screen" : settings.paper,
    orientation:
      settings.target === "screen" ? "drawing" : settings.orientation,
    screenAspect,
  });
}

function exportCameraForView(view, page, pixels, settings) {
  if (settings.target === "screen") {
    return activeInteraction.snapshot().camera;
  }
  const aspect = pixels.width / pixels.height;
  const bounds =
    view.preferredBounds ??
    activeScene.renderer.combinedBounds ??
    activeScene.renderer.overviewScene?.fitBounds;
  if (!bounds) {
    throw new Error(`${view.label}의 출력 범위를 확인할 수 없습니다.`);
  }
  if (
    settings.scale === "drawing" &&
    view.kind === "model" &&
    view.preferredView &&
    settings.orientation === "drawing" &&
    settings.paper === "drawing"
  ) {
    return Object.freeze({
      origin: Object.freeze([...view.preferredView.center]),
      worldHeight: view.preferredView.height,
    });
  }
  if (settings.scale === "fit" || settings.scale === "drawing") {
    return fitCameraView(bounds, aspect);
  }
  const denominator = Number(settings.scale);
  const center = view.preferredView?.center ?? [
    bounds.min[0] * 0.5 + bounds.max[0] * 0.5,
    bounds.min[1] * 0.5 + bounds.max[1] * 0.5,
    0,
  ];
  const measurement = createMeasurementFormat(
    activeScene.metadata.drawing.insertionUnits,
    activeMeasurementPreferences,
  );
  if (!measurement.canUsePhysicalUnits) {
    throw new Error(
      "단위 없는 도면에서 1:N 축척을 사용하려면 측정 설정에서 실제 길이로 단위를 먼저 보정하세요.",
    );
  }
  return scaleCameraView(
    center,
    page.heightMm,
    denominator,
    1 / measurement.millimetersPerDrawingUnit,
  );
}

function setExportProgress(current, total, message) {
  exportProgress.hidden = false;
  exportProgressBar.max = Math.max(total, 1);
  exportProgressBar.value = Math.min(current, total);
  exportProgressLabel.textContent = message;
}

function setExportBusy(busy) {
  const controls = [
    exportTarget,
    exportFormat,
    exportPaper,
    exportOrientation,
    exportDpi,
    exportScale,
    exportPlotStyle,
    exportStart,
  ];
  for (const control of controls) {
    control.disabled = Boolean(busy);
  }
  exportCancel.hidden = !busy;
  exportToggle.disabled = Boolean(busy) || !viewControlsEnabled;
  exportPanel.setAttribute("aria-busy", String(Boolean(busy)));
  dropZone.classList.toggle("export-busy", Boolean(busy));
  for (const button of layoutTabs.querySelectorAll("button")) {
    button.disabled = Boolean(busy);
  }
  if (!busy) {
    updateExportOptions();
  }
}

function updateExportOptions() {
  const current = activeViewDescriptor();
  const settings = exportSettingsFromForm();
  const layouts = activeScene?.views.filter(
    (view) => view.kind === "layout",
  ) ?? [];
  const allLayoutsOption = exportTarget.querySelector(
    'option[value="layouts"]',
  );
  if (allLayoutsOption) {
    allLayoutsOption.disabled = layouts.length === 0;
  }
  if (settings.target === "layouts" && layouts.length === 0) {
    exportTarget.value = "view";
  }
  const screen = exportTarget.value === "screen";
  exportPaper.disabled = screen;
  exportOrientation.disabled = screen;
  exportDpi.disabled = screen;
  exportScale.disabled = screen;
  if (!current) {
    exportSummary.textContent = "";
    exportHelp.textContent = "도면을 연 뒤 출력할 수 있습니다.";
    return;
  }
  const page = pageGeometryFor(current, {
    ...settings,
    target: exportTarget.value,
  });
  const formatLabel =
    exportFormat.value === "pdf"
      ? "PDF"
      : exportTarget.value === "layouts"
        ? "PNG ZIP"
        : "PNG";
  exportSummary.textContent =
    `${formatLabel} · ${Number(page.widthMm.toFixed(1))} × ` +
    `${Number(page.heightMm.toFixed(1))} mm`;
  const numericScale = Number(exportScale.value);
  if (Number.isFinite(numericScale) && numericScale > 0) {
    const measurement = createMeasurementFormat(
      activeScene.metadata.drawing.insertionUnits,
      activeMeasurementPreferences,
    );
    exportHelp.textContent = measurement.canUsePhysicalUnits
      ? `DWG 단위 또는 측정 보정값을 기준으로 1:${numericScale} 축척을 적용합니다.`
      : "단위 없는 도면입니다. 1:N 축척을 쓰려면 측정 설정에서 실제 길이로 단위를 먼저 보정하세요.";
    return;
  }
  exportHelp.textContent = screen
    ? "도면 UI와 검토 가이드는 제외하고 현재 보이는 도면 화면만 저장합니다."
    : page.source === "drawing"
      ? `${page.label} 용지 정보를 사용합니다. 각 배치는 서로 다른 용지 크기를 유지할 수 있습니다.`
      : "도면에 유효한 용지 값이 없거나 용지를 직접 선택해 선택한 크기로 출력합니다.";
}

function setExportPanelOpen(open) {
  const next = Boolean(open) && Boolean(activeScene);
  exportPanel.hidden = !next;
  exportToggle.setAttribute("aria-expanded", String(next));
  if (next) {
    setViewerToolsOpen(true);
    layerPanel.hidden = true;
    layersToggle.setAttribute("aria-expanded", "false");
    fontPanel.hidden = true;
    fontsToggle.setAttribute("aria-expanded", "false");
    xrefPanel.hidden = true;
    xrefsToggle.setAttribute("aria-expanded", "false");
    updateExportOptions();
  }
}

function canvasToBytes(canvasElement, type, quality, signal) {
  throwIfExportCancelled(signal);
  return new Promise((resolve, reject) => {
    canvasElement.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("출력 이미지를 인코딩하지 못했습니다."));
          return;
        }
        try {
          throwIfExportCancelled(signal);
          resolve(new Uint8Array(await blob.arrayBuffer()));
        } catch (error) {
          reject(error);
        }
      },
      type,
      quality,
    );
  });
}

async function captureExportPage(
  view,
  page,
  pixels,
  settings,
  signal,
  warnings,
) {
  throwIfExportCancelled(signal);
  const renderer = activeScene.renderer;
  const returnCamera = activeInteraction.snapshot().camera;
  const palette = new Uint8Array(renderer.aciPalette);
  const lineWeights = new Int16Array(renderer.plotStyleLineWeights);
  const plotStylesEnabled = renderer.plotStylesEnabled;
  const lineWeightsVisible = renderer.lineWeightsVisible;
  let plotStyleEntry = null;
  let appliedPlotStyle = false;
  if (settings.plotStyle && view.kind === "layout") {
    plotStyleEntry = await waitForPlotStyleEntry(view, signal);
  }
  throwIfExportCancelled(signal);
  try {
    if (settings.plotStyle && plotStyleEntry?.status === "loaded") {
      renderer.setPlotStyle(
        makePlotStylePalette(plotStyleEntry.table),
        makePlotStyleLineWeights(plotStyleEntry.table),
      );
      activeTextComposite?.setPalette(renderer.aciPalette);
      renderer.setLineWeightsVisible(true);
      appliedPlotStyle = true;
    } else if (settings.plotStyle && view.kind === "layout") {
      const requested = view.layout?.styleSheet?.trim();
      if (requested) {
        warnings.add(`${view.label}: ${requested} CTB를 적용하지 못함`);
      }
      renderer.clearPlotStyle();
      activeTextComposite?.setPalette(renderer.aciPalette);
    } else if (!settings.plotStyle) {
      renderer.clearPlotStyle();
      activeTextComposite?.setPalette(renderer.aciPalette);
    }
    const camera = exportCameraForView(view, page, pixels, settings);
    const background =
      settings.target === "screen" && !appliedPlotStyle
        ? getComputedStyle(dropZone).backgroundColor || "#0e1013"
        : "#ffffff";
    return renderer.captureRaster(camera, {
      width: pixels.width,
      height: pixels.height,
      background,
    }).canvas;
  } finally {
    renderer.setLineWeightsVisible(lineWeightsVisible);
    if (plotStylesEnabled) {
      renderer.setPlotStyle(palette, lineWeights);
    } else {
      renderer.clearPlotStyle();
    }
    activeTextComposite?.setPalette(renderer.aciPalette);
    renderer.redraw(returnCamera);
  }
}

function triggerStandaloneDownload(bytes, fileName, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function saveExportBytes(bytes, format, suggestedName) {
  const extension = format;
  const fileName = `${sanitizeExportStem(suggestedName)}.${extension}`;
  if (!vscodeApi) {
    triggerStandaloneDownload(
      bytes,
      fileName,
      format === "pdf"
        ? "application/pdf"
        : format === "png"
          ? "image/png"
          : "application/zip",
    );
    return Promise.resolve({ status: "saved", bytes: bytes.length });
  }
  const requestId = nextExportSaveRequestId++;
  return new Promise((resolve, reject) => {
    pendingExportSaves.set(requestId, { resolve, reject });
    vscodeApi.postMessage({
      type: "dwg-export-save/1",
      requestId,
      format,
      suggestedName,
      data: bytesToBase64(bytes),
    });
  });
}

async function restoreViewAfterExport({
  scene,
  view,
  camera: viewCamera,
  history,
  reviewTool,
  revision,
}) {
  if (
    activeScene !== scene ||
    revision !== openRevision ||
    !view
  ) {
    return;
  }
  if (activeViewId !== view.id) {
    await activateView(
      scene,
      view,
      activeRangeMetricsSource,
      revision,
      { awaitReady: true },
    );
  }
  activeInteraction?.restoreView(viewCamera);
  activeViewHistory = history;
  updateViewNavigationControls();
  if (reviewTool && activeReviewTools && !activeReviewTools.activeTool) {
    activeReviewTools.activate(reviewTool);
  }
  configurePlotStyleForView(scene, view, revision);
  activeInteraction?.refresh();
}

async function performDrawingExport(settings, signal) {
  if (!activeScene || !activeInteraction) {
    throw new Error("출력할 도면이 열려 있지 않습니다.");
  }
  const scene = activeScene;
  const revision = openRevision;
  const originalView = activeViewDescriptor();
  const originalState = {
    scene,
    view: originalView,
    camera: activeInteraction.snapshot().camera,
    history: activeViewHistory,
    reviewTool: activeReviewTools?.activeTool ?? null,
    revision,
  };
  const views = exportViewsForTarget(settings.target);
  if (views.length === 0) {
    throw new Error("출력할 모델 또는 배치가 없습니다.");
  }
  const encodedPages = [];
  const warnings = new Set();
  let encodedBytes = 0;
  const maximumTotalPixels = 60_000_000;
  try {
    for (let index = 0; index < views.length; index += 1) {
      throwIfExportCancelled(signal);
      const view = views[index];
      setExportProgress(
        index,
        views.length,
        `${view.label} 화면 구성 중`,
      );
      if (activeViewId !== view.id) {
        const activated = await activateView(
          scene,
          view,
          activeRangeMetricsSource,
          revision,
          { awaitReady: true },
        );
        if (!activated) {
          throw new Error(`${view.label} 배치를 구성하지 못했습니다.`);
        }
      }
      throwIfExportCancelled(signal);
      const page = pageGeometryFor(view, settings);
      const rendererMaximum = scene.renderer.maximumRasterSize();
      const pixels =
        settings.target === "screen"
          ? Object.freeze({
              width: Math.max(1, canvas.width),
              height: Math.max(1, canvas.height),
              requestedWidth: Math.max(1, canvas.width),
              requestedHeight: Math.max(1, canvas.height),
              requestedDpi: 0,
              effectiveDpi: 0,
              limited: false,
            })
          : pixelsForPage(page, settings.dpi, {
              maximumPixels: Math.min(
                12_000_000,
                Math.max(
                  1_000_000,
                  Math.floor(maximumTotalPixels / views.length),
                ),
              ),
              maximumEdge: Math.min(
                8_192,
                rendererMaximum.width,
                rendererMaximum.height,
              ),
            });
      if (pixels.limited) {
        warnings.add(
          `${view.label}: 장치 한도에 맞춰 ${pixels.effectiveDpi.toFixed(
            0,
          )} DPI로 조정`,
        );
      }
      setExportProgress(
        index,
        views.length,
        `${view.label} ${pixels.width.toLocaleString()} × ${pixels.height.toLocaleString()} 렌더링 중`,
      );
      const outputCanvas = await captureExportPage(
        view,
        page,
        pixels,
        settings,
        signal,
        warnings,
      );
      throwIfExportCancelled(signal);
      const imageBytes = await canvasToBytes(
        outputCanvas,
        settings.format === "pdf" ? "image/jpeg" : "image/png",
        settings.format === "pdf" ? 0.92 : undefined,
        signal,
      );
      outputCanvas.width = 1;
      outputCanvas.height = 1;
      encodedBytes += imageBytes.length;
      if (encodedBytes > 64 * 1024 * 1024) {
        throw new Error("출력 결과가 64 MiB 안전 한도를 초과했습니다.");
      }
      encodedPages.push(
        Object.freeze({
          view,
          page,
          pixels,
          bytes: imageBytes,
        }),
      );
      setExportProgress(
        index + 1,
        views.length,
        `${view.label} 준비 완료`,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    await restoreViewAfterExport(originalState);
  }
  throwIfExportCancelled(signal);

  let bytes;
  let outputFormat;
  if (settings.format === "pdf") {
    bytes = makeRasterPdf(
      encodedPages.map(({ page, pixels, bytes: jpeg }) => ({
        jpeg,
        pixelWidth: pixels.width,
        pixelHeight: pixels.height,
        widthMm: page.widthMm,
        heightMm: page.heightMm,
      })),
    );
    outputFormat = "pdf";
  } else if (settings.target === "layouts") {
    bytes = makeStoredZip(
      makeLayoutPngZipEntries(
        encodedPages.map(({ view, bytes: data }) => ({
          label: view.label,
          data,
        })),
      ),
    );
    outputFormat = "zip";
  } else {
    bytes = encodedPages[0].bytes;
    outputFormat = "png";
  }
  const base = sanitizeExportStem(activeDocumentName);
  const suffix =
    settings.target === "screen"
      ? "screen"
      : settings.target === "layouts"
        ? "layouts"
        : sanitizeExportStem(originalView?.label, "view");
  setExportProgress(
    views.length,
    views.length,
    "저장 위치를 선택하세요",
  );
  exportCancel.hidden = true;
  const result = await saveExportBytes(
    bytes,
    outputFormat,
    `${base}-${suffix}`,
  );
  return Object.freeze({
    ...result,
    warnings: Object.freeze([...warnings]),
    pages: encodedPages.length,
    bytes: bytes.length,
  });
}

async function startDrawingExport() {
  if (activeExportController) {
    return;
  }
  const controller = new AbortController();
  activeExportController = controller;
  const settings = exportSettingsFromForm();
  setExportBusy(true);
  setExportProgress(0, 1, "출력을 준비하는 중");
  status.textContent = "도면 출력 준비 중";
  try {
    const result = await performDrawingExport(
      settings,
      controller.signal,
    );
    const warning =
      result.warnings.length > 0
        ? ` · 주의 ${result.warnings.join(" · ")}`
        : "";
    status.textContent =
      `${result.pages.toLocaleString()}페이지 · ${formatBytes(
        result.bytes,
      )} 저장 완료${warning}`;
    exportProgressLabel.textContent = "파일 저장 완료";
  } catch (error) {
    if (error?.name === "AbortError") {
      status.textContent = "도면 출력을 취소했습니다.";
      exportProgressLabel.textContent = "출력 취소됨";
    } else {
      const message =
        error instanceof Error ? error.message : String(error);
      status.textContent = `도면 출력 실패: ${message}`;
      exportProgressLabel.textContent = message;
      console.error(error);
    }
  } finally {
    if (activeExportController === controller) {
      activeExportController = undefined;
    }
    setExportBusy(false);
  }
}

function requiredFonts(styles) {
  const required = new Map();
  for (const style of styles) {
    for (const [name, isBigFont] of [
      [style.fontFile, false],
      [style.bigFontFile, true],
    ]) {
      const outline = !isBigFont && isOutlineFontReference(name);
      const shx = isShxFontReference(name, { bigFont: isBigFont });
      if (!outline && !shx) {
        continue;
      }
      const key = normalizeShxFontName(name);
      if (!key) {
        continue;
      }
      const existing = required.get(key);
      if (!existing) {
        required.set(key, {
          key,
          name,
          displayName: displayFontName(name),
          isBigFont,
          kind: outline ? "outline" : "shx",
        });
      } else if (isBigFont && !existing.isBigFont) {
        required.set(key, {
          ...existing,
          isBigFont: true,
          kind: "shx",
        });
      }
    }
  }
  return required;
}

function mergeTextStyles(...styleGroups) {
  const merged = new Map();
  for (const styles of styleGroups) {
    for (const style of styles) {
      const key = [
        normalizeShxFontName(style?.fontFile),
        normalizeShxFontName(style?.bigFontFile),
        normalizeShxFontName(style?.trueTypeFont),
      ].join("\u0000");
      if (!merged.has(key)) {
        merged.set(key, style);
      }
    }
  }
  return Object.freeze([...merged.values()]);
}

function fontStateLabel(state) {
  return (
    {
      loaded: "연결됨",
      mapped: "대체됨",
      loading: "찾는 중",
      missing: "누락",
      ambiguous: "선택 필요",
      invalid: "손상",
      unreadable: "읽기 실패",
      "too-large": "크기 초과",
      "budget-exceeded": "한도 초과",
    }[state] ?? "확인 중"
  );
}

function bigFontEncodingLabel(encoding) {
  return (
    {
      auto: "자동(EUC-KR → CP949 → Johab)",
      "euc-kr": "EUC-KR",
      cp949: "CP949/UHC",
      johab: "Johab/CP1361",
    }[encoding] ?? "자동"
  );
}

function renderFontDiagnostics() {
  const entries = [...fontDiagnostics.values()];
  const ready = entries.filter(({ state }) =>
    ["loaded", "mapped"].includes(state),
  ).length;
  const loading = entries.filter(({ state }) => state === "loading").length;
  const failures = entries.length - ready - loading;
  fontSummary.textContent =
    entries.length === 0
      ? "요구 글꼴 없음"
      : `${ready.toLocaleString()} / ${entries.length.toLocaleString()} 연결`;
  setViewerToolMessage(
    fontsToggle,
    failures > 0 ? "toolbar.fontsWithIssues" : "toolbar.fonts",
    { count: i18n.formatNumber(failures) },
  );
  fontStatusList.replaceChildren();

  if (entries.length === 0) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "font-name";
    name.textContent = "도면이 참조하는 SHX·BigFont가 없습니다.";
    item.append(name);
    fontStatusList.append(item);
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "ko"),
  );
  for (const entry of entries) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const state = document.createElement("span");
    name.className = "font-name";
    name.title = entry.name;
    name.textContent = entry.displayName;
    state.className = "font-state";
    state.dataset.state = entry.state;
    state.textContent = fontStateLabel(entry.state);
    item.append(name, state);
    const resolution =
      entry.state === "mapped"
        ? `${displayFontName(entry.resolvedName)} 파일로 대체`
        : entry.state === "loaded" && entry.size
          ? `${entry.source === "drawing" ? "도면 폴더" : entry.source === "project" ? "프로젝트 폴더" : entry.source === "configured" ? "등록 폴더" : "현재 세션"} · ${formatBytes(entry.size)}`
          : entry.error;
    const detailText = [
      resolution,
      entry.isBigFont
        ? `문자 코드: ${bigFontEncodingLabel(entry.encoding)}`
        : entry.kind === "outline"
          ? "TrueType/OpenType"
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (detailText) {
      const detail = document.createElement("span");
      detail.className = "font-resolution";
      detail.textContent = detailText;
      item.append(detail);
    }
    if (
      vscodeApi &&
      ["missing", "ambiguous", "invalid", "unreadable"].includes(
        entry.state,
      )
    ) {
      const select = document.createElement("button");
      select.type = "button";
      select.className = "xref-select";
      select.textContent = "글꼴 파일 직접 선택";
      select.addEventListener("click", () => {
        select.disabled = true;
        fontPanelHelp.textContent =
          `${entry.displayName}에 적용할 글꼴 파일을 선택하세요.`;
        vscodeApi.postMessage({
          type: "dwg-font-file-select/1",
          cacheId: activeHostCacheId,
          name: entry.name,
          kind: entry.kind,
        });
      });
      item.append(select);
    }
    fragment.append(item);
  }
  fontStatusList.append(fragment);
}

function xrefStateLabel(state) {
  return (
    {
      waiting: "대기",
      searching: "찾는 중",
      converting: "변환 중",
      decoding: "표시 준비",
      ready: "연결됨",
      missing: "누락",
      ambiguous: "선택 필요",
      cycle: "순환 참조",
      limit: "한도",
      unsupported: "미지원",
      error: "오류",
    }[state] ?? "확인 중"
  );
}

function renderXrefDiagnostics() {
  const entries = [...xrefDiagnostics.values()];
  const ready = entries.filter((entry) => entry.status === "ready").length;
  const unresolved = entries.filter((entry) =>
    [
      "missing",
      "ambiguous",
      "cycle",
      "limit",
      "unsupported",
      "error",
    ].includes(
      entry.status,
    ),
  ).length;
  xrefSummary.textContent =
    entries.length === 0
      ? "참조 없음"
      : `${ready.toLocaleString()} / ${entries.length.toLocaleString()} 연결`;
  setViewerToolMessage(
    xrefsToggle,
    unresolved > 0 ? "toolbar.xrefsWithIssues" : "toolbar.xrefs",
    { count: i18n.formatNumber(unresolved) },
  );
  xrefsToggle.disabled = entries.length === 0;
  xrefStatusList.replaceChildren();
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.textContent = "이 도면에는 외부 도면이나 이미지 참조가 없습니다.";
    xrefStatusList.append(item);
    return;
  }
  entries.sort(
    (left, right) =>
      (left.depth ?? 0) - (right.depth ?? 0) ||
      String(left.kind ?? "xref").localeCompare(
        String(right.kind ?? "xref"),
      ) ||
      left.name.localeCompare(right.name, "ko"),
  );
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const state = document.createElement("span");
    const storedPath = document.createElement("span");
    name.className = "xref-name";
    name.textContent =
      entry.kind === "image"
        ? `이미지 · ${entry.name || "(이름 없음)"}`
        : entry.name || "(이름 없음)";
    state.className = "xref-state";
    state.dataset.state = entry.status;
    state.textContent = xrefStateLabel(entry.status);
    storedPath.className = "xref-path";
    storedPath.title = entry.storedPath ?? "";
    storedPath.textContent =
      entry.fileName || entry.storedPath || "저장 경로 없음";
    item.append(name, state, storedPath);
    if (entry.message) {
      const detail = document.createElement("span");
      detail.className = "xref-message";
      detail.textContent = entry.message;
      item.append(detail);
    }
    if (entry.canSelect && vscodeApi) {
      const select = document.createElement("button");
      select.type = "button";
      select.className = "xref-select";
      select.textContent = "파일 직접 선택";
      select.addEventListener("click", () => {
        select.disabled = true;
        vscodeApi.postMessage(
          entry.kind === "image"
            ? {
                type: "dwg-image-select/1",
                cacheId: entry.cacheId,
                imageIndex: entry.imageIndex,
              }
            : {
                type: "dwg-xref-select/1",
                parentCacheId: entry.parentCacheId,
                blockIndex: entry.blockIndex,
              },
        );
      });
      item.append(select);
    }
    fragment.append(item);
  }
  xrefStatusList.append(fragment);
}

function resetExternalDeferredWorkers() {
  externalCurveRequestRevision += 1;
  pendingExternalCurveRequest = undefined;
  if (externalCurveRefinementTimer !== undefined) {
    clearTimeout(externalCurveRefinementTimer);
    externalCurveRefinementTimer = undefined;
  }
  for (const worker of externalPrimitiveWorkers) {
    worker.cancel();
  }
  externalPrimitiveWorkers.clear();
  for (const context of externalHatchContexts.values()) {
    context.worker.cancel();
  }
  externalHatchContexts.clear();
  for (const context of externalCurveContexts.values()) {
    context.worker?.cancel();
  }
  externalCurveContexts.clear();
  externalCurveRequestInFlight = false;
}

function resetExternalReferences() {
  resetExternalDeferredWorkers();
  for (const source of externalHostSources.values()) {
    source.dispose();
  }
  externalHostSources.clear();
  externalRangeSources.clear();
  externalCacheData.clear();
  externalAttachmentsByCache.clear();
  externalMaskCounts.clear();
  discoveredXrefCaches.clear();
  readyExternalMessages.clear();
  xrefDiagnostics.clear();
  externalSourceOverviewBytes = 0;
  externalLoadQueue = Promise.resolve();
  activeTextComposite = undefined;
  activeImageComposite = undefined;
  activeImageAssetStore?.dispose();
  activeImageAssetStore = undefined;
  pendingImageRequests.clear();
  xrefsToggle.disabled = true;
  setViewerToolMessage(xrefsToggle, "toolbar.xrefs");
  xrefsToggle.setAttribute("aria-expanded", "false");
  xrefPanel.hidden = true;
  renderXrefDiagnostics();
}

function syncFontDiagnostics(styles) {
  activeTextStyles = Object.freeze([...styles]);
  const required = requiredFonts(styles);
  for (const key of [...fontDiagnostics.keys()]) {
    if (!required.has(key)) {
      fontDiagnostics.delete(key);
    }
  }
  for (const descriptor of required.values()) {
    const existing = fontDiagnostics.get(descriptor.key);
    const cacheStatus =
      descriptor.kind === "outline"
        ? localOutlineFaces.has(descriptor.key)
          ? { state: "registered", size: localOutlineFaces.get(descriptor.key).size }
          : { state: "missing" }
        : glyphCache.fontStatus(descriptor.name);
    const encoding = descriptor.isBigFont
      ? glyphCache.legacyEncodingForFont(descriptor.name)
      : undefined;
    if (cacheStatus.state === "invalid") {
      fontDiagnostics.set(descriptor.key, {
        ...existing,
        ...descriptor,
        encoding,
        state: "invalid",
        error:
          descriptor.kind === "outline"
            ? "TTF/OTF 파일을 해석할 수 없습니다."
            : "SHX 파일 형식을 해석할 수 없습니다.",
      });
    } else if (cacheStatus.state === "registered") {
      fontDiagnostics.set(descriptor.key, {
        ...existing,
        ...descriptor,
        encoding,
        state:
          existing?.state === "mapped" ? "mapped" : "loaded",
        size: existing?.size ?? cacheStatus.size,
        source: existing?.source ?? "session",
      });
    } else if (!existing) {
      fontDiagnostics.set(descriptor.key, {
        ...descriptor,
        encoding,
        state: "missing",
        error: vscodeApi
          ? "도면·프로젝트·등록 글꼴 폴더에서 찾지 못했습니다."
          : "글꼴 파일을 선택해 연결할 수 있습니다.",
      });
    }
  }
  fontsToggle.disabled = false;
  renderFontDiagnostics();
}

function requestHostFonts(styles = activeTextStyles, revision = openRevision) {
  if (!vscodeApi || !activeHostCacheId || revision !== openRevision) {
    return;
  }
  const required = requiredFonts(styles);
  for (const descriptor of required.values()) {
    if (
      (descriptor.kind === "outline"
        ? localOutlineFaces.has(descriptor.key)
        : glyphCache.hasFont(descriptor.name)) ||
      attemptedHostFontKeys.has(descriptor.key)
    ) {
      continue;
    }
    attemptedHostFontKeys.add(descriptor.key);
    const encoding = descriptor.isBigFont
      ? glyphCache.legacyEncodingForFont(descriptor.name)
      : undefined;
    const requestId = nextHostFontRequestId;
    nextHostFontRequestId += 1;
    pendingHostFontRequests.set(requestId, {
      ...descriptor,
      encoding,
      cacheId: activeHostCacheId,
      revision,
    });
    fontDiagnostics.set(descriptor.key, {
      ...descriptor,
      encoding,
      state: "loading",
    });
    vscodeApi.postMessage({
      type: "dwg-font-read/1",
      cacheId: activeHostCacheId,
      requestId,
      name: descriptor.name,
    });
  }
  renderFontDiagnostics();
}

function requestInlineTextFonts(names, revision = openRevision) {
  if (
    revision !== openRevision ||
    !activeScene ||
    !Array.isArray(names) ||
    names.length === 0
  ) {
    return;
  }
  const inlineStyles = [];
  for (const source of names.slice(0, 128)) {
    if (typeof source !== "string") {
      continue;
    }
    const name = source.trim().slice(0, 128);
    if (!name) {
      continue;
    }
    const reference = /\.(?:shx|ttf|otf|ttc)$/iu.test(name)
      ? name
      : `${name}.ttf`;
    inlineStyles.push(
      Object.freeze({
        fontFile: reference,
        bigFontFile: "",
        trueTypeFont: reference,
      }),
    );
  }
  if (inlineStyles.length === 0) {
    return;
  }
  const combined = mergeTextStyles(activeTextStyles, inlineStyles);
  syncFontDiagnostics(combined);
  requestHostFonts(combined, revision);
}

function refreshTextAfterFontChange(revision) {
  if (revision !== openRevision || !activeScene) {
    return;
  }
  activeInteraction?.refresh();
  const missing = glyphCache.missingFonts(activeTextStyles);
  activeTextStatus = Object.freeze({
    sourceTexts: activeTextStatus?.sourceTexts ?? 0,
    missingFonts: missing,
  });
  syncFontDiagnostics(activeTextStyles);
  status.textContent =
    missing.length === 0
      ? "도면 글꼴 연결 완료"
      : `도면 글꼴 확인 완료${missingFontSuffix()}(시스템 글꼴 대체)`;
}

function scheduleFontRefresh(revision) {
  if (fontRefreshTimer !== undefined) {
    clearTimeout(fontRefreshTimer);
  }
  fontRefreshTimer = setTimeout(() => {
    fontRefreshTimer = undefined;
    refreshTextAfterFontChange(revision);
  }, 40);
}

function unregisterHostFont(key) {
  const outline = localOutlineFaces.get(key);
  if (outline) {
    document.fonts.delete(outline.face);
    for (const name of outline.names ?? [outline.name]) {
      unregisterLocalOutlineFont(name);
    }
    localOutlineFaces.delete(key);
  } else {
    glyphCache.unregisterFont(key);
  }
  hostLoadedFontKeys.delete(key);
}

function clearHostFonts() {
  for (const key of [...hostLoadedFontKeys]) {
    unregisterHostFont(key);
  }
  hostLoadedFontKeys.clear();
}

async function registerHostOutlineFont(pending, message) {
  if (
    typeof FontFace !== "function" ||
    !(message.bytes instanceof ArrayBuffer)
  ) {
    throw new Error("local outline fonts are unsupported");
  }
  unregisterHostFont(pending.key);
  const family = `DwgLocalFont_${pending.revision}_${message.requestId}`;
  const face = new FontFace(family, message.bytes);
  await face.load();
  if (
    pending.revision !== openRevision ||
    pending.cacheId !== activeHostCacheId
  ) {
    return undefined;
  }
  document.fonts.add(face);
  const names = [pending.name];
  const stem = pending.name.replace(/\.(?:ttf|otf|ttc)$/iu, "");
  if (stem && stem !== pending.name) {
    names.push(stem);
  }
  for (const name of names) {
    registerLocalOutlineFont(name, family);
  }
  const entry = Object.freeze({
    face,
    family,
    name: pending.name,
    names: Object.freeze(names),
    size: Number.isSafeInteger(message.size) ? message.size : 0,
  });
  localOutlineFaces.set(pending.key, entry);
  return entry;
}

async function handleHostFontResponse(message) {
  const pending = pendingHostFontRequests.get(message?.requestId);
  if (!pending) {
    return;
  }
  pendingHostFontRequests.delete(message.requestId);
  if (
    pending.revision !== openRevision ||
    pending.cacheId !== activeHostCacheId ||
    message.cacheId !== activeHostCacheId
  ) {
    return;
  }
  if (message.status === "loaded") {
    try {
      const registered =
        pending.kind === "outline"
          ? await registerHostOutlineFont(pending, message)
          : glyphCache.registerFont(pending.name, message.bytes);
      if (!registered) {
        return;
      }
      const mapped =
        message.source === "mapping" ||
        normalizeShxFontName(message.resolvedName) !== pending.key;
      fontDiagnostics.set(pending.key, {
        ...pending,
        state: mapped ? "mapped" : "loaded",
        resolvedName: message.resolvedName,
        source: message.source,
        size: registered.size ?? message.size,
      });
      hostLoadedFontKeys.add(pending.key);
      scheduleFontRefresh(pending.revision);
    } catch {
      fontDiagnostics.set(pending.key, {
        ...pending,
        state: "invalid",
        error:
          pending.kind === "outline"
            ? "TTF/OTF 파일을 등록하거나 해석할 수 없습니다."
            : "SHX 파일을 등록하거나 해석할 수 없습니다.",
      });
      renderFontDiagnostics();
    }
    return;
  }
  const allowedFailures = new Set([
    "missing",
    "ambiguous",
    "invalid",
    "too-large",
    "budget-exceeded",
    "unreadable",
  ]);
  fontDiagnostics.set(pending.key, {
    ...pending,
    state: allowedFailures.has(message.status)
      ? message.status
      : "unreadable",
    error:
      typeof message.error === "string"
        ? message.error.slice(0, 200)
        : "글꼴을 연결하지 못했습니다.",
  });
  renderFontDiagnostics();
}

function handleFontConfigurationChanged(message) {
  if (
    !activeHostCacheId ||
    message.cacheId !== activeHostCacheId ||
    !activeScene
  ) {
    return;
  }
  glyphCache.configureLegacyEncodings(message.bigFontEncodings);
  clearHostFonts();
  pendingHostFontRequests.clear();
  attemptedHostFontKeys.clear();
  syncFontDiagnostics(activeTextStyles);
  requestHostFonts(activeTextStyles, openRevision);
}

function missingFontSuffix() {
  const missing = activeTextStatus?.missingFonts ?? [];
  if (missing.length === 0) {
    return "";
  }
  const visibleNames = missing
    .slice(0, 3)
    .map((name) => name.split(/[\\/]/).at(-1).slice(0, 80))
    .join(", ");
  const remainder =
    missing.length > 3 ? ` 외 ${missing.length - 3}개` : "";
  return ` · 누락 SHX: ${visibleNames}${remainder}`;
}

function renderMetrics(scene, rangeSource, viewport = null) {
  const value = scene.metrics;
  const reads = rangeSource.snapshot();
  const externalReads = [...externalRangeSources.values()].reduce(
    (total, source) => {
      const snapshot = source.snapshot();
      total.requests += snapshot.requests;
      total.bytesRead += snapshot.bytesRead;
      total.maximumRequestBytes = Math.max(
        total.maximumRequestBytes,
        snapshot.maximumRequestBytes,
      );
      return total;
    },
    { requests: 0, bytesRead: 0, maximumRequestBytes: 0 },
  );
  const render = viewport?.render ?? value.renderer;
  const memory = activeMemoryTelemetry?.sample(
    render?.gpuTrackedBytes ?? 0,
  );
  const detail = viewport?.detail;
  const xrefRows =
    (render?.externalScenes ?? 0) > 0 || xrefDiagnostics.size > 0
      ? `
      <div><dt>참조도면 장면</dt><dd>${(render?.externalScenes ?? 0).toLocaleString()}개</dd></div>
      <div><dt>참조 첫 화면 원본</dt><dd>${formatBytes(externalSourceOverviewBytes)}</dd></div>
      <div><dt>참조 첫 화면 GPU</dt><dd>${formatBytes(render?.externalOverviewGpuBytes ?? 0)}</dd></div>
      <div><dt>참조 상세 GPU</dt><dd>${formatBytes(render?.externalDetailGpuBytes ?? 0)}</dd></div>
      <div><dt>참조 범위 읽기</dt><dd>${formatBytes(externalReads.bytesRead)}</dd></div>
    `
      : "";
  const detailRows = detail
    ? `
      <div><dt>현재 확대</dt><dd>${viewport.zoom.toFixed(2)}×</dd></div>
      <div><dt>화면 상세</dt><dd>${detail.selectedBatches.toLocaleString()}개</dd></div>
      <div><dt>상세 캐시</dt><dd>${detail.cache.entries.toLocaleString()}개</dd></div>
      <div><dt>상세 GPU</dt><dd>${formatBytes(detail.cache.bytes)}</dd></div>
      <div><dt>상세 대기</dt><dd>${detail.loading.toLocaleString()}</dd></div>
    `
    : "";
  const text = render?.text;
  const textRows = text
    ? `
      <div><dt>문자 원본</dt><dd>${text.sourceTexts.toLocaleString()}개</dd></div>
      <div><dt>화면 문자</dt><dd>${text.visibleOccurrences.toLocaleString()}개</dd></div>
      <div><dt>SHX 글자</dt><dd>${text.vectorGlyphs.toLocaleString()}개</dd></div>
      <div><dt>대체 글자</dt><dd>${text.fallbackGlyphs.toLocaleString()}개</dd></div>
      <div><dt>문자 선분</dt><dd>${text.segments.toLocaleString()}개</dd></div>
      <div><dt>화면 가림</dt><dd>${text.maskOccurrences.toLocaleString()}개</dd></div>
      <div><dt>문자 가림 적용</dt><dd>${text.clippedTextOccurrences.toLocaleString()}개</dd></div>
      <div><dt>Glyph 캐시</dt><dd>${formatBytes(glyphCache.stats.glyphBytes)}</dd></div>
    `
    : "";
  const images = render?.images;
  const imageRows = images
    ? `
      <div><dt>이미지 원본</dt><dd>${images.sourceImages.toLocaleString()}개</dd></div>
      <div><dt>화면 이미지</dt><dd>${images.loadedOccurrences.toLocaleString()} / ${images.visibleOccurrences.toLocaleString()}개</dd></div>
      <div><dt>이미지 대기</dt><dd>${(images.requestedImages + images.decodingImages).toLocaleString()}개</dd></div>
      <div><dt>이미지 압축 메모리</dt><dd>${formatBytes(images.memory?.compressedBytes ?? 0)}</dd></div>
      <div><dt>이미지 화면 메모리</dt><dd>${formatBytes(images.memory?.decodedBytes ?? 0)}</dd></div>
    `
    : "";
  const hatch = render?.hatchFill ?? activeHatchStatus?.fillMetrics;
  const pattern =
    render?.hatchPattern ?? activeHatchStatus?.patternMetrics;
  const hatchRows = hatch
    ? `
      <div><dt>해치 원본</dt><dd>${hatch.sourceHatches.toLocaleString()}개</dd></div>
      <div><dt>해치 표시</dt><dd>${hatch.renderedHatches.toLocaleString()}개</dd></div>
      <div><dt>채움 삼각형</dt><dd>${hatch.triangles.toLocaleString()}개</dd></div>
      <div><dt>채움 배치</dt><dd>${hatch.batches.toLocaleString()}개</dd></div>
      <div><dt>채움 GPU</dt><dd>${formatBytes(hatch.gpuBytes)}</dd></div>
      <div><dt>채움 원본 읽기</dt><dd>${formatBytes(activeHatchStatus?.reads?.bytesRead ?? 0)}</dd></div>
    `
    : "";
  const patternRows = pattern
    ? `
      <div><dt>패턴 정의선</dt><dd>${pattern.patternDefinitions.toLocaleString()}개</dd></div>
      <div><dt>패턴 표시</dt><dd>${pattern.renderedHatches.toLocaleString()}개</dd></div>
      <div><dt>패턴 선분</dt><dd>${pattern.segments.toLocaleString()}개</dd></div>
      <div><dt>패턴 오류 생략</dt><dd>${((pattern.skippedInvalidDefinitions ?? 0) + (pattern.skippedInvalidIntersections ?? 0) + (pattern.skippedInvalidSegments ?? 0)).toLocaleString()}건</dd></div>
      <div><dt>패턴 배치</dt><dd>${pattern.batches.toLocaleString()}개</dd></div>
      <div><dt>패턴 GPU</dt><dd>${formatBytes(pattern.gpuBytes)}</dd></div>
      <div><dt>패턴 원본 읽기</dt><dd>${formatBytes(activeHatchStatus?.patternReads?.bytesRead ?? activeHatchStatus?.reads?.bytesRead ?? 0)}</dd></div>
    `
    : "";
  const primitives =
    render?.primitives ?? activePrimitiveStatus?.metrics;
  const primitiveRows = primitives
    ? `
      <div><dt>점 원본/표시</dt><dd>${primitives.sourcePoints.toLocaleString()} / ${primitives.renderedPoints.toLocaleString()}개</dd></div>
      <div><dt>솔리드 원본</dt><dd>${primitives.sourceSolids.toLocaleString()}개</dd></div>
      <div><dt>솔리드 채움</dt><dd>${primitives.renderedFilledSolids.toLocaleString()}개</dd></div>
      <div><dt>솔리드 외곽선</dt><dd>${primitives.renderedOutlineSolids.toLocaleString()}개</dd></div>
      <div><dt>폭 폴리라인 원본/표시</dt><dd>${primitives.sourceWidePolylines.toLocaleString()} / ${(primitives.renderedFilledWidePolylines + primitives.renderedOutlineWidePolylines).toLocaleString()}개</dd></div>
      <div><dt>폭 폴리라인 GPU</dt><dd>${formatBytes(primitives.widePolylineFillGpuBytes + primitives.widePolylineOutlineGpuBytes)}</dd></div>
      <div><dt>3D 면 원본/표시</dt><dd>${primitives.sourceFaces.toLocaleString()} / ${primitives.renderedFaces.toLocaleString()}개</dd></div>
      <div><dt>3D 면 가장자리</dt><dd>${primitives.renderedFaceEdges.toLocaleString()}개</dd></div>
      <div><dt>가림 객체 원본</dt><dd>${primitives.sourceWipeouts.toLocaleString()}개</dd></div>
      <div><dt>가림 마스크</dt><dd>${primitives.renderedWipeoutMasks.toLocaleString()}개</dd></div>
      <div><dt>가림 삼각형</dt><dd>${primitives.renderedWipeoutMaskTriangles.toLocaleString()}개</dd></div>
      <div><dt>가림 프레임</dt><dd>${primitives.renderedWipeoutFrames.toLocaleString()}개</dd></div>
      <div><dt>가림 GPU</dt><dd>${formatBytes(primitives.wipeoutMaskGpuBytes)}</dd></div>
      <div><dt>후처리 GPU</dt><dd>${formatBytes(primitives.gpuBytes)}</dd></div>
      <div><dt>후처리 원본 읽기</dt><dd>${formatBytes(activePrimitiveStatus?.reads?.bytesRead ?? 0)}</dd></div>
    `
    : "";
  const curves =
    render?.curveRefinement ?? activeCurveStatus?.metrics;
  const curveRows = curves
    ? `
      <div><dt>화면 곡선 정밀화</dt><dd>${curves.refined.toLocaleString()} / ${curves.visible.toLocaleString()}개</dd></div>
      <div><dt>정밀 곡선 선분</dt><dd>${curves.segments.toLocaleString()}개</dd></div>
      <div><dt>정밀 곡선 GPU</dt><dd>${formatBytes(curves.gpuBytes)}</dd></div>
      <div><dt>곡선 화면 오차</dt><dd>${curves.pixelError.toFixed(2)} px 이하</dd></div>
      <div><dt>곡선 원본 읽기</dt><dd>${formatBytes(activeCurveStatus?.source?.byteLength ?? 0)}</dd></div>
      <div><dt>곡선 최대 범위 읽기</dt><dd>${formatBytes(activeCurveStatus?.source?.maximumReadBytes ?? 0)}</dd></div>
    `
    : "";
  const maskRows = activeMaskStatus
    ? `
      <div><dt>객체 표시 순서</dt><dd>${activeMaskStatus.enabled ? (activeMaskStatus.generalOrderEnabled ? "전체 객체" : activeMaskStatus.masks > 0 ? "가림 객체만" : "정렬표 객체만") : "비활성"}</dd></div>
      <div><dt>가림 객체</dt><dd>${activeMaskStatus.masks.toLocaleString()}개 · ${activeWipeoutMasksVisible ? "표시" : "숨김"}</dd></div>
      <div><dt>정렬표 읽기</dt><dd>${activeMaskStatus.tables.toLocaleString()} / ${activeMaskStatus.entries.toLocaleString()}개</dd></div>
      <div><dt>확장 순서 단계</dt><dd>${activeMaskStatus.maximumExpandedMasks.toLocaleString()}개</dd></div>
      ${activeMaskStatus.generalOrderEnabled ? `<div><dt>Canvas 순서 합성</dt><dd>${render?.orderedOverlayCompositionEnabled ? `${render.orderedOverlayDrawCalls.toLocaleString()}회 · ${formatBytes(render.orderedOverlayGpuBytes)}` : "DOM 대체"}</dd></div>` : ""}
      ${activeMaskStatus.generalOrderReason ? `<div><dt>전체 순서 제한</dt><dd>${escapeHtml(activeMaskStatus.generalOrderReason)}</dd></div>` : ""}
      <div><dt>순서 계산</dt><dd>${activeMaskStatus.buildMs.toFixed(1)} ms</dd></div>
    `
    : "";
  const memoryRows = memory
    ? `
      <div><dt>GPU 추적 메모리</dt><dd>${formatBytes(memory.gpuTrackedBytes)}</dd></div>
      <div><dt>GPU 추적 최고</dt><dd>${formatBytes(memory.peakGpuTrackedBytes)}</dd></div>
      <div><dt>인스턴스 작업 버퍼</dt><dd>${formatBytes(render.instanceScratchBytes ?? 0)}</dd></div>
      ${
        memory.jsHeapAvailable
          ? `
      <div><dt>JavaScript 힙</dt><dd>${formatBytes(memory.usedJsHeapBytes)}</dd></div>
      <div><dt>JavaScript 힙 최고</dt><dd>${formatBytes(memory.peakUsedJsHeapBytes)} / ${formatBytes(memory.hardLimitBytes)}${memory.hardLimitExceeded ? " · 기준 초과" : ""}</dd></div>
      `
          : `
      <div><dt>JavaScript 힙</dt><dd>브라우저 계측 미지원</dd></div>
      `
      }
    `
    : "";
  metrics.innerHTML = `
    <dl>
      <div><dt>첫 화면</dt><dd>${value.timings.firstFrameMs.toFixed(1)} ms</dd></div>
      <div><dt>읽은 데이터</dt><dd>${formatBytes(reads.bytesRead)}</dd></div>
      <div><dt>가장 큰 읽기</dt><dd>${formatBytes(reads.maximumRequestBytes)}</dd></div>
      <div><dt>첫 화면 버퍼</dt><dd>${formatBytes(value.overviewBytes)}</dd></div>
      <div><dt>블록 인스턴스</dt><dd>${value.instances.toLocaleString()}</dd></div>
      <div><dt>GPU 호출</dt><dd>${render.drawCalls.toLocaleString()}</dd></div>
      <div><dt>제출 정점</dt><dd>${render.submittedVertices.toLocaleString()}</dd></div>
      <div><dt>GPU 정점 버퍼</dt><dd>${formatBytes(render.gpuVertexBytes)}</dd></div>
      <div><dt>전체 캐시</dt><dd>${formatBytes(value.cacheBytes)}</dd></div>
      ${xrefRows}
      ${memoryRows}
      ${detailRows}
      ${hatchRows}
      ${patternRows}
      ${primitiveRows}
      ${curveRows}
      ${maskRows}
      ${imageRows}
      ${textRows}
    </dl>
  `;
}

function setControlsEnabled(enabled) {
  viewControlsEnabled = Boolean(enabled);
  for (const control of viewControls) {
    control.disabled = !enabled;
  }
  layersToggle.disabled = !enabled;
  exportToggle.disabled = !enabled || Boolean(activeExportController);
  wipeoutToggle.disabled =
    !enabled ||
    !activeMaskStatus?.enabled ||
    activeMaskStatus.masks === 0;
  if (activeReviewTools) {
    activeReviewTools.setEnabled(enabled);
  } else {
    reviewToolbar.hidden = true;
  }
  updateViewNavigationControls();
}

function updateWipeoutToggle() {
  setViewerToolMessage(
    wipeoutToggle,
    activeWipeoutMasksVisible
      ? "toolbar.wipeoutOn"
      : "toolbar.wipeoutOff",
  );
  wipeoutToggle.setAttribute(
    "aria-pressed",
    String(activeWipeoutMasksVisible),
  );
  wipeoutToggle.title = t(
    activeWipeoutMasksVisible
      ? "toolbar.wipeout.hide"
      : "toolbar.wipeout.show",
  );
}

function refreshMaskSourceCount() {
  if (!activeMaskStatus) {
    return;
  }
  const masks =
    (activeMaskOrder?.masks.length ?? 0) +
    [...externalMaskCounts.values()].reduce(
      (total, count) => total + count,
      0,
    );
  if (activeMaskStatus.masks !== masks) {
    activeMaskStatus = Object.freeze({
      ...activeMaskStatus,
      masks,
    });
  }
  setControlsEnabled(viewControlsEnabled);
  updateWipeoutToggle();
}

function updateLayerSummary() {
  if (!activeScene) {
    layerSummary.textContent = "";
    return;
  }
  const visibility = activeScene.renderer.getLayerVisibility();
  const visible = visibility.filter(Boolean).length;
  const xrefGroups = activeLayerGroups.filter(
    ({ kind }) => kind === "xref",
  ).length;
  layerSummary.textContent = [
    `${visible.toLocaleString()} / ${visibility.length.toLocaleString()} 켜짐`,
    xrefGroups > 0
      ? `외부참조 ${xrefGroups.toLocaleString()}개`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function resetLayerPanel() {
  layerPanel.hidden = true;
  layersToggle.setAttribute("aria-expanded", "false");
  layerSearch.value = "";
  layerList.replaceChildren();
  layerSummary.textContent = "";
  previousLayerVisibility = null;
  activeLayerGroups = Object.freeze([]);
  layersRestore.disabled = true;
}

function syncLayerGroupCheckboxes(visibility) {
  for (const checkbox of layerList.querySelectorAll(
    "input[data-layer-group-index]",
  )) {
    const groupIndex = Number.parseInt(
      checkbox.dataset.layerGroupIndex,
      10,
    );
    const group = activeLayerGroups[groupIndex];
    if (!group) {
      continue;
    }
    const groupState = layerGroupVisibility(group, visibility);
    checkbox.checked = groupState.checked;
    checkbox.indeterminate = groupState.indeterminate;
    checkbox.setAttribute(
      "aria-checked",
      groupState.indeterminate ? "mixed" : String(groupState.checked),
    );
    const count = checkbox
      .closest(".layer-group")
      ?.querySelector("[data-layer-group-count]");
    if (count) {
      count.textContent =
        `${groupState.visible.toLocaleString()} / ` +
        `${groupState.total.toLocaleString()}`;
    }
  }
}

function syncLayerCheckboxes(visibility) {
  for (const checkbox of layerList.querySelectorAll(
    "input[data-layer-index]",
  )) {
    const index = Number.parseInt(checkbox.dataset.layerIndex, 10);
    checkbox.checked = Boolean(visibility[index]);
  }
  syncLayerGroupCheckboxes(visibility);
}

function applyLayerVisibilityState(
  visibility,
  { remember = true, message = "" } = {},
) {
  if (!activeScene) {
    return false;
  }
  const current = activeScene.renderer.getLayerVisibility();
  if (
    visibility.length !== current.length ||
    visibility.every((visible, index) => Boolean(visible) === current[index])
  ) {
    return false;
  }
  if (remember) {
    previousLayerVisibility = current;
    layersRestore.disabled = false;
  }
  const next = visibility.map(Boolean);
  activeScene.renderer.setLayerVisibilityState(next);
  syncLayerCheckboxes(next);
  activeInteraction?.refresh();
  activeReviewTools?.redraw();
  updateLayerSummary();
  if (message) {
    status.textContent = message;
  }
  return true;
}

function createLayerItem(scene, row, visibility) {
  const item = document.createElement("li");
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  const name = document.createElement("span");
  const fullName = row.fullName || "(이름 없음)";
  const displayName = row.displayName || "(이름 없음)";
  item.className = "layer-item";
  item.dataset.layerName = row.searchText;
  checkbox.type = "checkbox";
  checkbox.checked = visibility[row.index];
  checkbox.dataset.layerIndex = String(row.index);
  checkbox.setAttribute("aria-label", `${fullName} 레이어 표시`);
  name.className = "layer-name";
  name.textContent = displayName;
  if (displayName !== fullName) {
    name.title = fullName;
  }
  checkbox.addEventListener("change", () => {
    if (activeScene !== scene) {
      return;
    }
    const next = scene.renderer.getLayerVisibility();
    next[row.index] = checkbox.checked;
    applyLayerVisibilityState(next, {
      message: `${fullName} 레이어를 ${checkbox.checked ? "켰습니다" : "껐습니다"}.`,
    });
  });
  const isolate = document.createElement("button");
  isolate.type = "button";
  isolate.className = "layer-isolate";
  isolate.textContent = "단독";
  isolate.title = `${fullName} 레이어만 보기`;
  isolate.addEventListener("click", () => {
    if (activeScene !== scene) {
      return;
    }
    const next = visibility.map(
      (_visible, layerIndex) => layerIndex === row.index,
    );
    applyLayerVisibilityState(next, {
      message: `${fullName} 레이어만 표시합니다.`,
    });
  });
  label.append(checkbox, name);
  item.append(label, isolate);
  return item;
}

function setLayerGroupExpanded(item, expanded) {
  const toggle = item.querySelector("[data-layer-group-toggle]");
  const children = item.querySelector("[data-layer-group-children]");
  if (!toggle || !children) {
    return;
  }
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute(
    "aria-label",
    `${item.dataset.layerGroupLabel ?? "그룹"} 레이어 목록 ${
      expanded ? "접기" : "펼치기"
    }`,
  );
  children.hidden = !expanded;
  item.classList.toggle("expanded", expanded);
}

function createLayerGroupItem(
  scene,
  group,
  groupIndex,
  visibility,
) {
  const item = document.createElement("li");
  const heading = document.createElement("div");
  const toggle = document.createElement("button");
  const chevron = document.createElement("span");
  const name = document.createElement("span");
  const visibilityLabel = document.createElement("label");
  const checkbox = document.createElement("input");
  const count = document.createElement("span");
  const isolate = document.createElement("button");
  const children = document.createElement("ul");
  const groupState = layerGroupVisibility(group, visibility);

  item.className = "layer-group";
  item.dataset.layerGroupKind = group.kind;
  item.dataset.layerGroupLabel = group.name;
  item.dataset.layerName = group.name
    .normalize("NFC")
    .toLocaleLowerCase("ko-KR");
  heading.className = "layer-group-heading";
  toggle.type = "button";
  toggle.className = "layer-group-toggle";
  toggle.dataset.layerGroupToggle = "";
  chevron.className = "layer-group-chevron";
  chevron.textContent = "›";
  name.className = "layer-group-name";
  name.textContent = group.name;
  visibilityLabel.className = "layer-group-visibility";
  visibilityLabel.title = `${group.name} 그룹 전체 표시 또는 숨김`;
  checkbox.type = "checkbox";
  checkbox.checked = groupState.checked;
  checkbox.indeterminate = groupState.indeterminate;
  checkbox.dataset.layerGroupIndex = String(groupIndex);
  checkbox.setAttribute("aria-label", `${group.name} 그룹 표시`);
  checkbox.setAttribute(
    "aria-checked",
    groupState.indeterminate ? "mixed" : String(groupState.checked),
  );
  count.className = "layer-group-count";
  count.dataset.layerGroupCount = "";
  count.textContent =
    `${groupState.visible.toLocaleString()} / ` +
    `${groupState.total.toLocaleString()}`;
  isolate.type = "button";
  isolate.className = "layer-isolate layer-group-isolate";
  isolate.textContent = "그룹 단독";
  isolate.title = `${group.name} 그룹의 레이어만 보기`;
  children.className = "layer-group-layers";
  children.dataset.layerGroupChildren = "";
  children.setAttribute("aria-label", `${group.name} 레이어`);

  toggle.append(chevron, name);
  visibilityLabel.append(checkbox, count);
  heading.append(toggle, visibilityLabel, isolate);
  for (const row of group.rows) {
    children.append(createLayerItem(scene, row, visibility));
  }
  item.append(heading, children);
  setLayerGroupExpanded(item, false);

  toggle.addEventListener("click", () => {
    setLayerGroupExpanded(
      item,
      toggle.getAttribute("aria-expanded") !== "true",
    );
  });
  checkbox.addEventListener("change", () => {
    if (activeScene !== scene) {
      return;
    }
    applyLayerVisibilityState(
      setLayerGroupVisibility(
        scene.renderer.getLayerVisibility(),
        group,
        checkbox.checked,
      ),
      {
        message: `${group.name} 그룹 레이어를 ${
          checkbox.checked ? "모두 켰습니다" : "모두 껐습니다"
        }.`,
      },
    );
  });
  isolate.addEventListener("click", () => {
    if (activeScene !== scene) {
      return;
    }
    applyLayerVisibilityState(
      isolateLayerGroup(scene.renderer.getLayerVisibility(), group),
      {
        message: `${group.name} 그룹 레이어만 표시합니다.`,
      },
    );
  });
  return item;
}

function populateLayerPanel(scene) {
  layerList.replaceChildren();
  const visibility = scene.renderer.getLayerVisibility();
  activeLayerGroups = buildLayerGroups(scene.metadata.layers);
  const fragment = document.createDocumentFragment();
  const hasExternalGroups = activeLayerGroups.some(
    ({ kind }) => kind === "xref",
  );
  if (!hasExternalGroups) {
    for (const row of activeLayerGroups[0]?.rows ?? []) {
      fragment.append(createLayerItem(scene, row, visibility));
    }
  } else {
    for (const [groupIndex, group] of activeLayerGroups.entries()) {
      fragment.append(
        createLayerGroupItem(
          scene,
          group,
          groupIndex,
          visibility,
        ),
      );
    }
  }
  layerList.append(fragment);
  syncLayerCheckboxes(visibility);
  updateLayerSummary();
}

function filterLayerPanel(value) {
  const query = value.trim().normalize("NFC").toLocaleLowerCase("ko-KR");
  for (const item of layerList.children) {
    if (!item.classList.contains("layer-group")) {
      item.hidden =
        Boolean(query) && !item.dataset.layerName.includes(query);
      continue;
    }
    const toggle = item.querySelector("[data-layer-group-toggle]");
    const children = item.querySelector("[data-layer-group-children]");
    if (!toggle || !children) {
      continue;
    }
    if (!query) {
      item.hidden = false;
      for (const child of children.children) {
        child.hidden = false;
      }
      if (item.dataset.layerExpandedBeforeSearch !== undefined) {
        setLayerGroupExpanded(
          item,
          item.dataset.layerExpandedBeforeSearch === "true",
        );
        delete item.dataset.layerExpandedBeforeSearch;
      }
      continue;
    }
    if (item.dataset.layerExpandedBeforeSearch === undefined) {
      item.dataset.layerExpandedBeforeSearch =
        toggle.getAttribute("aria-expanded") === "true"
          ? "true"
          : "false";
    }
    const groupMatches = item.dataset.layerName.includes(query);
    let matchingChildren = 0;
    for (const child of children.children) {
      const matches =
        groupMatches || child.dataset.layerName.includes(query);
      child.hidden = !matches;
      matchingChildren += matches ? 1 : 0;
    }
    item.hidden = matchingChildren === 0;
    if (matchingChildren > 0) {
      setLayerGroupExpanded(item, true);
    }
  }
}

function setAllLayersVisible(visible) {
  if (!activeScene) {
    return;
  }
  const next = activeScene.renderer
    .getLayerVisibility()
    .map(() => visible);
  applyLayerVisibilityState(next, {
    message: visible
      ? "모든 레이어를 표시합니다."
      : "모든 레이어를 숨겼습니다.",
  });
}

function queueTextReveal(message) {
  const handle =
    typeof message?.handle === "string"
      ? message.handle.trim().replace(/^0x/iu, "")
      : "";
  const point =
    Array.isArray(message?.point) &&
    message.point.length === 3 &&
    message.point.every(Number.isFinite)
      ? [...message.point]
      : null;
  if (!/^[0-9a-f]{1,16}$/iu.test(handle) || !point) {
    return false;
  }
  pendingTextReveal = Object.freeze({
    handle: handle.toUpperCase(),
    kind:
      typeof message.kind === "string"
        ? message.kind.slice(0, 24)
        : "문자",
    value:
      typeof message.value === "string"
        ? message.value.slice(0, 500)
        : "",
    point: Object.freeze(point),
    height:
      Number.isFinite(message.height) && message.height > 0
        ? message.height
        : 0,
    hidden: Boolean(message.hidden),
  });
  revealQueuedText();
  return true;
}

function revealQueuedText() {
  if (
    !pendingTextReveal ||
    !activeInteraction ||
    !activeReviewTools ||
    !activeTextStatus
  ) {
    return false;
  }
  const occurrence = activeTextComposite?.findTextOccurrence?.(
    pendingTextReveal.handle,
  );
  const point = occurrence?.point ?? pendingTextReveal.point;
  const currentWorldHeight =
    activeInteraction.snapshot().camera.worldHeight;
  const textHeight =
    occurrence?.worldHeight ?? pendingTextReveal.height;
  const desiredWorldHeight = Math.min(
    currentWorldHeight,
    Math.max(
      textHeight > 0 ? textHeight * 24 : 0,
      currentWorldHeight * 0.08,
    ),
  );
  activeInteraction.focusAt(point, desiredWorldHeight);
  activeReviewTools.showTextMatch({
    point,
    handle: pendingTextReveal.handle,
    kind: pendingTextReveal.kind,
    value: pendingTextReveal.value,
    hidden: pendingTextReveal.hidden,
  });
  return true;
}

function invertLayerVisibility() {
  if (!activeScene) {
    return;
  }
  const next = activeScene.renderer
    .getLayerVisibility()
    .map((visible) => !visible);
  applyLayerVisibilityState(next, {
    message: "레이어 표시 상태를 반전했습니다.",
  });
}

function restoreLayerVisibility() {
  if (!activeScene || !previousLayerVisibility) {
    return false;
  }
  const current = activeScene.renderer.getLayerVisibility();
  const previous = previousLayerVisibility;
  if (
    previous.length !== current.length ||
    !applyLayerVisibilityState(previous, {
      remember: false,
      message: "이전 레이어 표시 상태로 돌아갔습니다.",
    })
  ) {
    return false;
  }
  previousLayerVisibility = current;
  layersRestore.disabled = false;
  return true;
}

function imageDiagnosticKey(cacheId, imageIndex) {
  return `image:${cacheId}:${imageIndex}`;
}

function imageRequestKey(cacheId, imageIndex) {
  return `${cacheId}:${imageIndex}`;
}

function displayReferenceName(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.slice(0, 300) || "(경로 없음)";
}

function requestRasterImage({ cacheId, imageIndex, path }) {
  if (
    !vscodeApi ||
    !activeImageAssetStore ||
    typeof cacheId !== "string" ||
    !Number.isSafeInteger(imageIndex) ||
    imageIndex < 0 ||
    typeof path !== "string" ||
    path.length > 32_768
  ) {
    return false;
  }
  const key = imageRequestKey(cacheId, imageIndex);
  if (pendingImageRequests.has(key)) {
    return false;
  }
  const requestId = nextImageRequestId;
  nextImageRequestId += 1;
  const pending = Object.freeze({
    cacheId,
    imageIndex,
    requestId,
    path,
    revision: openRevision,
  });
  pendingImageRequests.set(key, pending);
  xrefDiagnostics.set(imageDiagnosticKey(cacheId, imageIndex), {
    kind: "image",
    cacheId,
    imageIndex,
    requestId,
    revision: openRevision,
    name: displayReferenceName(path),
    storedPath: path,
    status: "searching",
    depth: 0,
    canSelect: false,
  });
  renderXrefDiagnostics();
  vscodeApi.postMessage({
    type: "dwg-image-read/1",
    cacheId,
    imageIndex,
    requestId,
    path,
  });
  return true;
}

function handleImageStatus(message) {
  if (
    typeof message?.cacheId !== "string" ||
    !Number.isSafeInteger(message.imageIndex)
  ) {
    return;
  }
  const key = imageDiagnosticKey(message.cacheId, message.imageIndex);
  const existing = xrefDiagnostics.get(key);
  if (existing?.kind !== "image" || existing.revision !== openRevision) {
    return;
  }
  xrefDiagnostics.set(key, {
    ...existing,
    status: message.status === "searching" ? "searching" : existing.status,
  });
  renderXrefDiagnostics();
}

function imageResolutionMessage(resolution) {
  if (resolution === "relative") {
    return "도면과 같은 위치의 상대경로에서 연결했습니다.";
  }
  if (resolution === "search") {
    return "파일명과 상위 폴더 일치 순으로 자동 연결했습니다.";
  }
  if (typeof resolution === "string" && resolution.startsWith("manual")) {
    return "저장된 수동 연결을 적용했습니다.";
  }
  return "저장된 경로에서 연결했습니다.";
}

function handleImageResponse(message) {
  if (
    typeof message?.cacheId !== "string" ||
    !Number.isSafeInteger(message.imageIndex) ||
    !Number.isSafeInteger(message.requestId)
  ) {
    return;
  }
  const requestKey = imageRequestKey(
    message.cacheId,
    message.imageIndex,
  );
  const diagnosticKey = imageDiagnosticKey(
    message.cacheId,
    message.imageIndex,
  );
  const pending = pendingImageRequests.get(requestKey);
  const existing = xrefDiagnostics.get(diagnosticKey);
  const knownRequest =
    pending?.requestId === message.requestId &&
    pending.revision === openRevision;
  const knownManualRetry =
    existing?.kind === "image" &&
    existing.requestId === message.requestId &&
    existing.revision === openRevision;
  if (
    (!knownRequest && !knownManualRetry) ||
    !activeImageAssetStore
  ) {
    return;
  }
  if (message.ok !== true) {
    const knownStates = new Set([
      "missing",
      "ambiguous",
      "limit",
      "unsupported",
    ]);
    const state = knownStates.has(message.status)
      ? message.status
      : "error";
    xrefDiagnostics.set(diagnosticKey, {
      ...existing,
      kind: "image",
      cacheId: message.cacheId,
      imageIndex: message.imageIndex,
      requestId: message.requestId,
      revision: openRevision,
      name: existing?.name ?? "(이미지)",
      storedPath: existing?.storedPath ?? pending?.path ?? "",
      status: state,
      message:
        typeof message.message === "string"
          ? message.message.slice(0, 240)
          : "이미지 파일을 연결하지 못했습니다.",
      canSelect: Boolean(message.canSelect),
    });
    if (!message.canSelect) {
      pendingImageRequests.delete(requestKey);
    }
    renderXrefDiagnostics();
    return;
  }
  try {
    activeImageAssetStore.accept(message);
  } catch (error) {
    pendingImageRequests.delete(requestKey);
    xrefDiagnostics.set(diagnosticKey, {
      ...existing,
      status: "error",
      canSelect: true,
      message:
        error instanceof Error
          ? error.message.slice(0, 240)
          : "이미지 데이터를 안전하게 받을 수 없습니다.",
    });
    renderXrefDiagnostics();
    return;
  }
  pendingImageRequests.delete(requestKey);
  xrefDiagnostics.set(diagnosticKey, {
    ...existing,
    status: "ready",
    canSelect: false,
    resourceId: message.resourceId,
    fileName:
      typeof message.fileName === "string"
        ? message.fileName.slice(0, 300)
        : existing?.fileName,
    message: imageResolutionMessage(message.resolution),
  });
  renderXrefDiagnostics();
  activeInteraction?.refresh();
}

async function initializeImageOverlay(
  scene,
  revision,
  cacheId,
  instanceGraph = activeRenderInstanceGraph ?? scene.instanceGraph,
) {
  if (
    !activeImageAssetStore ||
    !cacheId
  ) {
    return;
  }
  const composite = activeImageComposite;
  const imageEntities =
    scene.imageEntities ?? (await scene.reader.readImageEntities());
  if (
    revision !== openRevision ||
    activeScene !== scene ||
    !activeImageAssetStore ||
    activeImageComposite !== composite ||
    instanceGraph !==
      (activeRenderInstanceGraph ?? scene.instanceGraph)
  ) {
    return;
  }
  if (!activeImageComposite) {
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    scene.renderer.setImageOverlay(activeImageComposite);
  }
  activeImageComposite.setHitTestingEnabled(
    Boolean(activeReviewTools?.activeTool),
  );
  const overlay = new CanvasRasterImageOverlay(imageCanvas, {
      imageEntities,
      blocks: scene.metadata.blocks,
      layers: scene.metadata.layers,
      displayLayers: scene.metadata.layers,
      instanceGraph,
      cacheId,
      assetStore: activeImageAssetStore,
      requestAsset: requestRasterImage,
      maskOrder: activeMaskOrder,
      sourceId: "root",
      sourceLabel: "현재 도면",
    });
  activeImageComposite.add(
    overlay,
    { first: true },
  );
  scene.renderer.setSupplementalBounds("root", overlay.bounds);
  activeInteraction?.refresh();
}

async function initializeTextOverlay(
  scene,
  revision,
  maskOrder = activeMaskOrder,
  instanceGraph = activeRenderInstanceGraph ?? scene.instanceGraph,
) {
  status.textContent = "문자 원본과 스타일 읽는 중";
  const [textEntities, styles] = await Promise.all([
    scene.reader.readTextEntities(),
    scene.reader.readTextStyles(),
  ]);
  if (
    revision !== openRevision ||
    activeScene !== scene ||
    instanceGraph !==
      (activeRenderInstanceGraph ?? scene.instanceGraph)
  ) {
    return;
  }
  const overlay = new CanvasTextOverlay(textCanvas, {
    textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph,
    glyphCache,
    maskOrder,
    sourceId: "root",
    sourceLabel: "현재 도면",
    onInlineFonts: (names) =>
      requestInlineTextFonts(names, revision),
  });
  if (!activeTextComposite) {
    activeTextComposite = new CompositeTextOverlay(textCanvas);
    scene.renderer.setTextOverlay(activeTextComposite);
  }
  activeTextComposite.setHitTestingEnabled(
    Boolean(activeReviewTools?.activeTool),
  );
  activeTextComposite.add(overlay, { first: true });
  const complexOverlay = new ComplexLinetypeOverlay(textCanvas, {
    vertices: scene.overview,
    batches: scene.metadata.batches,
    linetypes: scene.metadata.linetypes,
    textStyles: styles,
    layers: scene.metadata.layers,
    instanceGraph,
    glyphCache,
    globalLinetypeScale:
      scene.metadata.drawing.globalLinetypeScale,
    blocks: scene.metadata.blocks,
    maskOrder,
  });
  if (complexOverlay.source.sourceSegments > 0) {
    activeTextComposite.add(complexOverlay);
  }
  const missing = glyphCache.missingFonts(styles);
  activeTextStatus = Object.freeze({
    sourceTexts: textEntities.length,
    missingFonts: missing,
  });
  syncFontDiagnostics(styles);
  requestHostFonts(styles, revision);
  activeInteraction?.refresh();
  status.textContent =
    missing.length === 0
      ? `문자 ${textEntities.length.toLocaleString()}개 표시 준비 완료`
      : `문자 ${textEntities.length.toLocaleString()}개 표시${missingFontSuffix()}(시스템 글꼴 대체)`;
  revealQueuedText();
}

function externalReferenceBlockSpans(blocks) {
  const spans = new Uint32Array(blocks.length);
  for (const block of blocks) {
    if (
      Number.isSafeInteger(block.index) &&
      block.index >= 0 &&
      block.index < spans.length &&
      (block.flags & (1 << 2)) !== 0
    ) {
      spans[block.index] = 1;
    }
  }
  return spans;
}

function makeSceneMaskOrder(
  scene,
  drawOrder,
  wipeouts,
  orderedEntities,
) {
  const reservedBlockSpans = externalReferenceBlockSpans(
    scene.metadata.blocks,
  );
  let maskOrder = buildMaskOrderPlan(
    drawOrder,
    wipeouts,
    scene.metadata.blocks,
    scene.metadata.inserts,
    {
      orderedEntitySources: orderedEntities.limited
        ? []
        : [orderedEntities],
      reservedBlockSpans,
    },
  );
  if (orderedEntities.limited && maskOrder.enabled) {
    maskOrder = Object.freeze({
      ...maskOrder,
      generalOrderReason: "order-identity-limit",
    });
  }
  if (!maskOrder.enabled) {
    const generalOrderReason = orderedEntities.limited
      ? "order-identity-limit"
      : maskOrder.reason;
    const maskOnlyFallback = buildMaskOrderPlan(
      drawOrder,
      wipeouts,
      scene.metadata.blocks,
      scene.metadata.inserts,
      {
        includeOverrideTargets: false,
        reservedBlockSpans,
      },
    );
    if (maskOnlyFallback.enabled) {
      maskOrder = Object.freeze({
        ...maskOnlyFallback,
        generalOrderReason,
      });
    }
  }
  return maskOrder;
}

async function readSceneMaskOrder(scene) {
  const [drawOrder, wipeouts, orderedEntities] = await Promise.all([
    scene.reader.readDrawOrder(),
    scene.reader.readWipeoutEntities(),
    scene.reader.readDisplayOrderIdentities(),
  ]);
  return makeSceneMaskOrder(
    scene,
    drawOrder,
    wipeouts,
    orderedEntities,
  );
}

async function initializeMaskComposition(scene, revision) {
  const fallback = Object.freeze({
    maskOrder: null,
    instanceGraph: scene.instanceGraph,
  });
  status.textContent = "가림 객체의 앞·뒤 순서를 계산하는 중";
  const started = performance.now();
  const maskOrder = await readSceneMaskOrder(scene);
  if (revision !== openRevision || activeScene !== scene) {
    return fallback;
  }
  const instanceGraph = maskOrder.enabled
    ? typeof scene.buildViewInstanceGraph === "function"
      ? scene.buildViewInstanceGraph(scene.activeView, { maskOrder })
      : applyMaskOrderToInstanceGraph(
          scene.instanceGraph,
          scene.metadata.blocks,
          maskOrder,
        )
    : scene.instanceGraph;
  const enabled =
    maskOrder.enabled && instanceGraph.maskOrderEnabled;
  const buildMs = performance.now() - started;
  activeMaskStatus = Object.freeze({
    enabled,
    generalOrderEnabled: Boolean(maskOrder.generalOrderEnabled),
    masks: maskOrder.masks.length,
    generalOrderReason: maskOrder.generalOrderReason ?? null,
    tables: maskOrder.diagnostics.tables,
    entries: maskOrder.diagnostics.entries,
    maximumExpandedMasks: maskOrder.maximumExpandedMasks,
    buildMs,
    reason: enabled ? null : maskOrder.reason ?? "instance-graph",
  });
  if (!enabled) {
    return fallback;
  }
  scene.renderer.setMaskComposition({
    maskOrder,
    instanceGraph,
    blocks: scene.metadata.blocks,
    overviewVertices: scene.overview,
  });
  scene.renderer.redraw(scene.render.camera);
  return Object.freeze({ maskOrder, instanceGraph });
}

function workerCamera(camera) {
  if (!camera) {
    return null;
  }
  return {
    origin: [...camera.origin],
    worldWidth: camera.worldWidth,
    worldHeight: camera.worldHeight,
    width: camera.width,
    height: camera.height,
  };
}

function patternCameraKey(camera) {
  return [
    ...camera.origin,
    camera.worldWidth,
    camera.worldHeight,
    camera.width,
    camera.height,
  ]
    .map((value) => Number(value).toPrecision(12))
    .join(":");
}

function hatchWorkerView(scene) {
  const view =
    scene.views.find((candidate) => candidate.id === activeViewId) ??
    scene.activeView;
  return view?.kind === "layout"
    ? Object.freeze({
        kind: "layout",
        layoutIndex: view.layout.index,
      })
    : Object.freeze({ kind: "model" });
}

async function createViewerWorker(relativeUrl) {
  const workerUrl = new URL(relativeUrl, import.meta.url);
  if (!vscodeApi) {
    const worker = new Worker(workerUrl, { type: "module" });
    return {
      worker,
      terminate() {
        worker.terminate();
      },
    };
  }
  const response = await fetch(workerUrl);
  if (!response.ok) {
    throw new Error(`작업 모듈을 읽을 수 없습니다 (${response.status})`);
  }
  const blobUrl = URL.createObjectURL(
    new Blob([await response.arrayBuffer()], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl, { type: "module" });
  return {
    worker,
    terminate() {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    },
  };
}

function workerSourcePayload(workerSource) {
  return workerSource.kind === "host"
    ? { hostSource: { size: workerSource.source.size } }
    : { file: workerSource.file };
}

function remapExternalVertices(
  vertices,
  layerMap,
  {
    recordSize = 32,
    linetypeMap = null,
  } = {},
) {
  if (!vertices?.buffer || vertices.byteLength === 0) {
    return vertices;
  }
  remapLineVertexLayers(vertices.buffer, layerMap, recordSize);
  if (linetypeMap) {
    remapLineVertexLinetypes(
      vertices.buffer,
      linetypeMap,
      recordSize,
    );
  }
  return vertices;
}

function remapExternalPrimitiveResult(result, layerMap, linetypeMap) {
  remapExternalVertices(result.primitives.points.vertices, layerMap);
  remapExternalVertices(result.primitives.solidFills.vertices, layerMap);
  remapExternalVertices(
    result.primitives.solidOutlines.vertices,
    layerMap,
    { linetypeMap },
  );
  remapExternalVertices(result.primitives.wipeoutMasks.vertices, layerMap);
  return result;
}

function remapExternalHatchResult(result, layerMap, linetypeMap) {
  remapExternalVertices(result.fill.vertices, layerMap);
  if (result.pattern) {
    remapExternalVertices(result.pattern.vertices, layerMap, {
      linetypeMap,
    });
  }
  return result;
}

function remapExternalCurveResult(result, layerMap, linetypeMap) {
  for (const entry of result.refinement.entries) {
    remapExternalVertices(entry.vertices, layerMap, {
      recordSize: entry.vertices.recordSize ?? 36,
      linetypeMap,
    });
  }
  return result;
}

async function createHatchWorker(workerSource) {
  const workerHandle = await createViewerWorker("./hatch-worker.mjs");
  const { worker } = workerHandle;
  const removeRangeProxy =
    workerSource.kind === "host"
      ? installWorkerRangeProxy(worker, workerSource.source)
      : () => {};
  const pending = new Map();
  let nextRequestId = 1;
  let closed = false;
  const terminate = () => {
    removeRangeProxy();
    workerHandle.terminate();
  };
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  worker.addEventListener("message", (event) => {
    if (event.data?.type === WORKER_RANGE_REQUEST) {
      return;
    }
    const request = pending.get(event.data.requestId);
    if (!request) {
      return;
    }
    pending.delete(event.data.requestId);
    if (event.data.ok) {
      request.resolve(event.data);
    } else {
      request.reject(new Error(event.data.error));
    }
  });
  worker.addEventListener("error", (event) => {
    if (closed) {
      return;
    }
    closed = true;
    terminate();
    rejectPending(new Error(event.message || "HATCH worker failed"));
  });
  return {
    request(type, payload = {}) {
      if (closed) {
        return Promise.reject(
          new DOMException("HATCH 작업 취소됨", "AbortError"),
        );
      }
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ requestId, type, ...payload });
      });
    },
    cancel() {
      if (closed) {
        return;
      }
      closed = true;
      terminate();
      rejectPending(new DOMException("HATCH 작업 취소됨", "AbortError"));
    },
  };
}

async function createCurveWorker(workerSource) {
  const workerHandle = await createViewerWorker("./curve-worker.mjs");
  const { worker } = workerHandle;
  const removeRangeProxy =
    workerSource.kind === "host"
      ? installWorkerRangeProxy(worker, workerSource.source)
      : () => {};
  const pending = new Map();
  let nextRequestId = 1;
  let closed = false;
  const terminate = () => {
    removeRangeProxy();
    workerHandle.terminate();
  };
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  worker.addEventListener("message", (event) => {
    if (event.data?.type === WORKER_RANGE_REQUEST) {
      return;
    }
    const request = pending.get(event.data.requestId);
    if (!request) {
      return;
    }
    pending.delete(event.data.requestId);
    if (event.data.ok) {
      request.resolve(event.data);
    } else {
      request.reject(new Error(event.data.error));
    }
  });
  worker.addEventListener("error", (event) => {
    if (closed) {
      return;
    }
    closed = true;
    terminate();
    rejectPending(
      new Error(event.message || "곡선 정밀화 worker failed"),
    );
  });
  return {
    request(type, payload = {}) {
      if (closed) {
        return Promise.reject(
          new DOMException("곡선 정밀화 작업 취소됨", "AbortError"),
        );
      }
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ requestId, type, ...payload });
      });
    },
    cancel() {
      if (closed) {
        return;
      }
      closed = true;
      terminate();
      rejectPending(
        new DOMException("곡선 정밀화 작업 취소됨", "AbortError"),
      );
    },
  };
}

async function createPrimitiveWorker(workerSource) {
  const workerHandle = await createViewerWorker("./primitive-worker.mjs");
  const { worker } = workerHandle;
  const removeRangeProxy =
    workerSource.kind === "host"
      ? installWorkerRangeProxy(worker, workerSource.source)
      : () => {};
  let settled = false;
  let rejectRequest;
  let messageListener;
  let errorListener;
  const terminate = () => {
    if (messageListener) {
      worker.removeEventListener("message", messageListener);
      messageListener = undefined;
    }
    if (errorListener) {
      worker.removeEventListener("error", errorListener);
      errorListener = undefined;
    }
    removeRangeProxy();
    workerHandle.terminate();
  };
  return {
    initialize(wipeoutFrame, fillMode, maskOrder) {
      if (settled) {
        return Promise.reject(
          new DOMException("후처리 작업 취소됨", "AbortError"),
        );
      }
      return new Promise((resolve, reject) => {
        rejectRequest = reject;
        messageListener = (event) => {
          if (
            settled ||
            event.data?.type === WORKER_RANGE_REQUEST
          ) {
            return;
          }
          settled = true;
          terminate();
          rejectRequest = undefined;
          if (event.data.ok) {
            resolve(event.data);
          } else {
            reject(new Error(event.data.error));
          }
        };
        errorListener = (event) => {
          if (settled) {
            return;
          }
          settled = true;
          terminate();
          rejectRequest = undefined;
          reject(new Error(event.message || "후처리 worker failed"));
        };
        worker.addEventListener("message", messageListener);
        worker.addEventListener("error", errorListener);
        worker.postMessage({
          requestId: 1,
          type: "initialize",
          ...workerSourcePayload(workerSource),
          wipeoutFrame,
          fillMode,
          maskOrder,
        });
      });
    },
    cancel() {
      if (settled) {
        return;
      }
      settled = true;
      terminate();
      rejectRequest?.(
        new DOMException("후처리 작업 취소됨", "AbortError"),
      );
      rejectRequest = undefined;
    },
  };
}

async function createReviewEntityWorker(workerSource) {
  const workerHandle = await createViewerWorker(
    "./review-entity-worker.mjs",
  );
  const { worker } = workerHandle;
  const removeRangeProxy =
    workerSource.kind === "host"
      ? installWorkerRangeProxy(worker, workerSource.source)
      : () => {};
  let settled = false;
  let rejectRequest;
  let messageListener;
  let errorListener;
  const terminate = () => {
    if (messageListener) {
      worker.removeEventListener("message", messageListener);
      messageListener = undefined;
    }
    if (errorListener) {
      worker.removeEventListener("error", errorListener);
      errorListener = undefined;
    }
    removeRangeProxy();
    workerHandle.terminate();
  };
  return {
    initialize(
      view,
      {
        externalContext = null,
        limits = null,
      } = {},
    ) {
      if (settled) {
        return Promise.reject(
          new DOMException("채움 객체 검토 작업 취소됨", "AbortError"),
        );
      }
      return new Promise((resolve, reject) => {
        rejectRequest = reject;
        messageListener = (event) => {
          if (
            settled ||
            event.data?.type === WORKER_RANGE_REQUEST
          ) {
            return;
          }
          settled = true;
          terminate();
          rejectRequest = undefined;
          if (event.data.ok) {
            resolve(event.data);
          } else {
            reject(new Error(event.data.error));
          }
        };
        errorListener = (event) => {
          if (settled) {
            return;
          }
          settled = true;
          terminate();
          rejectRequest = undefined;
          reject(
            new Error(event.message || "채움 객체 검토 worker failed"),
          );
        };
        worker.addEventListener("message", messageListener);
        worker.addEventListener("error", errorListener);
        worker.postMessage({
          requestId: 1,
          type: "initialize",
          ...workerSourcePayload(workerSource),
          view,
          externalContext,
          limits,
        });
      });
    },
    cancel() {
      if (settled) {
        return;
      }
      settled = true;
      terminate();
      rejectRequest?.(
        new DOMException("채움 객체 검토 작업 취소됨", "AbortError"),
      );
      rejectRequest = undefined;
    },
  };
}

async function loadFilledObjectReviewData(
  workerSource,
  scene,
  signal,
  {
    externalContext = null,
    limits = null,
  } = {},
) {
  if (!workerSource || signal?.aborted) {
    throw new DOMException("채움 객체 검토 작업 취소됨", "AbortError");
  }
  const worker = await createReviewEntityWorker(workerSource);
  const cancel = () => worker.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    worker.cancel();
  }
  try {
    const result = await worker.initialize(
      scene ? hatchWorkerView(scene) : null,
      { externalContext, limits },
    );
    return result.review;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

const MAX_REVIEW_EXTERNAL_CONTEXTS = 64;

function filledReviewUsage(data) {
  return Object.freeze({
    occurrences:
      data?.metrics?.occurrences ?? data?.records?.length ?? 0,
    rings:
      data?.metrics?.rings ?? data?.ringStarts?.length ?? 0,
    vertices:
      data?.metrics?.vertices ??
      (data?.displayPoints?.length ?? 0) / 3,
  });
}

function remainingFilledReviewLimits(usage) {
  return Object.freeze({
    maximumOccurrences: Math.max(
      0,
      MAX_REVIEW_FILLED_OCCURRENCES - usage.occurrences,
    ),
    maximumRings: Math.max(
      0,
      MAX_REVIEW_FILLED_RINGS - usage.rings,
    ),
    maximumVertices: Math.max(
      0,
      MAX_REVIEW_FILLED_VERTICES - usage.vertices,
    ),
  });
}

function filledReviewLimitReached(usage) {
  return (
    usage.occurrences >= MAX_REVIEW_FILLED_OCCURRENCES ||
    usage.rings >= MAX_REVIEW_FILLED_RINGS ||
    usage.vertices >= MAX_REVIEW_FILLED_VERTICES
  );
}

async function loadFilledObjectReviewSources(
  workerSource,
  scene,
  signal,
) {
  const sources = [];
  const usage = {
    occurrences: 0,
    rings: 0,
    vertices: 0,
  };
  let truncated = false;
  let failedSources = 0;
  const root = await loadFilledObjectReviewData(
    workerSource,
    scene,
    signal,
    { limits: remainingFilledReviewLimits(usage) },
  );
  const rootUsage = filledReviewUsage(root);
  usage.occurrences += rootUsage.occurrences;
  usage.rings += rootUsage.rings;
  usage.vertices += rootUsage.vertices;
  truncated ||= Boolean(root.truncated);
  sources.push(
    Object.freeze({
      id: "root",
      label: "현재 도면",
      layers: scene.metadata.layers,
      data: root,
    }),
  );

  const contexts = [];
  for (const [cacheId, attachments] of externalAttachmentsByCache) {
    for (const attachment of attachments) {
      if (attachment.reviewContext) {
        contexts.push(
          Object.freeze({
            cacheId,
            ...attachment,
          }),
        );
      }
    }
  }
  contexts.sort(
    (left, right) =>
      left.prefix.localeCompare(right.prefix, "ko") ||
      left.id.localeCompare(right.id, "en"),
  );
  if (contexts.length > MAX_REVIEW_EXTERNAL_CONTEXTS) {
    contexts.length = MAX_REVIEW_EXTERNAL_CONTEXTS;
    truncated = true;
  }

  for (const context of contexts) {
    if (signal?.aborted) {
      throw new DOMException(
        "채움 객체 검토 작업 취소됨",
        "AbortError",
      );
    }
    if (filledReviewLimitReached(usage)) {
      truncated = true;
      break;
    }
    const source = externalHostSources.get(context.cacheId);
    if (!source) {
      failedSources += 1;
      continue;
    }
    try {
      const data = await loadFilledObjectReviewData(
        { kind: "host", source },
        null,
        signal,
        {
          externalContext: context.reviewContext,
          limits: remainingFilledReviewLimits(usage),
        },
      );
      const currentUsage = filledReviewUsage(data);
      usage.occurrences += currentUsage.occurrences;
      usage.rings += currentUsage.rings;
      usage.vertices += currentUsage.vertices;
      truncated ||= Boolean(data.truncated);
      if (data.records.length > 0) {
        sources.push(
          Object.freeze({
            id: context.id,
            label: context.prefix,
            layers: scene.metadata.layers,
            data,
          }),
        );
      }
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) {
        throw error;
      }
      failedSources += 1;
      console.warn(
        `${context.prefix} 채움 객체 선택 정보 생략:`,
        error,
      );
    }
  }
  return Object.freeze({
    sources: Object.freeze(sources),
    truncated,
    failedSources,
  });
}

async function initializePrimitives(
  workerSource,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  activePrimitiveStatus = Object.freeze({ state: "loading" });
  status.textContent =
    "점·솔리드·폭 폴리라인·3D 면·가림 객체 원본을 별도 작업 공간에서 읽는 중";
  const worker = await createPrimitiveWorker(workerSource);
  if (revision !== openRevision || activeScene !== scene) {
    worker.cancel();
    return;
  }
  activePrimitiveWorker = worker;
  let result;
  try {
    result = await worker.initialize(
      scene.metadata.drawing.wipeoutFrame,
      scene.metadata.drawing.fillMode,
      maskOrder,
    );
  } finally {
    if (activePrimitiveWorker === worker) {
      activePrimitiveWorker = undefined;
    }
  }
  if (revision !== openRevision || activeScene !== scene) {
    return;
  }
  scene.renderer.setPrimitiveMeshes(result.primitives);
  activePrimitiveStatus = Object.freeze({
    state: "ready",
    metrics: result.primitives.metrics,
    reads: result.reads,
  });
  activeInteraction?.refresh();
  const value = result.primitives.metrics;
  const warnings =
    value.skippedOwners +
    value.skippedDegenerateTriangles +
    value.skippedInvalidWidePolylines +
    Number(value.pointGpuLimitReached) +
    Number(value.solidFillGpuLimitReached) +
    Number(value.solidOutlineGpuLimitReached) +
    Number(value.faceOutlineGpuLimitReached) +
    Number(value.wipeoutOutlineGpuLimitReached) +
    Number(value.wipeoutMaskGpuLimitReached) +
    Number(value.widePolylineGpuLimitReached);
  status.textContent =
    `점 ${value.renderedPoints.toLocaleString()}개 · 솔리드 ${(value.renderedFilledSolids + value.renderedOutlineSolids).toLocaleString()}개 · 폭 폴리라인 ${(value.renderedFilledWidePolylines + value.renderedOutlineWidePolylines).toLocaleString()}개 · 3D 면 ${value.renderedFaces.toLocaleString()}개 · 가림 ${value.renderedWipeoutMasks.toLocaleString()}개 표시 완료` +
    (warnings > 0 ? ` · 제한/건너뜀 ${warnings.toLocaleString()}건` : "");
}

async function initializeHatchFills(
  workerSource,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  activeHatchStatus = Object.freeze({ state: "loading" });
  status.textContent = "해치 원본을 별도 작업 공간에서 읽는 중";
  const worker = await createHatchWorker(workerSource);
  if (revision !== openRevision || activeScene !== scene) {
    worker.cancel();
    return;
  }
  activeHatchWorker = worker;
  const initialPatternCameraKey = patternCameraKey(scene.render.camera);
  const result = await worker.request("initialize", {
    ...workerSourcePayload(workerSource),
    camera: workerCamera(scene.render.camera),
    maskOrder,
    view: hatchWorkerView(scene),
  });
  if (revision !== openRevision || activeScene !== scene) {
    worker.cancel();
    return;
  }
  scene.renderer.setHatchFills(result.fill);
  const currentCamera =
    activeInteraction?.snapshot().render.camera ?? scene.render.camera;
  const currentCameraKey = patternCameraKey(currentCamera);
  const acceptedPattern =
    result.pattern && currentCameraKey === initialPatternCameraKey
      ? result.pattern
      : null;
  if (acceptedPattern) {
    scene.renderer.setHatchPatterns(acceptedPattern);
    lastPatternCameraKey = initialPatternCameraKey;
  }
  activeHatchStatus = Object.freeze({
    state: "ready",
    fillMetrics: result.fill.metrics,
    patternMetrics: acceptedPattern?.metrics ?? null,
    reads: result.reads,
  });
  activeInteraction?.refresh();
  const warnings =
    result.fill.metrics.truncatedHatches +
    result.fill.metrics.sourceTruncatedHatches +
    result.fill.metrics.skippedTriangulations +
    (acceptedPattern?.metrics.truncatedHatches ?? 0);
  status.textContent =
    `해치 ${result.fill.metrics.renderedHatches.toLocaleString()}개 · 패턴 ${(acceptedPattern?.metrics.renderedHatches ?? 0).toLocaleString()}개 표시 완료` +
    (warnings > 0 ? ` · 제한/건너뜀 ${warnings.toLocaleString()}건` : "");
  if (currentCamera) {
    scheduleHatchPatterns(scene, currentCamera, revision);
  }
}

function scheduleHatchPatterns(scene, camera, revision) {
  const cameraKey = patternCameraKey(camera);
  const rootPending =
    activeHatchStatus?.state === "ready" &&
    Boolean(activeHatchWorker) &&
    cameraKey !== lastPatternCameraKey;
  const externalPending = [...externalHatchContexts.values()].some(
    (context) =>
      context.revision === revision &&
      context.rootScene === scene &&
      context.ready &&
      context.lastCameraKey !== cameraKey,
  );
  if (!rootPending && !externalPending) {
    return;
  }
  const requestRevision = ++patternRequestRevision;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
  }
  hatchPatternTimer = setTimeout(async () => {
    hatchPatternTimer = undefined;
    if (
      revision !== openRevision ||
      activeScene !== scene
    ) {
      return;
    }
    if (rootPending && activeHatchWorker) {
      try {
        const result = await activeHatchWorker.request("render-pattern", {
          camera: workerCamera(camera),
          view: hatchWorkerView(scene),
        });
        if (
          requestRevision !== patternRequestRevision ||
          revision !== openRevision ||
          activeScene !== scene
        ) {
          return;
        }
        scene.renderer.setHatchPatterns(result.pattern);
        lastPatternCameraKey = cameraKey;
        activeHatchStatus = Object.freeze({
          ...activeHatchStatus,
          patternMetrics: result.pattern.metrics,
        });
      } catch (error) {
        if (
          error?.name !== "AbortError" &&
          requestRevision === patternRequestRevision &&
          revision === openRevision
        ) {
          status.textContent = `패턴 해치 표시 실패: ${error.message}`;
          console.error(error);
        }
      }
    }
    for (const [sceneId, context] of externalHatchContexts) {
      if (
        requestRevision !== patternRequestRevision ||
        revision !== openRevision ||
        activeScene !== scene
      ) {
        return;
      }
      if (
        context.revision !== revision ||
        context.rootScene !== scene ||
        !context.ready ||
        context.lastCameraKey === cameraKey
      ) {
        continue;
      }
      try {
        const result = await context.worker.request("render-pattern", {
          camera: workerCamera(camera),
          view: Object.freeze({ kind: "model" }),
        });
        if (
          requestRevision !== patternRequestRevision ||
          externalHatchContexts.get(sceneId) !== context
        ) {
          return;
        }
        remapExternalVertices(result.pattern.vertices, context.layerMap, {
          linetypeMap: context.linetypeMap,
        });
        scene.renderer.setExternalHatchPatterns(
          sceneId,
          result.pattern,
        );
        context.lastCameraKey = cameraKey;
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error(`참조도면 ${sceneId} 패턴 해치 표시 실패:`, error);
        }
        if (externalHatchContexts.get(sceneId) === context) {
          context.worker.cancel();
          externalHatchContexts.delete(sceneId);
        }
      }
    }
    activeInteraction?.refresh();
  }, HATCH_PATTERN_DEBOUNCE_MS);
}

function invalidatePendingHatchPatterns() {
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
}

function invalidatePendingCurveRefinement({ clear = false } = {}) {
  curveRequestRevision += 1;
  pendingCurveRequest = undefined;
  if (curveRefinementTimer !== undefined) {
    clearTimeout(curveRefinementTimer);
    curveRefinementTimer = undefined;
  }
  if (clear && activeScene) {
    activeScene.renderer.clearCurveRefinement();
    activeCurveStatus = undefined;
  }
}

async function drainCurveRefinementRequest() {
  if (curveRequestInFlight || !pendingCurveRequest) {
    return;
  }
  const request = pendingCurveRequest;
  pendingCurveRequest = undefined;
  curveRequestInFlight = true;
  let worker = activeCurveWorker;
  try {
    if (
      request.revision !== openRevision ||
      request.scene !== activeScene ||
      !activeCurveWorkerSource
    ) {
      return;
    }
    if (!worker) {
      worker = await createCurveWorker(activeCurveWorkerSource);
      if (
        request.revision !== openRevision ||
        request.scene !== activeScene
      ) {
        worker.cancel();
        return;
      }
      activeCurveWorker = worker;
    }
    activeCurveStatus = Object.freeze({
      state: curveWorkerReady ? "refining" : "loading",
      cameraKey: request.cameraKey,
      metrics: activeCurveStatus?.metrics,
      reads: activeCurveStatus?.reads,
      source: activeCurveStatus?.source,
    });
    const result = curveWorkerReady
      ? await worker.request("render", {
          camera: request.camera,
          cameraKey: request.cameraKey,
          view: request.view,
        })
      : await worker.request("initialize", {
          ...workerSourcePayload(activeCurveWorkerSource),
          camera: request.camera,
          cameraKey: request.cameraKey,
          view: request.view,
          maskOrder: activeMaskOrder,
          metadata: {
            layers: request.scene.metadata.layers,
            linetypes: request.scene.metadata.linetypes,
            blocks: request.scene.metadata.blocks,
            inserts: request.scene.metadata.inserts,
            insertClips: request.scene.metadata.insertClips,
            layouts: request.scene.metadata.layouts,
          },
        });
    curveWorkerReady = true;
    const currentCamera =
      activeInteraction?.snapshot().render.camera;
    if (
      request.token !== curveRequestRevision ||
      request.revision !== openRevision ||
      request.scene !== activeScene ||
      request.cameraKey !== curveRefinementCameraKey(currentCamera)
    ) {
      return;
    }
    request.scene.renderer.setCurveRefinement({
      ...result.refinement,
      cameraKey: request.cameraKey,
    });
    activeCurveStatus = Object.freeze({
      state: "ready",
      cameraKey: request.cameraKey,
      metrics: result.refinement.metrics,
      reads: result.reads ?? activeCurveStatus?.reads,
      source: result.source ?? activeCurveStatus?.source,
    });
    activeInteraction?.refresh();
  } catch (error) {
    if (
      error?.name !== "AbortError" &&
      request.revision === openRevision &&
      request.scene === activeScene
    ) {
      activeCurveStatus = Object.freeze({
        state: "error",
        cameraKey: request.cameraKey,
        error: error.message,
      });
      status.textContent = `곡선 정밀화 실패: ${error.message}`;
      console.error(error);
    }
    if (!curveWorkerReady && activeCurveWorker === worker) {
      worker?.cancel();
      activeCurveWorker = undefined;
    }
  } finally {
    curveRequestInFlight = false;
    if (pendingCurveRequest) {
      curveRefinementTimer = setTimeout(() => {
        curveRefinementTimer = undefined;
        drainCurveRefinementRequest();
      }, 0);
    }
  }
}

function scheduleCurveRefinement(scene, viewport, revision) {
  if (
    revision !== openRevision ||
    scene !== activeScene ||
    !activeCurveWorkerSource
  ) {
    return;
  }
  if (viewport.render.interactive) {
    invalidatePendingCurveRefinement();
    return;
  }
  if (viewport.zoom < CURVE_REFINEMENT_ZOOM_THRESHOLD) {
    invalidatePendingCurveRefinement({ clear: true });
    return;
  }
  const camera = workerCamera(viewport.render.camera);
  const cameraKey = curveRefinementCameraKey(camera);
  if (
    activeCurveStatus?.state === "ready" &&
    activeCurveStatus.cameraKey === cameraKey
  ) {
    return;
  }
  const token = ++curveRequestRevision;
  pendingCurveRequest = Object.freeze({
    token,
    revision,
    scene,
    camera,
    cameraKey,
    view: hatchWorkerView(scene),
  });
  if (curveRefinementTimer !== undefined) {
    clearTimeout(curveRefinementTimer);
  }
  curveRefinementTimer = setTimeout(() => {
    curveRefinementTimer = undefined;
    drainCurveRefinementRequest();
  }, CURVE_REFINEMENT_DEBOUNCE_MS);
}

async function drainExternalCurveRefinementRequest() {
  if (externalCurveRequestInFlight || !pendingExternalCurveRequest) {
    return;
  }
  const request = pendingExternalCurveRequest;
  pendingExternalCurveRequest = undefined;
  externalCurveRequestInFlight = true;
  try {
    for (const [sceneId, context] of externalCurveContexts) {
      if (
        request.token !== externalCurveRequestRevision ||
        request.revision !== openRevision ||
        request.scene !== activeScene
      ) {
        return;
      }
      if (
        context.revision !== request.revision ||
        context.rootScene !== request.scene ||
        context.cameraKey === request.cameraKey
      ) {
        continue;
      }
      let worker = context.worker;
      try {
        if (!worker) {
          worker = await createCurveWorker(context.workerSource);
          if (
            request.token !== externalCurveRequestRevision ||
            externalCurveContexts.get(sceneId) !== context
          ) {
            worker.cancel();
            return;
          }
          context.worker = worker;
        }
        const result = context.ready
          ? await worker.request("render", {
              camera: request.camera,
              cameraKey: request.cameraKey,
              view: Object.freeze({ kind: "model" }),
            })
          : await worker.request("initialize", {
              ...workerSourcePayload(context.workerSource),
              camera: request.camera,
              cameraKey: request.cameraKey,
              view: Object.freeze({ kind: "model" }),
              maskOrder: context.maskOrder,
              metadata: context.metadata,
              externalInstanceGraph: context.instanceGraph,
            });
        context.ready = true;
        if (
          request.token !== externalCurveRequestRevision ||
          request.revision !== openRevision ||
          request.scene !== activeScene ||
          externalCurveContexts.get(sceneId) !== context ||
          request.cameraKey !==
            curveRefinementCameraKey(
              activeInteraction?.snapshot().render.camera,
            )
        ) {
          return;
        }
        remapExternalCurveResult(
          result,
          context.layerMap,
          context.linetypeMap,
        );
        request.scene.renderer.setExternalCurveRefinement(
          sceneId,
          {
            ...result.refinement,
            cameraKey: request.cameraKey,
          },
        );
        context.cameraKey = request.cameraKey;
      } catch (error) {
        if (context.worker === worker) {
          worker?.cancel();
          context.worker = null;
          context.ready = false;
        }
        if (error?.name !== "AbortError") {
          console.error(`참조도면 ${sceneId} 곡선 정밀화 실패:`, error);
        }
      }
    }
    activeInteraction?.refresh();
  } finally {
    externalCurveRequestInFlight = false;
    if (pendingExternalCurveRequest) {
      externalCurveRefinementTimer = setTimeout(() => {
        externalCurveRefinementTimer = undefined;
        drainExternalCurveRefinementRequest();
      }, 0);
    }
  }
}

function scheduleExternalCurveRefinement(scene, viewport, revision) {
  if (
    revision !== openRevision ||
    scene !== activeScene ||
    externalCurveContexts.size === 0
  ) {
    return;
  }
  if (viewport.render.interactive) {
    externalCurveRequestRevision += 1;
    pendingExternalCurveRequest = undefined;
    if (externalCurveRefinementTimer !== undefined) {
      clearTimeout(externalCurveRefinementTimer);
      externalCurveRefinementTimer = undefined;
    }
    return;
  }
  if (viewport.zoom < CURVE_REFINEMENT_ZOOM_THRESHOLD) {
    externalCurveRequestRevision += 1;
    pendingExternalCurveRequest = undefined;
    if (externalCurveRefinementTimer !== undefined) {
      clearTimeout(externalCurveRefinementTimer);
      externalCurveRefinementTimer = undefined;
    }
    for (const [sceneId, context] of externalCurveContexts) {
      if (context.cameraKey !== null) {
        scene.renderer.clearExternalCurveRefinement(sceneId);
        context.cameraKey = null;
      }
    }
    return;
  }
  const camera = workerCamera(viewport.render.camera);
  const cameraKey = curveRefinementCameraKey(camera);
  if (
    [...externalCurveContexts.values()].every(
      (context) => context.cameraKey === cameraKey,
    )
  ) {
    return;
  }
  const token = ++externalCurveRequestRevision;
  pendingExternalCurveRequest = Object.freeze({
    token,
    revision,
    scene,
    camera,
    cameraKey,
  });
  if (externalCurveRefinementTimer !== undefined) {
    clearTimeout(externalCurveRefinementTimer);
  }
  externalCurveRefinementTimer = setTimeout(() => {
    externalCurveRefinementTimer = undefined;
    drainExternalCurveRefinementRequest();
  }, CURVE_REFINEMENT_DEBOUNCE_MS);
}

async function initializeDeferredGeometry(
  workerSource,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  try {
    await initializePrimitives(workerSource, scene, revision, maskOrder);
  } catch (error) {
    if (revision === openRevision && activeScene === scene) {
      activePrimitiveStatus = Object.freeze({
        state: "error",
        error: error.message,
      });
      status.textContent = `점·솔리드·폭 폴리라인 표시 실패: ${error.message}`;
      console.error(error);
    }
  }
  if (revision !== openRevision || activeScene !== scene) {
    return;
  }
  try {
    await initializeHatchFills(workerSource, scene, revision, maskOrder);
  } catch (error) {
    if (revision === openRevision && activeScene === scene) {
      activeHatchStatus = Object.freeze({
        state: "error",
        error: error.message,
      });
      status.textContent = `해치 표시 실패: ${error.message}`;
      console.error(error);
    }
  }
}

async function initializeExternalPrimitives({
  workerSource,
  childScene,
  sceneId,
  layerMap,
  linetypeMap,
  maskOrder,
  rootScene,
  revision,
}) {
  const worker = await createPrimitiveWorker(workerSource);
  if (revision !== openRevision || activeScene !== rootScene) {
    worker.cancel();
    return;
  }
  externalPrimitiveWorkers.add(worker);
  try {
    const result = await worker.initialize(
      childScene.metadata.drawing.wipeoutFrame,
      childScene.metadata.drawing.fillMode,
      maskOrder,
    );
    if (revision !== openRevision || activeScene !== rootScene) {
      return;
    }
    remapExternalPrimitiveResult(result, layerMap, linetypeMap);
    rootScene.renderer.setExternalPrimitiveMeshes(
      sceneId,
      result.primitives,
    );
  } finally {
    externalPrimitiveWorkers.delete(worker);
  }
}

async function initializeExternalHatches({
  workerSource,
  childScene,
  sceneId,
  composedInstanceGraph,
  layerMap,
  linetypeMap,
  maskOrder,
  rootScene,
  revision,
}) {
  externalHatchContexts.get(sceneId)?.worker.cancel();
  const worker = await createHatchWorker(workerSource);
  const context = {
    worker,
    revision,
    rootScene,
    layerMap,
    linetypeMap,
    lastCameraKey: null,
    ready: false,
  };
  if (revision !== openRevision || activeScene !== rootScene) {
    worker.cancel();
    return;
  }
  externalHatchContexts.set(sceneId, context);
  const camera =
    activeInteraction?.snapshot().render.camera ?? rootScene.render.camera;
  try {
    const result = await worker.request("initialize", {
      ...workerSourcePayload(workerSource),
      camera: workerCamera(camera),
      maskOrder,
      view: Object.freeze({ kind: "model" }),
      externalInstanceGraph: composedInstanceGraph,
    });
    if (
      revision !== openRevision ||
      activeScene !== rootScene ||
      externalHatchContexts.get(sceneId) !== context
    ) {
      worker.cancel();
      return;
    }
    remapExternalHatchResult(result, layerMap, linetypeMap);
    rootScene.renderer.setExternalHatchFills(sceneId, result.fill);
    context.ready = true;
    if (result.pattern) {
      rootScene.renderer.setExternalHatchPatterns(sceneId, result.pattern);
      context.lastCameraKey = patternCameraKey(camera);
    }
  } catch (error) {
    if (externalHatchContexts.get(sceneId) === context) {
      externalHatchContexts.delete(sceneId);
    }
    worker.cancel();
    throw error;
  }
}

function registerExternalCurveContext({
  workerSource,
  childScene,
  sceneId,
  composedInstanceGraph,
  layerMap,
  linetypeMap,
  maskOrder,
  rootScene,
  revision,
}) {
  externalCurveContexts.get(sceneId)?.worker?.cancel();
  externalCurveContexts.set(sceneId, {
    workerSource,
    metadata: {
      layers: childScene.metadata.layers,
      linetypes: childScene.metadata.linetypes,
      blocks: childScene.metadata.blocks,
      inserts: childScene.metadata.inserts,
      insertClips: childScene.metadata.insertClips,
      layouts: childScene.metadata.layouts,
    },
    instanceGraph: composedInstanceGraph,
    layerMap,
    linetypeMap,
    maskOrder,
    rootScene,
    revision,
    worker: null,
    ready: false,
    cameraKey: null,
  });
}

async function initializeExternalDeferredGeometry(options) {
  const results = await Promise.allSettled([
    initializeExternalPrimitives(options),
    initializeExternalHatches(options),
  ]);
  for (const result of results) {
    if (
      result.status === "rejected" &&
      result.reason?.name !== "AbortError"
    ) {
      console.error(result.reason);
    }
  }
  if (
    options.revision !== openRevision ||
    activeScene !== options.rootScene
  ) {
    return;
  }
  registerExternalCurveContext(options);
  const viewport = activeInteraction?.snapshot();
  if (viewport) {
    scheduleExternalCurveRefinement(
      options.rootScene,
      viewport,
      options.revision,
    );
  }
}

async function registerFontFiles(files) {
  if (files.length === 0) {
    return;
  }
  status.textContent = `SHX 글꼴 ${files.length.toLocaleString()}개 읽는 중`;
  const registered = await glyphCache.registerFiles(files);
  for (const font of registered) {
    hostLoadedFontKeys.delete(normalizeShxFontName(font.name));
  }
  if (activeScene) {
    if (activeScene.renderer.textOverlay) {
      activeInteraction?.refresh();
    } else {
      await initializeTextOverlay(activeScene, openRevision);
    }
    const styles = await activeScene.reader.readTextStyles();
    syncFontDiagnostics(styles);
    const missing = glyphCache.missingFonts(styles);
    activeTextStatus = Object.freeze({
      sourceTexts: activeTextStatus?.sourceTexts ?? 0,
      missingFonts: missing,
    });
    status.textContent =
      `SHX ${registered.length.toLocaleString()}개 등록` +
      (missing.length === 0 ? " · 누락 없음" : missingFontSuffix());
  } else {
    status.textContent = `SHX 글꼴 ${registered.length.toLocaleString()}개 등록 완료`;
  }
}

function discoverExternalReferences(scene, cacheId, depth = 0) {
  if (
    !vscodeApi ||
    !cacheId ||
    discoveredXrefCaches.has(cacheId)
  ) {
    return;
  }
  discoveredXrefCaches.add(cacheId);
  const references = scene.metadata.blocks
    .filter(
      (block) =>
        (block.flags & (1 << 2)) !== 0 &&
        typeof block.xrefPath === "string" &&
        block.xrefPath.length > 0,
    )
    .slice(0, 64)
    .map((block) => ({
      blockIndex: block.index,
      name: block.name,
      path: block.xrefPath,
      overlay: (block.flags & (1 << 3)) !== 0,
    }));
  for (const reference of references) {
    const key = `${cacheId}:${reference.blockIndex}`;
    if (!xrefDiagnostics.has(key)) {
      xrefDiagnostics.set(key, {
        ...reference,
        parentCacheId: cacheId,
        storedPath: reference.path,
        status: "waiting",
        depth,
      });
    }
  }
  renderXrefDiagnostics();
  if (references.length > 0) {
    vscodeApi.postMessage({
      type: "dwg-xrefs-discovered/1",
      cacheId,
      references,
    });
  }
}

function handleXrefStatus(message) {
  if (
    typeof message?.parentCacheId !== "string" ||
    !Number.isSafeInteger(message.blockIndex)
  ) {
    return;
  }
  const key = `${message.parentCacheId}:${message.blockIndex}`;
  const existing = xrefDiagnostics.get(key);
  if (!existing) {
    return;
  }
  xrefDiagnostics.set(key, {
    ...existing,
    status:
      typeof message.status === "string" ? message.status : "error",
    message:
      typeof message.message === "string"
        ? message.message.slice(0, 300)
        : undefined,
    canSelect: Boolean(message.canSelect),
  });
  renderXrefDiagnostics();
}

function externalParentContexts(parentCacheId) {
  if (
    parentCacheId === activeHostCacheId &&
    activeScene &&
    activeRenderInstanceGraph
  ) {
    return [
      {
        id: "root",
        prefix: "",
        instanceGraph: activeRenderInstanceGraph,
        orderScale: 1,
      },
    ];
  }
  return externalAttachmentsByCache.get(parentCacheId) ?? [];
}

function loadExternalCacheData(message, revision) {
  const existing = externalCacheData.get(message.cacheId);
  if (existing) {
    return existing;
  }
  const rawSource = createVsCodeRangeSource(vscodeApi, {
    cacheId: message.cacheId,
    size: message.size,
  });
  externalHostSources.set(message.cacheId, rawSource);
  const source = new TrackedRangeSource(rawSource);
  externalRangeSources.set(message.cacheId, source);
  const loading = loadExternalFirstFrame(source, {
    onProgress(progressMessage) {
      if (revision === openRevision) {
        status.textContent = progressMessage;
      }
    },
  })
    .then(async (scene) => {
      if (revision !== openRevision) {
        throw new Error("stale external reference load");
      }
      if (
        scene.overview.byteLength >
        MAX_EXTERNAL_SOURCE_OVERVIEW_BYTES -
          externalSourceOverviewBytes
      ) {
        throw new Error(
          `참조도면 첫 화면 데이터가 전체 ${formatBytes(
            MAX_EXTERNAL_SOURCE_OVERVIEW_BYTES,
          )} 한도를 초과합니다.`,
        );
      }
      externalSourceOverviewBytes += scene.overview.byteLength;
      let maskOrder = null;
      let maskInstanceGraph = scene.instanceGraph;
      try {
        const candidate = await readSceneMaskOrder(scene);
        if (candidate.enabled) {
          const orderedGraph = applyMaskOrderToInstanceGraph(
            scene.instanceGraph,
            scene.metadata.blocks,
            candidate,
          );
          if (orderedGraph.maskOrderEnabled) {
            maskOrder = candidate;
            maskInstanceGraph = orderedGraph;
          }
        }
      } catch (error) {
        console.warn("참조도면 표시 순서를 적용하지 못했습니다.", error);
      }
      if (revision !== openRevision) {
        throw new Error("stale external reference load");
      }
      return Object.freeze({
        scene,
        source,
        maskOrder,
        maskInstanceGraph,
      });
    })
    .catch((error) => {
      if (externalCacheData.get(message.cacheId) === loading) {
        externalCacheData.delete(message.cacheId);
        externalHostSources.delete(message.cacheId);
        externalRangeSources.delete(message.cacheId);
      }
      rawSource.dispose();
      throw error;
    });
  externalCacheData.set(message.cacheId, loading);
  return loading;
}

function enqueueExternalCacheReady(message) {
  const revision = openRevision;
  if (
    typeof message?.parentCacheId === "string" &&
    Number.isSafeInteger(message.parentBlockIndex) &&
    typeof message.cacheId === "string"
  ) {
    readyExternalMessages.set(
      `${message.parentCacheId}:${message.parentBlockIndex}:${message.cacheId}`,
      Object.freeze({ ...message }),
    );
  }
  externalLoadQueue = externalLoadQueue
    .catch(() => undefined)
    .then(async () => {
      if (revision !== openRevision) {
        return;
      }
      let mounted = false;
      try {
        await handleExternalCacheReady(message);
        mounted = true;
      } catch (error) {
        handleXrefStatus({
          parentCacheId: message.parentCacheId,
          blockIndex: message.parentBlockIndex,
          status: "error",
          message: `참조도면 표시 실패: ${
            error instanceof Error ? error.message : "알 수 없는 오류"
          }`,
        });
        console.error(error);
      } finally {
        if (
          vscodeApi &&
          typeof message?.parentCacheId === "string" &&
          Number.isSafeInteger(message.parentBlockIndex) &&
          typeof message.cacheId === "string"
        ) {
          vscodeApi.postMessage({
            type: "dwg-xref-mounted/1",
            parentCacheId: message.parentCacheId,
            blockIndex: message.parentBlockIndex,
            cacheId: message.cacheId,
            status: mounted ? "ready" : "error",
          });
        }
      }
    });
}

async function addExternalText(
  externalScene,
  composedInstanceGraph,
  layerMap,
  overview = null,
  sourceId = "external",
  sourceLabel = "외부 참조",
  linetypeMap = null,
  maskOrder = null,
  maskBucketScale = 1,
) {
  const revision = openRevision;
  const rootScene = activeScene;
  const textComposite = activeTextComposite;
  if (!rootScene || !textComposite) {
    return;
  }
  const needsComplexOverlay = Boolean(overview?.vertices);
  const [textEntities, styles, rootStyles] = await Promise.all([
    externalScene.reader.readTextEntities(),
    externalScene.reader.readTextStyles(),
    needsComplexOverlay
      ? rootScene.reader.readTextStyles()
      : Promise.resolve(null),
  ]);
  if (
    revision !== openRevision ||
    activeScene !== rootScene ||
    activeTextComposite !== textComposite
  ) {
    return;
  }
  const remapped = remapTextEntityLayers(
    textEntities,
    layerMap,
    linetypeMap,
  );
  const overlay = new CanvasTextOverlay(textCanvas, {
    textEntities: remapped,
    blocks: externalScene.metadata.blocks,
    layers: rootScene.metadata.layers,
    instanceGraph: composedInstanceGraph,
    glyphCache,
    maskOrder,
    orderCompositionEnabled: Boolean(
      activeMaskOrder?.generalOrderEnabled,
    ),
    orderDepthBias: 0,
    maskBucketScale,
    sourceId,
    sourceLabel,
    onInlineFonts: (names) =>
      requestInlineTextFonts(names, revision),
  });
  textComposite.add(overlay);
  if (needsComplexOverlay) {
    const complexOverlay = new ComplexLinetypeOverlay(textCanvas, {
      vertices: overview.vertices,
      batches: overview.batches,
      linetypes: rootScene.metadata.linetypes,
      textStyles: rootStyles,
      layers: rootScene.metadata.layers,
      instanceGraph: composedInstanceGraph,
      glyphCache,
      globalLinetypeScale:
        rootScene.metadata.drawing.globalLinetypeScale,
      blocks: externalScene.metadata.blocks,
      maskOrder,
      orderCompositionEnabled: Boolean(
        activeMaskOrder?.generalOrderEnabled,
      ),
      orderDepthBias: 0,
      maskBucketScale,
    });
    if (complexOverlay.source.sourceSegments > 0) {
      textComposite.add(complexOverlay);
    }
  }
  const combinedStyles = mergeTextStyles(activeTextStyles, styles);
  syncFontDiagnostics(combinedStyles);
  requestHostFonts(combinedStyles, revision);
}

async function addExternalImages(
  externalScene,
  cacheId,
  sceneId,
  composedInstanceGraph,
  layerMap,
  sourceLabel,
  maskOrder = null,
  maskBucketScale = 1,
) {
  const revision = openRevision;
  const rootScene = activeScene;
  const store = activeImageAssetStore;
  const composite = activeImageComposite;
  if (!rootScene || !store) {
    return;
  }
  const imageEntities =
    externalScene.imageEntities ??
    (await externalScene.reader.readImageEntities());
  if (
    revision !== openRevision ||
    activeScene !== rootScene ||
    activeImageAssetStore !== store ||
    activeImageComposite !== composite
  ) {
    return;
  }
  if (!activeImageComposite) {
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    rootScene.renderer.setImageOverlay(activeImageComposite);
  }
  activeImageComposite.setHitTestingEnabled(
    Boolean(activeReviewTools?.activeTool),
  );
  const overlay = new CanvasRasterImageOverlay(imageCanvas, {
      imageEntities,
      blocks: externalScene.metadata.blocks,
      layers: externalScene.metadata.layers,
      displayLayers: rootScene.metadata.layers,
      instanceGraph: composedInstanceGraph,
      cacheId,
      assetStore: store,
      requestAsset: requestRasterImage,
      maskOrder,
      orderCompositionEnabled: Boolean(
        activeMaskOrder?.generalOrderEnabled,
      ),
      orderDepthBias: -0.25 * maskBucketScale,
      layerMap,
      linetypeMap: buildExternalLinetypeMap(
        rootScene.metadata.linetypes,
        externalScene.metadata.linetypes,
      ),
      sourceId: sceneId,
      sourceLabel,
      maskBucketScale,
    });
  activeImageComposite.add(overlay);
  return rootScene.renderer.setSupplementalBounds(
    `image:${sceneId}`,
    overlay.bounds,
  );
}

function externalMaskState(loaded, parentContext) {
  const parentScale =
    Number.isFinite(parentContext.orderScale) &&
    parentContext.orderScale > 0 &&
    parentContext.orderScale <= 1
      ? parentContext.orderScale
      : 1;
  if (!activeMaskOrder?.enabled || !loaded.maskOrder?.enabled) {
    return Object.freeze({
      maskOrder: null,
      instanceGraph: loaded.scene.instanceGraph,
      maskBucketScale: parentScale,
      orderMapQuantized: false,
    });
  }
  const maskBucketScale =
    parentScale / (loaded.maskOrder.maximumExpandedMasks + 1);
  return Object.freeze({
    maskOrder: loaded.maskOrder,
    instanceGraph: loaded.maskInstanceGraph,
    maskBucketScale,
    orderMapQuantized:
      maskBucketScale < 1 / DRAW_ORDER_SUBDIVISIONS,
  });
}

async function handleExternalCacheReady(message) {
  if (
    !activeScene ||
    !activeInteraction ||
    typeof message?.cacheId !== "string" ||
    typeof message.parentCacheId !== "string" ||
    !Number.isSafeInteger(message.parentBlockIndex) ||
    !Number.isSafeInteger(message.size) ||
    message.size <= 0 ||
    typeof message.name !== "string"
  ) {
    return;
  }
  const revision = openRevision;
  const parentContexts = externalParentContexts(message.parentCacheId);
  if (parentContexts.length === 0) {
    return;
  }
  const loaded = await loadExternalCacheData(message, revision);
  if (revision !== openRevision || !activeScene || !activeInteraction) {
    return;
  }
  externalMaskCounts.set(
    message.cacheId,
    loaded.maskOrder?.masks.length ?? 0,
  );
  refreshMaskSourceCount();
  const childContexts = externalAttachmentsByCache.get(message.cacheId) ?? [];
  let lastFit;
  for (const parentContext of parentContexts) {
    const maskState = externalMaskState(loaded, parentContext);
    const prefix = parentContext.prefix
      ? `${parentContext.prefix}|${message.name}`
      : message.name;
    const layerMap = buildExternalLayerMap(
      activeScene.metadata.layers,
      loaded.scene.metadata.layers,
      prefix,
    );
    const linetypeMap = buildExternalLinetypeMap(
      activeScene.metadata.linetypes,
      loaded.scene.metadata.linetypes,
    );
    const composed = composeExternalInstanceGraph(
      parentContext.instanceGraph,
      message.parentBlockIndex,
      maskState.instanceGraph,
      loaded.scene.metadata.batches,
      layerMap,
      linetypeMap,
      maskState.maskBucketScale,
    );
    if (composed.instanceGraph.instanceCount === 0) {
      continue;
    }
    const sceneId = `${message.parentCacheId}:${message.parentBlockIndex}:${message.cacheId}:${parentContext.id}`;
    if (childContexts.some((context) => context.id === sceneId)) {
      continue;
    }
    let mountedOverview = null;
    if (
      loaded.scene.overview.byteLength > 0 &&
      composed.batches.some((batch) => batch.lodLevel === 0)
    ) {
      const overviewBuffer = loaded.scene.overview.buffer.slice(0);
      remapLineVertexLayers(
        overviewBuffer,
        layerMap,
        loaded.scene.overview.recordSize,
      );
      remapLineVertexLinetypes(
        overviewBuffer,
        linetypeMap,
        loaded.scene.overview.recordSize,
      );
      lastFit = activeScene.renderer.addExternalOverview({
        id: sceneId,
        batches: composed.batches,
        blocks: loaded.scene.metadata.blocks,
        instanceGraph: composed.instanceGraph,
        maskOrder: maskState.maskOrder,
        vertices: {
          buffer: overviewBuffer,
          byteLength: overviewBuffer.byteLength,
          vertexCount:
            overviewBuffer.byteLength / loaded.scene.overview.recordSize,
        },
      });
      const detailReader = {
        async readBatchVertices(batch) {
          const vertices =
            await loaded.scene.reader.readBatchVertices(batch);
          remapLineVertexLayers(
            vertices.buffer,
            layerMap,
            vertices.recordSize,
          );
          remapLineVertexLinetypes(
            vertices.buffer,
            linetypeMap,
            vertices.recordSize,
          );
          return vertices;
        },
      };
      activeInteraction.addExternalDetailSource(
        sceneId,
        detailReader,
        composed.batches,
        composed.instanceGraph,
      );
      mountedOverview = Object.freeze({
        batches: composed.batches,
        vertices: Object.freeze({
          buffer: overviewBuffer,
          byteLength: overviewBuffer.byteLength,
          vertexCount:
            overviewBuffer.byteLength / loaded.scene.overview.recordSize,
          recordSize: loaded.scene.overview.recordSize,
        }),
      });
    } else {
      lastFit = activeScene.renderer.addExternalOverview({
        id: sceneId,
        batches: Object.freeze([]),
        blocks: loaded.scene.metadata.blocks,
        instanceGraph: composed.instanceGraph,
        maskOrder: maskState.maskOrder,
        vertices: {
          buffer: new ArrayBuffer(0),
          byteLength: 0,
          vertexCount: 0,
        },
      });
    }
    activeReviewTools?.addSource(sceneId, {
      id: sceneId,
      label: prefix,
      batches: mountedOverview?.batches ?? [],
      vertices: mountedOverview?.vertices,
      instanceGraph: composed.instanceGraph,
      layers: activeScene.metadata.layers,
      blocks: loaded.scene.metadata.blocks,
      linetypes: activeScene.metadata.linetypes,
      layerMap,
      linetypeMap,
      maskOrder: maskState.maskOrder,
      maskBucketScale: maskState.maskBucketScale,
      reader: loaded.scene.reader,
    });
    await addExternalText(
      loaded.scene,
      composed.instanceGraph,
      layerMap,
      mountedOverview,
      sceneId,
      prefix,
      linetypeMap,
      maskState.maskOrder,
      maskState.maskBucketScale,
    );
    const imageFit = await addExternalImages(
      loaded.scene,
      message.cacheId,
      sceneId,
      composed.instanceGraph,
      layerMap,
      prefix,
      maskState.maskOrder,
      maskState.maskBucketScale,
    );
    lastFit = imageFit ?? lastFit;
    const externalSource = externalHostSources.get(message.cacheId);
    if (externalSource) {
      await initializeExternalDeferredGeometry({
        workerSource: { kind: "host", source: externalSource },
        childScene: loaded.scene,
        sceneId,
        composedInstanceGraph: composed.instanceGraph,
        layerMap,
        linetypeMap,
        maskOrder: maskState.maskOrder,
        rootScene: activeScene,
        revision,
      });
      if (revision !== openRevision || !activeScene) {
        return;
      }
      lastFit = Object.freeze({
        camera: activeScene.renderer.fitCamera(),
      });
    }
    childContexts.push({
      id: sceneId,
      prefix,
      instanceGraph: composed.instanceGraph,
      orderScale: maskState.maskBucketScale,
      orderMapQuantized: maskState.orderMapQuantized,
      overview: mountedOverview,
      reviewContext: Object.freeze({
        parentBlockIndex: message.parentBlockIndex,
        parentInstances:
          parentContext.instanceGraph.instancesByBlock.get(
            message.parentBlockIndex,
          ),
        parentClipNodes:
          parentContext.instanceGraph.clipNodes ?? Object.freeze([]),
        parentLayerVisibilityRows:
          parentContext.instanceGraph.layerVisibilityRows ??
          Object.freeze([]),
        layerMap,
        linetypeMap,
      }),
    });
  }
  externalAttachmentsByCache.set(message.cacheId, childContexts);
  activeReviewTools?.refreshFilledObjects();
  if (lastFit) {
    activeInteraction.updateFit(lastFit.camera);
  } else {
    activeInteraction.refresh();
  }
  const key = `${message.parentCacheId}:${message.parentBlockIndex}`;
  const existing = xrefDiagnostics.get(key);
  if (existing) {
    xrefDiagnostics.set(key, {
      ...existing,
      status: "ready",
      canSelect: false,
      fileName:
        typeof message.fileName === "string"
          ? message.fileName.slice(0, 300)
          : existing.fileName,
      message:
        message.resolution === "relative"
          ? "도면 기준 상대경로에서 연결했습니다."
          : message.resolution === "search"
            ? "파일명과 상위 폴더 일치 순으로 자동 연결했습니다."
            : message.resolution?.startsWith("manual")
              ? "저장된 수동 연결을 적용했습니다."
              : "저장된 경로에서 연결했습니다.",
    });
  }
  renderXrefDiagnostics();
  if (!message.overlay) {
    discoverExternalReferences(
      loaded.scene,
      message.cacheId,
      Number.isSafeInteger(message.depth) ? message.depth : 1,
    );
  }
  if (activeRangeMetricsSource) {
    renderMetrics(
      activeScene,
      activeRangeMetricsSource,
      activeInteraction.snapshot(),
    );
  }
  status.textContent = `참조도면 ${message.name} 연결 완료`;
}

async function remountExternalReferences(revision, switchRevision) {
  resetExternalDeferredWorkers();
  externalAttachmentsByCache.clear();
  const messages = [...readyExternalMessages.values()].sort(
    (left, right) => (left.depth ?? 0) - (right.depth ?? 0),
  );
  for (const message of messages) {
    if (
      revision !== openRevision ||
      switchRevision !== viewSwitchRevision ||
      !activeScene ||
      !activeInteraction
    ) {
      return;
    }
    try {
      await handleExternalCacheReady(message);
    } catch (error) {
      console.error(error);
    }
  }
}

function installInteraction(
  scene,
  instanceGraph,
  render,
  source,
  revision,
) {
  activeReviewTools?.dispose();
  activeReviewTools = undefined;
  activeViewHistory = new CameraViewHistory(render.camera);
  const interactionScene = Object.freeze({
    ...scene,
    instanceGraph,
    render,
  });
  activeInteraction = new ViewportInteraction(interactionScene, canvas, {
    onUpdate(viewport) {
      renderMetrics(scene, source, viewport);
      if (viewport.render.interactive) {
        invalidatePendingHatchPatterns();
      } else {
        scheduleHatchPatterns(
          scene,
          viewport.render.camera,
          revision,
        );
      }
      scheduleCurveRefinement(scene, viewport, revision);
      scheduleExternalCurveRefinement(scene, viewport, revision);
      status.textContent = viewport.render.interactive
        ? `${viewport.zoom.toFixed(2)}× · 빠른 이동 화면`
        : viewport.detail.loading > 0
          ? `상세 청크 ${viewport.detail.loading.toLocaleString()}개 읽는 중`
          : `${viewport.zoom.toFixed(2)}× · 화면 상세 ${viewport.detail.selectedBatches.toLocaleString()}개`;
      if (scene.metrics.preview) {
        status.textContent += " · 빠른 미리보기";
      }
      if (
        activeCurveStatus?.state === "loading" ||
        activeCurveStatus?.state === "refining"
      ) {
        status.textContent += " · 곡선 정밀화 중";
      } else if (
        activeCurveStatus?.state === "ready" &&
        activeCurveStatus.cameraKey ===
          curveRefinementCameraKey(viewport.render.camera)
      ) {
        status.textContent +=
          ` · 정밀 곡선 ${activeCurveStatus.metrics.refined.toLocaleString()}개`;
      }
      status.textContent += missingFontSuffix();
      activeReviewTools?.setCamera(viewport.render.camera);
    },
    onError(error) {
      status.textContent = `상세 표시 실패: ${error.message}`;
      console.error(error);
    },
    onReviewBatch(sourceId, batch, vertices, candidate) {
      return (
        activeReviewTools?.addDetailBatch(
          sourceId,
          batch,
          vertices,
          candidate,
        ) ?? false
      );
    },
    onReviewBatchEvicted(sourceId, batchId) {
      activeReviewTools?.removeDetailBatch(sourceId, batchId);
    },
    onReviewSelection(sourceId, candidates) {
      activeReviewTools?.setDetailSelection(sourceId, candidates);
    },
    onViewCommit(view) {
      activeViewHistory?.commit(view);
      updateViewNavigationControls();
    },
    onViewReplace(view) {
      activeViewHistory?.replace(view);
      updateViewNavigationControls();
    },
    onWindowZoomModeChange: handleWindowZoomModeChange,
    windowZoomGuide,
  });
  activeReviewTools = new ReviewTools({
    canvas,
    overlay: reviewCanvas,
    toolbar: reviewToolbar,
    result: reviewResult,
    scene,
    instanceGraph,
    getCamera: () =>
      activeInteraction?.snapshot().render.camera ?? render.camera,
    getLayerVisibility: () => scene.renderer.getLayerVisibility(),
    onFit: () => activeInteraction?.reset(),
    findOverlayCandidates({ x, y, snapKinds, tolerancePixels }) {
      return [
        activeTextComposite?.hitTest(x, y, {
          snapKinds,
          tolerancePixels,
        }),
        activeImageComposite?.hitTest(x, y, {
          snapKinds,
          tolerancePixels,
        }),
      ].filter(Boolean);
    },
    resolveRenderPick(pick) {
      return scene.renderer.resolveRenderDeltaPick(pick);
    },
    onIsolateLayer(layerIndex) {
      const visibility = scene.renderer.getLayerVisibility();
      if (
        !Number.isSafeInteger(layerIndex) ||
        layerIndex < 0 ||
        layerIndex >= visibility.length
      ) {
        return false;
      }
      return applyLayerVisibilityState(
        visibility.map((_visible, index) => index === layerIndex),
      );
    },
    onRestoreLayers: restoreLayerVisibility,
    measurementPreferences: activeMeasurementPreferences,
    onMeasurementPreferencesChange: saveMeasurementPreferences,
    loadFilledObjects({ signal }) {
      if (
        revision !== openRevision ||
        activeScene !== scene ||
        !activeCurveWorkerSource
      ) {
        return Promise.resolve(null);
      }
      return loadFilledObjectReviewSources(
        activeCurveWorkerSource,
        scene,
        signal,
      );
    },
    onReviewModeChange(enabled) {
      if (enabled) {
        activeInteraction?.setWindowZoomEnabled(false);
        setViewBookmarkPanelOpen(false);
      }
      activeTextComposite?.setHitTestingEnabled(enabled);
      activeImageComposite?.setHitTestingEnabled(enabled);
      activeInteraction?.setReviewEnabled(enabled);
      activeInteraction?.refresh();
    },
    onSelectionChange(selection, options) {
      const controller =
        activeViewerRuntime?.presentation.selectionController;
      if (!controller || controller.disposed) {
        return;
      }
      if (selection) {
        const renderRevisionId =
          selection.renderPick?.revisionId;
        if (
          typeof renderRevisionId === "string" &&
          renderRevisionId !==
            controller.snapshot().revisionId
        ) {
          controller.advanceRevision(renderRevisionId, {
            reason: "render-delta.revision",
          });
        }
        controller.replace(selection, options);
      } else {
        controller.clear(options);
      }
    },
    onStatus(message) {
      status.textContent = message;
    },
  });
  activeReviewTools.setCamera(render.camera);
  updateViewNavigationControls();
  renderViewBookmarks();
  return interactionScene;
}

function updateLayoutTabSelection() {
  for (const button of layoutTabs.querySelectorAll("button[data-view-id]")) {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.viewId === activeViewId),
    );
  }
  if (!activeExportController) {
    updateExportOptions();
  }
}

async function activateView(
  scene,
  view,
  source,
  revision,
  { awaitReady = false } = {},
) {
  if (
    revision !== openRevision ||
    activeScene !== scene ||
    view.id === activeViewId
  ) {
    return view.id === activeViewId;
  }
  const switchRevision = ++viewSwitchRevision;
  for (const button of layoutTabs.querySelectorAll("button")) {
    button.disabled = true;
  }
  status.textContent = `${view.label} 화면 구성 중`;
  activeReviewTools?.dispose();
  activeReviewTools = undefined;
  activeInteraction?.dispose();
  activeInteraction = undefined;
  activeViewHistory = undefined;
  setViewBookmarkPanelOpen(false);
  updateViewNavigationControls();
  invalidatePendingCurveRefinement();
  activeCurveStatus = undefined;
  try {
    const instanceGraph = scene.buildViewInstanceGraph(
      view,
      activeMaskOrder?.enabled
        ? { maskOrder: activeMaskOrder }
        : {},
    );
    const imageBounds = scene.imageEntities
      ? calculateRasterImageBounds({
          imageEntities: scene.imageEntities,
          blocks: scene.metadata.blocks,
          instanceGraph,
        })
      : null;
    if (
      revision !== openRevision ||
      switchRevision !== viewSwitchRevision ||
      activeScene !== scene
    ) {
      return;
    }
    const render = scene.renderer.setInstanceGraph(instanceGraph, {
      preferredBounds: view.preferredBounds,
      preferredView: view.preferredView,
      supplementalBounds: imageBounds,
      clearExternal: true,
    });
    activeRenderInstanceGraph = instanceGraph;
    activeViewId = view.id;
    updateLayoutTabSelection();
    renderViewBookmarks();
    activeTextStatus = undefined;
    activeTextComposite = new CompositeTextOverlay(textCanvas);
    scene.renderer.setTextOverlay(activeTextComposite);
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    scene.renderer.setImageOverlay(activeImageComposite);
    installInteraction(scene, instanceGraph, render, source, revision);
    configurePlotStyleForView(scene, view, revision);
    lastPatternCameraKey = undefined;
    patternRequestRevision += 1;
    if (activeHatchStatus?.state === "ready") {
      activeHatchStatus = Object.freeze({
        ...activeHatchStatus,
        patternMetrics: null,
      });
    }
    activeInteraction.refresh();
    activeInteraction.scheduleDetail(0);
    const textReady = initializeTextOverlay(
      scene,
      revision,
      activeMaskOrder,
      instanceGraph,
    ).catch((error) => {
      if (revision === openRevision && activeScene === scene) {
        status.textContent = `문자 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
    const imageReady = initializeImageOverlay(
      scene,
      revision,
      activeHostCacheId ?? `local-${revision}`,
      instanceGraph,
    ).catch((error) => {
      if (revision === openRevision && activeScene === scene) {
        status.textContent = `이미지 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
    const referencesReady = remountExternalReferences(
      revision,
      switchRevision,
    ).catch(console.error);
    if (awaitReady) {
      await Promise.all([textReady, imageReady, referencesReady]);
      if (
        revision !== openRevision ||
        switchRevision !== viewSwitchRevision ||
        activeScene !== scene
      ) {
        return false;
      }
      activeInteraction?.refresh();
    }
    status.textContent = `${view.label} 표시 완료`;
    return true;
  } catch (error) {
    if (
      revision === openRevision &&
      switchRevision === viewSwitchRevision
    ) {
      status.textContent = `${view.label} 표시 실패: ${error.message}`;
      console.error(error);
    }
    return false;
  } finally {
    if (
      revision === openRevision &&
      switchRevision === viewSwitchRevision
    ) {
      for (const button of layoutTabs.querySelectorAll("button")) {
        button.disabled = false;
      }
    }
  }
}

function populateLayoutTabs(scene, source, revision) {
  layoutTabs.replaceChildren();
  activeViewId = scene.activeView.id;
  renderViewBookmarks();
  if (scene.views.length <= 1) {
    layoutTabs.hidden = true;
    dropZone.classList.remove("has-layout-tabs");
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const view of scene.views) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.viewId = view.id;
    button.setAttribute("role", "tab");
    button.textContent = view.label;
    button.title =
      view.kind === "model"
        ? "모델 공간"
        : `배치 탭 · 뷰포트 ${view.layout.viewports.length.toLocaleString()}개`;
    button.addEventListener("click", () => {
      activateView(scene, view, source, revision);
    });
    fragment.append(button);
  }
  layoutTabs.append(fragment);
  layoutTabs.hidden = false;
  dropZone.classList.add("has-layout-tabs");
  updateLayoutTabSelection();
}

async function openCache(source, workerSource, cacheSha256) {
  activeExportController?.abort();
  activeExportController = undefined;
  setExportPanelOpen(false);
  const revision = ++openRevision;
  viewSwitchRevision += 1;
  activeViewId = undefined;
  activeViewHistory = undefined;
  setViewBookmarkPanelOpen(false);
  layoutTabs.replaceChildren();
  layoutTabs.hidden = true;
  dropZone.classList.remove("has-layout-tabs");
  status.textContent = "준비 중";
  metrics.innerHTML = "";
  activeRangeMetricsSource = source;
  setControlsEnabled(false);
  resetLayerPanel();
  resetExternalReferences();
  const imageStore = new RasterImageAssetStore({
    onChange(event) {
      if (
        revision === openRevision &&
        activeImageAssetStore === imageStore
      ) {
        let diagnosticsChanged = false;
        for (const [key, entry] of xrefDiagnostics) {
          if (
            entry.kind !== "image" ||
            entry.resourceId !== event.resourceId
          ) {
            continue;
          }
          xrefDiagnostics.set(key, {
            ...entry,
            status: event.type === "error" ? "error" : "ready",
            canSelect: event.type === "error",
            ...(event.type === "error"
              ? {
                  message:
                    event.error instanceof Error
                      ? event.error.message.slice(0, 240)
                      : "이미지를 화면용으로 해석하지 못했습니다.",
                }
              : {}),
          });
          diagnosticsChanged = true;
        }
        if (diagnosticsChanged) {
          renderXrefDiagnostics();
        }
        activeInteraction?.refresh();
      }
    },
  });
  activeImageAssetStore = imageStore;
  resetPlotStyleSession();
  activeTextStatus = undefined;
  activeTextStyles = Object.freeze([]);
  clearHostFonts();
  fontDiagnostics.clear();
  pendingHostFontRequests.clear();
  attemptedHostFontKeys.clear();
  fontsToggle.disabled = true;
  setViewerToolMessage(fontsToggle, "toolbar.fonts");
  fontsToggle.setAttribute("aria-expanded", "false");
  fontPanel.hidden = true;
  renderFontDiagnostics();
  activeHatchStatus = undefined;
  activePrimitiveStatus = undefined;
  activeCurveStatus = undefined;
  activeMaskOrder = undefined;
  activeRenderInstanceGraph = undefined;
  activeMaskStatus = undefined;
  activeWipeoutMasksVisible = false;
  updateWipeoutToggle();
  activeMemoryTelemetry = new WebviewMemoryTelemetry();
  lastPatternCameraKey = undefined;
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
  if (fontRefreshTimer !== undefined) {
    clearTimeout(fontRefreshTimer);
    fontRefreshTimer = undefined;
  }
  activeHatchWorker?.cancel();
  activeHatchWorker = undefined;
  activePrimitiveWorker?.cancel();
  activePrimitiveWorker = undefined;
  invalidatePendingCurveRefinement();
  activeCurveWorker?.cancel();
  activeCurveWorker = undefined;
  activeCurveWorkerSource = workerSource;
  curveWorkerReady = false;
  curveRequestInFlight = false;
  pendingCurveRequest = undefined;
  activeInteraction?.dispose();
  activeInteraction = undefined;
  activeReviewTools?.dispose();
  activeReviewTools = undefined;
  const previousRuntime = activeViewerRuntime;
  activeViewerRuntime = undefined;
  await previousRuntime?.dispose().catch(console.error);
  activeScene = undefined;
  const renderer = new WebGlLineRenderer(canvas);
  renderer.setWipeoutMasksVisible(activeWipeoutMasksVisible);
  let runtime;
  try {
    const renderSource = createDwgRenderSource(source, cacheSha256);
    runtime = await openViewerRuntime(renderSource, {
      host: createWebviewViewerHost(),
      mount: (context) =>
        mountDwgWebGlPresentation(context, {
          canvas,
          renderer,
          projectSelection: projectDwgSelection,
          onProgress(message) {
            if (revision === openRevision) {
              status.textContent = message;
            }
          },
        }),
    });
    const { scene, rangeSource } = runtime.presentation;
    if (revision !== openRevision) {
      await runtime.dispose().catch(console.error);
      return;
    }
    activeViewerRuntime = runtime;
    activeScene = scene;
    activeTextComposite = new CompositeTextOverlay(textCanvas);
    scene.renderer.setTextOverlay(activeTextComposite);
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    scene.renderer.setImageOverlay(activeImageComposite);
    dropZone.classList.add("loaded");
    populateLayerPanel(scene);
    renderMetrics(activeScene, source);
    let maskState = Object.freeze({
      maskOrder: null,
      instanceGraph: scene.instanceGraph,
    });
    try {
      maskState = await initializeMaskComposition(
        scene,
        revision,
      );
    } catch (error) {
      if (revision === openRevision && activeScene === scene) {
        activeMaskStatus = Object.freeze({
          enabled: false,
          generalOrderEnabled: false,
          masks: 0,
          generalOrderReason: null,
          tables: 0,
          entries: 0,
          maximumExpandedMasks: 0,
          buildMs: 0,
          reason: error.message,
        });
        console.error(error);
      }
    }
    if (revision !== openRevision || activeScene !== scene) {
      if (activeViewerRuntime === runtime) {
        activeViewerRuntime = undefined;
      }
      await runtime.dispose().catch(console.error);
      return;
    }
    activeMaskOrder = maskState.maskOrder;
    activeRenderInstanceGraph = maskState.instanceGraph;
    activeViewId = scene.activeView.id;
    renderMetrics(activeScene, source);
    installInteraction(
      scene,
      activeRenderInstanceGraph,
      {
        ...scene.render,
        ...scene.renderer.redraw(scene.render.camera),
      },
      source,
      revision,
    );
    populateLayoutTabs(scene, source, revision);
    configurePlotStyleForView(scene, scene.activeView, revision);
    setControlsEnabled(true);
    discoverExternalReferences(
      activeScene,
      activeHostCacheId,
      0,
    );
    initializeDeferredGeometry(
      workerSource,
      activeScene,
      revision,
      activeMaskOrder,
    ).catch(
      console.error,
    );
    initializeTextOverlay(
      activeScene,
      revision,
      activeMaskOrder,
      activeRenderInstanceGraph,
    ).catch((error) => {
      if (revision === openRevision) {
        status.textContent = `문자 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
    initializeImageOverlay(
      activeScene,
      revision,
      activeHostCacheId ?? `local-${revision}`,
      activeRenderInstanceGraph,
    ).catch((error) => {
      if (revision === openRevision) {
        status.textContent = `이미지 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
  } catch (error) {
    if (activeViewerRuntime === runtime) {
      activeViewerRuntime = undefined;
    }
    await runtime?.dispose().catch(() => {});
    try {
      await source.dispose?.();
    } catch {
      // Preserve the render failure.
    }
    renderer.dispose();
    if (revision !== openRevision) {
      return;
    }
    activeInteraction = undefined;
    activeReviewTools?.dispose();
    activeReviewTools = undefined;
    activeScene = undefined;
    dropZone.classList.remove("loaded");
    status.textContent = `열기 실패: ${error.message}`;
    throw error;
  }
}

async function openFile(file) {
  const requestRevision = ++sourceOpenRequestRevision;
  const cacheSha256 = await localCacheSessionDigest(file);
  if (requestRevision !== sourceOpenRequestRevision) {
    return;
  }
  activeHostCacheId = undefined;
  activeDocumentName =
    typeof file?.name === "string" && file.name ? file.name : "drawing";
  activeViewDocumentKey =
    `blob:${String(file?.name ?? "cache").normalize("NFC").slice(0, 120)}:` +
    `${Number(file?.size) || 0}:${Number(file?.lastModified) || 0}`;
  glyphCache.configureLegacyEncodings({});
  return openCache(
    new TrackedRangeSource(new BlobRangeSource(file)),
    { kind: "blob", file },
    cacheSha256,
  );
}

function openHostedCache(message) {
  sourceOpenRequestRevision += 1;
  glyphCache.configureLegacyEncodings(message.bigFontEncodings);
  activeHostCacheId = message.cacheId;
  activeDocumentName =
    typeof message.documentName === "string" && message.documentName
      ? message.documentName
      : "drawing";
  activeViewDocumentKey = "host-document";
  const source = createVsCodeRangeSource(vscodeApi, {
    cacheId: message.cacheId,
    size: message.size,
  });
  return openCache(
    new TrackedRangeSource(source),
    { kind: "host", source },
    message.cacheId,
  );
}

function closeViewerPanels() {
  layerPanel.hidden = true;
  layersToggle.setAttribute("aria-expanded", "false");
  fontPanel.hidden = true;
  fontsToggle.setAttribute("aria-expanded", "false");
  xrefPanel.hidden = true;
  xrefsToggle.setAttribute("aria-expanded", "false");
  exportPanel.hidden = true;
  exportToggle.setAttribute("aria-expanded", "false");
}

function viewerToolSurfaceContains(target) {
  return (
    pageHeader.contains(target) ||
    [layerPanel, fontPanel, xrefPanel, exportPanel].some(
      (panel) => !panel.hidden && panel.contains(target),
    )
  );
}

function setViewerToolsOpen(open) {
  if (!pageHeader || !viewerToolsTrigger) {
    return;
  }
  if (!open) {
    closeViewerPanels();
  }
  pageHeader.classList.toggle("tools-open", open);
  viewerToolsTrigger.setAttribute("aria-expanded", String(open));
  viewerToolsTrigger.setAttribute(
    "aria-label",
    t(open ? "toolbar.more.close" : "toolbar.more.open"),
  );
}

function setHostedState(state, detail = "", code = "") {
  if (!vscodeApi) {
    return;
  }
  switch (state) {
    case "preparing":
      setViewerToolsOpen(false);
      status.textContent = t("status.host.preparing");
      hostRetry.hidden = true;
      hostRebuild.hidden = true;
      hostAdapterSetup.hidden = true;
      break;
    case "converting":
      status.textContent = t("status.host.converting");
      hostRetry.hidden = true;
      hostRebuild.hidden = true;
      hostAdapterSetup.hidden = true;
      break;
    case "validating":
      status.textContent = t("status.host.validating");
      hostRetry.hidden = true;
      hostRebuild.hidden = true;
      hostAdapterSetup.hidden = true;
      break;
    case "error":
      setViewerToolsOpen(true);
      status.textContent = detail
        ? t("status.host.errorWithDetail", {
            detail: detail.slice(0, 300),
          })
        : t("status.host.error");
      hostRetry.hidden = false;
      hostRebuild.hidden = false;
      hostAdapterSetup.hidden =
        typeof code !== "string" || !code.startsWith("ADAPTER_");
      break;
    case "ready":
      hostRetry.hidden = true;
      hostRebuild.hidden = false;
      hostAdapterSetup.hidden = true;
      break;
  }
}

if (vscodeApi) {
  cachePicker.hidden = true;
  fontFileButton.hidden = true;
  viewerToolsTrigger.hidden = false;
  hostFontFolder.hidden = false;
  fontPanelHelp.textContent = t("fonts.hostHelp");
  document.querySelector("h1").textContent = t("page.hostHeading");
  document.querySelector(".empty-state strong").textContent = t(
    "empty.hostTitle",
  );
  document.querySelector(".empty-state span").textContent = t(
    "empty.hostHelp",
  );
  setHostedState("preparing");
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "dwg-menu-display-settings/1") {
      applyMenuDisplaySettings(message);
      return;
    }
    if (message?.type === "dwg-export-save-result/1") {
      const pending = pendingExportSaves.get(message.requestId);
      if (!pending) {
        return;
      }
      pendingExportSaves.delete(message.requestId);
      if (message.status === "saved") {
        pending.resolve({
          status: "saved",
          bytes:
            Number.isSafeInteger(message.bytes) && message.bytes >= 0
              ? message.bytes
              : 0,
        });
      } else if (message.status === "cancelled") {
        pending.reject(abortError());
      } else {
        pending.reject(
          new Error(
            typeof message.message === "string"
              ? message.message
              : t("status.exportSaveError"),
          ),
        );
      }
      return;
    }
    if (message?.type === "dwg-reveal-text/1") {
      queueTextReveal(message);
      return;
    }
    if (message?.type === "dwg-font-read-response/1") {
      void handleHostFontResponse(message);
      return;
    }
    if (message?.type === "dwg-plot-style-read-response/1") {
      handleHostPlotStyleResponse(message);
      return;
    }
    if (message?.type === "dwg-font-configuration-changed/1") {
      handleFontConfigurationChanged(message);
      return;
    }
    if (message?.type === "dwg-font-folder-select-result/1") {
      hostFontFolder.disabled = false;
      if (message.failed) {
        fontPanelHelp.textContent =
          "글꼴 폴더 설정을 저장하지 못했습니다. VS Code 설정을 확인하세요.";
      } else if (!message.changed) {
        fontPanelHelp.textContent =
          "글꼴 폴더 선택이 취소되었습니다. 기존 설정은 유지됩니다.";
      }
      return;
    }
    if (message?.type === "dwg-font-file-select-result/1") {
      const key = normalizeShxFontName(message.name);
      if (
        message.cacheId !== activeHostCacheId ||
        !key ||
        !fontDiagnostics.has(key)
      ) {
        return;
      }
      if (message.changed) {
        attemptedHostFontKeys.delete(key);
        fontDiagnostics.set(key, {
          ...fontDiagnostics.get(key),
          state: "loading",
          error: undefined,
        });
        fontPanelHelp.textContent =
          "선택한 글꼴을 현재 도면에 연결하고 있습니다.";
        requestHostFonts(activeTextStyles, openRevision);
      } else {
        fontPanelHelp.textContent = message.failed
          ? "선택한 파일을 이 글꼴에 적용할 수 없습니다."
          : "글꼴 파일 선택이 취소되었습니다.";
        renderFontDiagnostics();
      }
      return;
    }
    if (message?.type === "dwg-plot-style-file-select-result/1") {
      const key = normalizePlotStyleName(message.name);
      if (
        message.cacheId !== activeHostCacheId ||
        !activeScene ||
        !key ||
        key !== activePlotStyleName
      ) {
        return;
      }
      if (message.changed) {
        plotStyleTables.delete(key);
        const view =
          activeScene.views.find(
            (candidate) => candidate.id === activeViewId,
          ) ?? activeScene.activeView;
        configurePlotStyleForView(
          activeScene,
          view,
          openRevision,
        );
      } else {
        const entry = plotStyleTables.get(key);
        setPlotStyleUnavailable(
          entry?.requestedName ?? message.name,
          entry?.status ?? (message.failed ? "invalid" : "missing"),
        );
      }
      return;
    }
    if (message?.type === "dwg-adapter-select-result/1") {
      hostAdapterSetup.disabled = false;
      return;
    }
    if (message?.type === "dwg-image-status/1") {
      handleImageStatus(message);
      return;
    }
    if (message?.type === "dwg-image-read-response/1") {
      handleImageResponse(message);
      return;
    }
    if (message?.type === "dwg-xref-status/1") {
      handleXrefStatus(message);
      return;
    }
    if (message?.type === "dwg-xref-cache-ready/1") {
      enqueueExternalCacheReady(message);
      return;
    }
    if (message?.type === "dwg-cache-state/1") {
      setHostedState(message.state, message.message, message.code);
      return;
    }
    const isPreview = message?.type === "dwg-cache-preview-ready/1";
    if (!isPreview && message?.type !== "dwg-cache-ready/1") {
      return;
    }
    if (!isPreview) {
      setHostedState("ready");
    }
    openHostedCache(message)
      .then(() => {
        if (activeHostCacheId !== message.cacheId) {
          return;
        }
        if (isPreview) {
          status.textContent =
            "빠른 미리보기 표시 중 · 전체 도면을 계속 준비하고 있습니다";
        }
        vscodeApi.postMessage({
          type: "dwg-first-frame-ready/1",
          cacheId: message.cacheId,
          firstFrameMs: activeScene?.metrics.timings.firstFrameMs ?? null,
        });
      })
      .catch((error) => {
        if (activeHostCacheId !== message.cacheId) {
          return;
        }
        setHostedState("error", error.message);
        vscodeApi.postMessage({
          type: "dwg-viewer-error/1",
          code: "CACHE_RENDER_FAILED",
          cacheId: message.cacheId,
          error: error.message.slice(0, 500),
        });
      });
  });
  vscodeApi.postMessage({ type: "dwg-webview-ready/1" });
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) {
    openFile(file).catch(console.error);
  }
});

fontInput.addEventListener("change", () => {
  const files = [...fontInput.files];
  fontInput.value = "";
  registerFontFiles(files).catch((error) => {
    status.textContent = `SHX 글꼴 실패: ${error.message}`;
    console.error(error);
  });
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  const files = [...event.dataTransfer.files];
  const fonts = files.filter((file) => file.name.toLocaleLowerCase().endsWith(".shx"));
  const cache = files.find((file) => !file.name.toLocaleLowerCase().endsWith(".shx"));
  if (fonts.length > 0) {
    registerFontFiles(fonts).catch(console.error);
  }
  if (cache) {
    openFile(cache).catch(console.error);
  }
});

for (const control of viewControls) {
  control.addEventListener("click", () => {
    if (!activeInteraction) {
      return;
    }
    switch (control.dataset.viewAction) {
      case "zoom-in":
        activeInteraction.zoomBy(0.7);
        break;
      case "zoom-out":
        activeInteraction.zoomBy(1 / 0.7);
        break;
      case "fit":
        activeInteraction.reset();
        break;
      case "window": {
        const enabling = !activeInteraction.windowZoomEnabled;
        if (enabling && activeReviewTools?.activeTool) {
          activeReviewTools.activate(null);
        }
        activeInteraction.setWindowZoomEnabled(enabling, {
          reason: enabling ? "" : "cancelled",
        });
        break;
      }
      case "previous":
        navigateViewHistory("back");
        break;
      case "next":
        navigateViewHistory("forward");
        break;
      case "bookmarks":
        if (activeInteraction.windowZoomEnabled) {
          activeInteraction.setWindowZoomEnabled(false, {
            reason: "cancelled",
          });
        }
        setViewBookmarkPanelOpen(viewBookmarkPanel.hidden);
        break;
    }
  });
}

viewBookmarkForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!activeInteraction) {
    return;
  }
  const scope = activeViewBookmarkScope();
  const bookmarks = currentViewBookmarks();
  if (!scope || bookmarks.length >= MAXIMUM_BOOKMARKS_PER_SCOPE) {
    status.textContent =
      "현재 모델 또는 배치에는 화면 북마크를 더 저장할 수 없습니다.";
    return;
  }
  activeInteraction.flushViewCommit();
  const name =
    viewBookmarkName.value.trim() ||
    nextAutomaticBookmarkName(bookmarks);
  try {
    saveStoredViewBookmarks(
      addViewBookmark(storedViewBookmarks, {
        id: createViewBookmarkId(),
        scope,
        name,
        view: activeInteraction.snapshot().camera,
      }),
    );
    viewBookmarkName.value = "";
    renderViewBookmarks();
    status.textContent = `${name.slice(0, 64)} 북마크를 저장했습니다.`;
  } catch {
    status.textContent = "현재 화면 북마크를 저장하지 못했습니다.";
  }
});

viewBookmarkClose.addEventListener("click", () => {
  setViewBookmarkPanelOpen(false);
});

reviewToolbar.addEventListener("click", (event) => {
  if (
    !(event.target instanceof Element) ||
    !event.target.closest("[data-review-tool], [data-review-action]")
  ) {
    return;
  }
  setViewBookmarkPanelOpen(false);
  if (activeInteraction?.windowZoomEnabled) {
    activeInteraction.setWindowZoomEnabled(false);
  }
});

viewerToolsTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  setViewerToolsOpen(
    viewerToolsTrigger.getAttribute("aria-expanded") !== "true",
  );
});

document.addEventListener("pointerdown", (event) => {
  if (
    pageHeader.classList.contains("tools-open") &&
    event.target instanceof Node &&
    !viewerToolSurfaceContains(event.target)
  ) {
    setViewerToolsOpen(false);
  }
  if (
    !viewBookmarkPanel.hidden &&
    event.target instanceof Node &&
    !viewBookmarkPanel.contains(event.target) &&
    !viewBookmarksToggle.contains(event.target)
  ) {
    setViewBookmarkPanelOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (activeExportController) {
      activeExportController.abort();
      event.preventDefault();
    }
    setViewerToolsOpen(false);
    setViewBookmarkPanelOpen(false);
  }
});

layersToggle.addEventListener("click", () => {
  const opening = layerPanel.hidden;
  layerPanel.hidden = !opening;
  layersToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    setViewerToolsOpen(true);
    fontPanel.hidden = true;
    fontsToggle.setAttribute("aria-expanded", "false");
    xrefPanel.hidden = true;
    xrefsToggle.setAttribute("aria-expanded", "false");
    exportPanel.hidden = true;
    exportToggle.setAttribute("aria-expanded", "false");
    layerSearch.focus();
  }
});

fontsToggle.addEventListener("click", () => {
  const opening = fontPanel.hidden;
  fontPanel.hidden = !opening;
  fontsToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    setViewerToolsOpen(true);
    layerPanel.hidden = true;
    layersToggle.setAttribute("aria-expanded", "false");
    xrefPanel.hidden = true;
    xrefsToggle.setAttribute("aria-expanded", "false");
    exportPanel.hidden = true;
    exportToggle.setAttribute("aria-expanded", "false");
  }
});

xrefsToggle.addEventListener("click", () => {
  const opening = xrefPanel.hidden;
  xrefPanel.hidden = !opening;
  xrefsToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    setViewerToolsOpen(true);
    layerPanel.hidden = true;
    layersToggle.setAttribute("aria-expanded", "false");
    fontPanel.hidden = true;
    fontsToggle.setAttribute("aria-expanded", "false");
    exportPanel.hidden = true;
    exportToggle.setAttribute("aria-expanded", "false");
  }
});

exportToggle.addEventListener("click", () => {
  setExportPanelOpen(exportPanel.hidden);
});

exportClose.addEventListener("click", () => {
  if (activeExportController) {
    activeExportController.abort();
    return;
  }
  setExportPanelOpen(false);
});

exportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void startDrawingExport();
});

exportCancel.addEventListener("click", () => {
  activeExportController?.abort();
});

for (const control of [
  exportTarget,
  exportFormat,
  exportPaper,
  exportOrientation,
  exportDpi,
  exportScale,
  exportPlotStyle,
]) {
  control.addEventListener("change", updateExportOptions);
}

wipeoutToggle.addEventListener("click", () => {
  if (!activeScene || !activeMaskStatus?.enabled) {
    return;
  }
  activeWipeoutMasksVisible = !activeWipeoutMasksVisible;
  activeScene.renderer.setWipeoutMasksVisible(
    activeWipeoutMasksVisible,
  );
  updateWipeoutToggle();
  const viewport = activeInteraction?.refresh();
  if (activeRangeMetricsSource) {
    renderMetrics(activeScene, activeRangeMetricsSource, viewport);
  }
  status.textContent = activeWipeoutMasksVisible
    ? t("status.wipeout.on")
    : t("status.wipeout.off");
});

plotStyleToggle.addEventListener("click", () => {
  if (!activeScene || !activePlotStyleName) {
    return;
  }
  const entry = plotStyleTables.get(activePlotStyleName);
  if (entry?.status !== "loaded") {
    if (
      vscodeApi &&
      activeHostCacheId &&
      ["missing", "ambiguous"].includes(entry?.status)
    ) {
      plotStyleToggle.disabled = true;
      setViewerToolMessage(
        plotStyleToggle,
        "toolbar.plotStyle.selecting",
      );
      vscodeApi.postMessage({
        type: "dwg-plot-style-file-select/1",
        cacheId: activeHostCacheId,
        name: entry.requestedName,
      });
    }
    return;
  }
  applyPlotStyleEntry(
    activeScene,
    activePlotStyleName,
    entry,
    !activePlotStyleEnabled,
  );
  status.textContent = activePlotStyleEnabled
    ? `${entry.resolvedName || entry.requestedName} 출력 스타일을 적용했습니다`
    : "출력 스타일을 끄고 도면의 화면 색으로 표시합니다";
});

hostFontFolder.addEventListener("click", () => {
  if (!vscodeApi) {
    return;
  }
  hostFontFolder.disabled = true;
  fontPanelHelp.textContent = "추가할 SHX·BigFont 폴더를 선택하세요.";
  vscodeApi.postMessage({ type: "dwg-font-folder-select/1" });
});

layerSearch.addEventListener("input", () => {
  filterLayerPanel(layerSearch.value);
});

layersShowAll.addEventListener("click", () => {
  setAllLayersVisible(true);
});

layersHideAll.addEventListener("click", () => {
  setAllLayersVisible(false);
});

layersInvert.addEventListener("click", () => {
  invertLayerVisibility();
});

layersRestore.addEventListener("click", () => {
  restoreLayerVisibility();
});

hostRetry.addEventListener("click", () => {
  if (vscodeApi) {
    setHostedState("preparing");
    vscodeApi.postMessage({ type: "dwg-cache-retry/1" });
  }
});

hostRebuild.addEventListener("click", () => {
  if (vscodeApi) {
    setHostedState("preparing");
    vscodeApi.postMessage({ type: "dwg-cache-rebuild/1" });
  }
});

hostAdapterSetup.addEventListener("click", () => {
  if (vscodeApi) {
    hostAdapterSetup.disabled = true;
    vscodeApi.postMessage({ type: "dwg-adapter-select/1" });
  }
});

window.addEventListener("beforeunload", () => {
  activeExportController?.abort();
  activeExportController = undefined;
  for (const pending of pendingExportSaves.values()) {
    pending.reject(abortError());
  }
  pendingExportSaves.clear();
  openRevision += 1;
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
  if (fontRefreshTimer !== undefined) {
    clearTimeout(fontRefreshTimer);
    fontRefreshTimer = undefined;
  }
  pendingHostFontRequests.clear();
  clearHostFonts();
  activeHatchWorker?.cancel();
  activeHatchWorker = undefined;
  activePrimitiveWorker?.cancel();
  activePrimitiveWorker = undefined;
  invalidatePendingCurveRefinement();
  activeCurveWorker?.cancel();
  activeCurveWorker = undefined;
  activeCurveWorkerSource = undefined;
  activeInteraction?.dispose();
  void activeViewerRuntime?.dispose().catch(console.error);
  activeViewerRuntime = undefined;
  resetExternalReferences();
  activeInteraction = undefined;
  activeScene = undefined;
  activeRangeMetricsSource = undefined;
  activeMemoryTelemetry = undefined;
  glyphCache.dispose();
  resetLayerPanel();
});
