import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  ADAPTER_PROTOCOL,
  CACHE_SCHEMA_VERSION,
  diagnoseLibreDwgAdapter,
  LIBREDWG_NATIVE_ENGINE_VERSION,
  type LibreDwgDoctorReport,
} from "./native-cache";
import { SceneEngineError } from "./scene-engine";

export const ENGINE_ASSET_CATALOG_SCHEMA =
  "dwg-viewer-engine-assets/1";
export const ENGINE_ASSET_CATALOG_NAME = "engine-assets.json";
const ENGINE_LICENSE = "GPL-3.0-or-later";
const RELEASE_REPOSITORY = "menaje/dwg-viewer";
const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_ENGINE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const ASSET_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

interface RawEngineAsset {
  asset?: unknown;
  sha256?: unknown;
  size?: unknown;
  sourceAsset?: unknown;
  sourceSha256?: unknown;
  sourceSize?: unknown;
}

interface RawEngineAssetCatalog {
  schema?: unknown;
  viewerVersion?: unknown;
  repository?: unknown;
  releaseTag?: unknown;
  engine?: {
    id?: unknown;
    version?: unknown;
    protocol?: unknown;
    cacheSchema?: unknown;
    license?: unknown;
  };
  targets?: unknown;
}

export interface ManagedEngineAsset {
  readonly target: string;
  readonly asset: string;
  readonly sha256: string;
  readonly size: number;
  readonly sourceAsset: string;
  readonly sourceSha256: string;
  readonly sourceSize: number;
}

export interface ManagedEngineCatalog {
  readonly viewerVersion: string;
  readonly repository: string;
  readonly releaseTag: string;
  readonly target: ManagedEngineAsset;
}

export interface ManagedEngineInstallation {
  readonly adapterPath: string;
  readonly target: string;
  readonly reused: boolean;
  readonly assetUrl: string;
  readonly sourceUrl: string;
  readonly sha256: string;
}

interface ManagedEngineFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface ValidatedManagedEngine {
  readonly installation: ManagedEngineInstallation;
  readonly identity: ManagedEngineFileIdentity;
}

interface FetchHeaders {
  get(name: string): string | null;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly headers: FetchHeaders;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type EngineFetcher = (
  url: string,
  init: {
    headers: Readonly<Record<string, string>>;
    redirect: "follow";
    signal: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface ManagedEngineManagerOptions {
  readonly storageRoot: string;
  readonly catalogPath: string;
  readonly viewerVersion: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly fetcher?: EngineFetcher;
  readonly diagnose?: (
    adapterPath: string,
  ) => Promise<LibreDwgDoctorReport>;
  readonly onEvent?: (
    phase:
      | "checking"
      | "downloading"
      | "validating"
      | "installed"
      | "reused",
    details: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

function catalogError(message: string, cause?: unknown): SceneEngineError {
  return new SceneEngineError(
    "ENGINE_CATALOG_INVALID",
    "이 버전의 DWG Viewer에 맞는 변환기 정보를 확인하지 못했습니다.",
    { cause: cause ?? new Error(message) },
  );
}

function isSafeAssetName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    ASSET_NAME_PATTERN.test(value)
  );
}

function isSafeSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_ENGINE_BYTES
  );
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "libredwg-adapter.exe"
    : "libredwg-adapter";
}

export function resolveManagedEngineTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const target = `${platform}-${architecture}`;
  if (
    target !== "linux-x64" &&
    target !== "darwin-arm64" &&
    target !== "darwin-x64" &&
    target !== "win32-x64"
  ) {
    throw new SceneEngineError(
      "ENGINE_PLATFORM_UNSUPPORTED",
      `현재 환경에서는 자동 변환기를 제공하지 않습니다: ${target}`,
    );
  }
  return target;
}

export function parseManagedEngineCatalog(
  text: string,
  viewerVersion: string,
  target: string,
): ManagedEngineCatalog {
  let raw: RawEngineAssetCatalog;
  try {
    raw = JSON.parse(text) as RawEngineAssetCatalog;
  } catch (error) {
    throw catalogError("engine catalog is not valid JSON", error);
  }
  if (
    !VERSION_PATTERN.test(viewerVersion) ||
    raw.schema !== ENGINE_ASSET_CATALOG_SCHEMA ||
    raw.viewerVersion !== viewerVersion ||
    raw.repository !== RELEASE_REPOSITORY ||
    raw.releaseTag !== `v${viewerVersion}` ||
    raw.engine?.id !== "libredwg" ||
    raw.engine.version !== LIBREDWG_NATIVE_ENGINE_VERSION ||
    raw.engine.protocol !== ADAPTER_PROTOCOL ||
    raw.engine.cacheSchema !== CACHE_SCHEMA_VERSION ||
    raw.engine.license !== ENGINE_LICENSE ||
    !raw.targets ||
    typeof raw.targets !== "object" ||
    Array.isArray(raw.targets)
  ) {
    throw catalogError("engine catalog contract does not match the viewer");
  }
  const selected = (raw.targets as Record<string, unknown>)[target] as
    | RawEngineAsset
    | undefined;
  if (
    !selected ||
    !isSafeAssetName(selected.asset) ||
    typeof selected.sha256 !== "string" ||
    !SHA256_PATTERN.test(selected.sha256) ||
    !isSafeSize(selected.size) ||
    !isSafeAssetName(selected.sourceAsset) ||
    typeof selected.sourceSha256 !== "string" ||
    !SHA256_PATTERN.test(selected.sourceSha256) ||
    !isSafeSize(selected.sourceSize)
  ) {
    throw catalogError(`engine catalog does not support ${target}`);
  }
  const expectedAsset = `dwg-viewer-native-converter-${viewerVersion}-${target}${
    target === "win32-x64" ? ".exe" : ""
  }`;
  const expectedSource =
    `dwg-viewer-libredwg-${LIBREDWG_NATIVE_ENGINE_VERSION}-${target}.tar.gz`;
  if (
    selected.asset !== expectedAsset ||
    selected.sourceAsset !== expectedSource
  ) {
    throw catalogError("engine catalog asset names are not release-bound");
  }
  return Object.freeze({
    viewerVersion,
    repository: raw.repository,
    releaseTag: raw.releaseTag,
    target: Object.freeze({
      target,
      asset: selected.asset,
      sha256: selected.sha256,
      size: selected.size,
      sourceAsset: selected.sourceAsset,
      sourceSha256: selected.sourceSha256,
      sourceSize: selected.sourceSize,
    }),
  });
}

function releaseAssetUrl(
  catalog: ManagedEngineCatalog,
  asset: string,
): string {
  return `https://github.com/${catalog.repository}/releases/download/${catalog.releaseTag}/${asset}`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function expectedDoctorTarget(target: string): {
  platform: string;
  architecture: string;
} {
  const separator = target.indexOf("-");
  return {
    platform: target.slice(0, separator),
    architecture: target.slice(separator + 1),
  };
}

function assertDoctorTarget(
  report: LibreDwgDoctorReport,
  target: string,
): void {
  const expected = expectedDoctorTarget(target);
  if (
    report.platform !== expected.platform ||
    report.architecture !== expected.architecture
  ) {
    throw new SceneEngineError(
      "ENGINE_TARGET_MISMATCH",
      "다운로드한 변환기가 현재 운영체제 환경과 일치하지 않습니다.",
    );
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sameManagedEngineFile(
  left: ManagedEngineFileIdentity,
  right: ManagedEngineFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export class ManagedEngineManager {
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly fetcher: EngineFetcher;
  private readonly diagnose: (
    adapterPath: string,
  ) => Promise<LibreDwgDoctorReport>;
  private provisionPromise?: Promise<ManagedEngineInstallation>;
  private validatedEngine?: ValidatedManagedEngine;

  constructor(private readonly options: ManagedEngineManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.fetcher = options.fetcher ?? (globalThis.fetch as EngineFetcher);
    this.diagnose = options.diagnose ?? diagnoseLibreDwgAdapter;
    if (!path.isAbsolute(options.storageRoot)) {
      throw new TypeError("managed engine storage root must be absolute");
    }
    if (!path.isAbsolute(options.catalogPath)) {
      throw new TypeError("managed engine catalog path must be absolute");
    }
  }

  ensure(): Promise<ManagedEngineInstallation> {
    if (!this.provisionPromise) {
      const provision = this.ensureValidated();
      this.provisionPromise = provision;
      void provision.then(
        () => {
          if (this.provisionPromise === provision) {
            this.provisionPromise = undefined;
          }
        },
        () => {
          if (this.provisionPromise === provision) {
            this.provisionPromise = undefined;
          }
        },
      );
    }
    return this.provisionPromise;
  }

  private async engineFileIdentity(
    adapterPath: string,
  ): Promise<ManagedEngineFileIdentity | undefined> {
    try {
      const metadata = await lstat(adapterPath, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return undefined;
      }
      return {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
        ctimeNs: metadata.ctimeNs,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async ensureValidated(): Promise<ManagedEngineInstallation> {
    const validated = this.validatedEngine;
    if (validated) {
      const currentIdentity = await this.engineFileIdentity(
        validated.installation.adapterPath,
      );
      if (
        currentIdentity &&
        sameManagedEngineFile(validated.identity, currentIdentity)
      ) {
        this.options.onEvent?.("reused", {
          target: validated.installation.target,
          adapterPath: validated.installation.adapterPath,
          sessionValidated: true,
        });
        return Object.freeze({
          ...validated.installation,
          reused: true,
        });
      }
      this.validatedEngine = undefined;
    }

    const installation = await this.provision();
    const identity = await this.engineFileIdentity(installation.adapterPath);
    if (!identity) {
      throw new SceneEngineError(
        "ENGINE_INSTALL_REJECTED",
        "설치된 DWG 변환기를 최종 검증하지 못했습니다.",
      );
    }
    this.validatedEngine = { installation, identity };
    return installation;
  }

  private async readCatalog(target: string): Promise<ManagedEngineCatalog> {
    let metadata;
    try {
      metadata = await stat(this.options.catalogPath);
    } catch (error) {
      throw new SceneEngineError(
        "ENGINE_CATALOG_MISSING",
        "이 버전의 DWG Viewer에 맞는 변환기 목록이 없습니다.",
        { cause: error },
      );
    }
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_CATALOG_BYTES
    ) {
      throw catalogError("engine catalog size is invalid");
    }
    return parseManagedEngineCatalog(
      await readFile(this.options.catalogPath, "utf8"),
      this.options.viewerVersion,
      target,
    );
  }

  private async validateInstalled(
    adapterPath: string,
    asset: ManagedEngineAsset,
  ): Promise<boolean> {
    try {
      const metadata = await lstat(adapterPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== asset.size ||
        (await sha256File(adapterPath)) !== asset.sha256
      ) {
        return false;
      }
      assertDoctorTarget(await this.diagnose(adapterPath), asset.target);
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      return false;
    }
  }

  private async download(
    url: string,
    expectedSize: number,
  ): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await this.fetcher(url, {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "menaje-dwg-viewer-vscode",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`engine download returned HTTP ${response.status}`);
      }
      const finalUrl = new URL(response.url || url);
      if (
        finalUrl.protocol !== "https:" ||
        !ALLOWED_DOWNLOAD_HOSTS.has(finalUrl.hostname)
      ) {
        throw new Error("engine download redirected to an untrusted host");
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength) {
        const parsedLength = Number(declaredLength);
        if (
          !Number.isSafeInteger(parsedLength) ||
          parsedLength !== expectedSize
        ) {
          throw new Error("engine download length does not match the catalog");
        }
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength !== expectedSize) {
        throw new Error("engine download size does not match the catalog");
      }
      return buffer;
    } catch (error) {
      throw new SceneEngineError(
        "ENGINE_DOWNLOAD_FAILED",
        "DWG 변환기를 내려받지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async install(
    buffer: Buffer,
    adapterPath: string,
    asset: ManagedEngineAsset,
  ): Promise<void> {
    if (createHash("sha256").update(buffer).digest("hex") !== asset.sha256) {
      throw new SceneEngineError(
        "ENGINE_DOWNLOAD_REJECTED",
        "내려받은 DWG 변환기의 무결성 검사를 통과하지 못했습니다.",
      );
    }
    const directory = path.dirname(adapterPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(adapterPath)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temporaryPath, buffer, {
        flag: "wx",
        mode: 0o700,
      });
      if (this.platform !== "win32") {
        await chmod(temporaryPath, 0o700);
      }
      assertDoctorTarget(await this.diagnose(temporaryPath), asset.target);
      try {
        await link(temporaryPath, adapterPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          if (!(await this.validateInstalled(adapterPath, asset))) {
            throw error;
          }
        } else if (
          code === "EPERM" ||
          code === "ENOTSUP" ||
          code === "EXDEV"
        ) {
          await rename(temporaryPath, adapterPath);
        } else {
          throw error;
        }
      }
      if (this.platform !== "win32") {
        await chmod(adapterPath, 0o700);
      }
    } catch (error) {
      if (error instanceof SceneEngineError) {
        throw error;
      }
      throw new SceneEngineError(
        "ENGINE_INSTALL_FAILED",
        "DWG 변환기를 로컬 저장소에 설치하지 못했습니다.",
        { cause: error },
      );
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async provision(): Promise<ManagedEngineInstallation> {
    const target = resolveManagedEngineTarget(
      this.platform,
      this.architecture,
    );
    this.options.onEvent?.("checking", { target });
    const catalog = await this.readCatalog(target);
    const asset = catalog.target;
    const digestDirectory = path.join(
      this.options.storageRoot,
      catalog.viewerVersion,
      target,
      asset.sha256,
    );
    const adapterPath = path.join(
      digestDirectory,
      executableName(this.platform),
    );
    const assetUrl = releaseAssetUrl(catalog, asset.asset);
    const sourceUrl = releaseAssetUrl(catalog, asset.sourceAsset);

    if (await this.validateInstalled(adapterPath, asset)) {
      this.options.onEvent?.("reused", { target, adapterPath });
      return Object.freeze({
        adapterPath,
        target,
        reused: true,
        assetUrl,
        sourceUrl,
        sha256: asset.sha256,
      });
    }
    await rm(adapterPath, { force: true });

    this.options.onEvent?.("downloading", {
      target,
      bytes: asset.size,
    });
    const buffer = await this.download(assetUrl, asset.size);
    this.options.onEvent?.("validating", { target });
    await this.install(buffer, adapterPath, asset);
    if (!(await this.validateInstalled(adapterPath, asset))) {
      await rm(adapterPath, { force: true });
      throw new SceneEngineError(
        "ENGINE_INSTALL_REJECTED",
        "설치한 DWG 변환기의 최종 검증에 실패했습니다.",
      );
    }
    this.options.onEvent?.("installed", { target, adapterPath });
    return Object.freeze({
      adapterPath,
      target,
      reused: false,
      assetUrl,
      sourceUrl,
      sha256: asset.sha256,
    });
  }
}
