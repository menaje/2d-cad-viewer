#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  diagnoseLibreDwgAdapter,
  LibreDwgNativeSceneEngine,
} = require("../apps/vscode-extension/dist/src/native-cache.js");
const {
  SceneCacheManager,
} = require("../apps/vscode-extension/dist/src/scene-cache-manager.js");
const {
  isSceneEngineAbort,
} = require("../apps/vscode-extension/dist/src/scene-engine.js");

const REPORT_SCHEMA = "dwg-windows-native-qualification/1";

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      !value ||
      ![
        "--adapter",
        "--fixture",
        "--large-fixture",
        "--work-root",
        "--unc-root",
        "--report",
      ].includes(flag)
    ) {
      return undefined;
    }
    result[flag] = value;
  }
  if (
    !result["--adapter"] ||
    !result["--fixture"] ||
    !result["--large-fixture"] ||
    !result["--work-root"] ||
    !result["--unc-root"] ||
    !result["--report"]
  ) {
    return undefined;
  }
  return result;
}

function absoluteArgument(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.resolve(value);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function writeNewJson(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function assertCleanCacheRoot(cacheRoot) {
  const names = await readdir(cacheRoot);
  assert.equal(
    names.some(
      (name) =>
        name.endsWith(".tmp") ||
        name.endsWith(".preview") ||
        name.endsWith(".ready"),
    ),
    false,
  );
}

async function qualifySource({
  adapterPath,
  cacheRoot,
  label,
  sourcePath,
}) {
  await mkdir(cacheRoot, { recursive: true });
  const manager = new SceneCacheManager(
    cacheRoot,
    new LibreDwgNativeSceneEngine(adapterPath, {
      platform: "win32",
    }),
  );
  const phases = [];
  let prepared;
  try {
    prepared = await manager.prepare(sourcePath, {
      signal: new AbortController().signal,
      onProgress(event) {
        phases.push(event.phase);
      },
    });
    const [metadata, cache] = await Promise.all([
      stat(prepared.cachePath),
      readFile(prepared.cachePath),
    ]);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.size, prepared.size);
    assert.ok(metadata.size >= 64);
    assert.deepEqual(phases, [
      "checking",
      "parsing",
      "validating",
      "cache-ready",
    ]);
    return {
      label,
      status: "pass",
      cacheBytes: metadata.size,
      cacheSha256: sha256(cache),
      phases,
    };
  } finally {
    await prepared?.release();
    await manager.dispose();
    await assertCleanCacheRoot(cacheRoot);
  }
}

async function qualifyCancellation({
  adapterPath,
  cacheRoot,
  sourcePath,
}) {
  await mkdir(cacheRoot, { recursive: true });
  const manager = new SceneCacheManager(
    cacheRoot,
    new LibreDwgNativeSceneEngine(adapterPath, {
      platform: "win32",
    }),
  );
  const controller = new AbortController();
  let abortScheduled = false;
  try {
    await assert.rejects(
      manager.prepare(sourcePath, {
        signal: controller.signal,
        onProgress({ phase }) {
          if (phase === "parsing" && !abortScheduled) {
            abortScheduled = true;
            setTimeout(() => controller.abort(), 0).unref();
          }
        },
      }),
      (error) => isSceneEngineAbort(error),
    );
    assert.equal(abortScheduled, true);
  } finally {
    await manager.dispose();
  }
  await assertCleanCacheRoot(cacheRoot);
  return {
    label: "cancel-cleanup",
    status: "pass",
    temporaryArtifacts: 0,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    process.stderr.write(
      "usage: qualify-windows-native.mjs " +
        "--adapter ABSOLUTE_EXE --fixture ABSOLUTE_DWG " +
        "--large-fixture ABSOLUTE_DWG --work-root NEW_ABSOLUTE_DIRECTORY " +
        "--unc-root ABSOLUTE_UNC_DIRECTORY --report NEW_ABSOLUTE_JSON\n",
    );
    process.exitCode = 2;
    return;
  }

  const adapterPath = absoluteArgument(args["--adapter"], "adapter");
  const fixturePath = absoluteArgument(args["--fixture"], "fixture");
  const largeFixturePath = absoluteArgument(
    args["--large-fixture"],
    "large fixture",
  );
  const workRoot = absoluteArgument(args["--work-root"], "work root");
  const uncRoot = absoluteArgument(args["--unc-root"], "UNC root");
  const reportPath = absoluteArgument(args["--report"], "report");
  await mkdir(workRoot);

  const doctor = await diagnoseLibreDwgAdapter(adapterPath);
  assert.deepEqual(doctor, {
    engineVersion: "0.14",
    linkage: "static",
    platform: "win32",
    architecture: "x64",
  });

  const unicodeRoot = path.join(
    workRoot,
    "한글-NFC-가",
    "한글-NFD-가",
  );
  await mkdir(unicodeRoot, { recursive: true });
  const driveFixture = path.join(unicodeRoot, "A2-013-검증.dwg");
  const cancellationFixture = path.join(
    unicodeRoot,
    "대형-취소-검증.dwg",
  );
  await Promise.all([
    copyFile(fixturePath, driveFixture),
    copyFile(largeFixturePath, cancellationFixture),
  ]);

  const results = [];
  results.push(
    await qualifySource({
      adapterPath,
      cacheRoot: path.join(workRoot, "cache-drive"),
      label: "drive-unicode-nfc-nfd",
      sourcePath: driveFixture,
    }),
  );

  const previousDirectory = process.cwd();
  try {
    process.chdir(unicodeRoot);
    results.push(
      await qualifySource({
        adapterPath,
        cacheRoot: path.join(workRoot, "cache-relative"),
        label: "relative-unicode",
        sourcePath: path.basename(driveFixture),
      }),
    );
  } finally {
    process.chdir(previousDirectory);
  }

  const caseVariant = path.join(
    path.dirname(driveFixture),
    path.basename(driveFixture).toLocaleLowerCase("en-US"),
  );
  results.push(
    await qualifySource({
      adapterPath,
      cacheRoot: path.join(workRoot, "cache-case"),
      label: "case-insensitive-drive",
      sourcePath: caseVariant,
    }),
  );

  const uncUnicodeRoot = path.join(
    uncRoot,
    "한글-NFC-가",
    "한글-NFD-가",
  );
  await mkdir(uncUnicodeRoot, { recursive: true });
  const uncFixture = path.join(uncUnicodeRoot, "공유-도면.dwg");
  await copyFile(fixturePath, uncFixture);
  results.push(
    await qualifySource({
      adapterPath,
      cacheRoot: path.join(workRoot, "cache-unc"),
      label: "unc-unicode-nfc-nfd",
      sourcePath: uncFixture,
    }),
  );

  results.push(
    await qualifyCancellation({
      adapterPath,
      cacheRoot: path.join(workRoot, "cache-cancel"),
      sourcePath: cancellationFixture,
    }),
  );

  const referenceDigests = new Set(
    results
      .map((result) => result.cacheSha256)
      .filter((value) => typeof value === "string"),
  );
  assert.equal(referenceDigests.size, 1);

  const report = {
    schema: REPORT_SCHEMA,
    status: "pass",
    target: {
      platform: doctor.platform,
      architecture: doctor.architecture,
      engineVersion: doctor.engineVersion,
      linkage: doctor.linkage,
    },
    pathDisclosure: "none",
    cases: results,
    deterministicAcrossPaths: true,
  };
  await writeNewJson(reportPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `Windows native qualification failed: ${error.stack ?? error.message}\n`,
  );
  process.exitCode = 1;
});
