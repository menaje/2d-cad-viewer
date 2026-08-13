import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  normalizeBigFontEncodingMappings,
} from "./bigfont-encoding";
import {
  diagnoseLibreDwgAdapter,
  LIBREDWG_ADAPTER_EXTENSION_ID,
  LibreDwgNativeSceneEngine,
  resolveLibreDwgAdapter,
} from "./native-cache";
import {
  ENGINE_ASSET_CATALOG_NAME,
  ManagedEngineManager,
} from "./managed-engine";
import { CacheRangeChannel } from "./range-channel";
import {
  DEFAULT_PERSISTENT_CACHE_BYTES,
  normalizeSceneCacheMode,
  normalizePersistentCacheBytes,
  SceneCacheManager,
  type SceneCacheMode,
} from "./scene-cache-manager";
import {
  isSceneEngineAbort,
  SceneEngineError,
  type SceneEngineDescriptor,
  type SceneEngineProgressPhase,
} from "./scene-engine";
import {
  MAX_SHX_FONT_DIRECTORIES,
  ShxFontChannel,
} from "./shx-font-channel";
import { CtbPlotStyleChannel } from "./ctb-plot-style";
import {
  createQualificationReporter,
  type QualificationCloseStage,
  type QualificationFields,
  type QualificationReporter,
} from "./qualification";
import { activateRevisionComparisonQualification } from "./comparison-qualification";
import {
  DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
  DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
  normalizeWebviewZoomSensitivity,
  renderWebviewHtml,
  type InteractionRenderingMode,
  type MenuLabelMode,
  type RenderResolutionMode,
} from "./webview-html";
import { XrefController } from "./xref-controller";
import { ImageReferenceChannel } from "./image-reference-channel";
import {
  WorkspaceTextSearchController,
  type WorkspaceTextMatch,
} from "./workspace-text-search";

const VIEW_TYPE = "dwgViewer.dwg";
const ADD_SHX_FONT_FOLDERS_COMMAND = "dwgViewer.addShxFontFolders";
const SELECT_LIBREDWG_ADAPTER_COMMAND =
  "dwgViewer.selectLibreDwgAdapter";
const DIAGNOSE_LIBREDWG_ADAPTER_COMMAND =
  "dwgViewer.diagnoseLibreDwgAdapter";
const REUSED_PREVIEW_FRAME_WAIT_MS = 10_000;

function bundledLibreDwgExtensionPath(): string | undefined {
  return vscode.extensions.getExtension(
    LIBREDWG_ADAPTER_EXTENSION_ID,
  )?.extensionPath;
}

function configuredMenuLabelMode(
  configuration: vscode.WorkspaceConfiguration,
  key: "topToolbarLabels" | "leftToolbarLabels",
): MenuLabelMode {
  return configuration.get<string>(key, "hover") === "icons"
    ? "icons"
    : "hover";
}

function configuredRenderResolution(
  configuration: vscode.WorkspaceConfiguration,
): RenderResolutionMode {
  const value = configuration.get<string>("renderResolution", "auto");
  return value === "quality" || value === "performance"
    ? value
    : "auto";
}

function configuredInteractionRendering(
  configuration: vscode.WorkspaceConfiguration,
): InteractionRenderingMode {
  const value = configuration.get<string>(
    "interactionRendering",
    "hybrid",
  );
  return value === "continuous" || value === "maximumPerformance"
    ? value
    : "hybrid";
}

function configuredSceneCacheMode(
  configuration: vscode.WorkspaceConfiguration,
): SceneCacheMode {
  return normalizeSceneCacheMode(
    configuration.get<unknown>("sceneCacheMode", "session"),
  );
}

function configuredPersistentCacheBytes(
  configuration: vscode.WorkspaceConfiguration,
): number {
  const gibibytes = configuration.get<unknown>(
    "sceneCacheMaximumSizeGiB",
    5,
  );
  return normalizePersistentCacheBytes(
    typeof gibibytes === "number" && Number.isSafeInteger(gibibytes)
      ? gibibytes * 1024 * 1024 * 1024
      : DEFAULT_PERSISTENT_CACHE_BYTES,
  );
}

async function maintainSceneCacheStorage(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  adapterPath: string,
): Promise<void> {
  const manager = new SceneCacheManager(
    path.join(context.globalStorageUri.fsPath, "cache"),
    new LibreDwgNativeSceneEngine(adapterPath),
    {
      mode: configuredSceneCacheMode(
        vscode.workspace.getConfiguration("dwgViewer"),
      ),
      maximumPersistentBytes: configuredPersistentCacheBytes(
        vscode.workspace.getConfiguration("dwgViewer"),
      ),
    },
  );
  try {
    await manager.maintain();
    output.appendLine("[SCENE_CACHE_STORAGE_MAINTAINED]");
  } catch {
    output.appendLine("[SCENE_CACHE_STORAGE_MAINTENANCE_DEFERRED]");
  } finally {
    await manager.dispose();
  }
}

function configuredZoomSensitivity(
  configuration: vscode.WorkspaceConfiguration,
  key:
    | "mouseWheelZoomSensitivity"
    | "trackpadPinchZoomSensitivity",
  fallback: number,
): number {
  return normalizeWebviewZoomSensitivity(
    configuration.get<number>(key),
    fallback,
  );
}

function adapterErrorDetails(error: unknown): {
  code: string;
  message: string;
} {
  return error instanceof SceneEngineError
    ? { code: error.code, message: error.userMessage }
    : {
        code: "ADAPTER_DIAGNOSIS_FAILED",
        message: "LibreDWG 변환기를 확인하지 못했습니다.",
      };
}

async function diagnoseAdapterWithProgress(
  adapterPath: string,
): ReturnType<typeof diagnoseLibreDwgAdapter> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "2D CAD Viewer: LibreDWG 변환기 진단",
      cancellable: false,
    },
    () => diagnoseLibreDwgAdapter(adapterPath),
  );
}

async function selectLibreDwgAdapter(
  output: vscode.OutputChannel,
): Promise<boolean> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: "2D CAD Viewer용 LibreDWG 변환기 선택",
    openLabel: "선택 후 진단",
  });
  const adapterUri = selected?.find((uri) => uri.scheme === "file");
  if (!adapterUri) {
    return false;
  }

  try {
    const adapterPath = await resolveLibreDwgAdapter({
      configuredPath: adapterUri.fsPath,
      extensionPath: "",
    });
    const report = await diagnoseAdapterWithProgress(adapterPath);
    await vscode.workspace
      .getConfiguration("dwgViewer")
      .update(
        "libredwgAdapterPath",
        adapterPath,
        vscode.ConfigurationTarget.Global,
      );
    const linkage =
      report.linkage === "static"
        ? "독립 실행형"
        : "로컬 라이브러리 연결형";
    output.appendLine(
      `[ADAPTER_READY] engine=${report.engineVersion} linkage=${report.linkage} target=${report.platform}-${report.architecture}`,
    );
    void vscode.window.showInformationMessage(
      `2D CAD Viewer: LibreDWG ${report.engineVersion} 변환기 진단을 통과했습니다 (${linkage}).`,
    );
    return true;
  } catch (error) {
    const details = adapterErrorDetails(error);
    output.appendLine(`[${details.code}] adapter selection failed`);
    void vscode.window.showErrorMessage(
      `2D CAD Viewer: ${details.message}`,
    );
    return false;
  }
}

async function diagnoseConfiguredLibreDwgAdapter(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  managedEngine: ManagedEngineManager,
): Promise<boolean> {
  try {
    const installation = await managedEngine.ensure();
    const adapterPath = installation.adapterPath;
    const report = await diagnoseAdapterWithProgress(adapterPath);
    output.appendLine(
      `[MANAGED_ENGINE_READY] engine=${report.engineVersion} linkage=${report.linkage} target=${installation.target} reused=${installation.reused} source=${installation.sourceUrl}`,
    );
    void vscode.window.showInformationMessage(
      `2D CAD Viewer: 자동 설치된 LibreDWG ${report.engineVersion} 변환기가 정상입니다 (${report.platform}-${report.architecture}, ${report.linkage}).`,
    );
    return true;
  } catch (error) {
    const fallback = await resolveCompatibleFallbackAdapter(
      context,
      output,
    );
    if (fallback) {
      void vscode.window.showInformationMessage(
        `2D CAD Viewer: 호환되는 오프라인 변환기를 사용합니다 (${fallback.report.platform}-${fallback.report.architecture}).`,
      );
      return true;
    }
    const details = adapterErrorDetails(error);
    output.appendLine(`[${details.code}] adapter diagnosis failed`);
    void vscode.window.showErrorMessage(
      `2D CAD Viewer: ${details.message}`,
    );
    return false;
  }
}

interface CompatibleFallbackAdapter {
  readonly adapterPath: string;
  readonly source: "configured" | "environment" | "legacy-companion";
  readonly report: Awaited<ReturnType<typeof diagnoseLibreDwgAdapter>>;
}

async function resolveCompatibleFallbackAdapter(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<CompatibleFallbackAdapter | undefined> {
  const configuration = vscode.workspace.getConfiguration("dwgViewer");
  const configuredPath = configuration
    .get<string>("libredwgAdapterPath", "")
    .trim();
  const environmentPath = (
    process.env.DWG_VIEWER_LIBREDWG_ADAPTER ?? ""
  ).trim();
  const legacyExtensionPath = bundledLibreDwgExtensionPath();
  const candidates: ReadonlyArray<{
    source: CompatibleFallbackAdapter["source"];
    configuredPath?: string;
    extensionPath: string;
  }> = [
    ...(configuredPath
      ? [{ source: "configured" as const, configuredPath, extensionPath: "" }]
      : []),
    ...(environmentPath
      ? [{ source: "environment" as const, configuredPath: environmentPath, extensionPath: "" }]
      : []),
    ...(legacyExtensionPath
      ? [{ source: "legacy-companion" as const, extensionPath: legacyExtensionPath }]
      : []),
  ];
  for (const candidate of candidates) {
    try {
      const adapterPath = await resolveLibreDwgAdapter({
        configuredPath: candidate.configuredPath,
        extensionPath: candidate.extensionPath,
      });
      const report = await diagnoseLibreDwgAdapter(adapterPath);
      output.appendLine(
        `[FALLBACK_ENGINE_READY] source=${candidate.source} engine=${report.engineVersion} target=${report.platform}-${report.architecture}`,
      );
      return Object.freeze({
        adapterPath,
        source: candidate.source,
        report,
      });
    } catch (error) {
      const details = adapterErrorDetails(error);
      output.appendLine(
        `[${details.code}] incompatible fallback source=${candidate.source}`,
      );
    }
  }
  return undefined;
}

async function resolveViewerAdapter(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  managedEngine: ManagedEngineManager,
): Promise<string> {
  try {
    const installation = await managedEngine.ensure();
    output.appendLine(
      `[MANAGED_ENGINE_SELECTED] target=${installation.target} reused=${installation.reused} sha256=${installation.sha256} source=${installation.sourceUrl}`,
    );
    return installation.adapterPath;
  } catch (error) {
    const details = adapterErrorDetails(error);
    output.appendLine(`[${details.code}] managed engine unavailable`);
    const fallback = await resolveCompatibleFallbackAdapter(
      context,
      output,
    );
    if (fallback) {
      return fallback.adapterPath;
    }
    throw error;
  }
}

function fontDirectoryKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

async function addShxFontFolders(): Promise<boolean> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    title: "2D CAD Viewer에서 사용할 SHX·BigFont 폴더 선택",
    openLabel: "글꼴 폴더 추가",
  });
  const directories = (selected ?? [])
    .filter((uri) => uri.scheme === "file")
    .map((uri) => path.resolve(uri.fsPath));
  if (directories.length === 0) {
    return false;
  }

  const configuration = vscode.workspace.getConfiguration("dwgViewer");
  const current = configuration.get<unknown>("shxFontDirectories", []);
  const currentDirectories = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === "string")
    : [];
  const existingKeys = new Set(
    currentDirectories
      .filter((directory) => path.isAbsolute(directory))
      .map(fontDirectoryKey),
  );
  const merged: string[] = [];
  const seen = new Set<string>();
  let added = 0;
  for (const directory of [
    ...currentDirectories,
    ...directories,
  ]) {
    if (!path.isAbsolute(directory)) {
      continue;
    }
    const resolved = path.resolve(directory);
    const key = fontDirectoryKey(resolved);
    if (
      !seen.has(key) &&
      merged.length < MAX_SHX_FONT_DIRECTORIES - 1
    ) {
      seen.add(key);
      merged.push(resolved);
      if (!existingKeys.has(key)) {
        added += 1;
      }
    }
  }
  await configuration.update(
    "shxFontDirectories",
    merged,
    vscode.ConfigurationTarget.Global,
  );
  void vscode.window.showInformationMessage(
    added > 0
      ? `2D CAD Viewer: SHX 글꼴 폴더 ${added.toLocaleString()}개를 추가했습니다.`
      : "2D CAD Viewer: 기존 SHX 글꼴 폴더 설정을 다시 읽습니다.",
  );
  return true;
}

class DwgDocument implements vscode.CustomDocument {
  private readonly sessions = new Set<() => void>();

  constructor(readonly uri: vscode.Uri) {}

  addSession(dispose: () => void): vscode.Disposable {
    this.sessions.add(dispose);
    return new vscode.Disposable(() => this.sessions.delete(dispose));
  }

  dispose(): void {
    for (const dispose of this.sessions) {
      dispose();
    }
    this.sessions.clear();
  }
}

interface HostMessage {
  type?: unknown;
  code?: unknown;
  cacheId?: unknown;
  data?: unknown;
  firstFrameMs?: unknown;
  format?: unknown;
  kind?: unknown;
  requestId?: unknown;
  name?: unknown;
  suggestedName?: unknown;
  webviewSettleMs?: unknown;
  detailPendingCount?: unknown;
  xrefCount?: unknown;
  xrefIssueCount?: unknown;
  imageCount?: unknown;
  imageIssueCount?: unknown;
  fontCount?: unknown;
  fontIssueCount?: unknown;
}

function visualCompletionCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 1_000_000
    ? (value as number)
    : undefined;
}

class DwgEditorProvider
  implements vscode.CustomReadonlyEditorProvider<DwgDocument>
{
  private readonly panels = new Map<
    string,
    Set<vscode.WebviewPanel>
  >();
  private readonly pendingTextMatches = new Map<
    string,
    WorkspaceTextMatch
  >();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly managedEngine: ManagedEngineManager,
    private readonly qualification?: QualificationReporter,
  ) {}

  private documentKey(uri: vscode.Uri): string {
    return uri.toString(true);
  }

  private textMatchMessage(
    match: WorkspaceTextMatch,
  ): Readonly<Record<string, unknown>> {
    return {
      type: "dwg-reveal-text/1",
      handle: match.handle,
      kind: match.kind,
      value: (match.value || match.tag || match.prompt).slice(0, 500),
      point: [...match.insertionPoint],
      height: Number.isFinite(match.height) ? match.height : 0,
      hidden: match.hidden,
    };
  }

  private postPendingTextMatch(
    uri: vscode.Uri,
    panel: vscode.WebviewPanel,
  ): Thenable<boolean> | undefined {
    const match = this.pendingTextMatches.get(this.documentKey(uri));
    return match
      ? panel.webview.postMessage(this.textMatchMessage(match))
      : undefined;
  }

  async revealTextMatch(match: WorkspaceTextMatch): Promise<void> {
    const key = this.documentKey(match.uri);
    this.pendingTextMatches.set(key, match);
    await vscode.commands.executeCommand(
      "vscode.openWith",
      match.uri,
      VIEW_TYPE,
      { preview: true },
    );
    const panels = this.panels.get(key);
    if (!panels || panels.size === 0) {
      return;
    }
    await Promise.allSettled(
      [...panels].map((panel) =>
        panel.webview.postMessage(this.textMatchMessage(match)),
      ),
    );
  }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): DwgDocument {
    if (uri.scheme !== "file") {
      throw new Error("2D CAD Viewer currently supports local files only.");
    }
    return new DwgDocument(uri);
  }

  async resolveCustomEditor(
    document: DwgDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const documentKey = this.documentKey(document.uri);
    let documentPanels = this.panels.get(documentKey);
    if (!documentPanels) {
      documentPanels = new Set();
      this.panels.set(documentKey, documentPanels);
    }
    documentPanels.add(webviewPanel);
    webviewPanel.onDidDispose(() => {
      const panels = this.panels.get(documentKey);
      panels?.delete(webviewPanel);
      if (panels?.size === 0) {
        this.panels.delete(documentKey);
      }
    });
    const qualificationSession = randomBytes(8).toString("hex");
    const emitQualification = (
      event: string,
      fields: QualificationFields = {},
    ): Promise<void> =>
      this.qualification?.emit(event, {
        session_id: qualificationSession,
        ...fields,
      }) ?? Promise.resolve();
    const closeAfterQualification = (
      stage: QualificationCloseStage,
    ): void => {
      if (!this.qualification?.claimClose(stage)) {
        return;
      }
      setTimeout(() => {
        void vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor",
        );
      }, stage === "conversion" ? 500 : 0);
    };
    void emitQualification("editor-open", {
      extension_host_pid: process.pid,
    });
    const mediaRoot = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "webview",
    );
    const template = await readFile(
      path.join(mediaRoot.fsPath, "index.html"),
      "utf8",
    );
    const progressivePreview = vscode.workspace
      .getConfiguration("dwgViewer", document.uri)
      .get<boolean>("progressivePreview", false);
    const sceneCacheMode = configuredSceneCacheMode(
      vscode.workspace.getConfiguration("dwgViewer", document.uri),
    );
    const maximumPersistentCacheBytes = configuredPersistentCacheBytes(
      vscode.workspace.getConfiguration("dwgViewer", document.uri),
    );

    const menuDisplaySettings = () => {
      const configuration = vscode.workspace.getConfiguration(
        "dwgViewer",
        document.uri,
      );
      return {
        type: "dwg-menu-display-settings/1",
        topToolbarLabels: configuredMenuLabelMode(
          configuration,
          "topToolbarLabels",
        ),
        leftToolbarLabels: configuredMenuLabelMode(
          configuration,
          "leftToolbarLabels",
        ),
      } as const;
    };

    const renderResolutionSettings = () => ({
      type: "dwg-render-resolution/1",
      mode: configuredRenderResolution(
        vscode.workspace.getConfiguration("dwgViewer", document.uri),
      ),
    } as const);

    const interactionRenderingSettings = () => ({
      type: "dwg-interaction-rendering/1",
      mode: configuredInteractionRendering(
        vscode.workspace.getConfiguration("dwgViewer", document.uri),
      ),
    } as const);

    const zoomSensitivitySettings = () => {
      const configuration = vscode.workspace.getConfiguration(
        "dwgViewer",
        document.uri,
      );
      return {
        type: "dwg-zoom-sensitivity/1",
        mouseWheelZoomSensitivity: configuredZoomSensitivity(
          configuration,
          "mouseWheelZoomSensitivity",
          DEFAULT_MOUSE_WHEEL_ZOOM_SENSITIVITY,
        ),
        trackpadPinchZoomSensitivity: configuredZoomSensitivity(
          configuration,
          "trackpadPinchZoomSensitivity",
          DEFAULT_TRACKPAD_PINCH_ZOOM_SENSITIVITY,
        ),
      } as const;
    };

    let disposed = false;
    let webviewInitialized = false;
    let webviewReady = false;
    let generation = 0;
    let conversion: AbortController | undefined;
    const rangeChannels = new Map<string, CacheRangeChannel>();
    const cacheReleases = new Map<string, () => Promise<void>>();
    const previewReleases = new Map<string, () => Promise<void>>();
    const previewFrameWaiters = new Map<string, () => void>();
    let fontChannel: ShxFontChannel | undefined;
    let plotStyleChannel: CtbPlotStyleChannel | undefined;
    let xrefController: XrefController | undefined;
    let imageReferenceChannel: ImageReferenceChannel | undefined;
    let sceneCacheManager: SceneCacheManager | undefined;
    let activeCacheId: string | undefined;
    let activeCacheReused = false;
    let activeEngine: SceneEngineDescriptor | undefined;
    let exportSaveInFlight = false;
    let activeCacheReadyMessage:
      | Readonly<Record<string, unknown>>
      | undefined;
    let pendingStateMessage:
      | Readonly<
          Record<
            string,
            boolean | number | string | undefined
          >
        >
      | undefined;
    let openStartedAt = 0;
    // LibreDWG can approach 600 MiB RSS, so retries never overlap processes.
    let startQueue: Promise<void> = Promise.resolve();

    const initializeWebview = (): void => {
      if (webviewInitialized || disposed) {
        return;
      }
      webviewInitialized = true;
      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: [mediaRoot],
      };
      const nonce = randomBytes(24).toString("base64url");
      const menuSettings = menuDisplaySettings();
      const renderSettings = renderResolutionSettings();
      const interactionSettings = interactionRenderingSettings();
      const zoomSettings = zoomSensitivitySettings();
      webviewPanel.webview.html = renderWebviewHtml(template, {
        cspSource: webviewPanel.webview.cspSource,
        nonce,
        stylesUri: webviewPanel.webview
          .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "styles.css"))
          .toString(),
        scriptUri: webviewPanel.webview
          .asWebviewUri(
            vscode.Uri.joinPath(mediaRoot, "src", "main.mjs"),
          )
          .toString(),
        locale: vscode.env.language,
        topToolbarLabels: menuSettings.topToolbarLabels,
        leftToolbarLabels: menuSettings.leftToolbarLabels,
        renderResolution: renderSettings.mode,
        interactionRendering: interactionSettings.mode,
        mouseWheelZoomSensitivity:
          zoomSettings.mouseWheelZoomSensitivity,
        trackpadPinchZoomSensitivity:
          zoomSettings.trackpadPinchZoomSensitivity,
      });
    };

    const postMenuDisplaySettings = (): void => {
      if (!webviewReady) {
        return;
      }
      void webviewPanel.webview.postMessage(menuDisplaySettings());
    };

    const postRenderResolutionSettings = (): void => {
      if (!webviewReady) {
        return;
      }
      void webviewPanel.webview.postMessage(renderResolutionSettings());
    };

    const postInteractionRenderingSettings = (): void => {
      if (!webviewReady) {
        return;
      }
      void webviewPanel.webview.postMessage(
        interactionRenderingSettings(),
      );
    };

    const postZoomSensitivitySettings = (): void => {
      if (!webviewReady) {
        return;
      }
      void webviewPanel.webview.postMessage(
        zoomSensitivitySettings(),
      );
    };

    const postState = async (
      state: "preparing" | "converting" | "validating" | "error",
      message: string,
      code?: string,
    ): Promise<void> => {
      const stateMessage = {
        type: "dwg-cache-state/1",
        state,
        message,
        code,
      } as const;
      if (!webviewReady) {
        pendingStateMessage = stateMessage;
        return;
      }
      await webviewPanel.webview.postMessage(stateMessage);
    };

    const stopCurrent = async (): Promise<void> => {
      conversion?.abort();
      conversion = undefined;
      activeCacheId = undefined;
      activeEngine = undefined;
      activeCacheReadyMessage = undefined;
      pendingStateMessage = undefined;
      const channels = [...rangeChannels.values()];
      const cacheReleaseCallbacks = [...cacheReleases.values()];
      const previewReleaseCallbacks = [...previewReleases.values()];
      const previewWaiters = [...previewFrameWaiters.values()];
      const manager = sceneCacheManager;
      sceneCacheManager = undefined;
      rangeChannels.clear();
      cacheReleases.clear();
      previewReleases.clear();
      previewFrameWaiters.clear();
      for (const settle of previewWaiters) {
        settle();
      }
      fontChannel?.dispose();
      fontChannel = undefined;
      plotStyleChannel?.dispose();
      plotStyleChannel = undefined;
      xrefController?.dispose();
      xrefController = undefined;
      imageReferenceChannel?.dispose();
      imageReferenceChannel = undefined;
      await Promise.allSettled(
        channels.map((channel) => channel.dispose()),
      );
      await Promise.allSettled(
        previewReleaseCallbacks.map((release) => release()),
      );
      await Promise.allSettled(
        cacheReleaseCallbacks.map((release) => release()),
      );
      await manager?.dispose();
    };

    const settlePreviewFrame = (cacheId: string): void => {
      const settle = previewFrameWaiters.get(cacheId);
      previewFrameWaiters.delete(cacheId);
      settle?.();
    };

    const waitForPreviewFrame = (
      cacheId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      settlePreviewFrame(cacheId);
      return new Promise((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          signal.removeEventListener("abort", finish);
          if (previewFrameWaiters.get(cacheId) === finish) {
            previewFrameWaiters.delete(cacheId);
          }
          resolve();
        };
        previewFrameWaiters.set(cacheId, finish);
        timer = setTimeout(finish, REUSED_PREVIEW_FRAME_WAIT_MS);
        timer.unref();
        if (signal.aborted) {
          finish();
        } else {
          signal.addEventListener("abort", finish, { once: true });
        }
      });
    };

    const disposePreview = async (cacheId: string): Promise<void> => {
      settlePreviewFrame(cacheId);
      const channel = rangeChannels.get(cacheId);
      const release = previewReleases.get(cacheId);
      rangeChannels.delete(cacheId);
      previewReleases.delete(cacheId);
      await channel?.dispose();
      await release?.();
    };

    const disposeInactivePreviews = async (): Promise<void> => {
      const previewIds = [...previewReleases.keys()].filter(
        (cacheId) => cacheId !== activeCacheId,
      );
      await Promise.allSettled(
        previewIds.map((cacheId) => disposePreview(cacheId)),
      );
    };

    const createFontChannel = (cacheId: string): ShxFontChannel => {
      const configuration = vscode.workspace.getConfiguration(
        "dwgViewer",
        document.uri,
      );
      const drawingDirectory = path.dirname(document.uri.fsPath);
      const workspaceDirectory =
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const packageDirectory = path.dirname(drawingDirectory);
      const projectDirectories = [
        ...(workspaceDirectory &&
        path.relative(workspaceDirectory, packageDirectory).startsWith("..")
          ? []
          : [packageDirectory]),
        ...(workspaceDirectory ? [workspaceDirectory] : []),
      ];
      const rawDirectories = configuration.get<unknown>(
        "shxFontDirectories",
        [],
      );
      const rawMappings = configuration.get<unknown>("shxFontMappings", {});
      const fontDirectories = Array.isArray(rawDirectories)
        ? rawDirectories.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const fontMappings =
        typeof rawMappings === "object" &&
        rawMappings !== null &&
        !Array.isArray(rawMappings)
          ? (rawMappings as Record<string, string>)
          : {};
      return new ShxFontChannel(
        cacheId,
        {
          drawingDirectory,
          projectDirectories,
          fontDirectories,
          fontMappings,
        },
        (message) => webviewPanel.webview.postMessage(message),
      );
    };

    const createPlotStyleChannel = (
      cacheId: string,
    ): CtbPlotStyleChannel => {
      const configuration = vscode.workspace.getConfiguration(
        "dwgViewer",
        document.uri,
      );
      const drawingDirectory = path.dirname(document.uri.fsPath);
      const workspaceDirectory =
        vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const packageDirectory = path.dirname(drawingDirectory);
      const projectDirectories = [
        ...(workspaceDirectory &&
        path.relative(workspaceDirectory, packageDirectory).startsWith("..")
          ? []
          : [packageDirectory]),
        ...(workspaceDirectory ? [workspaceDirectory] : []),
      ];
      const rawDirectories = configuration.get<unknown>(
        "shxFontDirectories",
        [],
      );
      const resourceDirectories = Array.isArray(rawDirectories)
        ? rawDirectories.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return new CtbPlotStyleChannel(
        cacheId,
        {
          drawingDirectory,
          projectDirectories,
          resourceDirectories,
        },
        (message) => webviewPanel.webview.postMessage(message),
      );
    };

    const bigFontEncodings = (): Readonly<Record<string, string>> =>
      normalizeBigFontEncodingMappings(
        vscode.workspace
          .getConfiguration("dwgViewer", document.uri)
          .get<unknown>("shxBigFontEncodings", {}),
      );

    const reloadFontConfiguration = (): void => {
      fontChannel?.dispose();
      fontChannel = activeCacheId
        ? createFontChannel(activeCacheId)
        : undefined;
      plotStyleChannel?.dispose();
      plotStyleChannel = activeCacheId
        ? createPlotStyleChannel(activeCacheId)
        : undefined;
      if (activeCacheId) {
        void webviewPanel.webview.postMessage({
          type: "dwg-font-configuration-changed/1",
          cacheId: activeCacheId,
          bigFontEncodings: bigFontEncodings(),
        });
      }
    };

    const start = async (
      force: boolean,
      currentGeneration: number,
    ): Promise<void> => {
      await stopCurrent();
      if (disposed || currentGeneration !== generation) {
        return;
      }
      const controller = new AbortController();
      conversion = controller;
      activeCacheId = undefined;
      activeCacheReused = false;
      openStartedAt = Date.now();
      void emitQualification("conversion-start", { force });
      await postState(
        "preparing",
        force ? "캐시를 다시 만들 준비 중…" : "도면 캐시 확인 중…",
      );

      try {
        const adapterPath = await resolveViewerAdapter(
          this.context,
          this.output,
          this.managedEngine,
        );
        const engine = new LibreDwgNativeSceneEngine(adapterPath, {
          onPerformance: (performance) => {
            this.output.appendLine(
              `[CONVERSION_PERFORMANCE] ${JSON.stringify(performance)}`,
            );
          },
        });
        activeEngine = engine.descriptor;
        const manager = new SceneCacheManager(
          path.join(this.context.globalStorageUri.fsPath, "cache"),
          engine,
          {
            mode: sceneCacheMode,
            maximumPersistentBytes: maximumPersistentCacheBytes,
          },
        );
        sceneCacheManager = manager;
        this.output.appendLine(
          `[ENGINE_SELECTED] id=${engine.descriptor.engineId} version=${engine.descriptor.engineVersion} backend=${engine.descriptor.backendId}`,
        );
        const prepared = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "2D CAD Viewer",
            cancellable: true,
          },
          async (progress, cancellationToken) => {
            const cancellation = cancellationToken.onCancellationRequested(() =>
              controller.abort(),
            );
            const resolutionCancellation = token.onCancellationRequested(() =>
              controller.abort(),
            );
            try {
              return await manager.prepare(document.uri.fsPath, {
                force,
                signal: controller.signal,
                onPreview: progressivePreview
                  ? async (preview) => {
                      if (
                        disposed ||
                        controller.signal.aborted ||
                        currentGeneration !== generation
                      ) {
                        await preview.release();
                        return;
                      }
                      const channel = await CacheRangeChannel.open(
                        preview.cacheId,
                        preview.cachePath,
                        preview.size,
                        (message) =>
                          webviewPanel.webview.postMessage(message),
                      );
                      if (
                        disposed ||
                        controller.signal.aborted ||
                        currentGeneration !== generation
                      ) {
                        await channel.dispose();
                        await preview.release();
                        return;
                      }
                      rangeChannels.set(preview.cacheId, channel);
                      previewReleases.set(
                        preview.cacheId,
                        preview.release,
                      );
                      const firstFrame = preview.reused
                        ? waitForPreviewFrame(
                            preview.cacheId,
                            controller.signal,
                          )
                        : undefined;
                      try {
                        const posted = await webviewPanel.webview.postMessage({
                          type: "dwg-cache-preview-ready/1",
                          cacheId: preview.cacheId,
                          size: preview.size,
                          engineId: preview.engine.engineId,
                          engineVersion: preview.engine.engineVersion,
                          engineBackend: preview.engine.backendId,
                          bigFontEncodings: bigFontEncodings(),
                        });
                        if (!posted) {
                          settlePreviewFrame(preview.cacheId);
                        }
                        void emitQualification("preview-published", {
                          size_bytes: preview.size,
                          reused: preview.reused,
                        });
                        await firstFrame;
                      } catch (error) {
                        await disposePreview(preview.cacheId);
                        throw error;
                      }
                    }
                  : undefined,
                onProgress: (event) => {
                  const phaseText: Record<
                    SceneEngineProgressPhase,
                    string
                  > = {
                    checking: "기존 캐시 확인 중…",
                    parsing: `${engine.descriptor.displayName}에서 DWG 해석 중…`,
                    "preview-ready": "첫 화면 데이터 준비 완료",
                    validating: "변환 결과 검사 중…",
                    "cache-ready": "캐시 준비 완료",
                    failed: "변환 엔진 실행 실패",
                    cancelled: "변환 취소됨",
                  };
                  const message = phaseText[event.phase];
                  progress.report({ message });
                  void emitQualification("engine-progress", {
                    phase: event.phase,
                  }).finally(() => {
                    if (event.phase === "parsing") {
                      closeAfterQualification("conversion");
                    }
                  });
                  if (
                    event.phase === "parsing" ||
                    event.phase === "preview-ready" ||
                    event.phase === "validating"
                  ) {
                    void postState(
                      event.phase === "parsing"
                        ? "converting"
                        : "validating",
                      message,
                    );
                  }
                },
              });
            } finally {
              cancellation.dispose();
              resolutionCancellation.dispose();
            }
          },
        );
        cacheReleases.set(prepared.cachePath, prepared.release);
        if (
          disposed ||
          controller.signal.aborted ||
          currentGeneration !== generation
        ) {
          return;
        }
        void emitQualification("cache-prepared", {
          reused: prepared.reused,
          size_bytes: prepared.size,
        });
        const channel = await CacheRangeChannel.open(
          prepared.cacheId,
          prepared.cachePath,
          prepared.size,
          (message) => webviewPanel.webview.postMessage(message),
        );
        if (
          disposed ||
          controller.signal.aborted ||
          currentGeneration !== generation
        ) {
          await channel.dispose();
          return;
        }
        rangeChannels.set(prepared.cacheId, channel);
        imageReferenceChannel = new ImageReferenceChannel({
          context: this.context,
          documentUri: document.uri,
          output: this.output,
          postMessage: (message) =>
            webviewPanel.webview.postMessage(message),
        });
        imageReferenceChannel.registerSource(
          prepared.cacheId,
          document.uri.fsPath,
        );
        xrefController = new XrefController({
          context: this.context,
          documentUri: document.uri,
          manager,
          output: this.output,
          postMessage: (message) =>
            webviewPanel.webview.postMessage(message),
          publishCache: async (xrefCache, sourcePath) => {
            cacheReleases.set(xrefCache.cachePath, xrefCache.release);
            imageReferenceChannel?.registerSource(
              xrefCache.cacheId,
              sourcePath,
            );
            if (rangeChannels.has(xrefCache.cacheId)) {
              return;
            }
            const xrefChannel = await CacheRangeChannel.open(
              xrefCache.cacheId,
              xrefCache.cachePath,
              xrefCache.size,
              (message) => webviewPanel.webview.postMessage(message),
            );
            if (disposed || controller.signal.aborted) {
              await xrefChannel.dispose();
              return;
            }
            rangeChannels.set(xrefCache.cacheId, xrefChannel);
          },
        });
        xrefController.registerRoot(
          prepared.cacheId,
          document.uri.fsPath,
        );
        activeCacheId = prepared.cacheId;
        activeCacheReused = prepared.reused;
        activeEngine = prepared.engine;
        fontChannel = createFontChannel(prepared.cacheId);
        plotStyleChannel = createPlotStyleChannel(prepared.cacheId);
        activeCacheReadyMessage = {
          type: "dwg-cache-ready/1",
          cacheId: prepared.cacheId,
          documentName: path.basename(document.uri.fsPath),
          size: prepared.size,
          reused: prepared.reused,
          engineId: prepared.engine.engineId,
          engineVersion: prepared.engine.engineVersion,
          engineBackend: prepared.engine.backendId,
          bigFontEncodings: bigFontEncodings(),
        };
        initializeWebview();
        if (webviewReady) {
          await webviewPanel.webview.postMessage(
            activeCacheReadyMessage,
          );
        }
      } catch (error) {
        if (
          disposed ||
          currentGeneration !== generation ||
          isSceneEngineAbort(error)
        ) {
          if (!disposed && currentGeneration === generation) {
            void emitQualification("conversion-cancelled");
            await postState(
              "error",
              "변환이 취소되었습니다. 재시도할 수 있습니다.",
              "CONVERSION_CANCELLED",
            );
            initializeWebview();
          }
          return;
        }
        const code =
          error instanceof SceneEngineError
            ? error.code
            : "VIEWER_PREPARATION_FAILED";
        const message =
          error instanceof SceneEngineError
            ? error.userMessage
            : "도면 뷰어를 준비하지 못했습니다.";
        this.output.appendLine(`[${code}] cache preparation failed`);
        void emitQualification("conversion-failed", { code });
        await postState("error", message, code);
        initializeWebview();
      } finally {
        if (conversion === controller) {
          conversion = undefined;
        }
      }
    };

    const requestStart = (force: boolean): void => {
      const currentGeneration = ++generation;
      conversion?.abort();
      startQueue = startQueue
        .catch(() => undefined)
        .then(() => start(force, currentGeneration))
        .catch(() => {
          this.output.appendLine(
            "[VIEWER_START_FAILED] viewer start queue failed",
          );
        });
    };

    const messageSubscription =
      webviewPanel.webview.onDidReceiveMessage((raw: HostMessage) => {
        const messageCacheId =
          typeof raw?.cacheId === "string" ? raw.cacheId : undefined;
        if (
          messageCacheId &&
          rangeChannels.get(messageCacheId)?.handleMessage(raw)
        ) {
          return;
        }
        if (fontChannel?.handleMessage(raw)) {
          return;
        }
        if (plotStyleChannel?.handleMessage(raw)) {
          return;
        }
        if (xrefController?.handleMessage(raw)) {
          return;
        }
        if (imageReferenceChannel?.handleMessage(raw)) {
          return;
        }
        switch (raw?.type) {
          case "dwg-webview-ready/1": {
            webviewReady = true;
            postMenuDisplaySettings();
            postRenderResolutionSettings();
            postInteractionRenderingSettings();
            postZoomSensitivitySettings();
            if (activeCacheReadyMessage) {
              void webviewPanel.webview.postMessage(
                activeCacheReadyMessage,
              );
            } else if (pendingStateMessage) {
              void webviewPanel.webview.postMessage(
                pendingStateMessage,
              );
            } else if (progressivePreview) {
              requestStart(false);
            }
            void this.postPendingTextMatch(
              document.uri,
              webviewPanel,
            );
            break;
          }
          case "dwg-cache-retry/1":
            requestStart(false);
            break;
          case "dwg-cache-rebuild/1":
            requestStart(true);
            break;
          case "dwg-export-save/1": {
            const requestId =
              typeof raw.requestId === "number" &&
              Number.isSafeInteger(raw.requestId)
                ? raw.requestId
                : 0;
            const format =
              raw.format === "png" ||
              raw.format === "pdf" ||
              raw.format === "zip"
                ? raw.format
                : "";
            const data =
              typeof raw.data === "string" ? raw.data : "";
            const maximumBase64Length =
              Math.ceil((64 * 1024 * 1024 * 4) / 3) + 4;
            if (
              !requestId ||
              !format ||
              !data ||
              data.length > maximumBase64Length ||
              exportSaveInFlight
            ) {
              void webviewPanel.webview.postMessage({
                type: "dwg-export-save-result/1",
                requestId,
                status: "error",
                message: exportSaveInFlight
                  ? "다른 출력 파일을 저장하고 있습니다."
                  : "출력 파일 데이터가 올바르지 않습니다.",
              });
              break;
            }
            const extension = format;
            const requestedStem =
              typeof raw.suggestedName === "string"
                ? raw.suggestedName
                    .normalize("NFC")
                    .replace(/\.[^.\\/]+$/u, "")
                    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
                    .replace(/[.\s]+$/gu, "")
                    .trim()
                    .slice(0, 120)
                : "";
            const documentStem = path
              .basename(document.uri.fsPath, path.extname(document.uri.fsPath))
              .slice(0, 120);
            const fileName = `${requestedStem || documentStem || "drawing"}.${extension}`;
            exportSaveInFlight = true;
            void Promise.resolve(
              vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(
                  path.join(path.dirname(document.uri.fsPath), fileName),
                ),
                title: "2D CAD Viewer 출력 파일 저장",
                saveLabel: "저장",
                filters:
                  format === "pdf"
                    ? { "PDF 문서": ["pdf"] }
                    : format === "png"
                      ? { "PNG 이미지": ["png"] }
                      : { "PNG 배치 묶음": ["zip"] },
              }),
            )
              .then(async (selected) => {
                if (!selected) {
                  await webviewPanel.webview.postMessage({
                    type: "dwg-export-save-result/1",
                    requestId,
                    status: "cancelled",
                  });
                  return;
                }
                const bytes = Buffer.from(data, "base64");
                if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) {
                  throw new Error("출력 파일이 64 MiB 제한을 초과했습니다.");
                }
                await vscode.workspace.fs.writeFile(selected, bytes);
                this.output.appendLine(
                  `[EXPORT_SAVED] format=${format} bytes=${bytes.length}`,
                );
                await webviewPanel.webview.postMessage({
                  type: "dwg-export-save-result/1",
                  requestId,
                  status: "saved",
                  bytes: bytes.length,
                });
                void vscode.window.showInformationMessage(
                  `2D CAD Viewer: ${path.basename(selected.fsPath || selected.path)} 저장 완료`,
                );
              })
              .catch((error: unknown) => {
                const message =
                  error instanceof Error
                    ? error.message
                    : "출력 파일을 저장하지 못했습니다.";
                this.output.appendLine("[EXPORT_SAVE_FAILED]");
                return webviewPanel.webview.postMessage({
                  type: "dwg-export-save-result/1",
                  requestId,
                  status: "error",
                  message: message.slice(0, 300),
                });
              })
              .finally(() => {
                exportSaveInFlight = false;
              });
            break;
          }
          case "dwg-adapter-select/1":
            void Promise.resolve(
              vscode.commands.executeCommand<boolean>(
                SELECT_LIBREDWG_ADAPTER_COMMAND,
              ),
            )
              .then((changed) => {
                void webviewPanel.webview.postMessage({
                  type: "dwg-adapter-select-result/1",
                  changed: Boolean(changed),
                });
                if (changed && !disposed) {
                  requestStart(false);
                }
              })
              .catch(() => {
                this.output.appendLine(
                  "[ADAPTER_CONFIGURATION_FAILED] cannot select adapter",
                );
                void webviewPanel.webview.postMessage({
                  type: "dwg-adapter-select-result/1",
                  changed: false,
                  failed: true,
                });
              });
            break;
          case "dwg-font-folder-select/1": {
            const previousChannel = fontChannel;
            void Promise.resolve(
              vscode.commands.executeCommand<boolean>(
                ADD_SHX_FONT_FOLDERS_COMMAND,
              ),
            )
              .then((changed) => {
                if (changed && fontChannel === previousChannel) {
                  reloadFontConfiguration();
                }
                return webviewPanel.webview.postMessage({
                  type: "dwg-font-folder-select-result/1",
                  changed: Boolean(changed),
                });
              })
              .catch(() => {
                this.output.appendLine(
                  "[FONT_CONFIGURATION_FAILED] cannot update SHX font folders",
                );
                return webviewPanel.webview.postMessage({
                  type: "dwg-font-folder-select-result/1",
                  changed: false,
                  failed: true,
                });
              });
            break;
          }
          case "dwg-font-file-select/1": {
            const channel = fontChannel;
            const cacheId =
              typeof raw.cacheId === "string" ? raw.cacheId : "";
            const name = typeof raw.name === "string" ? raw.name : "";
            const kind =
              raw.kind === "outline"
                ? "outline"
                : raw.kind === "shx"
                  ? "shx"
                  : "";
            if (
              !channel ||
              cacheId !== activeCacheId ||
              !name ||
              !kind
            ) {
              void webviewPanel.webview.postMessage({
                type: "dwg-font-file-select-result/1",
                cacheId,
                name,
                changed: false,
                failed: true,
              });
              break;
            }
            void Promise.resolve(
              vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: `${path.basename(name).slice(0, 120)} 대체 글꼴 선택`,
                openLabel: "이 도면에 적용",
                filters:
                  kind === "outline"
                    ? { "TrueType/OpenType 글꼴": ["ttf", "otf", "ttc"] }
                    : { "CAD SHX 글꼴": ["shx"] },
              }),
            )
              .then((selected) => {
                const selectedFile = selected?.find(
                  (uri) => uri.scheme === "file",
                );
                const selectedPath = selectedFile?.fsPath;
                const changed =
                  typeof selectedPath === "string" &&
                  channel === fontChannel &&
                  cacheId === activeCacheId &&
                  channel.setSessionMapping(name, selectedPath);
                return webviewPanel.webview.postMessage({
                  type: "dwg-font-file-select-result/1",
                  cacheId,
                  name,
                  changed,
                  failed: Boolean(selectedFile) && !changed,
                });
              })
              .catch(() =>
                webviewPanel.webview.postMessage({
                  type: "dwg-font-file-select-result/1",
                  cacheId,
                  name,
                  changed: false,
                  failed: true,
                }),
              );
            break;
          }
          case "dwg-plot-style-file-select/1": {
            const channel = plotStyleChannel;
            const cacheId =
              typeof raw.cacheId === "string" ? raw.cacheId : "";
            const name = typeof raw.name === "string" ? raw.name : "";
            if (
              !channel ||
              cacheId !== activeCacheId ||
              !name
            ) {
              void webviewPanel.webview.postMessage({
                type: "dwg-plot-style-file-select-result/1",
                cacheId,
                name,
                changed: false,
                failed: true,
              });
              break;
            }
            void Promise.resolve(
              vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: `${path.basename(name).slice(0, 120)} 출력 스타일 선택`,
                openLabel: "이 도면에 적용",
                filters: { "색상 종속 출력 스타일": ["ctb"] },
              }),
            )
              .then((selected) => {
                const selectedFile = selected?.find(
                  (uri) => uri.scheme === "file",
                );
                const selectedPath = selectedFile?.fsPath;
                const changed =
                  typeof selectedPath === "string" &&
                  channel === plotStyleChannel &&
                  cacheId === activeCacheId &&
                  channel.setSessionMapping(name, selectedPath);
                return webviewPanel.webview.postMessage({
                  type: "dwg-plot-style-file-select-result/1",
                  cacheId,
                  name,
                  changed,
                  failed: Boolean(selectedFile) && !changed,
                });
              })
              .catch(() =>
                webviewPanel.webview.postMessage({
                  type: "dwg-plot-style-file-select-result/1",
                  cacheId,
                  name,
                  changed: false,
                  failed: true,
                }),
              );
            break;
          }
          case "dwg-visual-complete/1": {
            if (raw.cacheId !== activeCacheId) {
              break;
            }
            const webviewSettleMs = visualCompletionCount(
              raw.webviewSettleMs,
            );
            const detailPendingCount = visualCompletionCount(
              raw.detailPendingCount,
            );
            const xrefCount = visualCompletionCount(raw.xrefCount);
            const xrefIssueCount = visualCompletionCount(
              raw.xrefIssueCount,
            );
            const imageCount = visualCompletionCount(raw.imageCount);
            const imageIssueCount = visualCompletionCount(
              raw.imageIssueCount,
            );
            const fontCount = visualCompletionCount(raw.fontCount);
            const fontIssueCount = visualCompletionCount(
              raw.fontIssueCount,
            );
            if (
              webviewSettleMs === undefined ||
              detailPendingCount === undefined ||
              xrefCount === undefined ||
              xrefIssueCount === undefined ||
              imageCount === undefined ||
              imageIssueCount === undefined ||
              fontCount === undefined ||
              fontIssueCount === undefined ||
              xrefIssueCount > xrefCount ||
              imageIssueCount > imageCount ||
              fontIssueCount > fontCount
            ) {
              break;
            }
            const hostElapsed = Math.max(0, Date.now() - openStartedAt);
            this.output.appendLine(
              `[VISUAL_COMPLETE] host_to_visual_ms=${hostElapsed} webview_settle_ms=${webviewSettleMs} detail_pending=${detailPendingCount} xrefs=${xrefCount} xref_issues=${xrefIssueCount} images=${imageCount} image_issues=${imageIssueCount} fonts=${fontCount} font_issues=${fontIssueCount}`,
            );
            void emitQualification("visual-complete", {
              host_to_visual_complete_ms: hostElapsed,
              webview_settle_ms: webviewSettleMs,
              detail_pending_count: detailPendingCount,
              xref_count: xrefCount,
              xref_issue_count: xrefIssueCount,
              image_count: imageCount,
              image_issue_count: imageIssueCount,
              font_count: fontCount,
              font_issue_count: fontIssueCount,
            }).finally(() => closeAfterQualification("visual"));
            break;
          }
          case "dwg-first-frame-ready/1":
            if (raw.cacheId === activeCacheId) {
              const hostElapsed = Math.max(0, Date.now() - openStartedAt);
              const webviewElapsed =
                typeof raw.firstFrameMs === "number" &&
                Number.isFinite(raw.firstFrameMs) &&
                raw.firstFrameMs >= 0
                  ? Math.round(raw.firstFrameMs)
                  : -1;
              this.output.appendLine(
                `[FIRST_FRAME_READY] cache=${
                  activeCacheReused ? "reused" : "created"
                } engine=${activeEngine?.engineId ?? "unknown"} backend=${
                  activeEngine?.backendId ?? "unknown"
                } host_to_frame_ms=${hostElapsed} webview_frame_ms=${webviewElapsed}`,
              );
              void disposeInactivePreviews();
              void emitQualification("full-first-frame", {
                host_to_frame_ms: hostElapsed,
                webview_frame_ms: webviewElapsed,
              }).finally(() => closeAfterQualification("full"));
            } else if (
              typeof raw.cacheId === "string" &&
              previewReleases.has(raw.cacheId)
            ) {
              settlePreviewFrame(raw.cacheId);
              const hostElapsed = Math.max(0, Date.now() - openStartedAt);
              this.output.appendLine(
                `[PREVIEW_FRAME_READY] engine=${
                  activeEngine?.engineId ?? "libredwg"
                } host_to_frame_ms=${hostElapsed}`,
              );
              void emitQualification("preview-first-frame", {
                host_to_frame_ms: hostElapsed,
              }).finally(() => closeAfterQualification("preview"));
            }
            break;
          case "dwg-viewer-error/1": {
            const code =
              typeof raw.code === "string"
                ? raw.code.slice(0, 80)
                : "unknown";
            this.output.appendLine(
              `[WEBVIEW_ERROR] ${code}`,
            );
            if (raw.cacheId === activeCacheId) {
              const qualificationCode = /^[^/\\\r\n]{1,80}$/u.test(code)
                ? code
                : "unknown";
              void emitQualification("render-failed", {
                code: qualificationCode,
              });
            }
            if (
              typeof raw.cacheId === "string" &&
              previewReleases.has(raw.cacheId)
            ) {
              void disposePreview(raw.cacheId);
            }
            break;
          }
        }
      });

    const fontConfigurationSubscription =
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration(
            "dwgViewer.shxFontDirectories",
            document.uri,
          ) &&
          !event.affectsConfiguration(
            "dwgViewer.shxFontMappings",
            document.uri,
          ) &&
          !event.affectsConfiguration(
            "dwgViewer.shxBigFontEncodings",
            document.uri,
          )
        ) {
          return;
        }
        reloadFontConfiguration();
      });

    const menuConfigurationSubscription =
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration(
            "dwgViewer.topToolbarLabels",
            document.uri,
          ) &&
          !event.affectsConfiguration(
            "dwgViewer.leftToolbarLabels",
            document.uri,
          )
        ) {
          return;
        }
        postMenuDisplaySettings();
      });

    const renderConfigurationSubscription =
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(
            "dwgViewer.renderResolution",
            document.uri,
          )
        ) {
          postRenderResolutionSettings();
        }
        if (
          event.affectsConfiguration(
            "dwgViewer.interactionRendering",
            document.uri,
          )
        ) {
          postInteractionRenderingSettings();
        }
        if (
          event.affectsConfiguration(
            "dwgViewer.mouseWheelZoomSensitivity",
            document.uri,
          ) ||
          event.affectsConfiguration(
            "dwgViewer.trackpadPinchZoomSensitivity",
            document.uri,
          )
        ) {
          postZoomSensitivitySettings();
        }
      });

    let resolutionCancellation: vscode.Disposable | undefined;
    const disposeSession = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      generation += 1;
      messageSubscription.dispose();
      fontConfigurationSubscription.dispose();
      menuConfigurationSubscription.dispose();
      renderConfigurationSubscription.dispose();
      resolutionCancellation?.dispose();
      resolutionCancellation = undefined;
      void emitQualification("editor-dispose-start");
      void stopCurrent().finally(() =>
        emitQualification("editor-disposed"),
      );
    };
    const documentSession = document.addSession(disposeSession);
    webviewPanel.onDidDispose(() => {
      documentSession.dispose();
      disposeSession();
    });
    resolutionCancellation =
      token.onCancellationRequested(disposeSession);
    if (disposed) {
      resolutionCancellation.dispose();
      resolutionCancellation = undefined;
    }
    if (progressivePreview) {
      initializeWebview();
    } else {
      requestStart(false);
    }
  }
}

let qualificationReporter: QualificationReporter | undefined;

export function activate(context: vscode.ExtensionContext): void {
  qualificationReporter = createQualificationReporter();
  if (qualificationReporter) {
    activateRevisionComparisonQualification(
      context,
      qualificationReporter,
    );
  }
  const output = vscode.window.createOutputChannel("2D CAD Viewer");
  const managedEngine = new ManagedEngineManager({
    storageRoot: path.join(
      context.globalStorageUri.fsPath,
      "engines",
    ),
    catalogPath: path.join(
      context.extensionPath,
      "dist",
      ENGINE_ASSET_CATALOG_NAME,
    ),
    viewerVersion: String(context.extension.packageJSON.version),
    onEvent: (phase, details) => {
      output.appendLine(
        `[MANAGED_ENGINE_${phase.toLocaleUpperCase("en-US")}] ${JSON.stringify(details)}`,
      );
    },
  });
  if (context.extensionMode === vscode.ExtensionMode.Production) {
    void managedEngine.ensure().then(
      async (installation) => {
        output.appendLine(
          `[MANAGED_ENGINE_PREFETCHED] target=${installation.target} reused=${installation.reused} source=${installation.sourceUrl}`,
        );
        await maintainSceneCacheStorage(
          context,
          output,
          installation.adapterPath,
        );
      },
      (error) => {
        const details = adapterErrorDetails(error);
        output.appendLine(
          `[${details.code}] managed engine background setup deferred`,
        );
      },
    );
  }
  const provider = new DwgEditorProvider(
    context,
    output,
    managedEngine,
    qualificationReporter,
  );
  const textSearch = new WorkspaceTextSearchController(
    context,
    output,
    (match) => provider.revealTextMatch(match),
  );
  context.subscriptions.push(
    output,
    textSearch,
    vscode.commands.registerCommand(
      ADD_SHX_FONT_FOLDERS_COMMAND,
      addShxFontFolders,
    ),
    vscode.commands.registerCommand(
      SELECT_LIBREDWG_ADAPTER_COMMAND,
      () => selectLibreDwgAdapter(output),
    ),
    vscode.commands.registerCommand(
      DIAGNOSE_LIBREDWG_ADAPTER_COMMAND,
      () =>
        diagnoseConfiguredLibreDwgAdapter(
          context,
          output,
          managedEngine,
        ),
    ),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: {
        retainContextWhenHidden: false,
      },
    }),
  );
}

export async function deactivate(): Promise<void> {
  await qualificationReporter?.close();
  qualificationReporter = undefined;
}
