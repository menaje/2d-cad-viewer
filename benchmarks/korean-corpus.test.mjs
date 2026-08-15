import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseCorpusArguments,
  runKoreanCorpus,
  validateCorpusManifest,
} from "./korean-corpus.mjs";

const execFile = promisify(execFileCallback);
const OPTIONS = Object.freeze({
  runnerPath: "/private/runner",
  adapterPath: "/private/adapter",
  engineVersion: "0.14",
  engineLicense: "GPL-3.0-or-later",
  runs: 3,
  warmupRuns: 1,
  timeoutMs: 60_000,
});

function manifestCase(index, overrides = {}) {
  return {
    id: `case-${String(index).padStart(3, "0")}`,
    path: `private-${index}.dwg`,
    redistributable: false,
    discipline: "architecture",
    sizeClass: "small",
    dwgVersion: "AC1015",
    encodings: ["cp949"],
    fontKinds: ["bigfont"],
    expectedText: {
      minimumHangulCharacters: 1,
      maximumReplacementCharacters: 0,
      maximumNullCharacters: 0,
    },
    ...overrides,
  };
}

function benchmarkReport(version = "AC1015", status = "pass") {
  return {
    schema: "dwg-engine-benchmark/1",
    engine: { id: "libredwg" },
    inspection: {
      deterministic_output: true,
      fingerprint: {
        drawing: { version, entities: 42 },
        text: {
          entities: 3,
          hangul_entities: 2,
          hangul_characters: 12,
          question_marks: 0,
          replacement_characters: 0,
          null_characters: 0,
        },
        embedded_text: {
          entities: 1,
          hangul_entities: 1,
          hangul_characters: 2,
          question_marks: 0,
          replacement_characters: 0,
          null_characters: 0,
        },
        unknown_entities: { count: 1 },
        diagnostics: { count: 2 },
      },
    },
    conversion: {
      deterministic_output: true,
      wall_ms: { median: 1200, maximum: 1400 },
      peak_rss_bytes: {
        median: 500_000_000,
        maximum: 550_000_000,
      },
      fingerprint: {
        cache: { format_major: 1, format_minor: 11 },
        coverage: {
          serialized_entities: 42,
          total_entities: 42,
          deferred_entities: 0,
        },
      },
    },
    decision: { status },
  };
}

test("parses absolute private corpus arguments", () => {
  assert.deepEqual(
    parseCorpusArguments([
      "--manifest",
      "/private/manifest.json",
      "--runner",
      "/private/runner",
      "--adapter",
      "/private/adapter",
      "--output",
      "/private/report.json",
      "--runs",
      "2",
      "--warmup-runs",
      "0",
      "--allow-incomplete",
    ]),
    {
      manifestPath: "/private/manifest.json",
      runnerPath: "/private/runner",
      adapterPath: "/private/adapter",
      outputPath: "/private/report.json",
      runs: 2,
      warmupRuns: 0,
      engineVersion: "0.14",
      engineLicense: "GPL-3.0-or-later",
      timeoutMs: 600_000,
      allowIncomplete: true,
    },
  );
  assert.throws(
    () =>
      parseCorpusArguments([
        "--manifest",
        "relative.json",
        "--runner",
        "/runner",
        "--adapter",
        "/adapter",
        "--output",
        "/report",
      ]),
    /absolute path/u,
  );
});

test("validates bounded metadata and resolves paths without publishing them", () => {
  const manifest = validateCorpusManifest(
    {
      schema: "dwg-korean-corpus-manifest/1",
      cases: [
        manifestCase(1, {
          encodings: ["cp949", "cp949", "johab"],
        }),
      ],
    },
    "/private/corpus",
  );
  assert.equal(
    manifest.cases[0].inputPath,
    path.resolve("/private/corpus", "private-1.dwg"),
  );
  assert.deepEqual(manifest.cases[0].encodings, [
    "cp949",
    "johab",
  ]);
  assert.deepEqual(
    validateCorpusManifest(
      {
        schema: "dwg-korean-corpus-manifest/1",
        cases: [manifestCase(2, { fontKinds: [] })],
      },
      "/private/corpus",
    ).cases[0].fontKinds,
    [],
  );
  assert.throws(
    () =>
      validateCorpusManifest(
        {
          schema: "dwg-korean-corpus-manifest/1",
          cases: [manifestCase(1), manifestCase(1)],
        },
        "/private",
      ),
    /duplicated/u,
  );
});

test("emits a path-free case result and detects text loss", async () => {
  const manifest = validateCorpusManifest(
    {
      schema: "dwg-korean-corpus-manifest/1",
      cases: [
        manifestCase(1, {
          expectedText: {
            minimumHangulCharacters: 20,
            maximumReplacementCharacters: 0,
          },
        }),
      ],
    },
    "/private/corpus",
  );
  const report = await runKoreanCorpus(
    manifest,
    OPTIONS,
    {
      stat: async () => ({
        isFile: () => true,
        size: 1234,
      }),
      executeBenchmark: async () => benchmarkReport(),
    },
  );
  assert.equal(report.cases[0].status, "fail");
  assert.deepEqual(report.cases[0].failures, [
    "hangul_below_minimum",
  ]);
  assert.equal(report.cases[0].text.hangul_characters, 14);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private-1|\/private\/corpus/u);
  assert.equal(report.config.pathsIncluded, false);
  assert.equal(report.qualification.status, "fail");
});

test("passes a 20-case declared coverage matrix", async () => {
  const versions = [
    "AC1015",
    "AC1018",
    "AC1021",
    "AC1024",
    "AC1027",
    "AC1032",
  ];
  const disciplines = ["architecture", "civil", "mep"];
  const sizes = ["small", "medium", "large"];
  const encodings = ["unicode", "euc-kr", "cp949", "johab"];
  const fontKinds = ["shx", "bigfont", "extended-bigfont"];
  const rawCases = Array.from({ length: 20 }, (_, index) =>
    manifestCase(index, {
      discipline: disciplines[index % disciplines.length],
      sizeClass: sizes[index % sizes.length],
      dwgVersion: versions[index % versions.length],
      encodings: [encodings[index % encodings.length]],
      fontKinds: [fontKinds[index % fontKinds.length]],
    }),
  );
  const manifest = validateCorpusManifest(
    {
      schema: "dwg-korean-corpus-manifest/1",
      cases: rawCases,
    },
    "/private/corpus",
  );
  const versionByPath = new Map(
    manifest.cases.map(({ inputPath, dwgVersion }) => [
      inputPath,
      dwgVersion,
    ]),
  );
  const report = await runKoreanCorpus(
    manifest,
    OPTIONS,
    {
      stat: async () => ({
        isFile: () => true,
        size: 2048,
      }),
      executeBenchmark: async (inputPath) =>
        benchmarkReport(versionByPath.get(inputPath)),
    },
  );
  assert.equal(report.summary.cases, 20);
  assert.equal(report.summary.passed, 20);
  assert.equal(report.qualification.status, "pass");
  assert.deepEqual(
    report.qualification.missingDeclaredCoverage,
    {
      versions: [],
      disciplines: [],
      sizeClasses: [],
      encodings: [],
      fontKinds: [],
    },
  );
});

test("writes one owner-only path-free report and refuses overwrite", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dwg-korean-corpus-test-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawingPath = path.join(root, "secret-drawing.dwg");
  const manifestPath = path.join(root, "manifest.json");
  const executablePath = path.join(root, "fake-runner.mjs");
  const outputPath = path.join(root, "report.json");
  await writeFile(drawingPath, Uint8Array.of(1, 2, 3));
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema: "dwg-korean-corpus-manifest/1",
      cases: [manifestCase(1, { path: drawingPath })],
    }),
  );
  await writeFile(
    executablePath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
      JSON.stringify(benchmarkReport()),
    )});\n`,
  );
  await chmod(executablePath, 0o700);

  const arguments_ = [
    path.resolve("benchmarks/korean-corpus.mjs"),
    "--manifest",
    manifestPath,
    "--runner",
    executablePath,
    "--adapter",
    executablePath,
    "--output",
    outputPath,
    "--runs",
    "1",
    "--warmup-runs",
    "0",
    "--allow-incomplete",
  ];
  await execFile(process.execPath, arguments_);
  const reportText = await readFile(outputPath, "utf8");
  assert.doesNotMatch(reportText, /secret-drawing|dwg-korean-corpus-test/u);
  assert.equal(JSON.parse(reportText).cases[0].status, "pass");
  if (process.platform !== "win32") {
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  }
  await assert.rejects(
    () => execFile(process.execPath, arguments_),
    /exited|failed|EEXIST/u,
  );
});
