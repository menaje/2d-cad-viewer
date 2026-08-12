#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

const MANIFEST_SCHEMA = "dwg-korean-corpus-manifest/1";
const REPORT_SCHEMA = "dwg-korean-corpus-report/1";
const MAX_CASES = 64;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DWG_VERSIONS = new Set([
  "AC1015",
  "AC1018",
  "AC1021",
  "AC1024",
  "AC1027",
  "AC1032",
]);
const DISCIPLINES = new Set([
  "architecture",
  "civil",
  "mep",
  "other",
]);
const SIZE_CLASSES = new Set(["small", "medium", "large"]);
const ENCODINGS = new Set([
  "unicode",
  "euc-kr",
  "cp949",
  "johab",
]);
const FONT_KINDS = new Set([
  "ttf",
  "shx",
  "bigfont",
  "extended-bigfont",
]);
const REQUIRED_COVERAGE = Object.freeze({
  versions: Object.freeze([...DWG_VERSIONS]),
  disciplines: Object.freeze(["architecture", "civil", "mep"]),
  sizeClasses: Object.freeze([...SIZE_CLASSES]),
  encodings: Object.freeze([...ENCODINGS]),
  fontKinds: Object.freeze([
    "shx",
    "bigfont",
    "extended-bigfont",
  ]),
});

function positiveInteger(value, label, minimum = 1) {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = positiveInteger(value, label, minimum);
  if (parsed > maximum) {
    throw new RangeError(`${label} must be <= ${maximum}`);
  }
  return parsed;
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

export function parseCorpusArguments(argv) {
  const options = {
    runs: 3,
    warmupRuns: 1,
    engineVersion: "0.14",
    engineLicense: "GPL-3.0-or-later",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowIncomplete: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--allow-incomplete") {
      options.allowIncomplete = true;
      continue;
    }
    const value = optionValue(argv, index, option);
    index += 1;
    switch (option) {
      case "--manifest":
        options.manifestPath = value;
        break;
      case "--runner":
        options.runnerPath = value;
        break;
      case "--adapter":
        options.adapterPath = value;
        break;
      case "--output":
        options.outputPath = value;
        break;
      case "--runs":
        options.runs = boundedInteger(value, "--runs", 1, 10);
        break;
      case "--warmup-runs":
        options.warmupRuns = boundedInteger(
          value,
          "--warmup-runs",
          0,
          5,
        );
        break;
      case "--engine-version":
        if (!/^[A-Za-z0-9._+-]{1,80}$/u.test(value)) {
          throw new TypeError("--engine-version is invalid");
        }
        options.engineVersion = value;
        break;
      case "--engine-license":
        if (!/^[A-Za-z0-9._+()-]{1,80}$/u.test(value)) {
          throw new TypeError("--engine-license is invalid");
        }
        options.engineLicense = value;
        break;
      case "--timeout-ms":
        options.timeoutMs = boundedInteger(
          value,
          "--timeout-ms",
          1_000,
          30 * 60 * 1_000,
        );
        break;
      default:
        throw new TypeError(`unknown option: ${option}`);
    }
  }
  for (const key of [
    "manifestPath",
    "runnerPath",
    "adapterPath",
    "outputPath",
  ]) {
    if (!options[key] || !path.isAbsolute(options[key])) {
      throw new TypeError(`${key} must be an absolute path`);
    }
  }
  if (options.outputPath === options.manifestPath) {
    throw new TypeError("outputPath must differ from manifestPath");
  }
  return Object.freeze(options);
}

function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} is unsupported`);
  }
  return value;
}

function enumList(value, allowed, label, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new TypeError(
      `${label} must be ${allowEmpty ? "an" : "a non-empty"} array`,
    );
  }
  return Object.freeze(
    [...new Set(value.map((item) => enumValue(item, allowed, label)))],
  );
}

function expectedText(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label}.expectedText must be an object`);
  }
  const result = {
    minimumHangulCharacters: positiveInteger(
      value.minimumHangulCharacters,
      `${label}.expectedText.minimumHangulCharacters`,
      0,
    ),
    maximumReplacementCharacters: positiveInteger(
      value.maximumReplacementCharacters ?? 0,
      `${label}.expectedText.maximumReplacementCharacters`,
      0,
    ),
    maximumNullCharacters: positiveInteger(
      value.maximumNullCharacters ?? 0,
      `${label}.expectedText.maximumNullCharacters`,
      0,
    ),
  };
  if (value.maximumQuestionMarks !== undefined) {
    result.maximumQuestionMarks = positiveInteger(
      value.maximumQuestionMarks,
      `${label}.expectedText.maximumQuestionMarks`,
      0,
    );
  }
  return Object.freeze(result);
}

export function validateCorpusManifest(value, manifestDirectory) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.schema !== MANIFEST_SCHEMA ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0 ||
    value.cases.length > MAX_CASES
  ) {
    throw new TypeError(`invalid ${MANIFEST_SCHEMA} manifest`);
  }
  const ids = new Set();
  const cases = value.cases.map((candidate, index) => {
    const label = `cases[${index}]`;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof candidate.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(candidate.id) ||
      ids.has(candidate.id)
    ) {
      throw new TypeError(`${label}.id is invalid or duplicated`);
    }
    ids.add(candidate.id);
    if (
      typeof candidate.path !== "string" ||
      candidate.path.trim().length === 0 ||
      candidate.path.includes("\0")
    ) {
      throw new TypeError(`${label}.path is invalid`);
    }
    if (typeof candidate.redistributable !== "boolean") {
      throw new TypeError(`${label}.redistributable must be boolean`);
    }
    const inputPath = path.resolve(
      manifestDirectory,
      candidate.path,
    );
    return Object.freeze({
      id: candidate.id,
      inputPath,
      redistributable: candidate.redistributable,
      discipline: enumValue(
        candidate.discipline,
        DISCIPLINES,
        `${label}.discipline`,
      ),
      sizeClass: enumValue(
        candidate.sizeClass,
        SIZE_CLASSES,
        `${label}.sizeClass`,
      ),
      dwgVersion: enumValue(
        candidate.dwgVersion,
        DWG_VERSIONS,
        `${label}.dwgVersion`,
      ),
      encodings: enumList(
        candidate.encodings,
        ENCODINGS,
        `${label}.encodings`,
      ),
      fontKinds: enumList(
        candidate.fontKinds,
        FONT_KINDS,
        `${label}.fontKinds`,
        true,
      ),
      expectedText: expectedText(candidate.expectedText, label),
    });
  });
  return Object.freeze({
    schema: MANIFEST_SCHEMA,
    cases: Object.freeze(cases),
  });
}

async function executeBenchmark(inputPath, options) {
  const arguments_ = [
    "benchmark",
    inputPath,
    "--adapter",
    options.adapterPath,
    "--engine-id",
    "libredwg",
    "--engine-version",
    options.engineVersion,
    "--engine-license",
    options.engineLicense,
    "--scope",
    "all",
    "--runs",
    String(options.runs),
    "--warmup-runs",
    String(options.warmupRuns),
  ];
  const runnerExtension = path.extname(options.runnerPath).toLowerCase();
  const nodeRunner = [".cjs", ".js", ".mjs"].includes(
    runnerExtension,
  );
  const { stdout } = await execFile(
    nodeRunner ? process.execPath : options.runnerPath,
    nodeRunner
      ? [options.runnerPath, ...arguments_]
      : arguments_,
    {
      encoding: "utf8",
      maxBuffer: MAX_REPORT_BYTES,
      timeout: options.timeoutMs,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

function finiteNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function combinedTextFingerprint(inspection) {
  const text = inspection?.text ?? {};
  const embedded = inspection?.embedded_text ?? {};
  const combined = {};
  for (const field of [
    "entities",
    "hangul_entities",
    "hangul_characters",
    "question_marks",
    "replacement_characters",
    "null_characters",
  ]) {
    combined[field] =
      finiteNonnegativeInteger(text[field]) +
      finiteNonnegativeInteger(embedded[field]);
  }
  return Object.freeze(combined);
}

function safeMetric(metric) {
  if (
    typeof metric !== "object" ||
    metric === null ||
    !Number.isSafeInteger(metric.median) ||
    !Number.isSafeInteger(metric.maximum)
  ) {
    return null;
  }
  return Object.freeze({
    median: metric.median,
    maximum: metric.maximum,
  });
}

function summarizeCase(candidate, sizeBytes, report) {
  if (
    report?.schema !== "dwg-engine-benchmark/1" ||
    report?.engine?.id !== "libredwg" ||
    typeof report?.inspection?.fingerprint !== "object"
  ) {
    return Object.freeze({
      ...publicCaseMetadata(candidate),
      inputSizeBytes: sizeBytes,
      status: "error",
      failures: Object.freeze(["invalid_benchmark_report"]),
    });
  }
  const inspection = report.inspection.fingerprint;
  const conversion = report.conversion?.fingerprint ?? {};
  const text = combinedTextFingerprint(inspection);
  const failures = [];
  const actualVersion = DWG_VERSIONS.has(
    inspection?.drawing?.version,
  )
    ? inspection.drawing.version
    : null;
  if (actualVersion !== candidate.dwgVersion) {
    failures.push("dwg_version_mismatch");
  }
  if (
    text.hangul_characters <
    candidate.expectedText.minimumHangulCharacters
  ) {
    failures.push("hangul_below_minimum");
  }
  if (
    text.replacement_characters >
    candidate.expectedText.maximumReplacementCharacters
  ) {
    failures.push("replacement_character_limit");
  }
  if (
    text.null_characters >
    candidate.expectedText.maximumNullCharacters
  ) {
    failures.push("null_character_limit");
  }
  if (
    candidate.expectedText.maximumQuestionMarks !== undefined &&
    text.question_marks >
      candidate.expectedText.maximumQuestionMarks
  ) {
    failures.push("question_mark_limit");
  }
  if (report.inspection.deterministic_output !== true) {
    failures.push("inspection_nondeterministic");
  }
  if (report.conversion?.deterministic_output !== true) {
    failures.push("conversion_nondeterministic");
  }
  if (report.decision?.status === "hard_fail") {
    failures.push("engine_hard_limit");
  }
  const decisionStatus = report.decision?.status;
  const status =
    failures.length > 0
      ? "fail"
      : decisionStatus === "target_miss"
        ? "target_miss"
        : decisionStatus === "pass"
          ? "pass"
          : "incomplete";
  return Object.freeze({
    ...publicCaseMetadata(candidate),
    inputSizeBytes: sizeBytes,
    status,
    failures: Object.freeze(failures),
    drawing: Object.freeze({
      version: actualVersion,
      entities: finiteNonnegativeInteger(
        inspection.drawing?.entities,
      ),
      unknownEntities: finiteNonnegativeInteger(
        inspection.unknown_entities?.count,
      ),
      diagnostics: finiteNonnegativeInteger(
        inspection.diagnostics?.count,
      ),
    }),
    text,
    conversion: Object.freeze({
      wallMs: safeMetric(report.conversion?.wall_ms),
      peakRssBytes: safeMetric(
        report.conversion?.peak_rss_bytes,
      ),
      cacheFormat:
        Number.isSafeInteger(conversion.cache?.format_major) &&
        Number.isSafeInteger(conversion.cache?.format_minor)
          ? `${conversion.cache.format_major}.${conversion.cache.format_minor}`
          : null,
      serializedEntities: finiteNonnegativeInteger(
        conversion.coverage?.serialized_entities,
      ),
      totalEntities: finiteNonnegativeInteger(
        conversion.coverage?.total_entities,
      ),
      deferredEntities: finiteNonnegativeInteger(
        conversion.coverage?.deferred_entities,
      ),
    }),
  });
}

function publicCaseMetadata(candidate) {
  return {
    id: candidate.id,
    redistributable: candidate.redistributable,
    discipline: candidate.discipline,
    sizeClass: candidate.sizeClass,
    declaredVersion: candidate.dwgVersion,
    encodings: candidate.encodings,
    fontKinds: candidate.fontKinds,
  };
}

function missingCoverage(cases, field, required) {
  const observed = new Set();
  for (const candidate of cases) {
    const values = Array.isArray(candidate[field])
      ? candidate[field]
      : [candidate[field]];
    for (const value of values) {
      observed.add(value);
    }
  }
  return Object.freeze(
    required.filter((value) => !observed.has(value)),
  );
}

function qualification(cases, results) {
  const missing = Object.freeze({
    versions: missingCoverage(
      cases,
      "dwgVersion",
      REQUIRED_COVERAGE.versions,
    ),
    disciplines: missingCoverage(
      cases,
      "discipline",
      REQUIRED_COVERAGE.disciplines,
    ),
    sizeClasses: missingCoverage(
      cases,
      "sizeClass",
      REQUIRED_COVERAGE.sizeClasses,
    ),
    encodings: missingCoverage(
      cases,
      "encodings",
      REQUIRED_COVERAGE.encodings,
    ),
    fontKinds: missingCoverage(
      cases,
      "fontKinds",
      REQUIRED_COVERAGE.fontKinds,
    ),
  });
  const coverageComplete = Object.values(missing).every(
    (values) => values.length === 0,
  );
  const resultFailure = results.some(({ status }) =>
    ["error", "fail", "incomplete"].includes(status),
  );
  const targetMiss = results.some(
    ({ status }) => status === "target_miss",
  );
  const enoughCases = cases.length >= 20;
  return Object.freeze({
    status: resultFailure
      ? "fail"
      : enoughCases && coverageComplete
        ? targetMiss
          ? "target_miss"
          : "pass"
        : "incomplete",
    minimumCases: 20,
    observedCases: cases.length,
    enoughCases,
    declaredCoverageComplete: coverageComplete,
    missingDeclaredCoverage: missing,
  });
}

export async function runKoreanCorpus(
  manifest,
  options,
  dependencies = {},
) {
  const benchmark = dependencies.executeBenchmark ?? executeBenchmark;
  const fileStat = dependencies.stat ?? stat;
  const results = [];
  for (const candidate of manifest.cases) {
    let metadata;
    try {
      metadata = await fileStat(candidate.inputPath);
      if (!metadata.isFile()) {
        throw new Error("not a file");
      }
    } catch {
      results.push(
        Object.freeze({
          ...publicCaseMetadata(candidate),
          inputSizeBytes: null,
          status: "error",
          failures: Object.freeze(["input_unavailable"]),
        }),
      );
      continue;
    }
    try {
      const report = await benchmark(candidate.inputPath, options);
      results.push(
        summarizeCase(candidate, metadata.size, report),
      );
    } catch {
      results.push(
        Object.freeze({
          ...publicCaseMetadata(candidate),
          inputSizeBytes: metadata.size,
          status: "error",
          failures: Object.freeze(["benchmark_failed"]),
        }),
      );
    }
  }
  const gate = qualification(manifest.cases, results);
  return Object.freeze({
    schema: REPORT_SCHEMA,
    engine: Object.freeze({
      id: "libredwg",
      version: options.engineVersion,
      license: options.engineLicense,
    }),
    config: Object.freeze({
      measuredRuns: options.runs,
      warmupRuns: options.warmupRuns,
      processIsolated: true,
      sequentialCases: true,
      pathsIncluded: false,
      textSamplesIncluded: false,
    }),
    summary: Object.freeze({
      cases: results.length,
      redistributableCases: manifest.cases.filter(
        ({ redistributable }) => redistributable,
      ).length,
      passed: results.filter(({ status }) => status === "pass").length,
      targetMisses: results.filter(
        ({ status }) => status === "target_miss",
      ).length,
      failed: results.filter(({ status }) =>
        ["error", "fail", "incomplete"].includes(status),
      ).length,
    }),
    qualification: gate,
    cases: Object.freeze(results),
  });
}

async function main(argv) {
  const options = parseCorpusArguments(argv);
  await Promise.all([
    access(options.manifestPath, fsConstants.R_OK),
    access(options.runnerPath, fsConstants.X_OK),
    access(options.adapterPath, fsConstants.X_OK),
  ]);
  const manifestValue = JSON.parse(
    await readFile(options.manifestPath, "utf8"),
  );
  const manifest = validateCorpusManifest(
    manifestValue,
    path.dirname(options.manifestPath),
  );
  const report = await runKoreanCorpus(manifest, options);
  await writeFile(
    options.outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  if (
    report.qualification.status === "fail" ||
    report.qualification.status === "target_miss" ||
    (report.qualification.status === "incomplete" &&
      !options.allowIncomplete)
  ) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Korean corpus qualification failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    process.exitCode = 1;
  });
}

export {
  MANIFEST_SCHEMA,
  REPORT_SCHEMA,
  REQUIRED_COVERAGE,
};
