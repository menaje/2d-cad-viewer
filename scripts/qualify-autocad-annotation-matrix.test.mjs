// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createAutoCadAnnotationScript,
  parseAutoCadAnnotationArguments,
  parseAutoCadAnnotationLog,
} from "./qualify-autocad-annotation-matrix.mjs";

function argumentsFor(overrides = {}) {
  const values = {
    activeScaleName: "1:2",
    activeScaleValue: "2",
    adapter: "adapter.exe",
    autocad: "acad.exe",
    caseId: "annotation-matrix",
    drawing: "blank.dwg",
    observedAt: "2026-08-12T12:00:00Z",
    output: "annotation-output",
    supportedScaleName: "1:1",
    supportedScaleValue: "1",
    ...overrides,
  };
  return [
    "--active-scale-name",
    values.activeScaleName,
    "--active-scale-value",
    values.activeScaleValue,
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
    "--supported-scale-name",
    values.supportedScaleName,
    "--supported-scale-value",
    values.supportedScaleValue,
  ];
}

test("parses bounded AutoCAD annotation matrix inputs", () => {
  const result = parseAutoCadAnnotationArguments(argumentsFor());
  assert.equal(result.adapterPath, path.resolve("adapter.exe"));
  assert.equal(result.autoCadPath, path.resolve("acad.exe"));
  assert.equal(result.drawingPath, path.resolve("blank.dwg"));
  assert.deepEqual(result.supportedScale, { name: "1:1", value: 1 });
  assert.deepEqual(result.activeScale, { name: "1:2", value: 2 });
  assert.throws(
    () =>
      parseAutoCadAnnotationArguments(
        argumentsFor({ activeScaleName: "1:1", activeScaleValue: "1" }),
      ),
    /must differ/u,
  );
  assert.throws(
    () => parseAutoCadAnnotationArguments(argumentsFor({ caseId: "../bad" })),
    /kebab-case/u,
  );
  assert.throws(
    () =>
      parseAutoCadAnnotationArguments(
        argumentsFor({ activeScaleValue: "Infinity" }),
      ),
    /finite positive/u,
  );
});

test("generates a two-camera, four-state AutoCAD annotation matrix", () => {
  const script = createAutoCadAnnotationScript({
    activeScale: { name: "1:2", value: 2 },
    caseId: "annotation-matrix",
    outputDirectory: "C:\\qualification output",
    supportedScale: { name: "1:1", value: 1 },
  });
  assert.equal(script.match(/_\.ZOOM/gu)?.length, 3);
  assert.equal(script.match(/_\.PNGOUT/gu)?.length, 8);
  assert.equal(script.match(/vla-SaveAs/gu)?.length, 8);
  assert.match(script, /AcadAnnotative/u);
  assert.match(script, /AnnotativeData/u);
  assert.match(script, /DWGV_ANNOTATION_ANNOTATION_MATRIX/u);
  assert.match(script, /DWGV_LAYOUT_ANNOTATION_MATRIX/u);
  assert.match(script, /m0-l0-model\.png/u);
  assert.match(script, /m1-l0-layout\.dwg/u);
  assert.match(script, /m1-l1-layout\.png/u);
  assert.match(script, /m0-l1-model\.dwg/u);
  assert.match(script, /C:\/qualification output/u);
  assert.doesNotMatch(script, /C:\\qualification/u);
  assert.match(script, /annotation-matrix\.ready/u);
});

test("parses exact model and layout values for every annotation state", () => {
  const lines = [
    "ACADVER\t25.1s",
    "PLATFORM\tMicrosoft Windows 11",
    "FIXTURE\tAA\tBB\tDWGV_ANNOTATIVE_ANNOTATION_MATRIX\tDWGV_LAYOUT_ANNOTATION_MATRIX\tDWGV_ANNOTATION_ANNOTATION_MATRIX",
  ];
  for (const [id, model, layout] of [
    ["m0-l0", 0, 0],
    ["m1-l0", 1, 0],
    ["m1-l1", 1, 1],
    ["m0-l1", 0, 1],
  ]) {
    lines.push(
      `STATE\t${id}\tmodel\t${model}\t${layout}\tModel\t1\t${model}\t1:2\t2.000000000000`,
      `STATE\t${id}\tlayout\t${model}\t${layout}\tDWGV_LAYOUT_ANNOTATION_MATRIX\t0\t${layout}\t1:2\t2.000000000000`,
    );
  }
  const result = parseAutoCadAnnotationLog(lines.join("\r\n"));
  assert.equal(result.states.length, 8);
  assert.deepEqual(
    result.states.map(({ id, space }) => `${id}:${space}`),
    [
      "m0-l0:model",
      "m0-l0:layout",
      "m1-l0:model",
      "m1-l0:layout",
      "m1-l1:model",
      "m1-l1:layout",
      "m0-l1:model",
      "m0-l1:layout",
    ],
  );
  assert.throws(
    () =>
      parseAutoCadAnnotationLog(
        lines.filter((line) => !line.includes("m1-l1\tlayout")).join("\n"),
      ),
    /Expected values to be strictly deep-equal/u,
  );
});
