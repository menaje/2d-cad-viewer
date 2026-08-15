#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  absolutePath,
  ADAPTER_PROTOCOL,
  appendBounded,
  boundedInteger,
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  mustNotExist,
  parseFlagPairs,
  reportFingerprint,
  sha256File,
  summarizeIntegers,
  verifyDwg,
  writeNewJson,
} from "./native-performance/core.mjs";

export { summarizeIntegers };

const REPORT_SCHEMA = "dwg-macos-native-performance/1";
const MODES = new Set(["full", "progressive"]);
const SOURCE_LOCATIONS = new Set(["local-disk", "mounted-network"]);
const MACOS_ARCHITECTURES = new Set(["x64", "arm64"]);

export function supportsTarget(platform, architecture) {
  return platform === "darwin" && MACOS_ARCHITECTURES.has(architecture);
}

export function parseArguments(values) {
  const raw = parseFlagPairs(values);
  if (!raw) {
    return undefined;
  }
  for (const flag of [
    "--adapter",
    "--fixture",
    "--work-root",
    "--report",
    "--source-location",
  ]) {
    if (!raw[flag]) {
      return undefined;
    }
  }
  const allowed = new Set([
    "--adapter",
    "--fixture",
    "--work-root",
    "--report",
    "--source-location",
    "--mode",
    "--runs",
    "--warmups",
    "--workers",
    "--max-median-wall-ms",
    "--max-median-preview-ms",
    "--max-peak-rss-bytes",
  ]);
  if (Object.keys(raw).some((flag) => !allowed.has(flag))) {
    return undefined;
  }
  const mode = raw["--mode"] ?? "full";
  const runs = boundedInteger(raw["--runs"] ?? "3", 1, 20);
  const warmups = boundedInteger(raw["--warmups"] ?? "1", 0, 3);
  const workers = raw["--workers"] === undefined
    ? undefined
    : boundedInteger(raw["--workers"], 1, 8);
  const maxMedianWallMs = raw["--max-median-wall-ms"] === undefined
    ? undefined
    : boundedInteger(
        raw["--max-median-wall-ms"],
        1,
        Number.MAX_SAFE_INTEGER,
      );
  const maxMedianPreviewMs =
    raw["--max-median-preview-ms"] === undefined
      ? undefined
      : boundedInteger(
          raw["--max-median-preview-ms"],
          1,
          Number.MAX_SAFE_INTEGER,
        );
  const maxPeakRssBytes = raw["--max-peak-rss-bytes"] === undefined
    ? undefined
    : boundedInteger(
        raw["--max-peak-rss-bytes"],
        1,
        Number.MAX_SAFE_INTEGER,
      );
  if (
    !MODES.has(mode) ||
    !SOURCE_LOCATIONS.has(raw["--source-location"]) ||
    runs === undefined ||
    warmups === undefined ||
    (raw["--workers"] !== undefined && workers === undefined) ||
    (raw["--max-median-wall-ms"] !== undefined &&
      maxMedianWallMs === undefined) ||
    (raw["--max-median-preview-ms"] !== undefined &&
      maxMedianPreviewMs === undefined) ||
    (raw["--max-peak-rss-bytes"] !== undefined &&
      maxPeakRssBytes === undefined) ||
    (maxMedianPreviewMs !== undefined && mode !== "progressive")
  ) {
    return undefined;
  }
  return {
    adapterPath: raw["--adapter"],
    fixturePath: raw["--fixture"],
    workRoot: raw["--work-root"],
    reportPath: raw["--report"],
    sourceLocation: raw["--source-location"],
    mode,
    runs,
    warmups,
    workers,
    maxMedianWallMs,
    maxMedianPreviewMs,
    maxPeakRssBytes,
  };
}

function requirePerformanceReport(report) {
  const performance = report?.performance;
  const stages = performance?.stages;
  const groups = stages?.section_groups;
  const values = [
    performance?.parse_ms,
    performance?.write_ms,
    performance?.total_ms,
    performance?.worker_count,
    performance?.parallel_sort_workers,
    performance?.parallel_section_workers,
    performance?.peak_rss_bytes,
    performance?.parse_peak_rss_bytes,
    stages?.reference_resolution_ms,
    stages?.table_ms,
    stages?.primitive_count_ms,
    stages?.gpu_count_ms,
    stages?.preview_ms,
    stages?.spatial_index_ms,
    stages?.spatial_collect_ms,
    stages?.spatial_sort_ms,
    stages?.spatial_run_write_ms,
    stages?.spatial_merge_ms,
    stages?.section_write_ms,
    stages?.finalize_ms,
    groups?.metadata_ms,
    groups?.entity_geometry_ms,
    groups?.curve_text_ms,
    groups?.gpu_cache_ms,
    groups?.hatch_ms,
    groups?.auxiliary_entity_ms,
    groups?.document_context_ms,
  ];
  if (
    report?.schema !== "dwg-scene-cache/1" ||
    report.status !== "ok" ||
    values.some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    performance.peak_rss_bytes === 0 ||
    performance.parse_peak_rss_bytes === 0
  ) {
    throw new Error("adapter omitted required macOS performance metrics");
  }
  return performance;
}

async function runAdapter({
  adapterPath,
  fixturePath,
  workRoot,
  sourceMetadata,
  mode,
  workers,
  fingerprint,
}) {
  const id = randomUUID();
  const outputPath = path.join(workRoot, `${id}.dwg.cache`);
  const previewPath = path.join(workRoot, `${id}.dwg.preview`);
  const markerPath = path.join(workRoot, `${id}.preview.ready`);
  const outputPaths = [outputPath, previewPath, markerPath];
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  const environment = {
    ...process.env,
    DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
    DWG_VIEWER_BENCHMARK_PHASE: "convert",
  };
  delete environment.DWG_VIEWER_PREVIEW_PATH;
  delete environment.DWG_VIEWER_PREVIEW_READY_PATH;
  if (workers === undefined) {
    delete environment.DWG_VIEWER_CONVERSION_WORKERS;
  } else {
    environment.DWG_VIEWER_CONVERSION_WORKERS = String(workers);
  }
  if (mode === "progressive") {
    environment.DWG_VIEWER_PREVIEW_PATH = previewPath;
    environment.DWG_VIEWER_PREVIEW_READY_PATH = markerPath;
  }

  let outputError;
  let previewReadyMs;
  const startedAt = performance.now();
  const child = spawn(
    adapterPath,
    ["convert", fixturePath, outputPath],
    {
      cwd: workRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const markerTimer = mode === "progressive"
    ? setInterval(() => {
        if (previewReadyMs === undefined && existsSync(markerPath)) {
          previewReadyMs = Math.round(performance.now() - startedAt);
        }
      }, 2)
    : undefined;
  markerTimer?.unref();
  const capture = (chunks, value, state, maximum, label) => {
    if (outputError) {
      return;
    }
    try {
      appendBounded(chunks, value, state, maximum, label);
    } catch (error) {
      outputError = error;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", (value) =>
    capture(
      stdout,
      value,
      stdoutState,
      MAX_STDOUT_BYTES,
      "adapter stdout",
    ),
  );
  child.stderr.on("data", (value) =>
    capture(
      stderr,
      value,
      stderrState,
      MAX_STDERR_BYTES,
      "adapter stderr",
    ),
  );

  try {
    const result = await new Promise((resolve) => {
      let spawnError;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, signal) =>
        resolve({ code, signal, spawnError }),
      );
    });
    const wallMs = Math.round(performance.now() - startedAt);
    if (markerTimer) {
      clearInterval(markerTimer);
    }
    if (previewReadyMs === undefined && existsSync(markerPath)) {
      previewReadyMs = wallMs;
    }
    if (outputError) {
      throw outputError;
    }
    if (result.spawnError) {
      throw result.spawnError;
    }
    if (result.code !== 0) {
      throw new Error(
        `adapter failed (${result.code ?? result.signal}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`,
      );
    }
    const currentSource = await stat(fixturePath, { bigint: true });
    if (
      !currentSource.isFile() ||
      currentSource.size !== sourceMetadata.size ||
      currentSource.mtimeNs !== sourceMetadata.mtimeNs
    ) {
      throw new Error("fixture changed during conversion");
    }
    const report = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    const adapterPerformance = requirePerformanceReport(report);
    const cacheMetadata = await stat(outputPath);
    const previewMetadata = mode === "progressive"
      ? await stat(previewPath)
      : undefined;
    if (
      mode === "progressive" &&
      (previewReadyMs === undefined ||
        !previewMetadata?.isFile() ||
        previewMetadata.size <= 0)
    ) {
      throw new Error("adapter omitted the progressive preview");
    }
    return {
      row: {
        wallMs,
        previewReadyMs,
        cacheBytes: cacheMetadata.size,
        previewBytes: previewMetadata?.size,
        performance: adapterPerformance,
      },
      cacheSha256: fingerprint
        ? await sha256File(outputPath)
        : undefined,
      previewSha256: fingerprint && previewMetadata
        ? await sha256File(previewPath)
        : undefined,
      reportFingerprint: fingerprint
        ? reportFingerprint(report)
        : undefined,
    };
  } finally {
    if (markerTimer) {
      clearInterval(markerTimer);
    }
    await Promise.all(
      outputPaths.map((filePath) => rm(filePath, { force: true })),
    );
  }
}

function summarizeRuns(rows, mode) {
  const metric = (select) =>
    summarizeIntegers(rows.map(select));
  const summary = {
    wallMs: metric((row) => row.wallMs),
    parseMs: metric((row) => row.performance.parse_ms),
    writeMs: metric((row) => row.performance.write_ms),
    totalMs: metric((row) => row.performance.total_ms),
    peakRssBytes: metric(
      (row) => row.performance.peak_rss_bytes,
    ),
    parsePeakRssBytes: metric(
      (row) => row.performance.parse_peak_rss_bytes,
    ),
    spatialIndexMs: metric(
      (row) => row.performance.stages.spatial_index_ms,
    ),
    sectionWriteMs: metric(
      (row) => row.performance.stages.section_write_ms,
    ),
    entityGeometryMs: metric(
      (row) =>
        row.performance.stages.section_groups.entity_geometry_ms,
    ),
    gpuCacheMs: metric(
      (row) => row.performance.stages.section_groups.gpu_cache_ms,
    ),
  };
  if (mode === "progressive") {
    summary.previewReadyMs = metric((row) => row.previewReadyMs);
    summary.previewWriteMs = metric(
      (row) => row.performance.stages.preview_ms,
    );
  }
  return summary;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    process.stderr.write(
      "usage: benchmark-macos-native.mjs " +
        "--adapter ABSOLUTE_FILE --fixture ABSOLUTE_DWG " +
        "--work-root NEW_ABSOLUTE_DIRECTORY " +
        "--report NEW_ABSOLUTE_JSON " +
        "--source-location local-disk|mounted-network " +
        "[--mode full|progressive] [--runs 3] [--warmups 1] " +
        "[--workers 1..8] [--max-median-wall-ms N] " +
        "[--max-median-preview-ms N] [--max-peak-rss-bytes N]\n",
    );
    process.exitCode = 2;
    return;
  }
  if (!supportsTarget(process.platform, process.arch)) {
    throw new Error(
      "macOS native performance qualification requires darwin-x64 or darwin-arm64",
    );
  }
  const adapterPath = absolutePath(options.adapterPath, "adapter");
  const fixturePath = absolutePath(options.fixturePath, "fixture");
  const workRoot = absolutePath(options.workRoot, "work root");
  const reportPath = absolutePath(options.reportPath, "report");
  if (path.dirname(reportPath) !== workRoot) {
    throw new Error("report must be directly inside the temporary work root");
  }
  await Promise.all([
    mustNotExist(workRoot, "work root"),
    mustNotExist(reportPath, "report"),
  ]);
  const adapterMetadata = await stat(adapterPath);
  if (!adapterMetadata.isFile()) {
    throw new Error("adapter is not a file");
  }
  const sourceMetadata = await verifyDwg(fixturePath);
  const availableMemoryBytesAtStart = os.freemem();
  let reportWritten = false;
  await mkdir(workRoot, { mode: 0o700 });
  try {
    const measured = [];
    const cacheDigests = new Set();
    const previewDigests = new Set();
    const reportFingerprints = new Set();
    const totalRuns = options.warmups + options.runs;
    for (let index = 0; index < totalRuns; index += 1) {
      const fingerprint = index >= options.warmups;
      const result = await runAdapter({
        adapterPath,
        fixturePath,
        workRoot,
        sourceMetadata,
        mode: options.mode,
        workers: options.workers,
        fingerprint,
      });
      if (fingerprint) {
        measured.push({
          run: index - options.warmups + 1,
          ...result.row,
        });
        cacheDigests.add(result.cacheSha256);
        reportFingerprints.add(result.reportFingerprint);
        if (options.mode === "progressive") {
          previewDigests.add(result.previewSha256);
        }
      }
    }
    if (
      cacheDigests.size !== 1 ||
      reportFingerprints.size !== 1 ||
      (options.mode === "progressive" && previewDigests.size !== 1)
    ) {
      throw new Error("measured conversions were not deterministic");
    }
    const summary = summarizeRuns(measured, options.mode);
    const limits = {};
    const violations = [];
    if (options.maxMedianWallMs !== undefined) {
      limits.maxMedianWallMs = options.maxMedianWallMs;
      if (summary.wallMs.median > options.maxMedianWallMs) {
        violations.push("median-wall-ms");
      }
    }
    if (options.maxMedianPreviewMs !== undefined) {
      limits.maxMedianPreviewMs = options.maxMedianPreviewMs;
      if (summary.previewReadyMs.median > options.maxMedianPreviewMs) {
        violations.push("median-preview-ms");
      }
    }
    if (options.maxPeakRssBytes !== undefined) {
      limits.maxPeakRssBytes = options.maxPeakRssBytes;
      if (summary.peakRssBytes.maximum > options.maxPeakRssBytes) {
        violations.push("peak-rss-bytes");
      }
    }
    const report = {
      schema: REPORT_SCHEMA,
      status: violations.length === 0 ? "pass" : "fail",
      target: { platform: process.platform, architecture: process.arch },
      system: {
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        availableMemoryBytesAtStart,
      },
      source: {
        locationKind: options.sourceLocation,
        pathDisclosure: "none",
      },
      sceneCacheCondition: "absent-per-run",
      sourcePageCache: options.warmups > 0
        ? "warm-after-process-warmup"
        : "uncontrolled",
      mode: options.mode,
      workers: options.workers ?? "automatic",
      warmups: options.warmups,
      runs: measured,
      summary,
      limits,
      violations,
      deterministic: true,
    };
    await writeNewJson(reportPath, report);
    reportWritten = true;
    process.stdout.write(
      `${JSON.stringify({ status: report.status, summary })}\n`,
    );
    if (report.status !== "pass") {
      process.exitCode = 1;
    }
  } finally {
    if (!reportWritten) {
      await rm(reportPath, { force: true });
      await rmdir(workRoot).catch(() => undefined);
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `macOS native performance qualification failed: ${error.stack ?? error.message}\n`,
    );
    process.exitCode = 1;
  });
}
