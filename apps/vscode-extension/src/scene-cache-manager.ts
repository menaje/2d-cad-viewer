import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
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
  engine: SceneEngineDescriptor;
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
  constructor(
    private readonly cacheRoot: string,
    private readonly engine: SceneEngine,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    if (
      engine.descriptor.schema !== SCENE_ENGINE_CONTRACT ||
      engine.descriptor.cacheSchema !== SCENE_CACHE_SCHEMA_VERSION
    ) {
      throw new TypeError("scene engine descriptor is incompatible");
    }
  }

  async prepare(
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
      const legacyIds = legacyCacheIds(
        identity,
        this.platform,
        realSourcePath,
      );
      const cachePath = path.join(
        this.cacheRoot,
        `${cacheId}.dwg.cache`,
      );

      if (force) {
        await rm(cachePath, { force: true });
      } else {
        const existing =
          (await this.readExistingCache(cacheId, cachePath)) ??
          (await this.reuseLegacyCache(cacheId, cachePath, legacyIds));
        if (existing) {
          this.notify(onProgress, "cache-ready");
          return existing;
        }
      }

      const temporaryPath = path.join(
        this.cacheRoot,
        `${cacheId}.${randomBytes(8).toString("hex")}.tmp`,
      );
      const persistentPreviewPath =
        onPreview && this.engine.descriptor.capabilities.progressivePreview
          ? path.join(
              this.cacheRoot,
              `${cacheId}.dwg.preview`,
            )
          : undefined;
      let previewHandedOff = false;
      let previewPublication = Promise.resolve();
      if (persistentPreviewPath) {
        const existingPreview =
          (await this.readExistingPreview(
            cacheId,
            persistentPreviewPath,
          )) ??
          (await this.reuseLegacyPreview(
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
              this.cacheRoot,
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
        const prepared = await this.readExistingCache(cacheId, cachePath);
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
      async release(): Promise<void> {
        // Range channels are released by the consumer. The overview remains
        // durable so an interrupted or forced full conversion can reuse it.
      },
    };
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
      return {
        cacheId,
        cachePath,
        size: metadata.size,
        reused: true,
        engine: this.engine.descriptor,
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
    cacheId: string,
    cachePath: string,
    legacyIds: readonly string[],
  ): Promise<PreparedCache | undefined> {
    for (const legacyId of legacyIds) {
      const legacyPath = path.join(
        this.cacheRoot,
        `${legacyId}.dwg.cache`,
      );
      const existing = await this.readExistingCache(
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
          const raced = await this.readExistingCache(cacheId, cachePath);
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
      const migrated = await this.readExistingCache(cacheId, cachePath);
      if (migrated) {
        await rm(legacyPath, { force: true }).catch(() => undefined);
        return migrated;
      }
    }
    return undefined;
  }

  private async reuseLegacyPreview(
    cacheId: string,
    previewPath: string,
    legacyIds: readonly string[],
  ): Promise<PreparedPreview | undefined> {
    for (const legacyId of legacyIds) {
      const legacyPath = path.join(
        this.cacheRoot,
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
