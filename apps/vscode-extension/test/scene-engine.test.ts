import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeCacheId,
  SceneCacheManager,
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
  const legacyPath = path.join(cacheRoot, `${legacyId}.dwg.cache`);
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
    "darwin",
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
  const legacyPath = path.join(cacheRoot, `${legacyId}.dwg.preview`);
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
    "darwin",
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
  const manager = new SceneCacheManager(cacheRoot, engine);
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
  const manager = new SceneCacheManager(cacheRoot, engine);
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
