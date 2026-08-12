// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createAutoCadPairScript,
  expectedDrawingVariable,
  parseAutoCadPairArguments,
} from "./qualify-autocad-variable-pair.mjs";

function argumentsFor(overrides = {}) {
  const values = {
    adapter: "adapter.exe",
    autocad: "acad.exe",
    caseId: "fillmode-pair",
    drawing: "HatchG.dwg",
    observedAt: "2026-08-12T12:00:00Z",
    output: "pair-output",
    space: "current",
    values: "0,1",
    variable: "FILLMODE",
    ...overrides,
  };
  return [
    "--adapter",
    values.adapter,
    "--autocad",
    values.autocad,
    "--case-id",
    values.caseId,
    "--drawing",
    values.drawing,
    "--observed-at",
    values.observedAt,
    "--output-dir",
    values.output,
    "--space",
    values.space,
    "--values",
    values.values,
    "--variable",
    values.variable,
  ];
}

test("parses a bounded AutoCAD system-variable pair", () => {
  const result = parseAutoCadPairArguments(argumentsFor());
  assert.equal(result.adapterPath, path.resolve("adapter.exe"));
  assert.equal(result.autoCadPath, path.resolve("acad.exe"));
  assert.equal(result.variable, "FILLMODE");
  assert.equal(result.space, "current");
  assert.deepEqual(result.values, [0, 1]);
  assert.throws(
    () =>
      parseAutoCadPairArguments(
        argumentsFor({ variable: "SECURELOAD" }),
      ),
    /unsupported AutoCAD variable/u,
  );
  assert.throws(
    () =>
      parseAutoCadPairArguments(argumentsFor({ values: "0,0" })),
    /distinct members/u,
  );
  assert.throws(
    () =>
      parseAutoCadPairArguments(
        argumentsFor({ caseId: "../../escape" }),
      ),
    /kebab-case/u,
  );
  assert.throws(
    () =>
      parseAutoCadPairArguments(argumentsFor({ space: "viewport" })),
    /space must be/u,
  );
});

test("selects an explicit model or layout context before fixing the camera", () => {
  const modelScript = createAutoCadPairScript({
    caseId: "annotation-model",
    outputDirectory: "C:\\pairs",
    space: "model",
    values: [0, 1],
    variable: "ANNOALLVISIBLE",
  });
  assert.ok(
    modelScript.indexOf('(setvar "TILEMODE" 1)') <
      modelScript.indexOf('(command "_.ZOOM" "_Extents")'),
  );

  const layoutScript = createAutoCadPairScript({
    caseId: "annotation-layout",
    layoutName: "Sheet 1",
    outputDirectory: "C:\\pairs",
    space: "layout",
    values: [0, 1],
    variable: "ANNOALLVISIBLE",
  });
  assert.match(layoutScript, /\(setvar "TILEMODE" 0\)/u);
  assert.match(layoutScript, /\(setvar "CTAB" "Sheet 1"\)/u);
});

test("generates one fixed AutoCAD camera and one output per value", () => {
  const script = createAutoCadPairScript({
    caseId: "attmode-pair",
    outputDirectory: "C:\\qualification output",
    values: [0, 1, 2],
    variable: "ATTMODE",
  });
  assert.equal(script.match(/_\.ZOOM/gu)?.length, 1);
  assert.match(script, /\(setvar "ATTMODE" \(car dwgv-state\)\)/u);
  assert.match(script, /attmode-pair-0/u);
  assert.match(script, /attmode-pair-1/u);
  assert.match(script, /attmode-pair-2/u);
  assert.match(script, /C:\/qualification output/u);
  assert.doesNotMatch(script, /C:\\qualification/u);
  assert.match(script, /_\.PNGOUT/u);
  assert.match(script, /vla-SaveAs/u);
  assert.match(script, /attmode-pair\.ready/u);
});

test("maps every variable value to its Scene Cache drawing field", () => {
  assert.deepEqual(expectedDrawingVariable("FILLMODE", 0), {
    field: "fillMode",
    value: false,
  });
  assert.deepEqual(expectedDrawingVariable("ATTMODE", 2), {
    field: "attributeDisplayMode",
    value: 2,
  });
  assert.deepEqual(expectedDrawingVariable("ANNOALLVISIBLE", 1), {
    field: "annotationAllVisible",
    value: true,
  });
  assert.deepEqual(expectedDrawingVariable("QTEXTMODE", 1), {
    field: "quickTextMode",
    value: true,
  });
  assert.deepEqual(expectedDrawingVariable("SPLFRAME", 0), {
    field: "splineFrame",
    value: false,
  });
  assert.deepEqual(expectedDrawingVariable("DISPSILH", 1), {
    field: "displaySilhouettes",
    value: true,
  });
  assert.deepEqual(expectedDrawingVariable("XREFOVERRIDE", 1), {
    field: "externalReferenceOverrides",
    value: true,
  });
  assert.deepEqual(expectedDrawingVariable("XCLIPFRAME", 1), {
    field: "xclipFrame",
    value: 1,
  });
  assert.throws(
    () => expectedDrawingVariable("FRAME", 3),
    /unsupported AutoCAD variable value/u,
  );
});
