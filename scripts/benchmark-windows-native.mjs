#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
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
  writeNewJson,
} from "./native-performance/core.mjs";

export { summarizeIntegers };

const REPORT_SCHEMA = "dwg-windows-native-performance/1";
const LOCATION_KINDS = new Set([
  "local-disk",
  "mapped-network-drive",
  "unc",
]);

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
    "--location-kind",
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
    "--location-kind",
    "--runs",
    "--warmups",
    "--workers",
    "--max-median-wall-ms",
    "--max-peak-private-bytes",
  ]);
  if (Object.keys(raw).some((flag) => !allowed.has(flag))) {
    return undefined;
  }
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
  const maxPeakPrivateBytes =
    raw["--max-peak-private-bytes"] === undefined
      ? undefined
      : boundedInteger(
          raw["--max-peak-private-bytes"],
          1,
          Number.MAX_SAFE_INTEGER,
        );
  if (
    runs === undefined ||
    warmups === undefined ||
    (raw["--workers"] !== undefined && workers === undefined) ||
    (raw["--max-median-wall-ms"] !== undefined &&
      maxMedianWallMs === undefined) ||
    (raw["--max-peak-private-bytes"] !== undefined &&
      maxPeakPrivateBytes === undefined) ||
    !LOCATION_KINDS.has(raw["--location-kind"])
  ) {
    return undefined;
  }
  return {
    adapterPath: raw["--adapter"],
    fixturePath: raw["--fixture"],
    workRoot: raw["--work-root"],
    reportPath: raw["--report"],
    locationKind: raw["--location-kind"],
    runs,
    warmups,
    workers,
    maxMedianWallMs,
    maxPeakPrivateBytes,
  };
}

async function openInput(inputPath) {
  const handle = await open(inputPath, "r");
  try {
    const metadata = await handle.stat({ bigint: true });
    const bytes = Buffer.alloc(6);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const version = bytes.toString("ascii");
    if (
      !metadata.isFile() ||
      metadata.size < 6n ||
      bytesRead !== bytes.length ||
      !/^AC\d{4}$/u.test(version)
    ) {
      throw new Error("fixture is not a readable DWG file");
    }
    return {
      handle,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      version,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function runAdapter({
  adapterPath,
  inputPath,
  outputPath,
  workers,
}) {
  const inheritedInput = await openInput(inputPath);
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  const environment = {
    ...process.env,
    DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
    DWG_VIEWER_BENCHMARK_PHASE: "convert",
    DWG_VIEWER_INPUT_TRANSPORT: "inherited-file-handle",
    DWG_VIEWER_STDIN_SOURCE_SIZE: inheritedInput.size.toString(),
    DWG_VIEWER_STDIN_SOURCE_VERSION: inheritedInput.version,
  };
  if (workers === undefined) {
    delete environment.DWG_VIEWER_CONVERSION_WORKERS;
  } else {
    environment.DWG_VIEWER_CONVERSION_WORKERS = String(workers);
  }
  const startedAt = performance.now();
  let child;
  try {
    child = spawn(adapterPath, ["convert", "-", path.basename(outputPath)], {
      cwd: path.dirname(outputPath),
      env: environment,
      stdio: [inheritedInput.handle.fd, "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    await inheritedInput.handle.close().catch(() => undefined);
    throw error;
  }
  try {
    await inheritedInput.handle.close();
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  child.stdout.on("data", (value) =>
    appendBounded(
      stdout,
      value,
      stdoutState,
      MAX_STDOUT_BYTES,
      "adapter stdout",
    ),
  );
  child.stderr.on("data", (value) =>
    appendBounded(
      stderr,
      value,
      stderrState,
      MAX_STDERR_BYTES,
      "adapter stderr",
    ),
  );
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const wallMs = Math.round(performance.now() - startedAt);
  if (result.code !== 0) {
    throw new Error(
      `adapter failed (${result.code ?? result.signal}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`,
    );
  }
  const currentInput = await stat(inputPath, { bigint: true });
  if (
    !currentInput.isFile() ||
    currentInput.size !== inheritedInput.size ||
    currentInput.mtimeNs !== inheritedInput.mtimeNs
  ) {
    throw new Error("fixture changed during conversion");
  }
  const report = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  if (
    report?.schema !== "dwg-scene-cache/1" ||
    report.status !== "ok" ||
    !Number.isSafeInteger(report.performance?.peak_rss_bytes) ||
    !Number.isSafeInteger(report.performance?.peak_private_bytes) ||
    !Number.isSafeInteger(report.performance?.working_set_bytes) ||
    !Number.isSafeInteger(report.performance?.private_bytes) ||
    !Number.isSafeInteger(report.performance?.parse_peak_rss_bytes) ||
    !Number.isSafeInteger(report.performance?.parse_peak_private_bytes) ||
    !Number.isSafeInteger(report.performance?.parse_working_set_bytes) ||
    !Number.isSafeInteger(report.performance?.parse_private_bytes) ||
    !Number.isSafeInteger(report.performance?.io_read_operations) ||
    !Number.isSafeInteger(report.performance?.io_write_operations) ||
    !Number.isSafeInteger(report.performance?.io_read_bytes) ||
    !Number.isSafeInteger(report.performance?.io_write_bytes)
  ) {
    throw new Error("adapter omitted required Windows performance metrics");
  }
  const outputMetadata = await stat(outputPath);
  const cacheSha256 = await sha256File(outputPath);
  return {
    wallMs,
    cacheBytes: outputMetadata.size,
    cacheSha256,
    reportFingerprint: reportFingerprint(report),
    performance: report.performance,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    process.stderr.write(
      "usage: benchmark-windows-native.mjs " +
        "--adapter ABSOLUTE_EXE --fixture ABSOLUTE_DWG " +
        "--work-root NEW_ABSOLUTE_DIRECTORY --report NEW_ABSOLUTE_JSON " +
        "--location-kind local-disk|mapped-network-drive|unc " +
        "[--runs 3] [--warmups 1] [--workers 1..8] " +
        "[--max-median-wall-ms N] [--max-peak-private-bytes N]\n",
    );
    process.exitCode = 2;
    return;
  }
  if (process.platform !== "win32") {
    throw new Error("Windows native performance qualification requires win32");
  }
  const adapterPath = absolutePath(options.adapterPath, "adapter");
  const fixturePath = absolutePath(options.fixturePath, "fixture");
  const workRoot = absolutePath(options.workRoot, "work root");
  const reportPath = absolutePath(options.reportPath, "report");
  const reportRelative = path.relative(workRoot, reportPath);
  if (
    reportRelative === "" ||
    reportRelative === ".." ||
    reportRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(reportRelative)
  ) {
    throw new Error("report must be inside the temporary work root");
  }
  await Promise.all([
    mustNotExist(workRoot, "work root"),
    mustNotExist(reportPath, "report"),
  ]);
  for (const [filePath, label] of [
    [adapterPath, "adapter"],
    [fixturePath, "fixture"],
  ]) {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      throw new Error(`${label} is not a file`);
    }
  }
  const sourceMetadata = await stat(fixturePath, { bigint: true });
  if (sourceMetadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("fixture size exceeds the report's exact integer range");
  }
  const availableMemoryBytesAtStart = os.freemem();
  await mkdir(workRoot);
  const outputs = new Set();
  const measured = [];
  try {
    const totalRuns = options.warmups + options.runs;
    for (let index = 0; index < totalRuns; index += 1) {
      const outputPath = path.join(
        workRoot,
        `cache-${randomUUID()}.dwgsc`,
      );
      outputs.add(outputPath);
      const row = await runAdapter({
        adapterPath,
        inputPath: fixturePath,
        outputPath,
        workers: options.workers,
      });
      await rm(outputPath, { force: true });
      outputs.delete(outputPath);
      if (index >= options.warmups) {
        measured.push({ run: index - options.warmups + 1, ...row });
      }
    }
    const cacheDigests = new Set(measured.map((row) => row.cacheSha256));
    const reportFingerprints = new Set(
      measured.map((row) => row.reportFingerprint),
    );
    if (cacheDigests.size !== 1 || reportFingerprints.size !== 1) {
      throw new Error("measured conversions were not deterministic");
    }
    const summary = {
      wallMs: summarizeIntegers(measured.map((row) => row.wallMs)),
      adapterTotalMs: summarizeIntegers(
        measured.map((row) => row.performance.total_ms),
      ),
      adapterWriteMs: summarizeIntegers(
        measured.map((row) => row.performance.write_ms),
      ),
      peakRssBytes: summarizeIntegers(
        measured.map((row) => row.performance.peak_rss_bytes),
      ),
      peakPrivateBytes: summarizeIntegers(
        measured.map((row) => row.performance.peak_private_bytes),
      ),
      workingSetBytes: summarizeIntegers(
        measured.map((row) => row.performance.working_set_bytes),
      ),
      privateBytes: summarizeIntegers(
        measured.map((row) => row.performance.private_bytes),
      ),
      parsePeakRssBytes: summarizeIntegers(
        measured.map((row) => row.performance.parse_peak_rss_bytes),
      ),
      parsePeakPrivateBytes: summarizeIntegers(
        measured.map((row) => row.performance.parse_peak_private_bytes),
      ),
      parseWorkingSetBytes: summarizeIntegers(
        measured.map((row) => row.performance.parse_working_set_bytes),
      ),
      parsePrivateBytes: summarizeIntegers(
        measured.map((row) => row.performance.parse_private_bytes),
      ),
      ioReadOperations: summarizeIntegers(
        measured.map((row) => row.performance.io_read_operations),
      ),
      ioWriteOperations: summarizeIntegers(
        measured.map((row) => row.performance.io_write_operations),
      ),
      ioReadBytes: summarizeIntegers(
        measured.map((row) => row.performance.io_read_bytes),
      ),
      ioWriteBytes: summarizeIntegers(
        measured.map((row) => row.performance.io_write_bytes),
      ),
    };
    const limits = {};
    const violations = [];
    if (options.maxMedianWallMs !== undefined) {
      limits.maxMedianWallMs = options.maxMedianWallMs;
      if (summary.wallMs.median > options.maxMedianWallMs) {
        violations.push("median-wall-ms");
      }
    }
    if (options.maxPeakPrivateBytes !== undefined) {
      limits.maxPeakPrivateBytes = options.maxPeakPrivateBytes;
      if (summary.peakPrivateBytes.maximum > options.maxPeakPrivateBytes) {
        violations.push("peak-private-bytes");
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
        sizeBytes: Number(sourceMetadata.size),
        locationKind: options.locationKind,
        pathDisclosure: "none",
      },
      inputTransport: "inherited-file-handle",
      cacheCondition: options.warmups > 0
        ? "warm-after-process-warmup"
        : "uncontrolled",
      workers: options.workers ?? "automatic",
      warmups: options.warmups,
      runs: measured,
      summary,
      limits,
      violations,
      deterministic: true,
    };
    await writeNewJson(reportPath, report);
    outputs.add(reportPath);
    process.stdout.write(
      `${JSON.stringify({ status: report.status, summary: report.summary })}\n`,
    );
    if (report.status !== "pass") {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(
      [...outputs]
        .filter((filePath) => filePath !== reportPath)
        .map((filePath) => rm(filePath, { force: true })),
    );
    if (!outputs.has(reportPath)) {
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
      `Windows native performance qualification failed: ${error.stack ?? error.message}\n`,
    );
    process.exitCode = 1;
  });
}
