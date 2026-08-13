import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  abortSceneEngineError,
  canonicalSceneConversionOptions,
  createSceneEngineProgress,
  EMPTY_SCENE_CONVERSION_OPTIONS,
  isSceneEngineAbort,
  normalizeSceneConversionOptions,
  SCENE_CACHE_SCHEMA_VERSION,
  SCENE_ENGINE_CONTRACT,
  SCENE_ENGINE_PROGRESS_SCHEMA,
  SceneEngineError,
  type SceneConversionOptions,
  type SceneEngine,
  type SceneEngineDescriptor,
  type SceneEngineProgressEvent,
  type SceneEngineProgressPhase,
} from "./scene-engine";

const SCENE_CACHE_MAGIC = Buffer.from([
  0x44, 0x57, 0x47, 0x53, 0x43, 0x4e, 0x31, 0x00,
]);
const SCENE_CACHE_HEADER_BYTES = 28;
const SCENE_CACHE_HEADER_FLAG_PREVIEW = 1;
const sceneCacheVersionMatch = /\/(\d+)\.(\d+)$/u.exec(
  SCENE_CACHE_SCHEMA_VERSION,
);
const EXPECTED_SCENE_CACHE_MAJOR = Number(sceneCacheVersionMatch?.[1]);
const EXPECTED_SCENE_CACHE_MINOR = Number(sceneCacheVersionMatch?.[2]);
const CACHE_STORAGE_SCHEMA = "dwg-scene-cache-storage/1";
const CACHE_GENERATIONS_DIRECTORY = "generations";
const CACHE_SESSIONS_DIRECTORY = "sessions";
const CACHE_LEASES_DIRECTORY = ".leases";
const CACHE_GENERATION_PATTERN = /^[a-f0-9]{64}$/u;
const CACHE_LEASE_PATTERN = /^[a-f0-9]{32}\.lease$/u;
const CACHE_SESSION_PATTERN = /^[a-f0-9]{32}$/u;
const LEGACY_CACHE_FILE_PATTERN =
  /^[a-f0-9]{64}(?:\.dwg\.(?:cache|preview)|\.[a-f0-9]{16}\.(?:tmp|preview\.tmp(?:\.ready)?))$/u;
const TEMPORARY_CACHE_FILE_PATTERN =
  /^[a-f0-9]{64}\.[a-f0-9]{16}\.(?:tmp|preview\.tmp(?:\.ready)?)$/u;
const DERIVED_CACHE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;
const PERSISTENT_CACHE_FILE_PATTERN =
  /^([a-f0-9]{64})\.dwg\.(?:cache|preview)$/u;
const MAX_STORAGE_ENTRIES = 4_096;
const CACHE_LEASE_HEARTBEAT_MS = 30_000;
const CACHE_LEASE_STALE_MS = 5 * 60_000;
export const DEFAULT_PERSISTENT_CACHE_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_PERSISTENT_CACHE_BYTES = 100 * 1024 * 1024 * 1024;

export type SceneCacheMode = "session" | "persistent";

export interface SceneCacheManagerOptions {
  readonly mode?: SceneCacheMode;
  readonly platform?: NodeJS.Platform;
  readonly maximumPersistentBytes?: number;
}

export function normalizeSceneCacheMode(value: unknown): SceneCacheMode {
  return value === "persistent" ? "persistent" : "session";
}

export function normalizePersistentCacheBytes(value: unknown): number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1024 * 1024 * 1024 &&
    value <= MAX_PERSISTENT_CACHE_BYTES
  )
    ? value
    : DEFAULT_PERSISTENT_CACHE_BYTES;
}

export function computeCacheGenerationId(
  engine: SceneEngineDescriptor,
  engineRevision: string,
): string {
  return hashFields([
    CACHE_STORAGE_SCHEMA,
    engine.schema,
    engine.cacheSchema,
    engine.engineId,
    engine.engineVersion,
    engine.backendId,
    engine.backendKind,
    engineRevision,
  ]);
}

async function boundedDirectoryEntries(directoryPath: string) {
  const entries: Dirent[] = [];
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return entries;
    }
    throw error;
  }
  try {
    for await (const entry of directory) {
      if (entries.length >= MAX_STORAGE_ENTRIES) {
        break;
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

const storageMaintenance = new Map<string, Promise<void>>();

async function serializeStorageMaintenance(
  cacheRoot: string,
  operation: () => Promise<void>,
): Promise<void> {
  const key = path.resolve(cacheRoot);
  const previous = storageMaintenance.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  storageMaintenance.set(key, current);
  try {
    await current;
  } finally {
    if (storageMaintenance.get(key) === current) {
      storageMaintenance.delete(key);
    }
  }
}

export async function maintainDerivedCacheStorage(
  storageRoot: string,
  mode: SceneCacheMode,
  currentGenerationId?: string,
): Promise<string | undefined> {
  if (
    mode === "persistent" &&
    (!currentGenerationId ||
      !CACHE_GENERATION_PATTERN.test(currentGenerationId))
  ) {
    throw new TypeError(
      "persistent derived cache storage requires a generation ID",
    );
  }
  const resolvedRoot = path.resolve(storageRoot);
  const generationsRoot = path.join(
    resolvedRoot,
    CACHE_GENERATIONS_DIRECTORY,
  );
  await serializeStorageMaintenance(resolvedRoot, async () => {
    for (const entry of await boundedDirectoryEntries(resolvedRoot)) {
      if (
        DERIVED_CACHE_FILE_PATTERN.test(entry.name) &&
        (entry.isFile() || entry.isSymbolicLink())
      ) {
        await rm(path.join(resolvedRoot, entry.name), { force: true }).catch(
          () => undefined,
        );
      }
    }
    for (const entry of await boundedDirectoryEntries(generationsRoot)) {
      if (
        entry.isDirectory() &&
        CACHE_GENERATION_PATTERN.test(entry.name) &&
        entry.name !== currentGenerationId
      ) {
        await rm(path.join(generationsRoot, entry.name), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
    }
  });
  if (mode === "session") {
    return undefined;
  }
  const generationRoot = path.join(
    generationsRoot,
    currentGenerationId!,
  );
  await mkdir(generationRoot, { recursive: true, mode: 0o700 });
  return generationRoot;
}

export interface CacheIdentity {
  sourcePath: string;
  sourceSize: bigint;
  sourceMtimeNs: bigint;
  engine: SceneEngineDescriptor;
  engineRevision: string;
  conversionOptions?: SceneConversionOptions;
}

function hashFields(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const encoded = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(encoded.byteLength);
    hash.update(length);
    hash.update(encoded);
  }
  return hash.digest("hex");
}

export function canonicalCacheSourcePath(
  sourcePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(sourcePath);
  return platform === "darwin" ? resolved.normalize("NFC") : resolved;
}

function computeCacheIdForSourcePath(
  identity: CacheIdentity,
  sourcePath: string,
): string {
  return hashFields([
    identity.engine.schema,
    identity.engine.cacheSchema,
    sourcePath,
    identity.sourceSize.toString(),
    identity.sourceMtimeNs.toString(),
    identity.engine.engineId,
    identity.engine.engineVersion,
    identity.engine.backendId,
    identity.engine.backendKind,
    identity.engineRevision,
    canonicalSceneConversionOptions(
      identity.conversionOptions ?? EMPTY_SCENE_CONVERSION_OPTIONS,
    ),
  ]);
}

export function computeCacheId(
  identity: CacheIdentity,
  platform: NodeJS.Platform = process.platform,
): string {
  return computeCacheIdForSourcePath(
    identity,
    canonicalCacheSourcePath(identity.sourcePath, platform),
  );
}

function legacyCacheIds(
  identity: CacheIdentity,
  platform: NodeJS.Platform,
  realSourcePath?: string,
): readonly string[] {
  if (platform !== "darwin") {
    return [];
  }
  const resolved = path.resolve(identity.sourcePath);
  const canonicalPath = resolved.normalize("NFC");
  const canonicalId = computeCacheIdForSourcePath(identity, canonicalPath);
  const legacyPaths = new Set([resolved, resolved.normalize("NFD")]);
  if (realSourcePath) {
    const resolvedRealPath = path.resolve(realSourcePath);
    if (resolvedRealPath.normalize("NFC") === canonicalPath) {
      legacyPaths.add(resolvedRealPath);
    }
  }
  const ids = new Set<string>();
  for (const legacyPath of legacyPaths) {
    const legacyId = computeCacheIdForSourcePath(identity, legacyPath);
    if (legacyId !== canonicalId) {
      ids.add(legacyId);
    }
  }
  return [...ids];
}

export interface PreparedCache {
  cacheId: string;
  cachePath: string;
  size: number;
  reused: boolean;
  storageGeneration: string;
  engine: SceneEngineDescriptor;
  release(): Promise<void>;
}

export interface PreparedPreview {
  cacheId: string;
  cachePath: string;
  size: number;
  reused: boolean;
  engine: SceneEngineDescriptor;
  release(): Promise<void>;
}

export interface PrepareCacheOptions {
  force?: boolean;
  signal: AbortSignal;
  conversionOptions?: SceneConversionOptions;
  onProgress?: (event: SceneEngineProgressEvent) => void;
  onPreview?: (preview: PreparedPreview) => void | Promise<void>;
}

export class SceneCacheManager {
  private readonly mode: SceneCacheMode;
  private readonly platform: NodeJS.Platform;
  private readonly maximumPersistentBytes: number;
  private readonly leaseId = randomBytes(16).toString("hex");
  private readonly activePreparations = new Set<Promise<PreparedCache>>();
  private readonly storageRoots = new Map<string, Promise<string>>();
  private readonly leasePaths = new Set<string>();
  private readonly leaseTimers = new Map<string, NodeJS.Timeout>();
  private readonly sessionId = randomBytes(16).toString("hex");
  private sessionRoot: string | undefined;
  private sessionStorage: Promise<string> | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly cacheRoot: string,
    private readonly engine: SceneEngine,
    options: SceneCacheManagerOptions | NodeJS.Platform = {},
  ) {
    this.platform =
      typeof options === "string"
        ? options
        : (options.platform ?? process.platform);
    this.mode =
      typeof options === "string"
        ? "persistent"
        : normalizeSceneCacheMode(options.mode);
    this.maximumPersistentBytes = normalizePersistentCacheBytes(
      typeof options === "string"
        ? undefined
        : options.maximumPersistentBytes,
    );
    if (
      engine.descriptor.schema !== SCENE_ENGINE_CONTRACT ||
      engine.descriptor.cacheSchema !== SCENE_CACHE_SCHEMA_VERSION
    ) {
      throw new TypeError("scene engine descriptor is incompatible");
    }
  }

  prepare(
    sourcePath: string,
    options: PrepareCacheOptions,
  ): Promise<PreparedCache> {
    if (this.disposed) {
      return Promise.reject(
        new SceneEngineError(
          "CACHE_MANAGER_DISPOSED",
          "도면 캐시 세션이 이미 종료되었습니다.",
        ),
      );
    }
    const operation = this.prepareInternal(sourcePath, options);
    this.activePreparations.add(operation);
    void operation.then(
      () => this.activePreparations.delete(operation),
      () => this.activePreparations.delete(operation),
    );
    return operation;
  }

  async maintain(): Promise<void> {
    if (this.disposed) {
      throw new SceneEngineError(
        "CACHE_MANAGER_DISPOSED",
        "도면 캐시 세션이 이미 종료되었습니다.",
      );
    }
    const snapshot = await this.engine.snapshot();
    await this.prepareStorage(snapshot.revision);
  }

  dispose(): Promise<void> {
    if (this.disposal) {
      return this.disposal;
    }
    this.disposed = true;
    this.disposal = this.disposeInternal();
    return this.disposal;
  }

  private async disposeInternal(): Promise<void> {
    await Promise.allSettled([...this.activePreparations]);
    for (const timer of this.leaseTimers.values()) {
      clearInterval(timer);
    }
    this.leaseTimers.clear();
    await Promise.allSettled(
      [...this.leasePaths].map((leasePath) =>
        rm(leasePath, { force: true }),
      ),
    );
    this.leasePaths.clear();
    if (this.mode === "persistent") {
      await Promise.allSettled(
        [...this.storageRoots.values()].map(async (storage) => {
          const generationRoot = await storage;
          await serializeStorageMaintenance(this.cacheRoot, async () => {
            if (!(await this.hasFreshGenerationLease(generationRoot))) {
              await this.prunePersistentGeneration(generationRoot);
            }
          });
        }),
      );
    }
    if (this.sessionRoot) {
      await rm(this.sessionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async prepareInternal(
    sourcePath: string,
    {
      force = false,
      signal,
      conversionOptions = EMPTY_SCENE_CONVERSION_OPTIONS,
      onProgress,
      onPreview,
    }: PrepareCacheOptions,
  ): Promise<PreparedCache> {
    try {
      if (signal.aborted) {
        throw abortSceneEngineError();
      }
      const normalizedOptions =
        normalizeSceneConversionOptions(conversionOptions);
      const supportedOptions = new Set(
        this.engine.descriptor.capabilities.conversionOptions,
      );
      const unsupportedOption = Object.keys(normalizedOptions).find(
        (name) => !supportedOptions.has(name),
      );
      if (unsupportedOption) {
        throw new SceneEngineError(
          "ENGINE_OPTIONS_UNSUPPORTED",
          `변환 엔진이 지원하지 않는 옵션입니다: ${unsupportedOption}`,
        );
      }
      this.notify(onProgress, "checking");
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });

      let sourceMetadata;
      let engineSnapshot;
      let realSourcePath: string | undefined;
      try {
        [sourceMetadata, engineSnapshot, realSourcePath] = await Promise.all([
          stat(sourcePath, { bigint: true }),
          this.engine.snapshot(),
          this.platform === "darwin"
            ? realpath(sourcePath).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
      } catch (error) {
        throw new SceneEngineError(
          "INPUT_METADATA_FAILED",
          "도면 또는 변환 엔진 정보를 읽지 못했습니다.",
          { cause: error },
        );
      }
      if (!sourceMetadata.isFile()) {
        throw new SceneEngineError(
          "INPUT_NOT_FILE",
          "선택한 DWG 파일을 읽을 수 없습니다.",
        );
      }

      const identity = {
        sourcePath,
        sourceSize: sourceMetadata.size,
        sourceMtimeNs: sourceMetadata.mtimeNs,
        engine: this.engine.descriptor,
        engineRevision: engineSnapshot.revision,
        conversionOptions: normalizedOptions,
      } satisfies CacheIdentity;
      const cacheId = computeCacheId(identity, this.platform);
      const storageGeneration = computeCacheGenerationId(
        this.engine.descriptor,
        engineSnapshot.revision,
      );
      const activeCacheRoot = await this.prepareStorage(
        engineSnapshot.revision,
      );
      const legacyIds = legacyCacheIds(
        identity,
        this.platform,
        realSourcePath,
      );
      const cachePath = path.join(
        activeCacheRoot,
        this.mode === "persistent"
          ? `${cacheId}.dwg.cache`
          : `${cacheId}.${randomBytes(8).toString("hex")}.dwg.cache`,
      );

      if (force && this.mode === "persistent") {
        await rm(cachePath, { force: true });
      } else if (this.mode === "persistent") {
        const existing =
          (await this.readExistingCache(
            storageGeneration,
            cacheId,
            cachePath,
          )) ??
          (await this.reuseLegacyCache(
            activeCacheRoot,
            storageGeneration,
            cacheId,
            cachePath,
            legacyIds,
          ));
        if (existing) {
          this.notify(onProgress, "cache-ready");
          return existing;
        }
      }

      const temporaryPath = path.join(
        activeCacheRoot,
        `${cacheId}.${randomBytes(8).toString("hex")}.tmp`,
      );
      const persistentPreviewPath =
        onPreview && this.engine.descriptor.capabilities.progressivePreview
          ? path.join(
              activeCacheRoot,
              this.mode === "persistent"
                ? `${cacheId}.dwg.preview`
                : `${cacheId}.${randomBytes(8).toString("hex")}.dwg.preview`,
            )
          : undefined;
      let previewHandedOff = false;
      let previewPublication = Promise.resolve();
      if (persistentPreviewPath && this.mode === "persistent") {
        const existingPreview =
          (await this.readExistingPreview(
            cacheId,
            persistentPreviewPath,
          )) ??
          (await this.reuseLegacyPreview(
            activeCacheRoot,
            cacheId,
            persistentPreviewPath,
            legacyIds,
          ));
        if (existingPreview) {
          previewHandedOff = true;
          this.notify(onProgress, "preview-ready");
          try {
            await onPreview?.(existingPreview);
          } catch {
            // A consumer failure cannot invalidate a reusable overview.
          }
        }
      }
      const previewPath =
        persistentPreviewPath && !previewHandedOff
          ? path.join(
              activeCacheRoot,
              `${cacheId}.${randomBytes(8).toString("hex")}.preview.tmp`,
            )
          : undefined;
      try {
        await this.engine.convert({
          sourcePath,
          outputPath: temporaryPath,
          previewPath,
          signal,
          options: normalizedOptions,
          onProgress: (event) => this.forward(onProgress, event),
          onPreview: previewPath
            ? (artifact) => {
                previewPublication = previewPublication
                  .then(async () => {
                    if (
                      previewHandedOff ||
                      signal.aborted ||
                      artifact.path !== previewPath ||
                      !Number.isSafeInteger(artifact.size) ||
                      artifact.size <= 0
                    ) {
                      return;
                    }
                    const [
                      currentSourceMetadata,
                      currentEngineSnapshot,
                      previewMetadata,
                    ] = await Promise.all([
                      stat(sourcePath, { bigint: true }),
                      this.engine.snapshot(),
                      stat(previewPath),
                    ]);
                    if (
                      currentSourceMetadata.size !== sourceMetadata.size ||
                      currentSourceMetadata.mtimeNs !==
                        sourceMetadata.mtimeNs ||
                      currentEngineSnapshot.revision !==
                        engineSnapshot.revision ||
                      !previewMetadata.isFile() ||
                      previewMetadata.size !== artifact.size
                    ) {
                      return;
                    }
                    const preparedPreview = await this.commitPreview(
                      cacheId,
                      previewPath,
                      persistentPreviewPath!,
                      artifact.size,
                    );
                    previewHandedOff = true;
                    this.notify(onProgress, "preview-ready");
                    try {
                      await onPreview?.(preparedPreview);
                    } catch {
                      // The committed overview remains available for retry.
                    }
                  })
                  .catch(async () => {
                    if (!previewHandedOff) {
                      await rm(previewPath, { force: true }).catch(
                        () => undefined,
                      );
                    }
                  });
                return previewPublication;
              }
            : undefined,
        });
        await previewPublication;
        if (signal.aborted) {
          throw abortSceneEngineError();
        }
        const [finalSourceMetadata, finalEngineSnapshot] = await Promise.all([
          stat(sourcePath, { bigint: true }),
          this.engine.snapshot(),
        ]);
        if (
          finalSourceMetadata.size !== sourceMetadata.size ||
          finalSourceMetadata.mtimeNs !== sourceMetadata.mtimeNs ||
          finalEngineSnapshot.revision !== engineSnapshot.revision
        ) {
          throw new SceneEngineError(
            "CACHE_INPUT_CHANGED",
            "변환 중 도면 또는 변환 엔진이 변경되었습니다. 다시 시도해 주세요.",
          );
        }
        try {
          await rename(temporaryPath, cachePath);
        } catch (error) {
          const racedCache = await this.readExistingCache(
            storageGeneration,
            cacheId,
            cachePath,
          );
          if (racedCache) {
            this.notify(onProgress, "cache-ready");
            return racedCache;
          }
          throw new SceneEngineError(
            "CACHE_COMMIT_FAILED",
            "변환 캐시를 저장하지 못했습니다.",
            { cause: error },
          );
        }
        if (process.platform !== "win32") {
          await chmod(cachePath, 0o600);
        }
        const prepared = await this.readExistingCache(
          storageGeneration,
          cacheId,
          cachePath,
        );
        if (!prepared) {
          throw new SceneEngineError(
            "CACHE_COMMIT_FAILED",
            "변환 캐시를 저장하지 못했습니다.",
          );
        }
        this.notify(onProgress, "cache-ready");
        return { ...prepared, reused: false };
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (previewPath) {
          await rm(`${previewPath}.ready`, { force: true }).catch(
            () => undefined,
          );
          if (!previewHandedOff) {
            await rm(previewPath, { force: true }).catch(() => undefined);
          }
        }
      }
    } catch (error) {
      this.notify(
        onProgress,
        signal.aborted || isSceneEngineAbort(error)
          ? "cancelled"
          : "failed",
      );
      throw error;
    }
  }

  private prepareStorage(engineRevision: string): Promise<string> {
    const generationId = computeCacheGenerationId(
      this.engine.descriptor,
      engineRevision,
    );
    const existing = this.storageRoots.get(generationId);
    if (existing) {
      return existing;
    }
    const storage = this.initializeStorage(generationId);
    this.storageRoots.set(generationId, storage);
    return storage;
  }

  private async initializeStorage(generationId: string): Promise<string> {
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    if (this.mode === "session") {
      const sessionRoot = await this.ensureSessionRoot();
      const generationRoot = path.join(sessionRoot, generationId);
      await mkdir(generationRoot, { recursive: true, mode: 0o700 });
      await serializeStorageMaintenance(this.cacheRoot, async () => {
        await this.cleanupLegacyCacheFiles();
        await this.cleanupAbandonedSessions();
        await this.cleanupPersistentGenerations(undefined);
      });
      return generationRoot;
    }

    const generationRoot = path.join(
      this.cacheRoot,
      CACHE_GENERATIONS_DIRECTORY,
      generationId,
    );
    const leasesRoot = path.join(
      generationRoot,
      CACHE_LEASES_DIRECTORY,
    );
    await mkdir(leasesRoot, { recursive: true, mode: 0o700 });
    await serializeStorageMaintenance(this.cacheRoot, async () => {
      await this.cleanupLegacyCacheFiles();
      await this.cleanupAbandonedSessions();
      await this.cleanupPersistentGenerations(generationId);
      await this.cleanupStaleTemporaryFiles(generationRoot);
      if (!(await this.hasFreshGenerationLease(generationRoot))) {
        await this.prunePersistentGeneration(generationRoot);
      }
    });
    await this.createLease(
      path.join(leasesRoot, `${this.leaseId}.lease`),
    );
    return generationRoot;
  }

  private ensureSessionRoot(): Promise<string> {
    if (this.sessionStorage) {
      return this.sessionStorage;
    }
    this.sessionStorage = (async () => {
      const sessionRoot = path.join(
        this.cacheRoot,
        CACHE_SESSIONS_DIRECTORY,
        this.sessionId,
      );
      await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
      this.sessionRoot = sessionRoot;
      await this.createLease(path.join(sessionRoot, ".lease"));
      return sessionRoot;
    })();
    return this.sessionStorage;
  }

  private async createLease(leasePath: string): Promise<void> {
    await writeFile(
      leasePath,
      `${JSON.stringify({ schema: CACHE_STORAGE_SCHEMA, pid: process.pid })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    this.leasePaths.add(leasePath);
    const timer = setInterval(() => {
      const now = new Date();
      void utimes(leasePath, now, now).catch(() => undefined);
    }, CACHE_LEASE_HEARTBEAT_MS);
    timer.unref();
    this.leaseTimers.set(leasePath, timer);
  }

  private async cleanupLegacyCacheFiles(): Promise<void> {
    for (const entry of await boundedDirectoryEntries(this.cacheRoot)) {
      if (
        LEGACY_CACHE_FILE_PATTERN.test(entry.name) &&
        (entry.isFile() || entry.isSymbolicLink())
      ) {
        await rm(path.join(this.cacheRoot, entry.name), { force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  private async cleanupAbandonedSessions(): Promise<void> {
    const sessionsRoot = path.join(
      this.cacheRoot,
      CACHE_SESSIONS_DIRECTORY,
    );
    for (const entry of await boundedDirectoryEntries(sessionsRoot)) {
      if (
        !entry.isDirectory() ||
        !CACHE_SESSION_PATTERN.test(entry.name) ||
        entry.name === this.sessionId
      ) {
        continue;
      }
      const sessionRoot = path.join(sessionsRoot, entry.name);
      if (await this.isFreshLease(path.join(sessionRoot, ".lease"))) {
        continue;
      }
      await rm(sessionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async cleanupPersistentGenerations(
    currentGenerationId: string | undefined,
  ): Promise<void> {
    const generationsRoot = path.join(
      this.cacheRoot,
      CACHE_GENERATIONS_DIRECTORY,
    );
    for (const entry of await boundedDirectoryEntries(generationsRoot)) {
      if (
        !entry.isDirectory() ||
        !CACHE_GENERATION_PATTERN.test(entry.name) ||
        entry.name === currentGenerationId
      ) {
        continue;
      }
      const generationRoot = path.join(generationsRoot, entry.name);
      if (await this.hasFreshGenerationLease(generationRoot)) {
        continue;
      }
      await rm(generationRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async hasFreshGenerationLease(
    generationRoot: string,
  ): Promise<boolean> {
    const leasesRoot = path.join(
      generationRoot,
      CACHE_LEASES_DIRECTORY,
    );
    let fresh = false;
    for (const entry of await boundedDirectoryEntries(leasesRoot)) {
      if (
        !CACHE_LEASE_PATTERN.test(entry.name) ||
        (!entry.isFile() && !entry.isSymbolicLink())
      ) {
        continue;
      }
      const leasePath = path.join(leasesRoot, entry.name);
      if (await this.isFreshLease(leasePath)) {
        fresh = true;
      } else {
        await rm(leasePath, { force: true }).catch(() => undefined);
      }
    }
    return fresh;
  }

  private async isFreshLease(leasePath: string): Promise<boolean> {
    try {
      const metadata = await stat(leasePath);
      if (!metadata.isFile()) {
        return false;
      }
      if (Date.now() - metadata.mtimeMs <= CACHE_LEASE_STALE_MS) {
        return true;
      }
      if (metadata.size <= 0 || metadata.size > 256) {
        return false;
      }
      const handle = await open(leasePath, "r");
      try {
        const bytes = Buffer.alloc(metadata.size);
        const { bytesRead } = await handle.read(
          bytes,
          0,
          bytes.byteLength,
          0,
        );
        let lease: { schema?: unknown; pid?: unknown };
        try {
          lease = JSON.parse(
            bytes.subarray(0, bytesRead).toString("utf8"),
          ) as { schema?: unknown; pid?: unknown };
        } catch {
          return false;
        }
        if (
          lease.schema !== CACHE_STORAGE_SCHEMA ||
          !Number.isSafeInteger(lease.pid) ||
          (lease.pid as number) <= 0
        ) {
          return false;
        }
        try {
          process.kill(lease.pid as number, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      return true;
    }
  }

  private async cleanupStaleTemporaryFiles(
    generationRoot: string,
  ): Promise<void> {
    const now = Date.now();
    for (const entry of await boundedDirectoryEntries(generationRoot)) {
      if (
        !TEMPORARY_CACHE_FILE_PATTERN.test(entry.name) ||
        (!entry.isFile() && !entry.isSymbolicLink())
      ) {
        continue;
      }
      const temporaryPath = path.join(generationRoot, entry.name);
      try {
        const metadata = await stat(temporaryPath);
        if (now - metadata.mtimeMs > CACHE_LEASE_STALE_MS) {
          await rm(temporaryPath, { force: true });
        }
      } catch {
        // Cleanup is best-effort and cannot block drawing preparation.
      }
    }
  }

  private async prunePersistentGeneration(
    generationRoot: string,
  ): Promise<void> {
    const entries = await boundedDirectoryEntries(generationRoot);
    const groups = new Map<
      string,
      {
        paths: string[];
        bytes: bigint;
        lastModifiedMs: number;
      }
    >();
    let totalBytes = 0n;
    for (const entry of entries) {
      const match = PERSISTENT_CACHE_FILE_PATTERN.exec(entry.name);
      if (
        !match ||
        (!entry.isFile() && !entry.isSymbolicLink())
      ) {
        continue;
      }
      const filePath = path.join(generationRoot, entry.name);
      try {
        const metadata = await stat(filePath, { bigint: true });
        if (!metadata.isFile() || metadata.size < 0n) {
          continue;
        }
        const group = groups.get(match[1]) ?? {
          paths: [],
          bytes: 0n,
          lastModifiedMs: 0,
        };
        group.paths.push(filePath);
        group.bytes += metadata.size;
        group.lastModifiedMs = Math.max(
          group.lastModifiedMs,
          Number(metadata.mtimeMs),
        );
        groups.set(match[1], group);
        totalBytes += metadata.size;
      } catch {
        // A raced reader or cleanup owns this entry now.
      }
    }
    const maximumBytes = BigInt(this.maximumPersistentBytes);
    if (totalBytes <= maximumBytes) {
      return;
    }
    const oldestFirst = [...groups.values()].sort(
      (left, right) => left.lastModifiedMs - right.lastModifiedMs,
    );
    for (const group of oldestFirst) {
      if (totalBytes <= maximumBytes) {
        break;
      }
      await Promise.allSettled(
        group.paths.map((filePath) => rm(filePath, { force: true })),
      );
      totalBytes -= group.bytes;
    }
  }

  private notify(
    observer: PrepareCacheOptions["onProgress"],
    phase: SceneEngineProgressPhase,
  ): void {
    try {
      observer?.(createSceneEngineProgress(this.engine.descriptor, phase));
    } catch {
      // Progress observers are diagnostic and cannot affect engine lifetime.
    }
  }

  private forward(
    observer: PrepareCacheOptions["onProgress"],
    event: SceneEngineProgressEvent,
  ): void {
    const descriptor = this.engine.descriptor;
    if (
      event.schema !== SCENE_ENGINE_PROGRESS_SCHEMA ||
      event.engineId !== descriptor.engineId ||
      event.engineVersion !== descriptor.engineVersion ||
      event.backendId !== descriptor.backendId ||
      event.backendKind !== descriptor.backendKind ||
      (event.phase !== "parsing" &&
        event.phase !== "preview-ready" &&
        event.phase !== "validating")
    ) {
      return;
    }
    if (
      event.phase === "preview-ready" &&
      !descriptor.capabilities.progressivePreview
    ) {
      return;
    }
    this.notify(observer, event.phase);
  }

  private preparedPreview(
    cacheId: string,
    cachePath: string,
    size: number,
    reused: boolean,
  ): PreparedPreview {
    return {
      cacheId: hashFields(["dwg-scene-preview/2", cacheId]),
      cachePath,
      size,
      reused,
      engine: this.engine.descriptor,
      release: this.releaseFile(cachePath),
    };
  }

  private releaseFile(cachePath: string): () => Promise<void> {
    if (this.mode === "persistent") {
      return async () => {
        // The consumer releases its range channel; the validated artifact
        // remains available for a later drawing session.
      };
    }
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await rm(cachePath, { force: true }).catch(() => undefined);
    };
  }

  private async markPersistentUse(cachePath: string): Promise<void> {
    if (this.mode !== "persistent") {
      return;
    }
    const now = new Date();
    await utimes(cachePath, now, now).catch(() => undefined);
  }

  private async readExistingPreview(
    cacheId: string,
    previewPath: string,
  ): Promise<PreparedPreview | undefined> {
    try {
      const metadata = await stat(previewPath);
      if (
        !metadata.isFile() ||
        metadata.size < SCENE_CACHE_HEADER_BYTES ||
        !(await this.hasCompatibleHeader(
          previewPath,
          SCENE_CACHE_HEADER_FLAG_PREVIEW,
        ))
      ) {
        await rm(previewPath, { force: true });
        return undefined;
      }
      if (!Number.isSafeInteger(metadata.size)) {
        throw new SceneEngineError(
          "CACHE_TOO_LARGE",
          "첫 화면 캐시가 지원 가능한 크기를 넘었습니다.",
        );
      }
      await this.markPersistentUse(previewPath);
      return this.preparedPreview(
        cacheId,
        previewPath,
        metadata.size,
        true,
      );
    } catch (error) {
      if (
        error instanceof SceneEngineError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      return undefined;
    }
  }

  private async commitPreview(
    cacheId: string,
    temporaryPath: string,
    previewPath: string,
    expectedSize: number,
  ): Promise<PreparedPreview> {
    try {
      await rename(temporaryPath, previewPath);
    } catch (error) {
      const racedPreview = await this.readExistingPreview(
        cacheId,
        previewPath,
      );
      if (racedPreview) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        return racedPreview;
      }
      throw error;
    }
    if (process.platform !== "win32") {
      await chmod(previewPath, 0o600);
    }
    const prepared = await this.readExistingPreview(cacheId, previewPath);
    if (!prepared || prepared.size !== expectedSize) {
      await rm(previewPath, { force: true }).catch(() => undefined);
      throw new SceneEngineError(
        "CACHE_PREVIEW_COMMIT_FAILED",
        "첫 화면 캐시를 저장하지 못했습니다.",
      );
    }
    return { ...prepared, reused: false };
  }

  private async readExistingCache(
    storageGeneration: string,
    cacheId: string,
    cachePath: string,
  ): Promise<PreparedCache | undefined> {
    try {
      const metadata = await stat(cachePath);
      if (!metadata.isFile() || metadata.size <= 0) {
        await rm(cachePath, { force: true });
        return undefined;
      }
      if (
        metadata.size < SCENE_CACHE_HEADER_BYTES ||
        !(await this.hasCompatibleHeader(cachePath, 0))
      ) {
        await rm(cachePath, { force: true });
        return undefined;
      }
      if (!Number.isSafeInteger(metadata.size)) {
        throw new SceneEngineError(
          "CACHE_TOO_LARGE",
          "변환 캐시가 지원 가능한 크기를 넘었습니다.",
        );
      }
      await this.markPersistentUse(cachePath);
      return {
        cacheId,
        cachePath,
        size: metadata.size,
        reused: true,
        storageGeneration,
        engine: this.engine.descriptor,
        release: this.releaseFile(cachePath),
      };
    } catch (error) {
      if (
        error instanceof SceneEngineError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      return undefined;
    }
  }

  private async reuseLegacyCache(
    activeCacheRoot: string,
    storageGeneration: string,
    cacheId: string,
    cachePath: string,
    legacyIds: readonly string[],
  ): Promise<PreparedCache | undefined> {
    for (const legacyId of legacyIds) {
      const legacyPath = path.join(
        activeCacheRoot,
        `${legacyId}.dwg.cache`,
      );
      const existing = await this.readExistingCache(
        storageGeneration,
        legacyId,
        legacyPath,
      );
      if (!existing) {
        continue;
      }
      try {
        await link(legacyPath, cachePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const raced = await this.readExistingCache(
            storageGeneration,
            cacheId,
            cachePath,
          );
          if (raced) {
            return raced;
          }
          continue;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        return { ...existing, cacheId };
      }
      const migrated = await this.readExistingCache(
        storageGeneration,
        cacheId,
        cachePath,
      );
      if (migrated) {
        await rm(legacyPath, { force: true }).catch(() => undefined);
        return migrated;
      }
    }
    return undefined;
  }

  private async reuseLegacyPreview(
    activeCacheRoot: string,
    cacheId: string,
    previewPath: string,
    legacyIds: readonly string[],
  ): Promise<PreparedPreview | undefined> {
    for (const legacyId of legacyIds) {
      const legacyPath = path.join(
        activeCacheRoot,
        `${legacyId}.dwg.preview`,
      );
      const existing = await this.readExistingPreview(
        legacyId,
        legacyPath,
      );
      if (!existing) {
        continue;
      }
      try {
        await link(legacyPath, previewPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const raced = await this.readExistingPreview(
            cacheId,
            previewPath,
          );
          if (raced) {
            return raced;
          }
          continue;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        return this.preparedPreview(
          cacheId,
          existing.cachePath,
          existing.size,
          true,
        );
      }
      const migrated = await this.readExistingPreview(
        cacheId,
        previewPath,
      );
      if (migrated) {
        await rm(legacyPath, { force: true }).catch(() => undefined);
        return migrated;
      }
    }
    return undefined;
  }

  private async hasCompatibleHeader(
    cachePath: string,
    expectedFlags: number,
  ): Promise<boolean> {
    const handle = await open(cachePath, "r");
    try {
      const header = Buffer.alloc(SCENE_CACHE_HEADER_BYTES);
      const { bytesRead } = await handle.read(
        header,
        0,
        header.byteLength,
        0,
      );
      return (
        bytesRead === header.byteLength &&
        header.subarray(0, SCENE_CACHE_MAGIC.byteLength).equals(
          SCENE_CACHE_MAGIC,
        ) &&
        header.readUInt16LE(8) === EXPECTED_SCENE_CACHE_MAJOR &&
        header.readUInt16LE(10) === EXPECTED_SCENE_CACHE_MINOR &&
        header.readUInt32LE(24) === expectedFlags
      );
    } finally {
      await handle.close();
    }
  }
}
