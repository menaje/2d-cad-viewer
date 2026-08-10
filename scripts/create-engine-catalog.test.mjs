// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEngineCatalog,
  ENGINE_ASSET_CATALOG_SCHEMA,
  ENGINE_TARGETS,
} from "./create-engine-catalog.mjs";

test("creates a deterministic catalog for every release target", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-engine-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const version = "0.1.4";
  for (const target of ENGINE_TARGETS) {
    await writeFile(
      path.join(
        root,
        `dwg-viewer-native-converter-${version}-${target}${
          target === "win32-x64" ? ".exe" : ""
        }`,
      ),
      `engine:${target}`,
    );
    await writeFile(
      path.join(root, `dwg-viewer-libredwg-0.14-${target}.tar.gz`),
      `source:${target}`,
    );
  }

  const catalog = await createEngineCatalog({ directory: root, version });
  assert.equal(catalog.schema, ENGINE_ASSET_CATALOG_SCHEMA);
  assert.equal(catalog.viewerVersion, version);
  assert.deepEqual(Object.keys(catalog.targets), ENGINE_TARGETS);
  for (const target of ENGINE_TARGETS) {
    const expected = createHash("sha256")
      .update(`engine:${target}`)
      .digest("hex");
    assert.equal(catalog.targets[target].sha256, expected);
    assert.match(
      catalog.targets[target].sourceAsset,
      new RegExp(`0\\.14-${target}\\.tar\\.gz$`, "u"),
    );
  }
});
