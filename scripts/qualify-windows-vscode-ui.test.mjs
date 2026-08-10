// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  adjustedHostViewportSize,
  candidatePositions,
  canvasPointIsUnobstructed,
  parseWindowsUiArguments,
  parseCoordinateMeasurementRows,
  parseDistanceMeasurementRows,
  parseVSCodeVersionOutput,
  rectIsContained,
  viewportZoomFromStatus,
  WINDOWS_UI_CLEANUP_OPTIONS,
  WINDOWS_UI_COMPANION_EXTENSION_ID,
  WINDOWS_UI_EXTENSION_ID,
  WINDOWS_UI_LOCALE,
} from "./qualify-windows-vscode-ui.mjs";

test("reads the installed VS Code CLI product version", () => {
  assert.equal(
    parseVSCodeVersionOutput(
      "1.131.0\r\n07b4ff1883f94da91f6d698744fc7c3638b59720\r\nx64\r\n",
    ),
    "1.131.0",
  );
  assert.throws(
    () => parseVSCodeVersionOutput("stable\ncommit\nx64\n"),
    /invalid product version/u,
  );
});

test("reads only a positive leading viewport zoom status", () => {
  assert.equal(
    viewportZoomFromStatus("1.43× · 화면 상세 2개"),
    1.43,
  );
  assert.equal(viewportZoomFromStatus("화면을 맞췄습니다."), null);
  assert.equal(viewportZoomFromStatus("0× · invalid"), null);
});

test("parses only the bounded Windows UI qualification inputs", () => {
  const options = parseWindowsUiArguments([
    "--drawing",
    "./drawing.dwg",
    "--companion-vsix",
    "./companion.vsix",
    "--vsix",
    "./viewer.vsix",
    "--output-dir",
    "./evidence",
  ]);
  assert.equal(options.drawingPath, path.resolve("./drawing.dwg"));
  assert.equal(
    options.companionVsixPath,
    path.resolve("./companion.vsix"),
  );
  assert.equal(options.vsixPath, path.resolve("./viewer.vsix"));
  assert.equal(options.outputDirectory, path.resolve("./evidence"));
  assert.throws(
    () =>
      parseWindowsUiArguments([
        "--drawing",
        "./drawing.dwg",
        "--companion-vsix",
        "./companion.vsix",
        "--vsix",
        "./viewer.vsix",
        "--output-dir",
        "./evidence",
        "--unknown",
        "value",
      ]),
    /unsupported option/u,
  );
  assert.equal(
    WINDOWS_UI_COMPANION_EXTENSION_ID,
    "menaje.dwg-viewer-libredwg",
  );
});

test("accepts only visible rectangles contained by the CSS viewport", () => {
  const viewport = { width: 800, height: 600 };
  assert.equal(
    rectIsContained(
      {
        left: 8,
        top: 8,
        right: 108,
        bottom: 58,
        width: 100,
        height: 50,
      },
      viewport,
    ),
    true,
  );
  assert.equal(
    rectIsContained(
      {
        left: 790,
        top: 8,
        right: 830,
        bottom: 58,
        width: 40,
        height: 50,
      },
      viewport,
    ),
    false,
  );
  assert.equal(
    rectIsContained(
      {
        left: 8,
        top: 8,
        right: 8,
        bottom: 58,
        width: 0,
        height: 50,
      },
      viewport,
    ),
    false,
  );
});

test("skips measurement points covered by floating viewer tools", () => {
  const canvas = {
    getBoundingClientRect() {
      return { left: 40, top: 60 };
    },
  };
  const toolbar = {};
  const candidate = { x: 120, y: 80 };
  let observedPoint;
  assert.equal(
    canvasPointIsUnobstructed(
      canvas,
      candidate,
      (x, y) => {
        observedPoint = { x, y };
        return toolbar;
      },
    ),
    false,
  );
  assert.deepEqual(observedPoint, { x: 160, y: 140 });
  assert.equal(
    canvasPointIsUnobstructed(
      canvas,
      candidate,
      () => canvas,
    ),
    true,
  );
});

test("keeps candidate points outside the expanded VS Code review toolbar", () => {
  const candidates = candidatePositions(720, 606);
  assert.ok(candidates.length > 20);
  assert.equal(
    candidates.every(
      ({ x, y }) =>
        x > 176 &&
        x < 720 &&
        y > 0 &&
        y < 606,
    ),
    true,
  );
});

test("adjusts the host CSS viewport by the observed editor-width delta", () => {
  assert.deepEqual(
    adjustedHostViewportSize(
      { width: 1_400, height: 900 },
      720,
      1_050,
    ),
    { width: 1_730, height: 900 },
  );
  assert.deepEqual(
    adjustedHostViewportSize(
      { width: 1_730, height: 700 },
      1_050,
      520,
    ),
    { width: 1_200, height: 820 },
  );
  assert.throws(
    () =>
      adjustedHostViewportSize(
        { width: Number.NaN, height: 900 },
        720,
        520,
      ),
    /finite/u,
  );
});

test("accepts English-locale measurement rows with one DWG unit", () => {
  assert.equal(WINDOWS_UI_LOCALE, "en");
  assert.deepEqual(
    parseCoordinateMeasurementRows([
      ["X", "1,234.5 mm"],
      ["Y", "-20 mm"],
      ["Z", "0 mm"],
      ["Snap", "Endpoint"],
    ]),
    {
      unit: "mm",
      values: {
        x: "1,234.5 mm",
        y: "-20 mm",
        z: "0 mm",
        snap: "Endpoint",
      },
    },
  );
  assert.deepEqual(
    parseDistanceMeasurementRows([
      ["Distance", "5 drawing units"],
      ["ΔX", "3 drawing units"],
      ["ΔY", "4 drawing units"],
      ["ΔZ", "0 drawing units"],
      ["Angle", "53.1301°"],
    ]),
    {
      unit: "drawing units",
      values: {
        distance: "5 drawing units",
        deltaX: "3 drawing units",
        deltaY: "4 drawing units",
        deltaZ: "0 drawing units",
        angle: "53.1301°",
      },
    },
  );
});

test("rejects nonnumeric or inconsistent measurement evidence", () => {
  assert.throws(
    () =>
      parseDistanceMeasurementRows([
        ["Distance", "five mm"],
        ["ΔX", "3 mm"],
        ["ΔY", "4 mm"],
        ["ΔZ", "0 mm"],
        ["Angle", "53°"],
      ]),
    /numeric measurement/u,
  );
  assert.throws(
    () =>
      parseCoordinateMeasurementRows([
        ["X", "1 mm"],
        ["Y", "2 cm"],
        ["Z", "0 mm"],
        ["Snap", "Endpoint"],
      ]),
    /units are inconsistent/u,
  );
});

test("uses the packaged extension manifest identity", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.resolve("apps/vscode-extension/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    WINDOWS_UI_EXTENSION_ID,
    `${manifest.publisher}.${manifest.name}`,
  );
});

test("derives the Windows qualification VSIX from the package version", async () => {
  const workflow = await readFile(
    path.resolve(".github/workflows/libredwg-adapter.yml"),
    "utf8",
  );
  assert.match(workflow, /\$extensionVersion = node -p/u);
  assert.match(
    workflow,
    /dwg-viewer-vscode-\$extensionVersion\.vsix/u,
  );
  assert.doesNotMatch(
    workflow,
    /dwg-viewer-vscode-\d+\.\d+\.\d+\.vsix/u,
  );
});

test("bounds Windows profile lock cleanup retries", () => {
  assert.deepEqual(WINDOWS_UI_CLEANUP_OPTIONS, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
});
