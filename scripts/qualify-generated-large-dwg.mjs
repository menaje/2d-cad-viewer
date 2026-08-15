#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  generateLargeLineDxf,
  REPORT_SCHEMA as GENERATOR_SCHEMA,
} from "../tests/fixtures/generate-large-line-dxf.mjs";
import {
  absolutePath,
  ADAPTER_PROTOCOL,
  boundedInteger,
  mustNotExist,
  parseFlagPairs,
  reportFingerprint,
  sha256File,
  verifyDwg,
  writeNewJson,
} from "./native-performance/core.mjs";

export const REPORT_SCHEMA = "dwg-generated-large-dwg-qualification/1";
const DEFAULT_ENTITY_COUNT = 100_000;
const DEFAULT_MINIMUM_DWG_BYTES = 5_000_000;
const MAX_ENTITY_COUNT = 1_000_000;
const MAX_CHILD_OUTPUT_BYTES = 2 * 1024 * 1024;
const FIXTURE_WRITER_TIMEOUT_MS = 30 * 60 * 1_000;
const ADAPTER_TIMEOUT_MS = 10 * 60 * 1_000;
const execFileAsync = promisify(execFile);

export function parseArguments(values) {
  const raw = parseFlagPairs(values);
  if (!raw) {
    return undefined;
  }
  const required = ["--adapter", "--dxf2dwg", "--work-root", "--report"];
  const allowed = new Set([
    ...required,
    "--entities",
    "--minimum-dwg-bytes",
  ]);
  if (
    required.some((flag) => !raw[flag]) ||
    Object.keys(raw).some((flag) => !allowed.has(flag))
  ) {
    return undefined;
  }
  const entityCount = boundedInteger(
    raw["--entities"] ?? String(DEFAULT_ENTITY_COUNT),
    1,
    MAX_ENTITY_COUNT,
  );
  const minimumDwgBytes = boundedInteger(
    raw["--minimum-dwg-bytes"] ?? String(DEFAULT_MINIMUM_DWG_BYTES),
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (entityCount === undefined || minimumDwgBytes === undefined) {
    return undefined;
  }
  return {
    adapterPath: raw["--adapter"],
    dxf2dwgPath: raw["--dxf2dwg"],
    workRoot: raw["--work-root"],
    reportPath: raw["--report"],
    entityCount,
    minimumDwgBytes,
  };
}

function sectionRecords(report, kind) {
  const section = report.cache?.sections?.find(
    (candidate) => candidate.kind === kind,
  );
  return section?.records;
}

export function validateAdapterReport(report, entityCount) {
  assert.equal(report?.schema, "dwg-scene-cache/1");
  assert.equal(report?.status, "ok");
  assert.equal(report?.cache?.validated, true);
  assert.equal(report?.coverage?.total_entities, entityCount);
  assert.equal(report?.coverage?.serialized_entities, entityCount);
  assert.equal(report?.coverage?.deferred_entities, 0);
  assert.equal(report?.coverage?.lines, entityCount);
  assert.equal(sectionRecords(report, "lines"), entityCount);
  assert.equal(report?.diagnostics, 0);
  return report;
}

function performanceEvidence(report) {
  const source = report.performance ?? {};
  const evidence = {};
  for (const name of [
    "parse_ms",
    "write_ms",
    "total_ms",
    "peak_rss_bytes",
    "parse_peak_rss_bytes",
    "peak_private_bytes",
    "parse_peak_private_bytes",
  ]) {
    if (Number.isSafeInteger(source[name]) && source[name] >= 0) {
      evidence[name] = source[name];
    }
  }
  return Object.freeze(evidence);
}

export function buildQualificationReport({
  generator,
  dwgBytes,
  dwgSha256,
  minimumDwgBytes,
  adapterReports,
  cacheBytes,
  cacheSha256,
  platform = process.platform,
  architecture = process.arch,
}) {
  assert.equal(generator?.schema, GENERATOR_SCHEMA);
  assert.ok(Number.isSafeInteger(dwgBytes) && dwgBytes >= minimumDwgBytes);
  assert.match(dwgSha256, /^[a-f0-9]{64}$/u);
  assert.equal(adapterReports.length, 2);
  assert.equal(cacheBytes.length, 2);
  assert.equal(cacheSha256.length, 2);
  for (const report of adapterReports) {
    validateAdapterReport(report, generator.entityCount);
  }
  assert.equal(cacheBytes[0], cacheBytes[1]);
  assert.equal(cacheSha256[0], cacheSha256[1]);
  const logicalFingerprints = adapterReports.map(reportFingerprint);
  assert.equal(logicalFingerprints[0], logicalFingerprints[1]);

  const deterministic = Object.freeze({
    generatorSha256: generator.sha256,
    dwgSha256,
    cacheSha256: cacheSha256[0],
    logicalReportSha256: logicalFingerprints[0],
    entityCount: generator.entityCount,
    deferredEntities: 0,
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(deterministic))
    .digest("hex");
  return Object.freeze({
    schema: REPORT_SCHEMA,
    status: "pass",
    target: Object.freeze({ platform, architecture }),
    fixturePolicy: Object.freeze({
      source: "repository-generated",
      license: generator.license,
      privateInput: false,
      committedBinary: false,
      fixtureWriterShipped: false,
    }),
    source: Object.freeze({
      format: generator.format,
      entityType: generator.entityType,
      entityCount: generator.entityCount,
      bytes: generator.bytes,
      sha256: generator.sha256,
    }),
    dwg: Object.freeze({
      format: "R2000",
      bytes: dwgBytes,
      sha256: dwgSha256,
      minimumBytes: minimumDwgBytes,
    }),
    sceneCache: Object.freeze({
      runs: 2,
      bytes: cacheBytes[0],
      sha256: cacheSha256[0],
      logicalReportSha256: logicalFingerprints[0],
      coverage: Object.freeze({
        totalEntities: generator.entityCount,
        serializedEntities: generator.entityCount,
        deferredEntities: 0,
        lines: generator.entityCount,
      }),
    }),
    performance: Object.freeze(
      adapterReports.map(performanceEvidence),
    ),
    fingerprint,
  });
}

async function executable(filePath, label) {
  const resolved = absolutePath(filePath, label);
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  await access(resolved, constants.X_OK);
  return resolved;
}

async function runFixtureWriter(dxf2dwgPath, dxfPath, dwgPath, workRoot) {
  try {
    await execFileAsync(
      dxf2dwgPath,
      ["-y", "-o", dwgPath, dxfPath],
      {
        cwd: workRoot,
        encoding: "utf8",
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        timeout: FIXTURE_WRITER_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error("fixture-only LibreDWG writer failed", { cause: error });
  }
}

async function runAdapter(adapterPath, dwgPath, cachePath, workRoot) {
  let result;
  try {
    result = await execFileAsync(
      adapterPath,
      ["convert", dwgPath, cachePath],
      {
        cwd: workRoot,
        env: {
          ...process.env,
          DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
          DWG_VIEWER_BENCHMARK_PHASE: "convert",
        },
        encoding: "utf8",
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        timeout: ADAPTER_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error("adapter rejected the generated large DWG", {
      cause: error,
    });
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error("adapter returned an invalid qualification report", {
      cause: error,
    });
  }
}

export async function qualifyGeneratedLargeDwg(options) {
  const adapterPath = await executable(options.adapterPath, "adapter");
  const dxf2dwgPath = await executable(options.dxf2dwgPath, "dxf2dwg");
  const workRoot = absolutePath(options.workRoot, "work root");
  const reportPath = absolutePath(options.reportPath, "report");
  await Promise.all([
    mustNotExist(workRoot, "work root"),
    mustNotExist(reportPath, "report"),
  ]);
  await mkdir(workRoot, { mode: 0o700 });

  const dxfPath = path.join(workRoot, "generated-large.dxf");
  const dwgPath = path.join(workRoot, "generated-large.dwg");
  const cachePaths = [
    path.join(workRoot, "generated-large-1.cache"),
    path.join(workRoot, "generated-large-2.cache"),
  ];
  const generator = await generateLargeLineDxf({
    outputPath: dxfPath,
    entityCount: options.entityCount,
  });
  await runFixtureWriter(dxf2dwgPath, dxfPath, dwgPath, workRoot);
  const dwgMetadata = await verifyDwg(dwgPath);
  const dwgBytes = Number(dwgMetadata.size);
  if (dwgBytes < options.minimumDwgBytes) {
    throw new Error("generated DWG did not reach the required large-input size");
  }

  const adapterReports = [];
  for (const cachePath of cachePaths) {
    const report = await runAdapter(
      adapterPath,
      dwgPath,
      cachePath,
      workRoot,
    );
    validateAdapterReport(report, options.entityCount);
    adapterReports.push(report);
  }
  const [dwgSha256, cacheMetadata, cacheSha256] = await Promise.all([
    sha256File(dwgPath),
    Promise.all(cachePaths.map((cachePath) => stat(cachePath))),
    Promise.all(cachePaths.map(sha256File)),
  ]);
  const report = await buildQualificationReport({
    generator,
    dwgBytes,
    dwgSha256,
    minimumDwgBytes: options.minimumDwgBytes,
    adapterReports,
    cacheBytes: cacheMetadata.map((metadata) => metadata.size),
    cacheSha256,
  });
  await writeNewJson(reportPath, report);
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(
      "usage: qualify-generated-large-dwg.mjs --adapter ABSOLUTE_FILE " +
        "--dxf2dwg ABSOLUTE_FILE --work-root NEW_ABSOLUTE_DIRECTORY " +
        "--report NEW_ABSOLUTE_JSON [--entities 1..1000000] " +
        "[--minimum-dwg-bytes POSITIVE_INTEGER]",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const report = await qualifyGeneratedLargeDwg(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
