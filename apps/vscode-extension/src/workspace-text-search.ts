import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  LibreDwgNativeSceneEngine,
  LIBREDWG_ADAPTER_EXTENSION_ID,
  resolveLibreDwgAdapter,
} from "./native-cache";
import {
  findSceneCacheTextMatches,
  readSceneCacheTextIndex,
  validateSceneCacheTextQuery,
  type SceneCacheTextMatch,
  type SceneCacheTextRecord,
} from "./scene-cache-text-index";
import { SceneCacheManager } from "./scene-cache-manager";
import { isSceneEngineAbort } from "./scene-engine";

export const TEXT_SEARCH_VIEW_ID = "dwgViewer.textSearch";
export const SEARCH_WORKSPACE_TEXT_COMMAND =
  "dwgViewer.searchWorkspaceText";
export const REFRESH_WORKSPACE_TEXT_COMMAND =
  "dwgViewer.refreshWorkspaceTextSearch";
export const TOGGLE_TEXT_SEARCH_REGULAR_EXPRESSION_COMMAND =
  "dwgViewer.toggleTextSearchRegularExpression";
export const OPEN_TEXT_MATCH_COMMAND = "dwgViewer.openTextMatch";

const INDEX_VERSION = 1;
const DEFAULT_MAXIMUM_FILES = 100;
const DEFAULT_MAXIMUM_RESULTS = 2_000;
const REGULAR_EXPRESSION_CONTEXT =
  "dwgViewer.textSearchRegularExpressionEnabled";
const REGULAR_EXPRESSION_STATE =
  "dwgViewer.textSearchRegularExpressionEnabled";

export interface WorkspaceTextMatch extends SceneCacheTextMatch {
  uri: vscode.Uri;
}

interface FileNode {
  type: "file";
  uri: vscode.Uri;
  matches: readonly WorkspaceTextMatch[];
}

interface MatchNode {
  type: "match";
  match: WorkspaceTextMatch;
}

interface StatusNode {
  type: "status";
  label: string;
  description?: string;
}

type TextSearchNode = FileNode | MatchNode | StatusNode;

interface StoredTextIndex {
  version: number;
  cacheId: string;
  records: readonly SceneCacheTextRecord[];
}

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), maximum)
    : fallback;
}

function isStoredRecord(value: unknown): value is SceneCacheTextRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<SceneCacheTextRecord>;
  return (
    typeof record.handle === "string" &&
    ["TEXT", "MTEXT", "ATTDEF", "ATTRIB"].includes(record.kind ?? "") &&
    typeof record.value === "string" &&
    typeof record.tag === "string" &&
    typeof record.prompt === "string" &&
    typeof record.searchText === "string" &&
    Number.isSafeInteger(record.layerIndex) &&
    Array.isArray(record.insertionPoint) &&
    record.insertionPoint.length === 3 &&
    record.insertionPoint.every(Number.isFinite) &&
    typeof record.height === "number" &&
    typeof record.hidden === "boolean"
  );
}

function fileKey(uri: vscode.Uri): string {
  return process.platform === "win32"
    ? uri.fsPath.toLocaleLowerCase("en-US")
    : uri.fsPath;
}

function relativeDirectory(uri: vscode.Uri): string {
  const relative = vscode.workspace.asRelativePath(uri, false);
  const directory = path.dirname(relative);
  return directory === "." ? "" : directory;
}

export class WorkspaceTextSearchController
  implements vscode.TreeDataProvider<TextSearchNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<
    TextSearchNode | undefined
  >();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly memoryIndexes = new Map<
    string,
    readonly SceneCacheTextRecord[]
  >();
  private roots: readonly TextSearchNode[] = [];
  private lastQuery = "";
  private searching = false;
  private useRegularExpression = false;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly onOpenMatch: (
      match: WorkspaceTextMatch,
    ) => Promise<void>,
  ) {
    this.useRegularExpression =
      context.workspaceState.get<boolean>(REGULAR_EXPRESSION_STATE) ??
      vscode.workspace
        .getConfiguration("dwgViewer")
        .get<boolean>("textSearchUseRegularExpression", false);
    this.roots = [
      {
        type: "status",
        label: "도면 문자 검색",
        description: this.searchModeDescription(
          "검색 버튼을 눌러 시작하세요.",
        ),
      },
    ];
    void vscode.commands.executeCommand(
      "setContext",
      REGULAR_EXPRESSION_CONTEXT,
      this.useRegularExpression,
    );
    const tree = vscode.window.createTreeView(TEXT_SEARCH_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(
      tree,
      vscode.commands.registerCommand(
        SEARCH_WORKSPACE_TEXT_COMMAND,
        () => this.promptAndSearch(),
      ),
      vscode.commands.registerCommand(
        REFRESH_WORKSPACE_TEXT_COMMAND,
        () => this.search(this.lastQuery),
      ),
      vscode.commands.registerCommand(
        TOGGLE_TEXT_SEARCH_REGULAR_EXPRESSION_COMMAND,
        () => this.toggleRegularExpression(),
      ),
      vscode.commands.registerCommand(
        OPEN_TEXT_MATCH_COMMAND,
        (match: WorkspaceTextMatch) => this.onOpenMatch(match),
      ),
    );
  }

  getTreeItem(element: TextSearchNode): vscode.TreeItem {
    if (element.type === "status") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = element.description;
      item.iconPath = new vscode.ThemeIcon(
        this.searching ? "loading~spin" : "search",
      );
      return item;
    }
    if (element.type === "file") {
      const item = new vscode.TreeItem(
        path.basename(element.uri.fsPath),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.resourceUri = element.uri;
      item.description = [
        relativeDirectory(element.uri),
        `${element.matches.length.toLocaleString()}개`,
      ]
        .filter(Boolean)
        .join(" · ");
      item.contextValue = "dwgTextSearchFile";
      return item;
    }
    const { match } = element;
    const item = new vscode.TreeItem(
      match.snippet || match.value || match.tag || "(빈 문자)",
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${match.kind} · 0x${match.handle}${
      match.hidden ? " · 숨김" : ""
    }`;
    item.iconPath = new vscode.ThemeIcon("symbol-text");
    item.tooltip = new vscode.MarkdownString(
      [
        `**${match.kind} · 0x${match.handle}**`,
        "",
        match.value || match.tag || match.prompt || "(빈 문자)",
      ].join("\n"),
    );
    item.command = {
      command: OPEN_TEXT_MATCH_COMMAND,
      title: "도면에서 문자 열기",
      arguments: [match],
    };
    item.contextValue = "dwgTextSearchMatch";
    return item;
  }

  getChildren(element?: TextSearchNode): TextSearchNode[] {
    if (!element) {
      return [...this.roots];
    }
    if (element.type === "file") {
      return element.matches.map((match) => ({
        type: "match",
        match,
      }));
    }
    return [];
  }

  private update(roots: readonly TextSearchNode[]): void {
    this.roots = roots;
    this.changed.fire(undefined);
  }

  private searchModeDescription(description?: string): string {
    return [
      this.useRegularExpression ? "정규식" : "일반 문자",
      description,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  private async toggleRegularExpression(): Promise<void> {
    if (this.searching) {
      void vscode.window.showInformationMessage(
        "검색이 끝난 뒤 정규식 모드를 바꿀 수 있습니다.",
      );
      return;
    }
    this.useRegularExpression = !this.useRegularExpression;
    await this.context.workspaceState.update(
      REGULAR_EXPRESSION_STATE,
      this.useRegularExpression,
    );
    await vscode.commands.executeCommand(
      "setContext",
      REGULAR_EXPRESSION_CONTEXT,
      this.useRegularExpression,
    );
    if (this.lastQuery) {
      await this.search(this.lastQuery);
      return;
    }
    this.update([
      {
        type: "status",
        label: "도면 문자 검색",
        description: this.searchModeDescription(
          "검색 버튼을 눌러 시작하세요.",
        ),
      },
    ]);
  }

  private async promptAndSearch(): Promise<void> {
    const useRegularExpression = this.useRegularExpression;
    const configuration =
      vscode.workspace.getConfiguration("dwgViewer");
    const matchCase = configuration.get<boolean>(
      "textSearchMatchCase",
      false,
    );
    const wholeWord = configuration.get<boolean>(
      "textSearchWholeWord",
      false,
    );
    const query = await vscode.window.showInputBox({
      title: `DWG 워크스페이스 문자 검색 (${
        useRegularExpression ? "정규식" : "일반 문자"
      })`,
      prompt: useRegularExpression
        ? "JavaScript 정규식으로 DWG 문자(TEXT·MTEXT·ATTRIB·ATTDEF)를 찾습니다. /구분자/는 입력하지 마세요."
        : "워크스페이스의 DWG 문자(TEXT·MTEXT·ATTRIB·ATTDEF)를 찾습니다.",
      placeHolder: useRegularExpression
        ? String.raw`예: 회의실|ROOM-\d+`
        : "찾을 문자",
      value: this.lastQuery,
      ignoreFocusOut: true,
      validateInput: (value) =>
        validateSceneCacheTextQuery(value, {
          matchCase,
          wholeWord,
          useRegularExpression,
        }),
    });
    if (query === undefined) {
      return;
    }
    await this.search(query);
  }

  private indexDirectory(): string {
    const root =
      this.context.storageUri ??
      vscode.Uri.joinPath(
        this.context.globalStorageUri,
        "workspace-text-index",
      );
    return path.join(root.fsPath, "dwg-text-index-v1");
  }

  private async loadStoredIndex(
    cacheId: string,
  ): Promise<readonly SceneCacheTextRecord[] | undefined> {
    const filePath = path.join(this.indexDirectory(), `${cacheId}.json`);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as
        | StoredTextIndex
        | undefined;
      if (
        parsed?.version !== INDEX_VERSION ||
        parsed.cacheId !== cacheId ||
        !Array.isArray(parsed.records) ||
        parsed.records.length > 262_144 ||
        !parsed.records.every(isStoredRecord)
      ) {
        return undefined;
      }
      return Object.freeze(
        parsed.records.map((record) =>
          Object.freeze({
            ...record,
            insertionPoint: Object.freeze(
              [...record.insertionPoint],
            ) as unknown as readonly [number, number, number],
          }),
        ),
      );
    } catch {
      return undefined;
    }
  }

  private async storeIndex(
    cacheId: string,
    records: readonly SceneCacheTextRecord[],
  ): Promise<void> {
    try {
      const directory = this.indexDirectory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(directory, `${cacheId}.json`),
        JSON.stringify({
          version: INDEX_VERSION,
          cacheId,
          records,
        } satisfies StoredTextIndex),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      this.output.appendLine(
        `[TEXT_INDEX_STORE_FAILED] cache=${cacheId.slice(0, 16)}`,
      );
    }
  }

  private async loadIndex(
    cacheId: string,
    cachePath: string,
  ): Promise<readonly SceneCacheTextRecord[]> {
    const memory = this.memoryIndexes.get(cacheId);
    if (memory) {
      return memory;
    }
    const stored = await this.loadStoredIndex(cacheId);
    if (stored) {
      this.memoryIndexes.set(cacheId, stored);
      return stored;
    }
    const records = await readSceneCacheTextIndex(cachePath);
    this.memoryIndexes.set(cacheId, records);
    void this.storeIndex(cacheId, records);
    return records;
  }

  private async search(query: string): Promise<void> {
    const useRegularExpression = this.useRegularExpression;
    const normalizedQuery = (
      useRegularExpression ? query : query.trim()
    ).normalize("NFC");
    this.lastQuery = normalizedQuery;
    if (!normalizedQuery) {
      this.searching = false;
      this.update([
        {
          type: "status",
          label: "검색어를 입력하세요.",
          description: this.searchModeDescription(),
        },
      ]);
      return;
    }
    if (this.searching) {
      void vscode.window.showInformationMessage(
        "DWG 문자 검색이 이미 진행 중입니다.",
      );
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      void vscode.window.showInformationMessage(
        "DWG 문자 검색을 사용하려면 먼저 폴더나 워크스페이스를 여세요.",
      );
      return;
    }
    const configuration =
      vscode.workspace.getConfiguration("dwgViewer");
    const maximumFiles = boundedInteger(
      configuration.get("textSearchMaximumFiles"),
      DEFAULT_MAXIMUM_FILES,
      500,
    );
    const maximumResults = boundedInteger(
      configuration.get("textSearchMaximumResults"),
      DEFAULT_MAXIMUM_RESULTS,
      10_000,
    );
    const matchCase = configuration.get<boolean>(
      "textSearchMatchCase",
      false,
    );
    const wholeWord = configuration.get<boolean>(
      "textSearchWholeWord",
      false,
    );
    const validationError = validateSceneCacheTextQuery(normalizedQuery, {
      matchCase,
      wholeWord,
      useRegularExpression,
    });
    if (validationError) {
      this.update([
        {
          type: "status",
          label: "검색식을 확인하세요.",
          description: validationError,
        },
      ]);
      void vscode.window.showErrorMessage(validationError);
      return;
    }

    this.searching = true;
    this.update([
      {
        type: "status",
        label: `"${normalizedQuery}" 검색 중…`,
        description: this.searchModeDescription(
          "도면 캐시를 순서대로 확인합니다.",
        ),
      },
    ]);
    try {
      const uris = await vscode.workspace.findFiles(
        "**/*.[dD][wW][gG]",
        "**/{.git,node_modules}/**",
        maximumFiles + 1,
      );
      const uniqueUris = [...new Map(uris.map((uri) => [fileKey(uri), uri])).values()]
        .sort((left, right) =>
          left.fsPath.localeCompare(right.fsPath, "ko-KR"),
        );
      const truncatedFiles = uniqueUris.length > maximumFiles;
      const files = uniqueUris.slice(0, maximumFiles);
      if (files.length === 0) {
        this.update([
          {
            type: "status",
            label: "워크스페이스에서 DWG 파일을 찾지 못했습니다.",
          },
        ]);
        return;
      }
      const configuredPath = configuration.get<string>(
        "libredwgAdapterPath",
        "",
      );
      let adapterPath: string;
      try {
        adapterPath = await resolveLibreDwgAdapter({
          configuredPath,
          environmentPath: process.env.DWG_VIEWER_LIBREDWG_ADAPTER,
          extensionPath: this.context.extensionPath,
          bundledExtensionPath: vscode.extensions.getExtension(
            LIBREDWG_ADAPTER_EXTENSION_ID,
          )?.extensionPath,
        });
      } catch {
        const selection = await vscode.window.showErrorMessage(
          "DWG 문자 검색에 사용할 LibreDWG 변환기를 찾지 못했습니다.",
          "변환기 선택",
        );
        if (selection === "변환기 선택") {
          await vscode.commands.executeCommand(
            "dwgViewer.selectLibreDwgAdapter",
          );
        }
        this.update([
          {
            type: "status",
            label: "LibreDWG 변환기 설정이 필요합니다.",
          },
        ]);
        return;
      }
      const engine = new LibreDwgNativeSceneEngine(adapterPath);
      const manager = new SceneCacheManager(
        path.join(this.context.globalStorageUri.fsPath, "cache"),
        engine,
      );
      const fileNodes: FileNode[] = [];
      let failed = 0;
      let totalMatches = 0;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `DWG 문자 검색${
            useRegularExpression ? " (정규식)" : ""
          }: ${normalizedQuery}`,
          cancellable: true,
        },
        async (progress, cancellationToken) => {
          const controller = new AbortController();
          const cancellation =
            cancellationToken.onCancellationRequested(() =>
              controller.abort(),
            );
          try {
            for (let index = 0; index < files.length; index += 1) {
              if (
                controller.signal.aborted ||
                totalMatches >= maximumResults
              ) {
                break;
              }
              const uri = files[index];
              progress.report({
                message: `${index + 1}/${files.length} ${path.basename(uri.fsPath)}`,
                increment: 100 / files.length,
              });
              try {
                const prepared = await manager.prepare(uri.fsPath, {
                  signal: controller.signal,
                });
                const records = await this.loadIndex(
                  prepared.cacheId,
                  prepared.cachePath,
                );
                const matches = findSceneCacheTextMatches(
                  records,
                  normalizedQuery,
                  {
                    matchCase,
                    wholeWord,
                    useRegularExpression,
                    maximumResults: maximumResults - totalMatches,
                  },
                ).map((match) =>
                  Object.freeze({ ...match, uri }),
                );
                if (matches.length > 0) {
                  fileNodes.push({
                    type: "file",
                    uri,
                    matches,
                  });
                  totalMatches += matches.length;
                  this.update(fileNodes);
                }
              } catch (error) {
                if (
                  controller.signal.aborted ||
                  isSceneEngineAbort(error)
                ) {
                  break;
                }
                failed += 1;
                this.output.appendLine(
                  `[TEXT_SEARCH_FILE_FAILED] file=${path.basename(uri.fsPath)} error=${
                    error instanceof Error ? error.message : "unknown"
                  }`,
                );
              }
            }
          } finally {
            cancellation.dispose();
          }
        },
      );
      if (fileNodes.length === 0) {
        this.update([
          {
            type: "status",
            label: `"${normalizedQuery}" 검색 결과가 없습니다.`,
            description: this.searchModeDescription(
              failed > 0 ? `${failed}개 도면 확인 실패` : undefined,
            ),
          },
        ]);
      } else {
        this.update([
          ...fileNodes,
          {
            type: "status",
            label: `${totalMatches.toLocaleString()}개 결과`,
            description: [
              useRegularExpression ? "정규식" : "일반 문자",
              `${fileNodes.length.toLocaleString()}개 도면`,
              truncatedFiles ? `파일 상한 ${maximumFiles}개 적용` : "",
              totalMatches >= maximumResults
                ? `결과 상한 ${maximumResults.toLocaleString()}개 적용`
                : "",
              failed > 0 ? `${failed}개 확인 실패` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          },
        ]);
      }
    } finally {
      this.searching = false;
      this.changed.fire(undefined);
    }
  }

  dispose(): void {
    this.changed.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.memoryIndexes.clear();
  }
}
