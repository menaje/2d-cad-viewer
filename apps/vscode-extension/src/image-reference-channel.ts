import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { inspectRasterImage } from "./raster-image";
import {
  resolveXrefPath,
  type XrefManualMappings,
  xrefExactMappingKey,
} from "./xref-resolver";

export const MAX_IMAGE_REFERENCE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_REFERENCE_TRANSFER_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_REFERENCES = 256;

const IMAGE_MAPPING_STATE_KEY = "dwgViewer.imageMappings.v1";
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".bmp",
  ".dib",
  ".gif",
]);

type PostMessage = (message: unknown) => PromiseLike<boolean>;

interface ImageReadMessage {
  type?: unknown;
  cacheId?: unknown;
  requestId?: unknown;
  imageIndex?: unknown;
  path?: unknown;
}

interface ImageSelectMessage {
  type?: unknown;
  cacheId?: unknown;
  imageIndex?: unknown;
}

interface ImageReference {
  key: string;
  cacheId: string;
  imageIndex: number;
  storedPath: string;
  sourcePath: string;
  requestId: number;
}

export interface ImageReferenceChannelOptions {
  context: vscode.ExtensionContext;
  documentUri: vscode.Uri;
  output: vscode.OutputChannel;
  postMessage: PostMessage;
  maximumFileBytes?: number;
  maximumTransferBytes?: number;
}

function validRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validImageIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

async function readBoundedFile(
  filePath: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0) {
      throw new Error("이미지 파일을 읽을 수 없습니다.");
    }
    if (metadata.size > maximumBytes) {
      throw new Error("이미지 파일 크기가 32 MiB 한도를 초과합니다.");
    }
    const bytes = new Uint8Array(metadata.size);
    let readBytes = 0;
    while (readBytes < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        readBytes,
        bytes.byteLength - readBytes,
        readBytes,
      );
      if (result.bytesRead === 0) {
        throw new Error("이미지 파일을 끝까지 읽지 못했습니다.");
      }
      readBytes += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs
    ) {
      throw new Error("이미지 파일이 읽는 동안 변경되었습니다.");
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class ImageReferenceChannel {
  private readonly sources = new Map<string, string>();
  private readonly references = new Map<string, ImageReference>();
  private readonly sentResources = new Set<string>();
  private readonly maximumFileBytes: number;
  private readonly maximumTransferBytes: number;
  private transferredBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: ImageReferenceChannelOptions) {
    this.maximumFileBytes =
      options.maximumFileBytes ?? MAX_IMAGE_REFERENCE_FILE_BYTES;
    this.maximumTransferBytes =
      options.maximumTransferBytes ?? MAX_IMAGE_REFERENCE_TRANSFER_BYTES;
  }

  registerSource(cacheId: string, sourcePath: string): void {
    if (
      this.disposed ||
      !/^[a-f0-9]{64}$/u.test(cacheId) ||
      !path.isAbsolute(sourcePath)
    ) {
      return;
    }
    this.sources.set(cacheId, path.resolve(sourcePath));
  }

  handleMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") {
      return false;
    }
    const type = (message as { type?: unknown }).type;
    if (type === "dwg-image-read/1") {
      this.enqueueRead(message as ImageReadMessage);
      return true;
    }
    if (type === "dwg-image-select/1") {
      this.enqueueSelection(message as ImageSelectMessage);
      return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.sources.clear();
    this.references.clear();
    this.sentResources.clear();
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (!this.disposed) {
          await task();
        }
      })
      .catch((error) => {
        this.options.output.appendLine(
          `[IMAGE_TASK_FAILED] ${
            error instanceof Error ? error.message.slice(0, 200) : "unknown"
          }`,
        );
      });
  }

  private enqueueRead(message: ImageReadMessage): void {
    const cacheId =
      typeof message.cacheId === "string" ? message.cacheId : "";
    const sourcePath = this.sources.get(cacheId);
    if (
      !sourcePath ||
      !validRequestId(message.requestId) ||
      !validImageIndex(message.imageIndex) ||
      typeof message.path !== "string" ||
      message.path.length > 32_768 ||
      message.path.includes("\0")
    ) {
      return;
    }
    const key = `${cacheId}:${message.imageIndex}`;
    const existing = this.references.get(key);
    if (existing && existing.storedPath !== message.path) {
      return;
    }
    if (!existing && this.references.size >= MAX_IMAGE_REFERENCES) {
      void this.postFailure(
        {
          key,
          cacheId,
          imageIndex: message.imageIndex,
          storedPath: message.path,
          sourcePath,
          requestId: message.requestId,
        },
        "limit",
        "이미지 참조 개수 한도에 도달했습니다.",
        false,
      );
      return;
    }
    const reference: ImageReference = existing ?? {
      key,
      cacheId,
      imageIndex: message.imageIndex,
      storedPath: message.path,
      sourcePath,
      requestId: message.requestId,
    };
    reference.requestId = message.requestId;
    this.references.set(key, reference);
    this.enqueue(() => this.resolveAndRead(reference));
  }

  private enqueueSelection(message: ImageSelectMessage): void {
    const cacheId =
      typeof message.cacheId === "string" ? message.cacheId : "";
    if (!validImageIndex(message.imageIndex)) {
      return;
    }
    const reference = this.references.get(
      `${cacheId}:${message.imageIndex}`,
    );
    if (reference) {
      this.enqueue(() => this.selectManually(reference));
    }
  }

  private searchRoots(): string[] {
    const configuration = vscode.workspace.getConfiguration(
      "dwgViewer",
      this.options.documentUri,
    );
    const configured = [
      configuration.get<unknown>("imageSearchDirectories", []),
      configuration.get<unknown>("xrefSearchDirectories", []),
    ].flatMap((value) =>
      Array.isArray(value)
        ? value.filter(
            (entry): entry is string =>
              typeof entry === "string" && path.isAbsolute(entry),
          )
        : [],
    );
    return [
      ...configured,
      ...(vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => folder.uri.fsPath),
    ];
  }

  private mappings(): XrefManualMappings {
    return cleanMappings(
      this.options.context.workspaceState.get(IMAGE_MAPPING_STATE_KEY),
    );
  }

  private async resolveAndRead(reference: ImageReference): Promise<void> {
    await this.options.postMessage({
      type: "dwg-image-status/1",
      cacheId: reference.cacheId,
      imageIndex: reference.imageIndex,
      status: "searching",
    });
    const resolution = await resolveXrefPath({
      drawingPath: reference.sourcePath,
      storedPath: reference.storedPath,
      searchRoots: this.searchRoots(),
      mappings: this.mappings(),
    });
    if (this.disposed) {
      return;
    }
    if (resolution.status !== "resolved") {
      await this.postFailure(
        reference,
        resolution.status,
        resolution.status === "ambiguous"
          ? "같은 우선순위의 이미지가 여러 개라 직접 선택이 필요합니다."
          : "이미지 파일을 찾지 못했습니다.",
        true,
      );
      return;
    }
    const extension = path.extname(resolution.path).toLocaleLowerCase("en-US");
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      await this.postFailure(
        reference,
        "unsupported",
        "현재는 JPG, PNG, BMP와 GIF 이미지만 표시할 수 있습니다.",
        true,
      );
      return;
    }
    try {
      const bytes = await readBoundedFile(
        resolution.path,
        this.maximumFileBytes,
      );
      const metadata = inspectRasterImage(bytes);
      const resourceId = createHash("sha256")
        .update(bytes)
        .digest("hex");
      const alreadySent = this.sentResources.has(resourceId);
      if (
        !alreadySent &&
        this.transferredBytes + bytes.byteLength >
          this.maximumTransferBytes
      ) {
        await this.postFailure(
          reference,
          "budget-exceeded",
          "열린 도면의 이미지 전송 한도를 초과했습니다.",
          false,
        );
        return;
      }
      if (!alreadySent) {
        this.sentResources.add(resourceId);
        this.transferredBytes += bytes.byteLength;
      }
      await this.options.postMessage({
        type: "dwg-image-read-response/1",
        cacheId: reference.cacheId,
        imageIndex: reference.imageIndex,
        requestId: reference.requestId,
        ok: true,
        resourceId,
        mimeType: metadata.mimeType,
        width: metadata.width,
        height: metadata.height,
        fileName: path.basename(resolution.path).slice(0, 300),
        resolution: resolution.method,
        ...(alreadySent ? {} : { bytes: bytes.buffer }),
      });
    } catch (error) {
      await this.postFailure(
        reference,
        "unreadable",
        error instanceof Error
          ? error.message.slice(0, 240)
          : "이미지 파일을 읽지 못했습니다.",
        true,
      );
    }
  }

  private async selectManually(reference: ImageReference): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(path.dirname(reference.sourcePath)),
      filters: { "도면 이미지": ["jpg", "jpeg", "png", "bmp", "dib", "gif"] },
      title: "도면 이미지 선택",
      openLabel: "이 이미지 연결",
    });
    const selectedPath = selected?.find(
      (uri) => uri.scheme === "file",
    )?.fsPath;
    if (!selectedPath || this.disposed) {
      return;
    }
    const mappings = this.mappings();
    const next: XrefManualMappings = {
      exact: { ...(mappings.exact ?? {}) },
      basenames: { ...(mappings.basenames ?? {}) },
      prefixes: { ...(mappings.prefixes ?? {}) },
    };
    (next.exact as Record<string, string>)[
      xrefExactMappingKey(reference.sourcePath, reference.storedPath)
    ] = selectedPath;
    await this.options.context.workspaceState.update(
      IMAGE_MAPPING_STATE_KEY,
      next,
    );
    await this.resolveAndRead(reference);
  }

  private async postFailure(
    reference: ImageReference,
    status: string,
    message: string,
    canSelect: boolean,
  ): Promise<void> {
    await Promise.resolve(
      this.options.postMessage({
        type: "dwg-image-read-response/1",
        cacheId: reference.cacheId,
        imageIndex: reference.imageIndex,
        requestId: reference.requestId,
        ok: false,
        status,
        message: message.slice(0, 240),
        canSelect,
      }),
    ).catch(() => false);
  }
}

export {
  IMAGE_MAPPING_STATE_KEY,
  SUPPORTED_IMAGE_EXTENSIONS,
};
export {
  inspectRasterImage,
  MAX_IMAGE_REFERENCE_PIXELS,
} from "./raster-image";
