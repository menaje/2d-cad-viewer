import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  classifyProcess,
  evaluateGate,
  parseDarwinFootprint,
  parseQualificationArgs,
  selectProcessTree,
} from "./qualify-extension-host.mjs";

test("parses the required qualification arguments and safe defaults", () => {
  const options = parseQualificationArgs([
    "--code",
    "./code",
    "--runtime",
    "./runtime",
    "--adapter",
    "./adapter",
    "--drawing",
    "./drawing.dwg",
    "--vsix",
    "./extension.vsix",
    "--companion-vsix",
    "./companion.vsix",
    "--output",
    "./report.json",
  ]);

  assert.equal(options.codePath, path.resolve("./code"));
  assert.equal(options.runtimePath, path.resolve("./runtime"));
  assert.equal(options.adapterPath, path.resolve("./adapter"));
  assert.equal(options.drawingPath, path.resolve("./drawing.dwg"));
  assert.equal(options.vsixPath, path.resolve("./extension.vsix"));
  assert.equal(
    options.companionVsixPath,
    path.resolve("./companion.vsix"),
  );
  assert.equal(options.outputPath, path.resolve("./report.json"));
  assert.equal(options.scenario, "all");
  assert.equal(options.progressivePreview, false);
  assert.equal(options.sampleMs, 100);
  assert.equal(options.timeoutMs, 45_000);
  assert.throws(
    () =>
      parseQualificationArgs([
        "--code",
        "./code",
        "--runtime",
        "./runtime",
        "--adapter",
        "./adapter",
        "--drawing",
        "./drawing.dwg",
        "--vsix",
        "./extension.vsix",
        "--companion-vsix",
        "./companion.vsix",
        "--output",
        "./report.json",
        "--sample-ms",
        "1",
      ]),
    /outside the supported range/u,
  );
});

test("enables the explicit high-memory progressive preview mode", () => {
  const options = parseQualificationArgs([
    "--code",
    "./code",
    "--runtime",
    "./runtime",
    "--adapter",
    "./adapter",
    "--drawing",
    "./drawing.dwg",
    "--vsix",
    "./extension.vsix",
    "--companion-vsix",
    "./companion.vsix",
    "--output",
    "./report.json",
    "--progressive-preview",
  ]);

  assert.equal(options.progressivePreview, true);
});

test("accepts the isolated packaged comparison scenario", () => {
  const options = parseQualificationArgs([
    "--code",
    "./code",
    "--runtime",
    "./runtime",
    "--adapter",
    "./adapter",
    "--drawing",
    "./drawing.dwg",
    "--vsix",
    "./extension.vsix",
    "--companion-vsix",
    "./companion.vsix",
    "--output",
    "./report.json",
    "--scenario",
    "comparison",
  ]);

  assert.equal(options.scenario, "comparison");
});

test("classifies only the adapter convert process as the converter", () => {
  const options = {
    adapterPath: "/private/adapter",
    extensionHostPid: 20,
    launcherPid: 10,
  };

  assert.equal(
    classifyProcess(
      {
        pid: 30,
        ppid: 20,
        command: "/private/adapter convert --input-fd 3",
      },
      options,
    ),
    "converter",
  );
  assert.equal(
    classifyProcess(
      {
        pid: 20,
        ppid: 10,
        command: "Code Helper (Plugin)",
      },
      options,
    ),
    "extension-host",
  );
  assert.equal(
    classifyProcess(
      {
        pid: 40,
        ppid: 10,
        command: "Code Helper (Renderer) --type=renderer",
      },
      options,
    ),
    "renderer",
  );
  assert.equal(
    classifyProcess(
      {
        pid: 50,
        ppid: 10,
        command: "/private/adapter diagnose",
      },
      options,
    ),
    "other",
  );
});

test("selects descendants without including unrelated processes", () => {
  const processes = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 99, ppid: 1 },
  ];

  assert.deepEqual(
    selectProcessTree(processes, new Set([10])).map(
      (process_) => process_.pid,
    ),
    [10, 11, 12],
  );
});

test("reports target misses separately from hard failures", () => {
  assert.deepEqual(evaluateGate(5, 5, 8), {
    status: "pass",
    value: 5,
  });
  assert.deepEqual(evaluateGate(6, 5, 8), {
    status: "target_miss",
    value: 6,
  });
  assert.deepEqual(evaluateGate(9, 5, 8), {
    status: "hard_fail",
    value: 9,
  });
  assert.deepEqual(evaluateGate(Number.NaN, 5, 8), {
    status: "unavailable",
    value: null,
  });
});

test("parses single and de-duplicated macOS footprint totals", () => {
  assert.equal(
    parseDarwinFootprint(
      "Code [42]: 64-bit    Footprint: 700000000 B\\n",
    ),
    700_000_000,
  );
  assert.equal(
    parseDarwinFootprint(
      "Code [42]: Footprint: 700000000 B\\nSummary Footprint: 650000000 B\\n",
    ),
    650_000_000,
  );
  assert.equal(parseDarwinFootprint("unavailable"), null);
});
