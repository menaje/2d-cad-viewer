import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ENGINE_ASSET_CATALOG_SCHEMA,
  ManagedEngineManager,
  parseManagedEngineCatalog,
  resolveManagedEngineTarget,
} from "../src/managed-engine";

const viewerVersion = "0.1.4";
const target = "darwin-arm64";
const engineBytes = Buffer.from("verified native converter bytes");
const sourceBytes = Buffer.from("source-complete archive bytes");
const sha256 = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function catalog(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schema: ENGINE_ASSET_CATALOG_SCHEMA,
    viewerVersion,
    repository: "menaje/dwg-viewer",
    releaseTag: `v${viewerVersion}`,
    engine: {
      id: "libredwg",
      version: "0.14",
      protocol: "dwg-engine-adapter/1",
      cacheSchema: "dwg-scene-cache/1.26",
      license: "GPL-3.0-or-later",
    },
    targets: {
      [target]: {
        asset: `dwg-viewer-native-converter-${viewerVersion}-${target}`,
        sha256: sha256(engineBytes),
        size: engineBytes.byteLength,
        sourceAsset: `dwg-viewer-libredwg-0.14-${target}.tar.gz`,
        sourceSha256: sha256(sourceBytes),
        sourceSize: sourceBytes.byteLength,
      },
    },
    ...overrides,
  }, null, 2)}\n`;
}

test("accepts only a release-bound engine catalog", () => {
  const parsed = parseManagedEngineCatalog(
    catalog(),
    viewerVersion,
    target,
  );
  assert.equal(parsed.releaseTag, "v0.1.4");
  assert.equal(parsed.target.sha256, sha256(engineBytes));
  assert.throws(
    () =>
      parseManagedEngineCatalog(
        catalog({ viewerVersion: "0.1.5" }),
        viewerVersion,
        target,
      ),
    /ENGINE_CATALOG_INVALID/u,
  );
  assert.throws(
    () =>
      parseManagedEngineCatalog(
        catalog({ repository: "outside/fork" }),
        viewerVersion,
        target,
      ),
    /ENGINE_CATALOG_INVALID/u,
  );
});

test("maps only supported native targets", () => {
  assert.equal(resolveManagedEngineTarget("darwin", "arm64"), target);
  assert.equal(
    resolveManagedEngineTarget("darwin", "x64"),
    "darwin-x64",
  );
  assert.throws(
    () => resolveManagedEngineTarget("linux", "arm64"),
    /ENGINE_PLATFORM_UNSUPPORTED/u,
  );
});

test("downloads, validates, installs, and reuses the exact engine", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-managed-engine-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "engine-assets.json");
  await writeFile(catalogPath, catalog());
  let downloads = 0;
  let diagnoses = 0;
  const manager = new ManagedEngineManager({
    storageRoot: path.join(root, "engines"),
    catalogPath,
    viewerVersion,
    platform: "darwin",
    architecture: "arm64",
    fetcher: async (url) => {
      downloads += 1;
      assert.equal(
        url,
        `https://github.com/menaje/dwg-viewer/releases/download/v0.1.4/dwg-viewer-native-converter-${viewerVersion}-${target}`,
      );
      return {
        ok: true,
        status: 200,
        url,
        headers: {
          get(name: string): string | null {
            return name.toLocaleLowerCase("en-US") === "content-length"
              ? String(engineBytes.byteLength)
              : null;
          },
        },
        async arrayBuffer(): Promise<ArrayBuffer> {
          return engineBytes.buffer.slice(
            engineBytes.byteOffset,
            engineBytes.byteOffset + engineBytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    },
    diagnose: async (adapterPath) => {
      diagnoses += 1;
      assert.deepEqual(await readFile(adapterPath), engineBytes);
      return {
        engineVersion: "0.14",
        linkage: "static",
        platform: "darwin",
        architecture: "arm64",
      };
    },
  });

  const first = await manager.ensure();
  const second = await manager.ensure();
  assert.equal(first.adapterPath, second.adapterPath);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(await readFile(first.adapterPath), engineBytes);
  assert.equal(downloads, 1);
  assert.equal(diagnoses >= 2, true);
  assert.match(first.sourceUrl, /dwg-viewer-libredwg-0\.14-darwin-arm64/u);

  await writeFile(first.adapterPath, Buffer.from("corrupt"));
  const repaired = await manager.ensure();
  assert.equal(repaired.reused, false);
  assert.deepEqual(await readFile(repaired.adapterPath), engineBytes);
  assert.equal(downloads, 2);
});

test("rejects a download whose digest differs from the catalog", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-managed-engine-bad-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "engine-assets.json");
  await writeFile(catalogPath, catalog());
  const tampered = Buffer.from(engineBytes);
  tampered[0] ^= 0xff;
  const manager = new ManagedEngineManager({
    storageRoot: path.join(root, "engines"),
    catalogPath,
    viewerVersion,
    platform: "darwin",
    architecture: "arm64",
    fetcher: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => String(tampered.byteLength) },
      arrayBuffer: async () =>
        tampered.buffer.slice(
          tampered.byteOffset,
          tampered.byteOffset + tampered.byteLength,
        ) as ArrayBuffer,
    }),
    diagnose: async () => {
      throw new Error("tampered engine must not run");
    },
  });
  await assert.rejects(manager.ensure(), /ENGINE_DOWNLOAD_REJECTED/u);
});
