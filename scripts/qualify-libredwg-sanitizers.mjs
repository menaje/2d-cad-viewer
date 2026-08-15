#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
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
  verifyDwg,
  writeNewJson,
} from "./native-performance/core.mjs";

export const REPORT_SCHEMA = "dwg-libredwg-sanitizer-qualification/1";
const DEFAULT_MUTATIONS = 24;
const MIN_MUTATIONS = 8;
const MAX_MUTATIONS = 64;
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;
const CASE_TIMEOUT_MS = 30_000;
const SANITIZER_DIAGNOSTIC =
  /AddressSanitizer|UndefinedBehaviorSanitizer|LeakSanitizer|runtime error:|SUMMARY: .*Sanitizer/iu;

export function parseArguments(values) {
  const raw = parseFlagPairs(values);
  if (!raw) {
    return undefined;
  }
  const required = ["--adapter", "--fixture", "--work-root", "--report"];
  const allowed = new Set([...required, "--mutations"]);
  if (
    required.some((flag) => !raw[flag]) ||
    Object.keys(raw).some((flag) => !allowed.has(flag))
  ) {
    return undefined;
  }
  const mutations = boundedInteger(
    raw["--mutations"] ?? String(DEFAULT_MUTATIONS),
    MIN_MUTATIONS,
    MAX_MUTATIONS,
  );
  if (mutations === undefined) {
    return undefined;
  }
  return {
    adapterPath: raw["--adapter"],
    fixturePath: raw["--fixture"],
    workRoot: raw["--work-root"],
    reportPath: raw["--report"],
    mutations,
  };
}

export function hasSanitizerDiagnostic(stdout, stderr) {
  return SANITIZER_DIAGNOSTIC.test(`${stdout}\n${stderr}`);
}

function boundedOffset(length, seed) {
  const payloadLength = Math.max(1, length - 6);
  return 6 + ((seed * 2_654_435_761) >>> 0) % payloadLength;
}

export function buildMutations(source, count) {
  if (
    !Buffer.isBuffer(source) ||
    source.length < 58 ||
    !Number.isSafeInteger(count) ||
    count < MIN_MUTATIONS ||
    count > MAX_MUTATIONS
  ) {
    throw new TypeError("a bounded DWG buffer and mutation count are required");
  }
  const mutations = [];
  for (let index = 0; index < count; index += 1) {
    let bytes;
    const kind = index % 8;
    const cycle = Math.floor(index / 8);
    if (kind === 0) {
      bytes = Buffer.from(source.subarray(0, Math.min(source.length, 6 + cycle * 8)));
    } else if (kind === 1) {
      bytes = Buffer.from(
        source.subarray(0, Math.min(source.length, 32 + cycle * 17)),
      );
    } else if (kind === 2) {
      bytes = Buffer.from(
        source.subarray(0, Math.floor(source.length / (2 + cycle))),
      );
    } else if (kind === 3) {
      bytes = Buffer.from(
        source.subarray(0, source.length - 1 - cycle),
      );
    } else {
      bytes = Buffer.from(source);
      const offset = boundedOffset(bytes.length, index + 1);
      if (kind === 4) {
        bytes.fill(0, offset, Math.min(bytes.length, offset + 32));
      } else if (kind === 5) {
        bytes.fill(0xff, offset, Math.min(bytes.length, offset + 32));
      } else if (kind === 6) {
        bytes[offset] ^= 1 << (index % 8);
      } else {
        const end = Math.min(bytes.length, offset + 4);
        bytes.subarray(offset, end).reverse();
      }
    }
    mutations.push(Object.freeze({ index, bytes }));
  }
  return Object.freeze(mutations);
}

function parseValidReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout.trim());
  } catch {
    throw new Error("valid fixture returned malformed adapter JSON");
  }
  if (
    report?.schema !== "dwg-scene-cache/1" ||
    report?.status !== "ok" ||
    report?.cache?.validated !== true
  ) {
    throw new Error("valid fixture did not produce a validated Scene Cache");
  }
  return report;
}

async function runCase(adapterPath, inputPath, outputPath) {
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  const environment = {
    ...process.env,
    DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
    ASAN_OPTIONS:
      "abort_on_error=1:allocator_may_return_null=1:detect_leaks=0",
    UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
  };
  let outputError;
  let timedOut = false;
  const child = spawn(
    adapterPath,
    ["convert", inputPath, outputPath],
    {
      cwd: path.dirname(outputPath),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
      "sanitizer adapter stdout",
    ));
  child.stderr.on("data", (value) =>
    capture(
      stderr,
      value,
      stderrState,
      MAX_STDERR_BYTES,
      "sanitizer adapter stderr",
    ));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, CASE_TIMEOUT_MS);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (outputError) {
    throw outputError;
  }
  return Object.freeze({
    ...result,
    timedOut,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  });
}

async function runCancellationCase(adapterPath, inputPath, outputPath) {
  const child = spawn(
    adapterPath,
    ["convert", inputPath, outputPath],
    {
      cwd: path.dirname(outputPath),
      env: {
        ...process.env,
        DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
        ASAN_OPTIONS:
          "abort_on_error=1:allocator_may_return_null=1:detect_leaks=0",
        UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  if (!child.kill("SIGSTOP")) {
    child.kill("SIGKILL");
    throw new Error("could not suspend the cancellation case");
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 5);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (result.signal !== "SIGKILL") {
    throw new Error("sanitizer cancellation did not terminate the adapter");
  }
  await rm(outputPath, { force: true });
}

export function buildQualificationReport({
  mutations,
  acceptedMutations,
  rejectedMutations,
  targetPlatform = process.platform,
  targetArchitecture = process.arch,
}) {
  for (const value of [mutations, acceptedMutations, rejectedMutations]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  assert.equal(acceptedMutations + rejectedMutations, mutations);
  const report = {
    schema: REPORT_SCHEMA,
    status: "pass",
    target: {
      platform: targetPlatform,
      architecture: targetArchitecture,
    },
    profile: {
      addressSanitizer: true,
      undefinedBehaviorSanitizer: true,
      leakDetection: false,
      leakDetectionReason:
        "the isolated converter intentionally lets the operating system reclaim large successful parse graphs at process exit",
    },
    fixturePolicy: {
      source: "public-or-synthetic",
      sourceIdentityDisclosure: "none",
      deterministicMutations: mutations,
    },
    cases: {
      valid: 1,
      cancellation: 1,
      malformedAccepted: acceptedMutations,
      malformedRejected: rejectedMutations,
      timedOut: 0,
      signaled: 0,
      sanitizerDiagnostics: 0,
    },
    cleanup: {
      remainingCaseArtifacts: 0,
    },
  };
  assert.equal(JSON.stringify(report).includes("/tmp/"), false);
  return Object.freeze(report);
}

async function executable(filePath) {
  const resolved = absolutePath(filePath, "adapter path");
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error("adapter must be a non-empty regular file");
  }
  await access(resolved, constants.X_OK);
  return resolved;
}

export async function qualify(options) {
  const adapterPath = await executable(options.adapterPath);
  const fixturePath = absolutePath(options.fixturePath, "fixture path");
  const fixtureMetadata = await verifyDwg(fixturePath);
  if (fixtureMetadata.size > MAX_FIXTURE_BYTES) {
    throw new Error("sanitizer fixture exceeds the bounded input size");
  }
  const workRoot = absolutePath(options.workRoot, "work root");
  const reportPath = absolutePath(options.reportPath, "report path");
  if (path.dirname(reportPath) !== workRoot) {
    throw new Error("report must be directly inside the work root");
  }
  await mustNotExist(workRoot, "work root");
  await mustNotExist(reportPath, "report");
  await mkdir(workRoot, { mode: 0o700 });
  const caseRoot = path.join(workRoot, "cases");
  await mkdir(caseRoot, { mode: 0o700 });

  let acceptedMutations = 0;
  let rejectedMutations = 0;
  try {
    const validOutput = path.join(caseRoot, "valid.cache");
    const valid = await runCase(
      adapterPath,
      fixturePath,
      validOutput,
    );
    if (valid.timedOut || valid.signal || valid.code !== 0) {
      throw new Error("sanitized adapter rejected the valid fixture");
    }
    if (hasSanitizerDiagnostic(valid.stdout, valid.stderr)) {
      throw new Error("sanitizer diagnosed the valid fixture");
    }
    parseValidReport(valid.stdout);

    await runCancellationCase(
      adapterPath,
      fixturePath,
      path.join(caseRoot, "cancelled.cache"),
    );

    const fixture = await readFile(fixturePath);
    const mutations = buildMutations(fixture, options.mutations);
    for (const mutation of mutations) {
      const stem = `mutation-${String(mutation.index).padStart(2, "0")}`;
      const inputPath = path.join(caseRoot, `${stem}.dwg`);
      const outputPath = path.join(caseRoot, `${stem}.cache`);
      await writeFile(inputPath, mutation.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      const result = await runCase(adapterPath, inputPath, outputPath);
      if (result.timedOut) {
        throw new Error("malformed-input sanitizer case timed out");
      }
      if (result.signal) {
        throw new Error("malformed-input sanitizer case was signaled");
      }
      if (hasSanitizerDiagnostic(result.stdout, result.stderr)) {
        throw new Error("sanitizer diagnosed a malformed-input case");
      }
      if (result.code === 0) {
        parseValidReport(result.stdout);
        acceptedMutations++;
      } else {
        rejectedMutations++;
      }
    }
  } finally {
    await rm(caseRoot, { recursive: true, force: true });
  }

  const report = buildQualificationReport({
    mutations: options.mutations,
    acceptedMutations,
    rejectedMutations,
  });
  await writeNewJson(reportPath, report);
  return report;
}

function usage() {
  process.stderr.write(
    "usage: qualify-libredwg-sanitizers.mjs " +
      "--adapter ABSOLUTE --fixture ABSOLUTE --work-root NEW_ABSOLUTE " +
      "--report NEW_ABSOLUTE [--mutations 8_TO_64]\n",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    usage();
    process.exitCode = 2;
  } else {
    try {
      await qualify(options);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
