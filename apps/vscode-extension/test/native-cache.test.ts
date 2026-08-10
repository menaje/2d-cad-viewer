import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  diagnoseLibreDwgAdapter,
  LIBREDWG_NATIVE_ENGINE_DESCRIPTOR,
  LibreDwgNativeSceneEngine,
  parseAdapterReport,
  parseLibreDwgDoctorReport,
  resolveLibreDwgAdapter,
  runLibreDwgAdapter,
} from "../src/native-cache";
import {
  computeCacheId,
  SceneCacheManager,
} from "../src/scene-cache-manager";
import {
  isSceneEngineAbort,
  type SceneEngineProgressPhase,
} from "../src/scene-engine";

test("cache identity is deterministic and changes with source metadata", () => {
  const identity = {
    sourcePath: "/drawings/example.dwg",
    sourceSize: 100n,
    sourceMtimeNs: 200n,
    engine: LIBREDWG_NATIVE_ENGINE_DESCRIPTOR,
    engineRevision: "adapter-revision-1",
  };
  const first = computeCacheId(identity);
  assert.equal(first, computeCacheId(identity));
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    first,
    computeCacheId({ ...identity, sourceMtimeNs: 201n }),
  );
  assert.notEqual(
    first,
    computeCacheId({
      ...identity,
      engine: {
        ...identity.engine,
        engineVersion: "0.14-test",
      },
    }),
  );
  assert.notEqual(
    first,
    computeCacheId({
      ...identity,
      engine: {
        ...identity.engine,
        backendId: "wasm-probe",
        backendKind: "wasm-worker",
      },
    }),
  );
  assert.notEqual(
    first,
    computeCacheId({
      ...identity,
      conversionOptions: { tessellation: 0.25 },
    }),
  );
  assert.equal(
    computeCacheId({
      ...identity,
      conversionOptions: { alpha: true, tessellation: 0.25 },
    }),
    computeCacheId({
      ...identity,
      conversionOptions: { tessellation: 0.25, alpha: true },
    }),
  );
});

test("adapter revision follows executable contents instead of its path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-engine-revision-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstPath = path.join(root, "first-adapter");
  const movedPath = path.join(root, "moved-adapter");
  await writeFile(firstPath, "same native adapter bytes");
  await writeFile(movedPath, "same native adapter bytes");

  const first = await new LibreDwgNativeSceneEngine(firstPath).snapshot();
  const moved = await new LibreDwgNativeSceneEngine(movedPath).snapshot();
  assert.equal(first.revision, moved.revision);
  assert.match(first.revision, /^[a-f0-9]{64}$/u);

  await writeFile(movedPath, "changed native adapter bytes");
  const changed = await new LibreDwgNativeSceneEngine(movedPath).snapshot();
  assert.notEqual(changed.revision, first.revision);
});

test("adapter report requires the expected schema, validation, and size", () => {
  parseAdapterReport(
    JSON.stringify({
      schema: "dwg-scene-cache/1",
      status: "ok",
      cache: {
        format_major: 1,
        format_minor: 20,
        size_bytes: 5,
        validated: true,
      },
    }),
    5n,
  );
  assert.throws(
    () =>
      parseAdapterReport(
        JSON.stringify({
          schema: "dwg-scene-cache/1",
          status: "ok",
          cache: {
            format_major: 1,
            format_minor: 20,
            size_bytes: 4,
            validated: true,
          },
        }),
        5n,
      ),
    /ADAPTER_REPORT_REJECTED/u,
  );
  assert.throws(
    () =>
      parseAdapterReport(
        JSON.stringify({
          schema: "dwg-scene-cache/1",
          status: "ok",
          cache: {
            format_major: 1,
            format_minor: 18,
            size_bytes: 5,
            validated: true,
          },
        }),
        5n,
      ),
    /ADAPTER_REPORT_REJECTED/u,
  );
});

test("adapter report returns validated conversion performance", () => {
  assert.deepEqual(
    parseAdapterReport(
      JSON.stringify({
        schema: "dwg-scene-cache/1",
        status: "ok",
        cache: {
          format_major: 1,
          format_minor: 20,
          size_bytes: "5",
          validated: true,
        },
        performance: {
          parse_ms: 101,
          write_ms: 202,
          total_ms: 303,
          worker_count: 6,
          parallel_sort_workers: 4,
          parallel_section_workers: 6,
          stages: {
            reference_resolution_ms: 8,
            section_write_ms: 181,
            ignored_negative_ms: -1,
            section_groups: {
              metadata_ms: 12,
              gpu_cache_ms: 78,
              ignored_fraction_ms: 1.5,
            },
          },
        },
      }),
      5n,
    ),
    {
      parseMs: 101,
      writeMs: 202,
      totalMs: 303,
      workerCount: 6,
      parallelSortWorkers: 4,
      parallelSectionWorkers: 6,
      stages: {
        reference_resolution_ms: 8,
        section_write_ms: 181,
        "section_groups.metadata_ms": 12,
        "section_groups.gpu_cache_ms": 78,
      },
    },
  );
});

test("doctor report requires the adapter, cache, engine, and license contract", () => {
  const compatible = {
    schema: "dwg-engine-doctor/1",
    status: "ok",
    protocol: "dwg-engine-adapter/1",
    engine: {
      id: "libredwg",
      version: "0.14",
      license: "GPL-3.0-or-later",
      linkage: "static",
    },
    cache: { schema: "dwg-scene-cache/1.20" },
    target: { platform: "darwin", architecture: "arm64" },
  };
  assert.deepEqual(
    parseLibreDwgDoctorReport(JSON.stringify(compatible)),
    {
      engineVersion: "0.14",
      linkage: "static",
      platform: "darwin",
      architecture: "arm64",
    },
  );
  assert.throws(
    () =>
      parseLibreDwgDoctorReport(
        JSON.stringify({
          ...compatible,
          cache: { schema: "dwg-scene-cache/1.10" },
        }),
      ),
    /ADAPTER_DOCTOR_REPORT_REJECTED/u,
  );
  assert.throws(
    () =>
      parseLibreDwgDoctorReport(
        JSON.stringify({
          ...compatible,
          engine: { ...compatible.engine, license: "unknown" },
        }),
    ),
    /ADAPTER_DOCTOR_REPORT_REJECTED/u,
  );
  assert.throws(
    () =>
      parseLibreDwgDoctorReport(
        JSON.stringify({
          ...compatible,
          engine: { ...compatible.engine, version: "0.15" },
        }),
      ),
    /ADAPTER_DOCTOR_REPORT_REJECTED/u,
  );
});

test(
  "runs a bounded adapter self-diagnosis and rejects a timeout",
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dwg-doctor-test-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const adapterScript = path.join(root, "libredwg-adapter.cjs");
    await writeFile(
      adapterScript,
      `
if (
  process.argv[2] !== "doctor" ||
  process.env.DWG_VIEWER_ADAPTER_PROTOCOL !== "dwg-engine-adapter/1" ||
  process.env.DWG_VIEWER_BENCHMARK_PHASE !== "doctor"
) process.exit(12);
if (process.env.DWG_DOCTOR_TEST_MODE === "slow") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({
    schema: "dwg-engine-doctor/1",
    status: "ok",
    protocol: "dwg-engine-adapter/1",
    engine: {
      id: "libredwg",
      version: "0.14",
      license: "GPL-3.0-or-later",
      linkage: "static"
    },
    cache: { schema: "dwg-scene-cache/1.20" },
    target: { platform: "test", architecture: "test" }
  }) + "\\n");
}
`,
    );

    const report = await diagnoseLibreDwgAdapter(process.execPath, {
      argumentPrefix: [adapterScript],
    });
    assert.equal(report.engineVersion, "0.14");
    assert.equal(report.linkage, "static");

    process.env.DWG_DOCTOR_TEST_MODE = "slow";
    try {
      await assert.rejects(
        diagnoseLibreDwgAdapter(process.execPath, {
          argumentPrefix: [adapterScript],
          timeoutMs: 100,
        }),
        /ADAPTER_DOCTOR_TIMEOUT/u,
      );
    } finally {
      delete process.env.DWG_DOCTOR_TEST_MODE;
    }
  },
);

test("resolves only an absolute executable adapter path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-adapter-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const adapterPath = path.join(root, "libredwg-adapter");
  await writeFile(adapterPath, "#!/bin/sh\nexit 0\n");
  await chmod(adapterPath, 0o700);

  assert.equal(
    await resolveLibreDwgAdapter({
      configuredPath: adapterPath,
      extensionPath: root,
    }),
    adapterPath,
  );
  await assert.rejects(
    resolveLibreDwgAdapter({
      configuredPath: "relative/adapter",
      extensionPath: root,
    }),
    /ADAPTER_PATH_NOT_ABSOLUTE/u,
  );
});

test("resolves the adapter from the GPL companion extension", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-companion-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mainExtensionRoot = path.join(root, "main");
  const companionRoot = path.join(root, "companion");
  const adapterPath = path.join(
    companionRoot,
    "native",
    `${process.platform}-${process.arch}`,
    process.platform === "win32"
      ? "libredwg-adapter.exe"
      : "libredwg-adapter",
  );
  await mkdir(path.dirname(adapterPath), { recursive: true });
  await writeFile(adapterPath, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") {
    await chmod(adapterPath, 0o700);
  }

  assert.equal(
    await resolveLibreDwgAdapter({
      extensionPath: mainExtensionRoot,
      bundledExtensionPath: companionRoot,
    }),
    adapterPath,
  );
});

test(
  "publishes a bounded native preview before full conversion completes",
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dwg-native-preview-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const unicodeRoot = path.join(root, "한글-é-e\u0301");
    await mkdir(unicodeRoot);
    const sourcePath = path.join(unicodeRoot, "도면.dwg");
    const outputPath = path.join(unicodeRoot, "drawing.cache");
    const previewPath = path.join(unicodeRoot, "drawing.preview");
    const adapterScript = path.join(root, "libredwg-adapter.cjs");
    await writeFile(sourcePath, "AC1015drawing");
    await writeFile(
      adapterScript,
      `
const fs = require("node:fs");
const output = process.argv[4];
const preview = process.env.DWG_VIEWER_PREVIEW_PATH;
const ready = process.env.DWG_VIEWER_PREVIEW_READY_PATH;
fs.writeFileSync(preview, "preview");
fs.writeFileSync(ready, "");
setTimeout(() => {
  fs.writeFileSync(output, "cache");
  process.stdout.write(JSON.stringify({
    schema: "dwg-scene-cache/1",
    status: "ok",
    cache: {
      format_major: 1,
      format_minor: 20,
      size_bytes: 5,
      validated: true,
    },
    performance: {
      parse_ms: 11,
      write_ms: 22,
      total_ms: 33,
      worker_count: 4,
      parallel_sort_workers: 3,
      parallel_section_workers: 4,
      stages: { section_write_ms: 19 }
    }
  }) + "\\n");
}, 120);
`,
    );

    let previewCount = 0;
    let performanceCount = 0;
    await runLibreDwgAdapter({
      adapterPath: process.execPath,
      argumentPrefix: [adapterScript],
      inputPath: sourcePath,
      outputPath,
      previewPath,
      platform: "win32",
      signal: new AbortController().signal,
      async onPreview(preview) {
        previewCount++;
        assert.equal(preview.path, previewPath);
        assert.equal(preview.size, 7);
        assert.equal(await readFile(preview.path, "utf8"), "preview");
        await assert.rejects(readFile(outputPath), /ENOENT/u);
      },
      onPerformance(performance) {
        performanceCount++;
        assert.equal(performance.workerCount, 4);
        assert.equal(performance.stages.section_write_ms, 19);
      },
    });

    assert.equal(previewCount, 1);
    assert.equal(performanceCount, 1);
    assert.equal(await readFile(outputPath, "utf8"), "cache");
  },
);

test(
  "creates, reuses, rebuilds, and cancels native caches",
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dwg-native-cache-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const unicodeRoot = path.join(root, "한글-é-e\u0301");
    await mkdir(unicodeRoot);
    const sourcePath = path.join(unicodeRoot, "도면.dwg");
    const adapterScript = path.join(root, "libredwg-adapter.cjs");
    const cacheRoot = path.join(unicodeRoot, "cache");
    await writeFile(sourcePath, "AC1015fast");
    await writeFile(
      adapterScript,
      `
const fs = require("node:fs");
const input = process.argv[3];
const output = process.argv[4];
if (
  process.env.DWG_VIEWER_ADAPTER_PROTOCOL !== "dwg-engine-adapter/1" ||
  process.env.DWG_VIEWER_BENCHMARK_PHASE !== "convert"
) process.exit(12);
const source = fs.readFileSync(input === "-" ? 0 : input, "utf8");
if (
  input === "-" &&
  (
    process.env.DWG_VIEWER_STDIN_SOURCE_SIZE !== String(Buffer.byteLength(source)) ||
    process.env.DWG_VIEWER_STDIN_SOURCE_VERSION !== source.slice(0, 6)
  )
) process.exit(13);
const mode = source.slice(6);
const cache = Buffer.alloc(64);
Buffer.from("DWGSCN1\\0", "binary").copy(cache, 0);
cache.writeUInt16LE(1, 8);
cache.writeUInt16LE(20, 10);
fs.writeFileSync(output, cache);
const report = () => process.stdout.write(JSON.stringify({
  schema: "dwg-scene-cache/1",
  status: "ok",
  cache: {
    format_major: 1,
    format_minor: 20,
    size_bytes: 64,
    validated: true
  }
}) + "\\n");
if (mode === "slow") setInterval(() => {}, 1000);
else if (mode === "change") setTimeout(report, 300);
else report();
`,
    );

    const manager = new SceneCacheManager(
      cacheRoot,
      new LibreDwgNativeSceneEngine(process.execPath, {
        argumentPrefix: [adapterScript],
        platform: "win32",
      }),
    );
    const unsupportedPhases: SceneEngineProgressPhase[] = [];
    await assert.rejects(
      manager.prepare(sourcePath, {
        signal: new AbortController().signal,
        conversionOptions: { tessellation: 0.25 },
        onProgress: ({ phase }) => unsupportedPhases.push(phase),
      }),
      /ENGINE_OPTIONS_UNSUPPORTED/u,
    );
    assert.deepEqual(unsupportedPhases, ["failed"]);

    const firstPhases: SceneEngineProgressPhase[] = [];
    const first = await manager.prepare(sourcePath, {
      signal: new AbortController().signal,
      onProgress: ({ phase }) => firstPhases.push(phase),
    });
    assert.equal(first.reused, false);
    const firstCache = await readFile(first.cachePath);
    assert.equal(firstCache.readUInt16LE(8), 1);
    assert.equal(firstCache.readUInt16LE(10), 20);
    assert.deepEqual(firstPhases, [
      "checking",
      "parsing",
      "validating",
      "cache-ready",
    ]);
    assert.equal(first.engine.backendId, "native");

    const reusedPhases: SceneEngineProgressPhase[] = [];
    const second = await manager.prepare(sourcePath, {
      signal: new AbortController().signal,
      onProgress: ({ phase }) => reusedPhases.push(phase),
    });
    assert.equal(second.reused, true);
    assert.equal(second.cacheId, first.cacheId);
    assert.deepEqual(reusedPhases, ["checking", "cache-ready"]);

    const obsoleteCache = Buffer.from(firstCache);
    obsoleteCache.writeUInt16LE(18, 10);
    await writeFile(first.cachePath, obsoleteCache);
    const migrated = await manager.prepare(sourcePath, {
      signal: new AbortController().signal,
    });
    assert.equal(migrated.reused, false);
    assert.equal((await readFile(migrated.cachePath)).readUInt16LE(10), 20);

    const rebuilt = await manager.prepare(sourcePath, {
      force: true,
      signal: new AbortController().signal,
    });
    assert.equal(rebuilt.reused, false);

    await writeFile(sourcePath, "AC1015change");
    const changedPhases: SceneEngineProgressPhase[] = [];
    const changedInput = manager.prepare(sourcePath, {
      signal: new AbortController().signal,
      onProgress: ({ phase }) => changedPhases.push(phase),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(sourcePath, "AC1015changed");
    await assert.rejects(changedInput, /CACHE_INPUT_CHANGED/u);
    assert.equal(changedPhases.at(-1), "failed");

    await writeFile(sourcePath, "AC1015slow");
    const controller = new AbortController();
    const cancelledPhases: SceneEngineProgressPhase[] = [];
    const cancelled = manager.prepare(sourcePath, {
      signal: controller.signal,
      onProgress: ({ phase }) => cancelledPhases.push(phase),
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(cancelled, (error) =>
      isSceneEngineAbort(error),
    );
    assert.equal(cancelledPhases.at(-1), "cancelled");
    assert.equal(
      (await readdir(cacheRoot)).some((name) => name.endsWith(".tmp")),
      false,
    );
  },
);
