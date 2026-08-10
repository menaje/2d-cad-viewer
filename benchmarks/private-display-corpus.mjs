#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  constants as fsConstants,
  mkdir,
  open,
  opendir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPORT_SCHEMA = "dwg-private-display-corpus/1";
const CASE_SCHEMA = "dwg-private-display-case/1";
const MAX_DRAWINGS = 4_096;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function boundedInteger(value, option, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new TypeError(
      `${option} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

export function parseArguments(argv) {
  const options = {
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = optionValue(argv, index, option);
    index += 1;
    switch (option) {
      case "--root":
        options.rootPath = value;
        break;
      case "--adapter":
        options.adapterPath = value;
        break;
      case "--work":
        options.workPath = value;
        break;
      case "--concurrency":
        options.concurrency = boundedInteger(value, option, 1, 8);
        break;
      case "--timeout-ms":
        options.timeoutMs = boundedInteger(
          value,
          option,
          1_000,
          30 * 60 * 1_000,
        );
        break;
      default:
        throw new TypeError(`unknown option: ${option}`);
    }
  }
  for (const key of ["rootPath", "adapterPath", "workPath"]) {
    if (!options[key] || !path.isAbsolute(options[key])) {
      throw new TypeError(`${key} must be an absolute path`);
    }
  }
  return Object.freeze(options);
}

async function discoverDrawings(rootPath) {
  const root = path.resolve(rootPath);
  const drawings = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (
        entry.isFile() &&
        entry.name.toLocaleLowerCase("en-US").endsWith(".dwg")
      ) {
        drawings.push(candidate);
        if (drawings.length > MAX_DRAWINGS) {
          throw new RangeError(
            `private display corpus exceeds ${MAX_DRAWINGS} drawings`,
          );
        }
      }
    }
  }
  drawings.sort((left, right) =>
    path
      .relative(root, left)
      .normalize("NFC")
      .localeCompare(path.relative(root, right).normalize("NFC"), "en"),
  );
  return Object.freeze(drawings);
}

function caseId(rootPath, inputPath) {
  const relativePath = path.relative(rootPath, inputPath).normalize("NFC");
  const digest = createHash("sha256")
    .update(relativePath, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `drawing-${digest}`;
}

async function execute(adapterPath, arguments_, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(adapterPath, arguments_, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("adapter timed out"));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("adapter stdout exceeded its limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("adapter stderr exceeded its limit"));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        finish(
          new Error(
            errorText ||
              `adapter exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          ),
        );
        return;
      }
      try {
        finish(
          null,
          JSON.parse(Buffer.concat(stdout).toString("utf8")),
        );
      } catch {
        finish(new Error("adapter returned invalid JSON"));
      }
    });
  });
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : "unknown error";
}

async function writeJsonExclusive(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function runCase(inputPath, index, total, options, directories) {
  const id = caseId(options.rootPath, inputPath);
  const resultPath = path.join(directories.results, `${id}.json`);
  const cachePath = path.join(directories.caches, `${id}.cache`);
  let hasExistingResult = false;
  try {
    const existing = JSON.parse(await readFile(resultPath, "utf8"));
    hasExistingResult = true;
    if (
      existing?.schema === CASE_SCHEMA &&
      existing?.id === id &&
      existing?.status === "converted" &&
      existing?.conversion?.schema === "dwg-scene-cache/1" &&
      existing?.conversion?.status === "ok"
    ) {
      try {
        await access(cachePath, fsConstants.R_OK);
        process.stderr.write(`[${index + 1}/${total}] resume ${id}\n`);
        return existing;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EACCES") {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (hasExistingResult) {
    await unlink(resultPath);
  }
  await unlink(cachePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });

  const metadata = await stat(inputPath);
  const relativePath = path
    .relative(options.rootPath, inputPath)
    .normalize("NFC");
  const startedAt = Date.now();
  let inspection = null;
  let conversion = null;
  let failure = null;
  try {
    inspection = await execute(
      options.adapterPath,
      ["inspect", inputPath, "--notification-samples", "0"],
      options.timeoutMs,
    );
    conversion = await execute(
      options.adapterPath,
      ["convert", inputPath, cachePath],
      options.timeoutMs,
    );
  } catch (error) {
    failure = errorMessage(error);
  }
  const result = Object.freeze({
    schema: CASE_SCHEMA,
    id,
    relativePath,
    inputSizeBytes: metadata.size,
    elapsedMs: Date.now() - startedAt,
    status:
      !failure &&
      inspection?.schema === "dwg-inspection/1" &&
      inspection?.status === "ok" &&
      conversion?.schema === "dwg-scene-cache/1" &&
      conversion?.status === "ok"
        ? "converted"
        : "error",
    failure,
    inspection,
    conversion,
  });
  await writeJsonExclusive(resultPath, result);
  process.stderr.write(
    `[${index + 1}/${total}] ${result.status} ${id} (${result.elapsedMs} ms)\n`,
  );
  return result;
}

async function runPool(drawings, options, directories) {
  const results = new Array(drawings.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < drawings.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runCase(
        drawings[index],
        index,
        drawings.length,
        options,
        directories,
      );
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, drawings.length) },
      () => worker(),
    ),
  );
  return Object.freeze(results);
}

function summarize(results) {
  return Object.freeze({
    drawings: results.length,
    converted: results.filter(({ status }) => status === "converted").length,
    failed: results.filter(({ status }) => status !== "converted").length,
    deferredEntities: results.reduce(
      (total, result) =>
        total + (result.conversion?.coverage?.deferred_entities ?? 0),
      0,
    ),
    unknownEntities: results.reduce(
      (total, result) =>
        total + (result.inspection?.unknown_entities?.count ?? 0),
      0,
    ),
    diagnostics: results.reduce(
      (total, result) =>
        total + (result.inspection?.diagnostics?.count ?? 0),
      0,
    ),
  });
}

export async function run(options) {
  await Promise.all([
    access(options.rootPath, fsConstants.R_OK),
    access(options.adapterPath, fsConstants.X_OK),
  ]);
  const rootMetadata = await stat(options.rootPath);
  if (!rootMetadata.isDirectory()) {
    throw new TypeError("rootPath must be a directory");
  }
  await mkdir(options.workPath, { recursive: false, mode: 0o700 }).catch(
    (error) => {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    },
  );
  const directories = {
    caches: path.join(options.workPath, "caches"),
    results: path.join(options.workPath, "cases"),
  };
  await Promise.all([
    mkdir(directories.caches, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    }),
    mkdir(directories.results, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    }),
  ]);
  const drawings = await discoverDrawings(options.rootPath);
  if (drawings.length === 0) {
    throw new Error("private display corpus contains no DWG drawings");
  }
  const results = await runPool(drawings, options, directories);
  const report = Object.freeze({
    schema: REPORT_SCHEMA,
    private: true,
    config: Object.freeze({
      rootPath: options.rootPath,
      adapterPath: options.adapterPath,
      cacheDirectory: directories.caches,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
    }),
    summary: summarize(results),
    cases: Object.freeze(
      results.map(({ inspection, conversion, ...result }) => ({
        ...result,
        drawing: inspection?.drawing ?? null,
        entityTypes: inspection?.entity_types ?? null,
        unknownEntities: inspection?.unknown_entities ?? null,
        text: inspection?.text ?? null,
        embeddedText: inspection?.embedded_text ?? null,
        bounds: inspection?.bounds ?? null,
        diagnostics: inspection?.diagnostics ?? null,
        coverage: conversion?.coverage ?? null,
        gpuLines: conversion?.gpu_lines ?? null,
        hatchFills: conversion?.hatch_fills ?? null,
        cache: conversion?.cache ?? null,
      })),
    ),
  });
  const reportPath = path.join(options.workPath, "report.json");
  try {
    await writeJsonExclusive(reportPath, report);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const file = await open(reportPath, "r");
    await file.close();
  }
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  return report;
}

async function main(argv) {
  const options = parseArguments(argv);
  await run(options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Private display corpus failed: ${errorMessage(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export { CASE_SCHEMA, REPORT_SCHEMA };
