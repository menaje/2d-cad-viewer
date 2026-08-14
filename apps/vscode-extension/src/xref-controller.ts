import path from "node:path";
import * as vscode from "vscode";
import {
  BoundedTaskQueue,
  TaskQueueDisposedError,
} from "./bounded-task-queue";
import {
  type PreparedCache,
  SceneCacheManager,
} from "./scene-cache-manager";
import {
  normalizePortablePath,
  resolveXrefPath,
  type XrefManualMappings,
  xrefBasename,
  xrefExactMappingKey,
} from "./xref-resolver";
import {
  xrefSavedState,
  xrefShouldLoadAutomatically,
  type XrefSavedState,
} from "./xref-state";

const XREF_MAPPING_STATE_KEY = "dwgViewer.xrefMappings.v1";
const MAX_XREF_REFERENCES = 64;
const MAX_XREF_DEPTH = 8;
const XREF_MOUNT_TIMEOUT_MS = 30_000;
const MAX_XREF_TASK_CONCURRENCY = 2;

interface XrefReferenceMessage {
  blockIndex?: unknown;
  name?: unknown;
  path?: unknown;
  overlay?: unknown;
  xrefLoaded?: unknown;
  xrefResolved?: unknown;
}

interface ValidXrefReference {
  blockIndex: number;
  name: string;
  path: string;
  overlay: boolean;
  xrefLoaded?: boolean;
  xrefResolved?: boolean;
}

interface XrefDiscoveryMessage {
  type?: unknown;
  cacheId?: unknown;
  references?: unknown;
}

interface XrefSelectionMessage {
  type?: unknown;
  parentCacheId?: unknown;
  blockIndex?: unknown;
}

interface XrefMountedMessage {
  type?: unknown;
  parentCacheId?: unknown;
  blockIndex?: unknown;
  cacheId?: unknown;
  status?: unknown;
}

interface SourceContext {
  sourcePath: string;
  depth: number;
  ancestors: ReadonlySet<string>;
  allowNested: boolean;
}

interface PendingReference {
  key: string;
  parentCacheId: string;
  parent: SourceContext;
  blockIndex: number;
  name: string;
  storedPath: string;
  overlay: boolean;
  savedState: XrefSavedState;
  lastFailure?: "ambiguous" | "error" | "missing";
}

type PostMessage = (message: unknown) => PromiseLike<boolean>;

export interface XrefControllerOptions {
  context: vscode.ExtensionContext;
  documentUri: vscode.Uri;
  manager: SceneCacheManager;
  output: vscode.OutputChannel;
  postMessage: PostMessage;
  publishCache: (
    prepared: PreparedCache,
    sourcePath: string,
  ) => Promise<void>;
}

function sourceKey(value: string): string {
  const resolved = path.resolve(value).normalize("NFC");
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

function validBlockIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validReference(
  value: unknown,
): value is ValidXrefReference {
  if (!value || typeof value !== "object") {
    return false;
  }
  const reference = value as XrefReferenceMessage;
  return (
    validBlockIndex(reference.blockIndex) &&
    typeof reference.name === "string" &&
    reference.name.length <= 1_024 &&
    typeof reference.path === "string" &&
    reference.path.length <= 32_768 &&
    typeof reference.overlay === "boolean" &&
    (reference.xrefLoaded === undefined ||
      typeof reference.xrefLoaded === "boolean") &&
    (reference.xrefResolved === undefined ||
      typeof reference.xrefResolved === "boolean")
  );
}

function portableDirectory(value: string): string {
  const normalized = normalizePortablePath(value);
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : "";
}

function cleanMappings(value: unknown): XrefManualMappings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const cleanRecord = (candidate: unknown): Record<string, string> => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .filter(
          ([key, mapped]) =>
            key.length <= 65_536 &&
            typeof mapped === "string" &&
            path.isAbsolute(mapped),
        )
        .slice(0, 512) as [string, string][],
    );
  };
  return {
    exact: cleanRecord(source.exact),
    basenames: cleanRecord(source.basenames),
    prefixes: cleanRecord(source.prefixes),
  };
}

export class XrefController {
  private readonly abortController = new AbortController();
  private readonly sources = new Map<string, SourceContext>();
  private readonly pending = new Map<string, PendingReference>();
  private readonly preparedBySource = new Map<string, PreparedCache>();
  private readonly mountWaiters = new Map<
    string,
    {
      resolve: (mounted: boolean) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly taskQueue = new BoundedTaskQueue(
    MAX_XREF_TASK_CONCURRENCY,
  );
  private readonly prepareQueue = new BoundedTaskQueue(1);
  private referenceCount = 0;
  private disposed = false;

  constructor(private readonly options: XrefControllerOptions) {}

  registerRoot(cacheId: string, sourcePath: string): void {
    const key = sourceKey(sourcePath);
    this.sources.set(cacheId, {
      sourcePath: path.resolve(sourcePath),
      depth: 0,
      ancestors: new Set([key]),
      allowNested: true,
    });
  }

  handleMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") {
      return false;
    }
    const type = (message as { type?: unknown }).type;
    if (type === "dwg-xrefs-discovered/1") {
      this.enqueueDiscovery(message as XrefDiscoveryMessage);
      return true;
    }
    if (type === "dwg-xref-select/1") {
      this.enqueueSelection(message as XrefSelectionMessage);
      return true;
    }
    if (type === "dwg-xref-load/1") {
      this.enqueueLoad(message as XrefSelectionMessage);
      return true;
    }
    if (type === "dwg-xref-mounted/1") {
      this.handleMounted(message as XrefMountedMessage);
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abortController.abort();
    this.taskQueue.dispose();
    this.prepareQueue.dispose();
    this.sources.clear();
    this.pending.clear();
    this.preparedBySource.clear();
    for (const waiter of this.mountWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.mountWaiters.clear();
  }

  private enqueue(task: () => Promise<void>): void {
    void this.taskQueue
      .run(async () => {
        if (!this.disposed) {
          await task();
        }
      })
      .catch((error: unknown) => {
        if (
          this.disposed ||
          error instanceof TaskQueueDisposedError
        ) {
          return;
        }
        this.options.output.appendLine(
          `[XREF_TASK_FAILED] ${
            error instanceof Error ? error.message.slice(0, 200) : "unknown"
          }`,
        );
      });
  }

  private prepareSource(
    resolvedKey: string,
    sourcePath: string,
  ): Promise<PreparedCache> {
    const existing = this.preparedBySource.get(resolvedKey);
    if (existing) {
      return Promise.resolve(existing);
    }
    return this.prepareQueue.run(async () => {
      let prepared = this.preparedBySource.get(resolvedKey);
      if (!prepared) {
        prepared = await this.options.manager.prepare(sourcePath, {
          signal: this.abortController.signal,
        });
        await this.options.publishCache(prepared, sourcePath);
        this.preparedBySource.set(resolvedKey, prepared);
      }
      return prepared;
    });
  }

  private enqueueDiscovery(message: XrefDiscoveryMessage): void {
    const cacheId =
      typeof message.cacheId === "string" ? message.cacheId : "";
    const parent = this.sources.get(cacheId);
    if (
      !parent ||
      !Array.isArray(message.references) ||
      message.references.length > MAX_XREF_REFERENCES ||
      !message.references.every(validReference)
    ) {
      return;
    }
    if (!parent.allowNested) {
      return;
    }
    for (const reference of message.references) {
      if (this.referenceCount >= MAX_XREF_REFERENCES) {
        void this.options.postMessage({
          type: "dwg-xref-status/1",
          parentCacheId: cacheId,
          blockIndex: reference.blockIndex,
          name: reference.name,
          status: "limit",
          message: "참조도면 자동 로드 한도에 도달했습니다.",
        });
        continue;
      }
      this.referenceCount += 1;
      const pending: PendingReference = {
        key: `${cacheId}:${reference.blockIndex}`,
        parentCacheId: cacheId,
        parent,
        blockIndex: reference.blockIndex,
        name: reference.name,
        storedPath: reference.path,
        overlay: reference.overlay,
        savedState: xrefSavedState(reference),
      };
      this.pending.set(pending.key, pending);
      if (xrefShouldLoadAutomatically(pending.savedState)) {
        this.enqueue(() => this.resolveAndPrepare(pending));
      } else {
        this.enqueue(() => this.postSavedState(pending));
      }
    }
  }

  private enqueueSelection(message: XrefSelectionMessage): void {
    const parentCacheId =
      typeof message.parentCacheId === "string"
        ? message.parentCacheId
        : "";
    if (!validBlockIndex(message.blockIndex)) {
      return;
    }
    const pending = this.pending.get(
      `${parentCacheId}:${message.blockIndex}`,
    );
    if (pending) {
      this.enqueue(() => this.selectManually(pending));
    }
  }

  private enqueueLoad(message: XrefSelectionMessage): void {
    const parentCacheId =
      typeof message.parentCacheId === "string"
        ? message.parentCacheId
        : "";
    if (!validBlockIndex(message.blockIndex)) {
      return;
    }
    const pending = this.pending.get(
      `${parentCacheId}:${message.blockIndex}`,
    );
    if (pending) {
      pending.lastFailure = undefined;
      this.enqueue(() => this.resolveAndPrepare(pending));
    }
  }

  private handleMounted(message: XrefMountedMessage): void {
    const parentCacheId =
      typeof message.parentCacheId === "string"
        ? message.parentCacheId
        : "";
    const cacheId =
      typeof message.cacheId === "string" ? message.cacheId : "";
    if (
      !parentCacheId ||
      !cacheId ||
      !validBlockIndex(message.blockIndex) ||
      (message.status !== "ready" && message.status !== "error")
    ) {
      return;
    }
    this.settleMount(
      this.mountKey(parentCacheId, message.blockIndex, cacheId),
      message.status === "ready",
    );
  }

  private searchRoots(): string[] {
    const configuration = vscode.workspace.getConfiguration(
      "dwgViewer",
      this.options.documentUri,
    );
    const configured = configuration.get<unknown>(
      "xrefSearchDirectories",
      [],
    );
    return [
      ...(Array.isArray(configured)
        ? configured.filter(
            (value): value is string =>
              typeof value === "string" && path.isAbsolute(value),
          )
        : []),
      ...(vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => folder.uri.fsPath),
    ];
  }

  private mappings(): XrefManualMappings {
    return cleanMappings(
      this.options.context.workspaceState.get(XREF_MAPPING_STATE_KEY),
    );
  }

  private async saveMappings(mappings: XrefManualMappings): Promise<void> {
    await this.options.context.workspaceState.update(
      XREF_MAPPING_STATE_KEY,
      mappings,
    );
  }

  private async resolveAndPrepare(
    reference: PendingReference,
  ): Promise<void> {
    if (
      this.disposed ||
      reference.parent.depth >= MAX_XREF_DEPTH
    ) {
      await this.postStatus(reference, "limit", {
        message: "중첩 참조 깊이 한도에 도달했습니다.",
      });
      return;
    }
    await this.postStatus(reference, "searching");
    const resolution = await resolveXrefPath({
      drawingPath: reference.parent.sourcePath,
      storedPath: reference.storedPath,
      searchRoots: this.searchRoots(),
      mappings: this.mappings(),
      signal: this.abortController.signal,
    });
    if (this.disposed || this.abortController.signal.aborted) {
      return;
    }
    if (resolution.status !== "resolved") {
      reference.lastFailure = resolution.status;
      await this.postStatus(reference, resolution.status, {
        candidateCount: resolution.candidates.length,
        searchTruncated: resolution.searchTruncated,
        canSelect: true,
        message:
          resolution.status === "ambiguous"
            ? "같은 우선순위의 파일이 여러 개라 직접 선택이 필요합니다."
            : "참조 파일을 찾지 못했습니다. 직접 파일을 지정할 수 있습니다.",
      });
      return;
    }
    const resolvedKey = sourceKey(resolution.path);
    if (reference.parent.ancestors.has(resolvedKey)) {
      await this.postStatus(reference, "cycle", {
        message: "순환 참조를 감지해 로드를 중단했습니다.",
      });
      return;
    }

    try {
      await this.postStatus(reference, "converting", {
        method: resolution.method,
      });
      const prepared = await this.prepareSource(
        resolvedKey,
        resolution.path,
      );
      if (this.disposed || this.abortController.signal.aborted) {
        return;
      }
      const ancestors = new Set(reference.parent.ancestors);
      ancestors.add(resolvedKey);
      if (!this.sources.has(prepared.cacheId)) {
        this.sources.set(prepared.cacheId, {
          sourcePath: resolution.path,
          depth: reference.parent.depth + 1,
          ancestors,
          allowNested: !reference.overlay,
        });
      }
      const readyMessage = {
        type: "dwg-xref-cache-ready/1",
        parentCacheId: reference.parentCacheId,
        parentBlockIndex: reference.blockIndex,
        cacheId: prepared.cacheId,
        size: prepared.size,
        name: reference.name,
        overlay: reference.overlay,
        depth: reference.parent.depth + 1,
        reused: prepared.reused,
        fileName: path.basename(resolution.path),
        resolution: resolution.method,
      };
      const mounted = await this.postAndWaitForMount(
        reference,
        prepared.cacheId,
        readyMessage,
      );
      if (!mounted) {
        if (this.disposed || this.abortController.signal.aborted) {
          return;
        }
        reference.lastFailure = "error";
        await this.postStatus(reference, "error", {
          canSelect: true,
          message:
            "참조도면 화면 구성이 완료되지 않았습니다. 파일을 다시 지정할 수 있습니다.",
        });
        return;
      }
      this.pending.delete(reference.key);
      this.options.output.appendLine(
        `[XREF_READY] parent=${reference.parentCacheId.slice(
          0,
          12,
        )} block=${reference.blockIndex} method=${
          resolution.method
        } cache=${prepared.reused ? "reused" : "created"}`,
      );
    } catch (error) {
      if (this.disposed || this.abortController.signal.aborted) {
        return;
      }
      this.options.output.appendLine(
        `[XREF_PREPARE_FAILED] ${
          error instanceof Error
            ? error.message.slice(0, 200)
            : "unknown"
        }`,
      );
      reference.lastFailure = "error";
      await this.postStatus(reference, "error", {
        canSelect: true,
        message:
          "참조도면을 변환하거나 읽기 채널을 열지 못했습니다. 다른 파일을 직접 선택할 수 있습니다.",
      });
    }
  }

  private mountKey(
    parentCacheId: string,
    blockIndex: number,
    cacheId: string,
  ): string {
    return `${parentCacheId}:${blockIndex}:${cacheId}`;
  }

  private settleMount(key: string, mounted: boolean): void {
    const waiter = this.mountWaiters.get(key);
    if (!waiter) {
      return;
    }
    this.mountWaiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(mounted);
  }

  private async postAndWaitForMount(
    reference: PendingReference,
    cacheId: string,
    message: unknown,
  ): Promise<boolean> {
    const key = this.mountKey(
      reference.parentCacheId,
      reference.blockIndex,
      cacheId,
    );
    this.settleMount(key, false);
    const mounted = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.settleMount(key, false);
      }, XREF_MOUNT_TIMEOUT_MS);
      this.mountWaiters.set(key, { resolve, timer });
    });
    try {
      if (!(await this.options.postMessage(message))) {
        this.settleMount(key, false);
      }
      return await mounted;
    } catch (error) {
      this.settleMount(key, false);
      await mounted;
      throw error;
    }
  }

  private async selectManually(
    reference: PendingReference,
  ): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(
        path.dirname(reference.parent.sourcePath),
      ),
      filters: { "DWG 도면": ["dwg", "DWG"] },
      title: `${reference.name} 참조도면 선택`,
      openLabel: "이 파일 연결",
    });
    const selectedPath = selected?.find(
      (uri) => uri.scheme === "file",
    )?.fsPath;
    if (!selectedPath || this.disposed) {
      if (!this.disposed) {
        await this.restoreManualSelection(reference);
      }
      return;
    }
    const basename = xrefBasename(reference.storedPath);
    const sourceDirectory = portableDirectory(reference.storedPath);
    const scopes: Array<{
      label: string;
      description: string;
      value: "exact" | "basename" | "prefix";
    }> = [
      {
        label: "이 참조만",
        description: "현재 도면의 이 경로에만 적용",
        value: "exact",
      },
    ];
    if (basename && basename !== ".dwg") {
      scopes.push({
        label: "같은 파일명",
        description: "이 워크스페이스의 같은 참조 파일명에 적용",
        value: "basename",
      });
    }
    if (sourceDirectory) {
      scopes.push({
        label: "같은 원본 폴더",
        description: "이전 서버 폴더를 선택한 로컬 폴더로 치환",
        value: "prefix",
      });
    }
    const scope = await vscode.window.showQuickPick(
      scopes,
      {
        title: "수동 연결 적용 범위",
        placeHolder: "기본값은 현재 참조에만 안전하게 적용합니다.",
      },
    );
    if (!scope || this.disposed) {
      if (!this.disposed) {
        await this.restoreManualSelection(reference);
      }
      return;
    }
    const current = this.mappings();
    const next: XrefManualMappings = {
      exact: { ...(current.exact ?? {}) },
      basenames: { ...(current.basenames ?? {}) },
      prefixes: { ...(current.prefixes ?? {}) },
    };
    if (scope.value === "basename") {
      (next.basenames as Record<string, string>)[basename] = selectedPath;
    } else if (scope.value === "prefix") {
      (next.prefixes as Record<string, string>)[sourceDirectory] =
        path.dirname(selectedPath);
    }
    (next.exact as Record<string, string>)[
      xrefExactMappingKey(
        reference.parent.sourcePath,
        reference.storedPath,
      )
    ] = selectedPath;
    await this.saveMappings(next);
    await this.resolveAndPrepare(reference);
  }

  private async restoreManualSelection(
    reference: PendingReference,
  ): Promise<void> {
    if (!reference.lastFailure && reference.savedState !== "enabled") {
      await this.postSavedState(reference, true);
      return;
    }
    const status = reference.lastFailure ?? "missing";
    await this.postStatus(reference, status, {
      canSelect: true,
      message:
        status === "ambiguous"
          ? "파일 선택을 취소했습니다. 후보가 여러 개라 직접 선택이 필요합니다."
          : status === "error"
            ? "파일 선택을 취소했습니다. 변환에 실패한 참조 파일을 다시 지정할 수 있습니다."
          : "파일 선택을 취소했습니다. 참조 파일을 직접 지정할 수 있습니다.",
    });
  }

  private async postSavedState(
    reference: PendingReference,
    selectionCancelled = false,
  ): Promise<void> {
    const cancelledPrefix = selectionCancelled
      ? "파일 선택을 취소했습니다. "
      : "";
    await this.postStatus(reference, reference.savedState, {
      canLoad: true,
      canSelect: true,
      message:
        reference.savedState === "unloaded"
          ? `${cancelledPrefix}원본 도면에 언로드 상태로 저장되어 있습니다. 이번 세션에서만 로드하거나 다른 파일을 지정할 수 있습니다.`
          : `${cancelledPrefix}원본 도면에 미해결 상태로 저장되어 있습니다. 이번 세션에서 경로를 다시 확인하거나 파일을 직접 지정할 수 있습니다.`,
    });
  }

  private async postStatus(
    reference: PendingReference,
    status: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.options.postMessage({
      type: "dwg-xref-status/1",
      parentCacheId: reference.parentCacheId,
      blockIndex: reference.blockIndex,
      name: reference.name,
      storedPath: reference.storedPath,
      status,
      ...fields,
    });
  }
}

export {
  MAX_XREF_DEPTH,
  MAX_XREF_REFERENCES,
  MAX_XREF_TASK_CONCURRENCY,
  XREF_MOUNT_TIMEOUT_MS,
  XREF_MAPPING_STATE_KEY,
};
