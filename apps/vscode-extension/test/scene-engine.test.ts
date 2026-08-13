import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeCacheGenerationId,
  computeCacheId,
  DEFAULT_PERSISTENT_CACHE_BYTES,
  maintainDerivedCacheStorage,
  normalizePersistentCacheBytes,
  normalizeSceneCacheMode,
  SceneCacheManager,
  type PreparedCache,
  type PreparedPreview,
} from "../src/scene-cache-manager";
import {
  canonicalSceneConversionOptions,
  createSceneEngineProgress,
  normalizeSceneConversionOptions,
  SCENE_CACHE_SCHEMA_VERSION,
  SCENE_ENGINE_CONTRACT,
  SCENE_ENGINE_PROGRESS_SCHEMA,
  type SceneEngine,
  type SceneEngineDescriptor,
  type SceneEngineProgressPhase,
} from "../src/scene-engine";

function sceneCacheBytes(payload: string, flags = 0): Buffer {
  const version = /\/(\d+)\.(\d+)$/u.exec(SCENE_CACHE_SCHEMA_VERSION);
  assert.ok(version);
  const header = Buffer.alloc(28);
  Buffer.from("DWGSCN1\0", "binary").copy(header);
  header.writeUInt16LE(Number(version[1]), 8);
  header.writeUInt16LE(Number(version[2]), 10);
  header.writeUInt32LE(flags, 24);
  return Buffer.concat([header, Buffer.from(payload, "utf8")]);
}

function sceneCachePayload(cache: Buffer): string {
  return cache.subarray(28).toString("utf8");
}

test("normalizes bounded conversion options into a stable cache identity", () => {
  assert.equal(
    canonicalSceneConversionOptions({
      tessellation: 0.25,
      includeText: true,
    }),
    canonicalSceneConversionOptions({
      includeText: true,
      tessellation: 0.25,
    }),
  );
  assert.deepEqual(
    normalizeSceneConversionOptions({
      tessellation: 0.25,
      includeText: true,
    }),
    { includeText: true, tessellation: 0.25 },
  );
  assert.throws(
    () => normalizeSceneConversionOptions({ "unsafe option": true }),
    /invalid scene conversion option/u,
  );
  assert.throws(
    () => normalizeSceneConversionOptions({ tessellation: Number.NaN }),
    /invalid value/u,
  );
});

test("binds progress events to one engine and backend identity", () => {
  const descriptor = wasmProbeDescriptor();
  const event = createSceneEngineProgress(descriptor, "preview-ready");
  assert.deepEqual(event, {
    schema: SCENE_ENGINE_PROGRESS_SCHEMA,
    phase: "preview-ready",
    engineId: "libredwg",
    engineVersion: "0.14",
    backendId: "wasm-probe",
    backendKind: "wasm-worker",
  });
  assert.equal(Object.isFrozen(event), true);
});

test("defaults drawing cache retention to one releasable session", async (context) => {
  assert.equal(normalizeSceneCacheMode(undefined), "session");
  assert.equal(normalizeSceneCacheMode("unexpected"), "session");
  assert.equal(normalizeSceneCacheMode("persistent"), "persistent");

  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-session-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "drawing.dwg");
  const cacheRoot = path.join(root, "cache");
  await writeFile(sourcePath, "drawing");
  const abandonedSession = path.join(
    cacheRoot,
    "sessions",
    "f".repeat(32),
  );
  const abandonedCache = path.join(abandonedSession, "orphan.cache");
  await mkdir(abandonedSession, { recursive: true });
  await writeFile(abandonedCache, "orphan");
  const descriptor = wasmProbeDescriptor();
  let conversionCount = 0;
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: "session-revision-1" };
    },
    async convert(request) {
      conversionCount += 1;
      const preview = sceneCacheBytes(`preview-${conversionCount}`, 1);
      await writeFile(request.previewPath!, preview);
      await request.onPreview?.({
        path: request.previewPath!,
        size: preview.byteLength,
      });
      await writeFile(
        request.outputPath,
        sceneCacheBytes(`cache-${conversionCount}`),
      );
    },
  };
  const manager = new SceneCacheManager(cacheRoot, engine);
  const previews: PreparedPreview[] = [];
  const prepare = () =>
    manager.prepare(sourcePath, {
      signal: new AbortController().signal,
      onPreview(preview) {
        previews.push(preview);
      },
    });

  const first = await prepare();
  await assert.rejects(readFile(abandonedCache), /ENOENT/u);
  const second = await prepare();
  assert.equal(conversionCount, 2);
  assert.equal(first.reused, false);
  assert.equal(second.reused, false);
  assert.equal(first.storageGeneration, second.storageGeneration);
  assert.notEqual(first.cachePath, second.cachePath);
  assert.equal(previews.length, 2);
  assert.equal(
    sceneCachePayload(await readFile(first.cachePath)),
    "cache-1",
  );
  assert.equal(
    sceneCachePayload(await readFile(previews[0].cachePath)),
    "preview-1",
  );

  await first.release();
  await first.release();
  await previews[0].release();
  await assert.rejects(readFile(first.cachePath), /ENOENT/u);
  await assert.rejects(readFile(previews[0].cachePath), /ENOENT/u);
  await manager.dispose();
  await assert.rejects(readFile(second.cachePath), /ENOENT/u);
  await assert.rejects(readFile(previews[1].cachePath), /ENOENT/u);
  assert.deepEqual(await readdir(path.join(cacheRoot, "sessions")), []);
});

test("removes an inactive engine cache generation but protects a live lease", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-generation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "drawing.dwg");
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(sourcePath, "drawing");
  const legacyFlatPath = path.join(
    cacheRoot,
    `${"a".repeat(64)}.dwg.cache`,
  );
  await writeFile(legacyFlatPath, sceneCacheBytes("legacy-flat"));

  const makeEngine = (version: string): SceneEngine => {
    const descriptor = {
      ...wasmProbeDescriptor(),
      engineVersion: version,
    };
    return {
      descriptor,
      async snapshot() {
        return { revision: `revision-${version}` };
      },
      async convert(request) {
        await writeFile(
          request.outputPath,
          sceneCacheBytes(`cache-${version}`),
        );
      },
    };
  };
  const firstManager = new SceneCacheManager(
    cacheRoot,
    makeEngine("0.14"),
    { mode: "persistent" },
  );
  const first = await firstManager.prepare(sourcePath, {
    signal: new AbortController().signal,
  });
  await assert.rejects(readFile(legacyFlatPath), /ENOENT/u);
  const firstLeasesRoot = path.join(
    path.dirname(first.cachePath),
    ".leases",
  );
  const [firstLease] = await readdir(firstLeasesRoot);
  const staleTime = new Date(Date.now() - 10 * 60_000);
  await utimes(
    path.join(firstLeasesRoot, firstLease),
    staleTime,
    staleTime,
  );

  const secondEngine = makeEngine("0.15");
  const secondManager = new SceneCacheManager(cacheRoot, secondEngine, {
    mode: "persistent",
  });
  const second = await secondManager.prepare(sourcePath, {
    signal: new AbortController().signal,
  });
  assert.notEqual(first.storageGeneration, second.storageGeneration);
  assert.equal(
    sceneCachePayload(await readFile(first.cachePath)),
    "cache-0.14",
  );

  await firstManager.dispose();
  const maintenance = new SceneCacheManager(cacheRoot, secondEngine, {
    mode: "persistent",
  });
  await maintenance.maintain();
  await assert.rejects(readFile(first.cachePath), /ENOENT/u);
  assert.equal(
    sceneCachePayload(await readFile(second.cachePath)),
    "cache-0.15",
  );
  await maintenance.dispose();
  await secondManager.dispose();
});

test("evicts the oldest closed persistent caches above the configured byte limit", async (context) => {
  assert.equal(
    normalizePersistentCacheBytes(undefined),
    DEFAULT_PERSISTENT_CACHE_BYTES,
  );
  assert.equal(
    normalizePersistentCacheBytes(1024 * 1024 * 1024),
    1024 * 1024 * 1024,
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-cap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cacheRoot = path.join(root, "cache");
  const descriptor = wasmProbeDescriptor();
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: "capacity-revision-1" };
    },
    async convert(request) {
      await writeFile(request.outputPath, sceneCacheBytes("cache"));
    },
  };
  const manager = new SceneCacheManager(cacheRoot, engine, {
    mode: "persistent",
    maximumPersistentBytes: 1024 * 1024 * 1024,
  });
  const prepared: PreparedCache[] = [];
  const sparseCacheBytes = 600 * 1024 * 1024;
  for (let index = 0; index < 3; index += 1) {
    const sourcePath = path.join(root, `drawing-${index}.dwg`);
    await writeFile(sourcePath, `drawing-${index}`);
    const cache = await manager.prepare(sourcePath, {
      signal: new AbortController().signal,
    });
    await truncate(cache.cachePath, sparseCacheBytes);
    const modified = new Date(Date.now() - (3 - index) * 60_000);
    await utimes(cache.cachePath, modified, modified);
    prepared.push(cache);
  }

  await manager.dispose();
  await assert.rejects(readFile(prepared[0].cachePath), /ENOENT/u);
  await assert.rejects(readFile(prepared[1].cachePath), /ENOENT/u);
  assert.equal((await stat(prepared[2].cachePath)).size, sparseCacheBytes);
});

test("session mode removes an unleased persistent cache generation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-opt-out-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "drawing.dwg");
  const cacheRoot = path.join(root, "cache");
  await writeFile(sourcePath, "drawing");
  const descriptor = wasmProbeDescriptor();
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: "opt-out-revision-1" };
    },
    async convert(request) {
      await writeFile(request.outputPath, sceneCacheBytes("persistent-cache"));
    },
  };
  const persistent = new SceneCacheManager(cacheRoot, engine, {
    mode: "persistent",
  });
  const prepared = await persistent.prepare(sourcePath, {
    signal: new AbortController().signal,
  });
  await persistent.dispose();

  const session = new SceneCacheManager(cacheRoot, engine);
  await session.maintain();
  await assert.rejects(readFile(prepared.cachePath), /ENOENT/u);
  await session.dispose();
});

test("keeps derived text indexes only for the selected persistent generation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-derived-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const oldGeneration = "1".repeat(64);
  const currentGeneration = "2".repeat(64);
  const legacyIndex = path.join(root, `${"3".repeat(64)}.json`);
  const oldIndex = path.join(
    root,
    "generations",
    oldGeneration,
    `${"4".repeat(64)}.json`,
  );
  await mkdir(path.dirname(oldIndex), { recursive: true });
  await writeFile(legacyIndex, "{}");
  await writeFile(oldIndex, "{}");

  const currentRoot = await maintainDerivedCacheStorage(
    root,
    "persistent",
    currentGeneration,
  );
  assert.equal(
    currentRoot,
    path.join(root, "generations", currentGeneration),
  );
  await assert.rejects(readFile(legacyIndex), /ENOENT/u);
  await assert.rejects(readFile(oldIndex), /ENOENT/u);
  const currentIndex = path.join(currentRoot!, `${"5".repeat(64)}.json`);
  await writeFile(currentIndex, "{}");

  assert.equal(
    await maintainDerivedCacheStorage(root, "session"),
    undefined,
  );
  await assert.rejects(readFile(currentIndex), /ENOENT/u);
  await assert.rejects(
    maintainDerivedCacheStorage(root, "persistent", "invalid"),
    /generation ID/u,
  );
});

test("reuses a legacy decomposed macOS cache under its NFC identity", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-nfc-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(
    root,
    "한글-도면.dwg".normalize("NFD"),
  );
  const cacheRoot = path.join(root, "cache");
  await writeFile(sourcePath, "drawing");
  await mkdir(cacheRoot, { recursive: true });

  const descriptor = wasmProbeDescriptor();
  const engineRevision = "wasm-probe-revision-1";
  const sourceMetadata = await stat(sourcePath, { bigint: true });
  const identity = {
    sourcePath,
    sourceSize: sourceMetadata.size,
    sourceMtimeNs: sourceMetadata.mtimeNs,
    engine: descriptor,
    engineRevision,
  };
  const legacyId = computeCacheId(identity, "linux");
  const canonicalId = computeCacheId(identity, "darwin");
  assert.notEqual(legacyId, canonicalId);
  const generationRoot = path.join(
    cacheRoot,
    "generations",
    computeCacheGenerationId(descriptor, engineRevision),
  );
  await mkdir(generationRoot, { recursive: true });
  const legacyPath = path.join(generationRoot, `${legacyId}.dwg.cache`);
  await writeFile(legacyPath, sceneCacheBytes("legacy-cache"));

  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: engineRevision };
    },
    async convert() {
      assert.fail("a compatible legacy cache must not be rebuilt");
    },
  };
  const prepared = await new SceneCacheManager(
    cacheRoot,
    engine,
    { mode: "persistent", platform: "darwin" },
  ).prepare(sourcePath, {
    signal: new AbortController().signal,
  });

  assert.equal(prepared.cacheId, canonicalId);
  assert.equal(prepared.reused, true);
  assert.equal(
    sceneCachePayload(await readFile(prepared.cachePath)),
    "legacy-cache",
  );
  await assert.rejects(readFile(legacyPath), /ENOENT/u);
});

test("reuses a legacy decomposed macOS preview during a full rebuild", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-nfc-preview-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(
    root,
    "한글-도면.dwg".normalize("NFD"),
  );
  const cacheRoot = path.join(root, "cache");
  await writeFile(sourcePath, "drawing");
  await mkdir(cacheRoot, { recursive: true });

  const descriptor = wasmProbeDescriptor();
  const engineRevision = "wasm-probe-revision-1";
  const sourceMetadata = await stat(sourcePath, { bigint: true });
  const identity = {
    sourcePath,
    sourceSize: sourceMetadata.size,
    sourceMtimeNs: sourceMetadata.mtimeNs,
    engine: descriptor,
    engineRevision,
  };
  const legacyId = computeCacheId(identity, "linux");
  const canonicalId = computeCacheId(identity, "darwin");
  const generationRoot = path.join(
    cacheRoot,
    "generations",
    computeCacheGenerationId(descriptor, engineRevision),
  );
  await mkdir(generationRoot, { recursive: true });
  const legacyPath = path.join(generationRoot, `${legacyId}.dwg.preview`);
  await writeFile(
    legacyPath,
    sceneCacheBytes("legacy-preview", 1),
  );

  let conversionCount = 0;
  let previewCount = 0;
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: engineRevision };
    },
    async convert(request) {
      conversionCount += 1;
      assert.equal(request.previewPath, undefined);
      await writeFile(request.outputPath, sceneCacheBytes("full-cache"));
    },
  };
  const prepared = await new SceneCacheManager(
    cacheRoot,
    engine,
    { mode: "persistent", platform: "darwin" },
  ).prepare(sourcePath, {
    signal: new AbortController().signal,
    async onPreview(preview) {
      previewCount += 1;
      assert.equal(preview.reused, true);
      assert.equal(
        sceneCachePayload(await readFile(preview.cachePath)),
        "legacy-preview",
      );
    },
  });

  assert.equal(prepared.cacheId, canonicalId);
  assert.equal(conversionCount, 1);
  assert.equal(previewCount, 1);
  await assert.rejects(readFile(legacyPath), /ENOENT/u);
});

test("prepares a progressive WASM-shaped engine through the common cache path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-engine-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "drawing.dwg");
  const cacheRoot = path.join(root, "cache");
  await writeFile(sourcePath, "drawing");

  const descriptor = wasmProbeDescriptor();
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: "wasm-probe-revision-1" };
    },
    async convert(request) {
      request.onProgress?.(
        createSceneEngineProgress(descriptor, "parsing"),
      );
      await writeFile(request.outputPath, sceneCacheBytes("packed-scene-cache"));
      request.onProgress?.(
        createSceneEngineProgress(descriptor, "preview-ready"),
      );
      request.onProgress?.(
        createSceneEngineProgress(descriptor, "validating"),
      );
    },
  };
  const manager = new SceneCacheManager(cacheRoot, engine, {
    mode: "persistent",
  });
  const phases: SceneEngineProgressPhase[] = [];
  const prepared = await manager.prepare(sourcePath, {
    signal: new AbortController().signal,
    conversionOptions: { tessellation: 0.25 },
    onProgress: ({ phase }) => phases.push(phase),
  });

  assert.deepEqual(phases, [
    "checking",
    "parsing",
    "preview-ready",
    "validating",
    "cache-ready",
  ]);
  assert.equal(prepared.reused, false);
  assert.equal(prepared.engine.backendKind, "wasm-worker");
  assert.equal(
    sceneCachePayload(await readFile(prepared.cachePath)),
    "packed-scene-cache",
  );
});

test("persists and reuses an independently readable preview", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-preview-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "drawing.dwg");
  await writeFile(sourcePath, "drawing");

  const descriptor = wasmProbeDescriptor();
  let conversionCount = 0;
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: "preview-revision-1" };
    },
    async convert(request) {
      conversionCount += 1;
      if (conversionCount === 1 || conversionCount === 3) {
        assert.equal(typeof request.previewPath, "string");
        const preview = sceneCacheBytes(
          conversionCount === 1
            ? "bounded-preview"
            : "replacement-preview",
          1,
        );
        await writeFile(request.previewPath!, preview);
        await request.onPreview?.({
          path: request.previewPath!,
          size: preview.byteLength,
        });
      } else {
        assert.equal(request.previewPath, undefined);
        assert.equal(request.onPreview, undefined);
      }
      await writeFile(request.outputPath, sceneCacheBytes("packed-scene-cache"));
    },
  };
  const cacheRoot = path.join(root, "cache");
  const manager = new SceneCacheManager(cacheRoot, engine, {
    mode: "persistent",
  });
  const phases: SceneEngineProgressPhase[] = [];
  let persistedPreviewPath: string | undefined;
  let firstPreviewId: string | undefined;
  const prepared = await manager.prepare(sourcePath, {
    signal: new AbortController().signal,
    onProgress: ({ phase }) => phases.push(phase),
    async onPreview(preview) {
      assert.match(preview.cacheId, /^[a-f0-9]{64}$/u);
      assert.equal(preview.reused, false);
      assert.equal(
        sceneCachePayload(await readFile(preview.cachePath)),
        "bounded-preview",
      );
      persistedPreviewPath = preview.cachePath;
      firstPreviewId = preview.cacheId;
      await preview.release();
      await preview.release();
    },
  });

  assert.equal(prepared.reused, false);
  assert.deepEqual(phases, [
    "checking",
    "preview-ready",
    "cache-ready",
  ]);
  assert.ok(persistedPreviewPath);
  assert.equal(
    sceneCachePayload(await readFile(persistedPreviewPath)),
    "bounded-preview",
  );

  await rm(prepared.cachePath);
  let reusedPreviewPath: string | undefined;
  const rebuilt = await manager.prepare(sourcePath, {
    signal: new AbortController().signal,
    async onPreview(preview) {
      assert.equal(preview.reused, true);
      assert.equal(preview.cacheId, firstPreviewId);
      reusedPreviewPath = preview.cachePath;
    },
  });
  assert.equal(conversionCount, 2);
  assert.equal(reusedPreviewPath, persistedPreviewPath);
  assert.equal(rebuilt.reused, false);
  assert.equal(
    sceneCachePayload(await readFile(rebuilt.cachePath)),
    "packed-scene-cache",
  );

  await rm(rebuilt.cachePath);
  const invalidPreview = await readFile(persistedPreviewPath);
  invalidPreview.writeUInt32LE(0, 24);
  await writeFile(persistedPreviewPath, invalidPreview);
  let replacementPublished = false;
  await manager.prepare(sourcePath, {
    signal: new AbortController().signal,
    async onPreview(preview) {
      replacementPublished = true;
      assert.equal(preview.reused, false);
      assert.equal(
        sceneCachePayload(await readFile(preview.cachePath)),
        "replacement-preview",
      );
    },
  });
  assert.equal(conversionCount, 3);
  assert.equal(replacementPublished, true);
  assert.equal(
    (await readdir(cacheRoot)).some(
      (name) => name.endsWith(".tmp") || name.endsWith(".ready"),
    ),
    false,
  );
});

test("keeps the final cache when preview publication fails", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-scene-preview-fail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "drawing.dwg");
  await writeFile(sourcePath, "drawing");

  const descriptor = wasmProbeDescriptor();
  let previewPath: string | undefined;
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision: "preview-revision-1" };
    },
    async convert(request) {
      previewPath = request.previewPath;
      const preview = sceneCacheBytes("bounded-preview", 1);
      await writeFile(request.previewPath!, preview);
      await request.onPreview?.({
        path: request.previewPath!,
        size: preview.byteLength,
      });
      await writeFile(request.outputPath, sceneCacheBytes("packed-scene-cache"));
    },
  };
  const prepared = await new SceneCacheManager(
    path.join(root, "cache"),
    engine,
    { mode: "persistent" },
  ).prepare(sourcePath, {
    signal: new AbortController().signal,
    async onPreview() {
      throw new Error("preview consumer failed");
    },
  });

  assert.equal(
    sceneCachePayload(await readFile(prepared.cachePath)),
    "packed-scene-cache",
  );
  assert.ok(previewPath);
  await assert.rejects(readFile(previewPath), /ENOENT/u);
  assert.equal(
    sceneCachePayload(
      await readFile(
        path.join(
          path.dirname(prepared.cachePath),
          `${prepared.cacheId}.dwg.preview`,
        ),
      ),
    ),
    "bounded-preview",
  );
});

test("rejects an engine revision that changes during conversion", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-engine-revision-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "drawing.dwg");
  await writeFile(sourcePath, "drawing");

  const descriptor = wasmProbeDescriptor();
  let revision = "wasm-probe-revision-1";
  const engine: SceneEngine = {
    descriptor,
    async snapshot() {
      return { revision };
    },
    async convert(request) {
      request.onProgress?.(
        createSceneEngineProgress(descriptor, "parsing"),
      );
      await writeFile(request.outputPath, sceneCacheBytes("packed-scene-cache"));
      revision = "wasm-probe-revision-2";
    },
  };
  const phases: SceneEngineProgressPhase[] = [];
  await assert.rejects(
    new SceneCacheManager(path.join(root, "cache"), engine).prepare(
      sourcePath,
      {
        signal: new AbortController().signal,
        onProgress: ({ phase }) => phases.push(phase),
      },
    ),
    /CACHE_INPUT_CHANGED/u,
  );
  assert.equal(phases.at(-1), "failed");
});

function wasmProbeDescriptor(): SceneEngineDescriptor {
  return {
    schema: SCENE_ENGINE_CONTRACT,
    engineId: "libredwg",
    engineVersion: "0.14",
    backendId: "wasm-probe",
    backendKind: "wasm-worker",
    displayName: "LibreDWG WASM 검증판",
    cacheSchema: SCENE_CACHE_SCHEMA_VERSION,
    capabilities: {
      localExecution: true,
      packedSceneCache: true,
      progressivePreview: true,
      cancellable: true,
      features: [
        "linework",
        "blocks",
        "hatch",
        "wipeout",
        "text",
        "shx-bigfont",
      ],
      conversionOptions: ["tessellation"],
    },
  };
}
