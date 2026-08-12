#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  MemoryRangeSource,
  SceneCacheReader,
} from "../packages/dwg-scene-source/src/index.mjs";
import {
  describePng,
  pngPixelSha256,
  validateAutoCad2026Identity,
  validateConversionReport,
} from "./qualify-autocad-display-parity.mjs";

const execFile = promisify(execFileCallback);
const REPORT_SCHEMA = "dwg-autocad-annotation-scale-matrix/2";
const CACHE_SCHEMA = "dwg-scene-cache/1.24";
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const AUTOCAD_STARTUP_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Customization/files/GUID-5510017F-4656-478F-BD4C-AB6B1998BF55.htm";
const AUTOCAD_PNGOUT_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-DC273B67-42AC-4A2A-9001-4825FF268E5D.htm";
const AUTOCAD_ANNOALLVISIBLE_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-D8E50F6F-FB71-4A20-A3B9-7701C0518B81.htm";
const AUTOCAD_CANNOSCALE_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-C7111BEE-76AA-481D-AC51-8600A31FA23A.htm";
const MATRIX_STATES = Object.freeze([
  Object.freeze({ id: "m0-l0", model: 0, layout: 0 }),
  Object.freeze({ id: "m1-l0", model: 1, layout: 0 }),
  Object.freeze({ id: "m1-l1", model: 1, layout: 1 }),
  Object.freeze({ id: "m0-l1", model: 0, layout: 1 }),
]);

function requiredValue(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function scaleName(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 .:_/-]{0,63}$/u.test(value) ||
    value.includes("\\")
  ) {
    throw new Error(`${label} must be a bounded AutoCAD scale name`);
  }
  return value;
}

function positiveScale(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1e9) {
    throw new Error(`${label} must be a finite positive scale factor`);
  }
  return parsed;
}

export function parseAutoCadAnnotationArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const key = {
      "--active-scale-name": "activeScaleName",
      "--active-scale-value": "activeScaleValue",
      "--adapter": "adapterPath",
      "--autocad": "autoCadPath",
      "--case-id": "caseId",
      "--drawing": "drawingPath",
      "--observed-at": "observedAt",
      "--output-dir": "outputDirectory",
      "--supported-scale-name": "supportedScaleName",
      "--supported-scale-value": "supportedScaleValue",
    }[option];
    if (!key || result[key] !== undefined) {
      throw new Error(`unsupported or repeated option: ${option}`);
    }
    result[key] = requiredValue(values, index, option);
    index += 1;
  }
  for (const key of [
    "activeScaleName",
    "activeScaleValue",
    "adapterPath",
    "autoCadPath",
    "caseId",
    "drawingPath",
    "observedAt",
    "outputDirectory",
    "supportedScaleName",
    "supportedScaleValue",
  ]) {
    if (!result[key]) {
      throw new Error(`${key} is required`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result.caseId)) {
    throw new Error("caseId must be a lowercase kebab-case identifier");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(
      result.observedAt,
    ) ||
    !Number.isFinite(Date.parse(result.observedAt))
  ) {
    throw new Error("observedAt must be a whole-second UTC timestamp");
  }
  const supported = Object.freeze({
    name: scaleName(result.supportedScaleName, "supported scale"),
    value: positiveScale(result.supportedScaleValue, "supported scale"),
  });
  const active = Object.freeze({
    name: scaleName(result.activeScaleName, "active scale"),
    value: positiveScale(result.activeScaleValue, "active scale"),
  });
  if (
    supported.name === active.name ||
    Math.abs(supported.value - active.value) <=
      Math.max(supported.value, active.value) * 1e-9
  ) {
    throw new Error("supported and active scales must differ");
  }
  return Object.freeze({
    activeScale: active,
    adapterPath: path.resolve(result.adapterPath),
    autoCadPath: path.resolve(result.autoCadPath),
    caseId: result.caseId,
    drawingPath: path.resolve(result.drawingPath),
    observedAt: result.observedAt,
    outputDirectory: path.resolve(result.outputDirectory),
    supportedScale: supported,
  });
}

function lispString(value) {
  return value.replaceAll("\\", "/").replaceAll('"', '\\"');
}

function generatedNames(caseId) {
  const suffix = caseId.replaceAll("-", "_").toUpperCase();
  return Object.freeze({
    layout: `DWGV_LAYOUT_${suffix}`,
    style: `DWGV_ANNOTATIVE_${suffix}`,
    text: `DWGV_ANNOTATION_${suffix}`,
  });
}

function stateStem(caseId, state, space) {
  return `${caseId}-${state}-${space}`;
}

export function createAutoCadAnnotationScript({
  activeScale,
  caseId,
  outputDirectory,
  supportedScale,
}) {
  const output = lispString(outputDirectory);
  const names = generatedNames(caseId);
  const logPath = `${output}/${caseId}-autocad.tsv`;
  const readyPath = `${output}/${caseId}.ready`;
  const stateLines = MATRIX_STATES.flatMap((state) => {
    const modelStem = stateStem(caseId, state.id, "model");
    const layoutStem = stateStem(caseId, state.id, "layout");
    return [
      `(dwgv-set-model ${state.model})`,
      `(dwgv-set-layout ${state.layout})`,
      `(dwgv-set-model ${state.model})`,
      "(command \"_.REGENALL\")",
      `(dwgv-log-state "${state.id}" "model" ${state.model} ${state.layout})`,
      `(command "_.PNGOUT" "${output}/${modelStem}.png" "")`,
      `(vla-SaveAs dwgv-doc "${output}/${modelStem}.dwg")`,
      `(dwgv-set-layout ${state.layout})`,
      "(command \"_.REGENALL\")",
      `(dwgv-log-state "${state.id}" "layout" ${state.model} ${state.layout})`,
      `(command "_.PNGOUT" "${output}/${layoutStem}.png" "")`,
      `(vla-SaveAs dwgv-doc "${output}/${layoutStem}.dwg")`,
    ];
  });
  return [
    "(vl-load-com)",
    "(setq dwgv-app (vlax-get-acad-object))",
    "(setq dwgv-doc (vla-get-ActiveDocument dwgv-app))",
    `(setq dwgv-log "${logPath}")`,
    "(defun dwgv-write (value / stream) (setq stream (open dwgv-log \"a\")) (write-line value stream) (close stream))",
    `(defun dwgv-set-model (value) (vla-put-ActiveSpace dwgv-doc acModelSpace) (setvar "CANNOSCALE" "${lispString(activeScale.name)}") (setvar "ANNOALLVISIBLE" value))`,
    `(defun dwgv-set-layout (value) (vla-put-ActiveLayout dwgv-doc dwgv-layout) (vla-put-ActiveSpace dwgv-doc acPaperSpace) (vla-put-MSpace dwgv-doc :vlax-false) (setvar "ANNOALLVISIBLE" value) (vla-put-MSpace dwgv-doc :vlax-true) (vla-put-ActivePViewport dwgv-doc dwgv-viewport) (setvar "CANNOSCALE" "${lispString(activeScale.name)}") (vla-put-MSpace dwgv-doc :vlax-false))`,
    "(defun dwgv-log-state (state space model-value layout-value) (dwgv-write (strcat \"STATE\\t\" state \"\\t\" space \"\\t\" (itoa model-value) \"\\t\" (itoa layout-value) \"\\t\" (getvar \"CTAB\") \"\\t\" (itoa (getvar \"TILEMODE\")) \"\\t\" (itoa (getvar \"ANNOALLVISIBLE\")) \"\\t\" (getvar \"CANNOSCALE\") \"\\t\" (rtos (getvar \"CANNOSCALEVALUE\") 2 12))))",
    "(dwgv-write (strcat \"ACADVER\\t\" (getvar \"ACADVER\")))",
    "(dwgv-write (strcat \"PLATFORM\\t\" (getvar \"PLATFORM\")))",
    "(setvar \"CMDECHO\" 0)",
    "(setvar \"FILEDIA\" 0)",
    "(setvar \"CMDDIA\" 0)",
    "(setvar \"BACKGROUNDPLOT\" 0)",
    "(setvar \"ANNOAUTOSCALE\" 0)",
    `(if (tblsearch "STYLE" "${names.style}") (progn (dwgv-write "ERROR\\tstyle-name-exists") (command "_.QUIT")))`,
    `(if (member "${names.layout}" (layoutlist)) (progn (dwgv-write "ERROR\\tlayout-name-exists") (command "_.QUIT")))`,
    `(setq dwgv-style (vla-Add (vla-get-TextStyles dwgv-doc) "${names.style}"))`,
    "(vla-put-FontFile dwgv-style \"txt.shx\")",
    "(vla-put-Height dwgv-style 2.5)",
    "(regapp \"AcadAnnotative\")",
    `(setq dwgv-style-entity (tblobjname "STYLE" "${names.style}"))`,
    "(entmod (append (entget dwgv-style-entity) '((-3 (\"AcadAnnotative\" (1000 . \"AnnotativeData\") (1002 . \"{\") (1070 . 1) (1070 . 1) (1002 . \"}\"))))))",
    "(vla-put-ActiveTextStyle dwgv-doc dwgv-style)",
    "(vla-put-ActiveSpace dwgv-doc acModelSpace)",
    `(setvar "CANNOSCALE" "${lispString(supportedScale.name)}")`,
    "(setvar \"ANNOALLVISIBLE\" 0)",
    `(setq dwgv-text (vla-AddText (vla-get-ModelSpace dwgv-doc) "${names.text}" (vlax-3d-point 25.0 25.0 0.0) 2.5))`,
    `(vla-put-StyleName dwgv-text "${names.style}")`,
    "(vla-Update dwgv-text)",
    "(vla-AddLine (vla-get-ModelSpace dwgv-doc) (vlax-3d-point 0 0 0) (vlax-3d-point 100 0 0))",
    "(vla-AddLine (vla-get-ModelSpace dwgv-doc) (vlax-3d-point 100 0 0) (vlax-3d-point 100 50 0))",
    "(vla-AddLine (vla-get-ModelSpace dwgv-doc) (vlax-3d-point 100 50 0) (vlax-3d-point 0 50 0))",
    "(vla-AddLine (vla-get-ModelSpace dwgv-doc) (vlax-3d-point 0 50 0) (vlax-3d-point 0 0 0))",
    "(command \"_.ZOOM\" \"_Window\" \"-10,-10\" \"110,60\")",
    `(setq dwgv-layout (vla-Add (vla-get-Layouts dwgv-doc) "${names.layout}"))`,
    "(vla-put-ActiveLayout dwgv-doc dwgv-layout)",
    "(vla-put-ActiveSpace dwgv-doc acPaperSpace)",
    "(vla-GetPaperSize dwgv-layout 'dwgv-paper-width 'dwgv-paper-height)",
    "(setq dwgv-paper-width (max dwgv-paper-width 1.0))",
    "(setq dwgv-paper-height (max dwgv-paper-height 1.0))",
    "(setq dwgv-viewport (vla-AddPViewport (vla-get-PaperSpace dwgv-doc) (vlax-3d-point (/ dwgv-paper-width 2.0) (/ dwgv-paper-height 2.0) 0.0) (* dwgv-paper-width 0.8) (* dwgv-paper-height 0.8)))",
    "(vla-Display dwgv-viewport :vlax-true)",
    "(vla-put-StandardScale dwgv-viewport acVpCustomScale)",
    `(vla-put-CustomScale dwgv-viewport ${1 / activeScale.value})`,
    "(vla-put-MSpace dwgv-doc :vlax-true)",
    "(vla-put-ActivePViewport dwgv-doc dwgv-viewport)",
    "(command \"_.ZOOM\" \"_Window\" \"-10,-10\" \"110,60\")",
    `(setvar "CANNOSCALE" "${lispString(activeScale.name)}")`,
    "(vla-put-MSpace dwgv-doc :vlax-false)",
    "(command \"_.ZOOM\" \"_Extents\")",
    `(dwgv-write (strcat "FIXTURE\\t" (vla-get-Handle dwgv-text) "\\t" (vla-get-Handle dwgv-viewport) "\\t${names.style}\\t${names.layout}\\t${names.text}"))`,
    ...stateLines,
    `(setq dwgv-ready-stream (open "${readyPath}" "w"))`,
    "(write-line \"pass\" dwgv-ready-stream)",
    "(close dwgv-ready-stream)",
    "(command \"_.QUIT\")",
    "",
  ].join("\r\n");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function describeFile(filePath) {
  const bytes = await readFile(filePath);
  return Object.freeze({
    file: path.basename(filePath),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

async function ensureBoundedFile(filePath, executable = false) {
  await access(filePath, executable ? 1 : 4);
  const metadata = await stat(filePath);
  assert.equal(metadata.isFile(), true, `${path.basename(filePath)} is not a file`);
  assert.ok(
    metadata.size > 0 && metadata.size <= MAX_SOURCE_BYTES,
    `${path.basename(filePath)} is outside the qualification size limit`,
  );
  return metadata;
}

async function runAdapter(adapterPath, args) {
  const { stdout } = await execFile(adapterPath, args, {
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
  });
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) {
    throw new Error("adapter produced no report");
  }
  return JSON.parse(line);
}

function scaleMatches(left, right) {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-6
  );
}

async function readAnnotationCache(
  cachePath,
  { activeScale, layoutName, supportedScale, textValue },
) {
  const bytes = await readFile(cachePath);
  assert.ok(bytes.byteLength <= MAX_SOURCE_BYTES);
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(arrayBuffer),
  );
  const [drawing, layouts, textEntities] = await Promise.all([
    reader.readDrawing(),
    reader.readLayouts(),
    reader.readTextEntities(),
  ]);
  const texts = [];
  for (let index = 0; index < textEntities.length; index += 1) {
    const text = textEntities.get(index);
    if (text.value === textValue) {
      texts.push(text);
    }
  }
  assert.equal(texts.length, 1, "generated annotative TEXT is not unique");
  const text = texts[0];
  assert.notEqual(text.flags & (1 << 2), 0, "generated TEXT is not annotative");
  assert.ok(text.annotationContexts.length > 0);
  assert.equal(
    text.annotationContexts.some((context) =>
      scaleMatches(context.scale, supportedScale.value),
    ),
    true,
    "generated TEXT lacks its supported annotation scale",
  );
  assert.equal(
    text.annotationContexts.some((context) =>
      scaleMatches(context.scale, activeScale.value),
    ),
    false,
    "generated TEXT unexpectedly supports the active annotation scale",
  );
  const matchingLayouts = layouts.filter((layout) => layout.name === layoutName);
  assert.equal(matchingLayouts.length, 1, "generated layout is not unique");
  const layout = matchingLayouts[0];
  const matchingViewports = layout.viewports.filter((viewport) =>
    scaleMatches(viewport.annotationScale, activeScale.value),
  );
  assert.equal(
    matchingViewports.length,
    1,
    "generated layout lacks one exact active-scale viewport",
  );
  return Object.freeze({
    drawing,
    layout,
    text: Object.freeze({
      handle: text.handle.toString(16).toUpperCase(),
      contextScales: Object.freeze(
        text.annotationContexts.map(({ scale }) => scale),
      ),
    }),
    viewport: matchingViewports[0],
  });
}

export function parseAutoCadAnnotationLog(value) {
  const lines = value.trim().split(/\r?\n/u).filter(Boolean);
  const property = (name) =>
    lines.find((line) => line.startsWith(`${name}\t`))?.split("\t").slice(1);
  assert.equal(property("ACADVER")?.[0]?.length > 0, true);
  assert.equal(property("PLATFORM")?.[0]?.length > 0, true);
  validateAutoCad2026Identity(
    property("ACADVER")[0],
    property("PLATFORM")[0],
  );
  assert.equal(property("ERROR"), undefined);
  const fixture = property("FIXTURE");
  assert.equal(fixture?.length, 5);
  const states = lines
    .filter((line) => line.startsWith("STATE\t"))
    .map((line) => {
      const [
        ,
        id,
        space,
        rawModel,
        rawLayout,
        tab,
        rawTileMode,
        rawVisible,
        currentScale,
        rawScaleValue,
      ] = line.split("\t");
      return Object.freeze({
        id,
        space,
        model: Number(rawModel),
        layout: Number(rawLayout),
        tab,
        tileMode: Number(rawTileMode),
        annotationAllVisible: Number(rawVisible),
        currentScale,
        currentScaleValue: Number(rawScaleValue),
      });
    });
  assert.deepEqual(
    states.map(({ id, space }) => `${id}:${space}`),
    MATRIX_STATES.flatMap(({ id }) => [`${id}:model`, `${id}:layout`]),
  );
  return Object.freeze({
    acadVersion: property("ACADVER")[0],
    platform: property("PLATFORM")[0],
    fixture: Object.freeze({
      textHandle: fixture[0],
      viewportHandle: fixture[1],
      styleName: fixture[2],
      layoutName: fixture[3],
      textValue: fixture[4],
    }),
    states: Object.freeze(states),
  });
}

function conversionSummary(conversion) {
  return Object.freeze({
    totalEntities: conversion.coverage.total_entities,
    serializedEntities: conversion.coverage.serialized_entities,
    deferredEntities: conversion.coverage.deferred_entities,
    coverage: Object.freeze({ ...conversion.coverage }),
    sections: Object.freeze(
      Object.fromEntries(
        conversion.cache.sections
          .filter((section) => section.records > 0)
          .map((section) => [section.kind, section.records]),
      ),
    ),
    invalidSupportedEntities:
      conversion.coverage.deferred_reasons.invalid_supported_entities,
  });
}

async function writeJsonExclusive(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function qualifyAutoCadAnnotationMatrix(options) {
  await Promise.all([
    ensureBoundedFile(options.drawingPath),
    ensureBoundedFile(options.adapterPath, true),
    ensureBoundedFile(options.autoCadPath, true),
  ]);
  await mkdir(options.outputDirectory);
  const sourceCopy = path.join(
    options.outputDirectory,
    `${options.caseId}-source.dwg`,
  );
  await copyFile(options.drawingPath, sourceCopy);
  const scriptPath = path.join(
    options.outputDirectory,
    `${options.caseId}.scr`,
  );
  await writeFile(
    scriptPath,
    createAutoCadAnnotationScript(options),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await execFile(
    options.autoCadPath,
    [sourceCopy, "/nologo", "/nossm", "/b", scriptPath],
    {
      encoding: "utf8",
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: false,
    },
  );
  assert.equal(
    (
      await readFile(
        path.join(options.outputDirectory, `${options.caseId}.ready`),
        "utf8",
      )
    ).trim(),
    "pass",
  );
  const autoCadLog = parseAutoCadAnnotationLog(
    await readFile(
      path.join(
        options.outputDirectory,
        `${options.caseId}-autocad.tsv`,
      ),
      "utf8",
    ),
  );
  const names = generatedNames(options.caseId);
  assert.equal(autoCadLog.fixture.styleName, names.style);
  assert.equal(autoCadLog.fixture.layoutName, names.layout);
  assert.equal(autoCadLog.fixture.textValue, names.text);
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "dwg-autocad-annotation-matrix-"),
  );
  try {
    const states = [];
    for (const expected of MATRIX_STATES) {
      const views = {};
      for (const space of ["model", "layout"]) {
        const stem = stateStem(options.caseId, expected.id, space);
        const dwgPath = path.join(options.outputDirectory, `${stem}.dwg`);
        const pngPath = path.join(options.outputDirectory, `${stem}.png`);
        await Promise.all([
          ensureBoundedFile(dwgPath),
          ensureBoundedFile(pngPath),
        ]);
        const cachePath = path.join(temporaryRoot, `${stem}.cache`);
        const conversion = validateConversionReport(
          await runAdapter(options.adapterPath, [
            "convert",
            dwgPath,
            cachePath,
          ]),
        );
        const cache = await readAnnotationCache(cachePath, {
          activeScale: options.activeScale,
          layoutName: names.layout,
          supportedScale: options.supportedScale,
          textValue: names.text,
        });
        assert.equal(cache.drawing.modelSpaceActive, space === "model");
        assert.equal(
          cache.drawing.annotationAllVisible,
          Boolean(expected.model),
        );
        assert.equal(
          cache.layout.annotationAllVisible,
          Boolean(expected.layout),
        );
        if (space === "model") {
          assert.equal(
            scaleMatches(
              cache.drawing.modelAnnotationScale,
              options.activeScale.value,
            ),
            true,
          );
        } else {
          assert.equal(
            scaleMatches(
              cache.viewport.annotationScale,
              options.activeScale.value,
            ),
            true,
          );
        }
        const autoCad = autoCadLog.states.find(
          (state) => state.id === expected.id && state.space === space,
        );
        assert.ok(autoCad);
        assert.equal(autoCad.model, expected.model);
        assert.equal(autoCad.layout, expected.layout);
        assert.equal(autoCad.tileMode, space === "model" ? 1 : 0);
        assert.equal(autoCad.annotationAllVisible, expected[space]);
        assert.equal(autoCad.currentScale, options.activeScale.name);
        assert.equal(
          scaleMatches(autoCad.currentScaleValue, options.activeScale.value),
          true,
        );
        const pngBytes = await readFile(pngPath);
        views[space] = Object.freeze({
          autoCad,
          drawing: await describeFile(dwgPath),
          referenceImage: Object.freeze({
            ...describePng(pngBytes, path.basename(pngPath)),
            pixelSha256: pngPixelSha256(pngBytes),
          }),
          observed: Object.freeze({
            activeAnnotationAllVisible:
              space === "model"
                ? cache.drawing.annotationAllVisible
                : cache.layout.annotationAllVisible,
            modelAnnotationAllVisible:
              cache.drawing.annotationAllVisible,
            layoutAnnotationAllVisible:
              cache.layout.annotationAllVisible,
            modelAnnotationScale: cache.drawing.modelAnnotationScale,
            viewportAnnotationScale: cache.viewport.annotationScale,
            textHandle: cache.text.handle,
            textContextScales: cache.text.contextScales,
          }),
          conversion: conversionSummary(conversion),
        });
      }
      states.push(
        Object.freeze({
          id: expected.id,
          values: Object.freeze({
            model: expected.model,
            layout: expected.layout,
          }),
          views: Object.freeze(views),
        }),
      );
    }
    const byId = new Map(states.map((state) => [state.id, state]));
    assert.notEqual(
      byId.get("m0-l0").views.model.referenceImage.pixelSha256,
      byId.get("m1-l0").views.model.referenceImage.pixelSha256,
      "model ANNOALLVISIBLE did not change AutoCAD pixels",
    );
    assert.notEqual(
      byId.get("m1-l0").views.layout.referenceImage.pixelSha256,
      byId.get("m1-l1").views.layout.referenceImage.pixelSha256,
      "layout ANNOALLVISIBLE did not change AutoCAD pixels",
    );
    assert.equal(
      byId.get("m1-l0").views.model.referenceImage.pixelSha256,
      byId.get("m1-l1").views.model.referenceImage.pixelSha256,
      "layout ANNOALLVISIBLE changed model-space AutoCAD pixels",
    );
    assert.equal(
      byId.get("m1-l1").views.layout.referenceImage.pixelSha256,
      byId.get("m0-l1").views.layout.referenceImage.pixelSha256,
      "model ANNOALLVISIBLE changed layout AutoCAD pixels",
    );
    const entityCounts = states.flatMap((state) =>
      Object.values(state.views).map(
        (view) => view.conversion.totalEntities,
      ),
    );
    assert.equal(
      new Set(entityCounts).size,
      1,
      "annotation state changes must retain the logical entity count",
    );
    const source = await describeFile(sourceCopy);
    const report = Object.freeze({
      schema: REPORT_SCHEMA,
      status: "pass",
      observedAt: options.observedAt,
      target: Object.freeze({
        product: "Autodesk AutoCAD",
        acadVersion: autoCadLog.acadVersion,
        platform: autoCadLog.platform,
        displayMode: "2D Wireframe model and layout",
      }),
      references: Object.freeze({
        startupScript: AUTOCAD_STARTUP_REFERENCE,
        pngOut: AUTOCAD_PNGOUT_REFERENCE,
        annotationAllVisible: AUTOCAD_ANNOALLVISIBLE_REFERENCE,
        currentAnnotationScale: AUTOCAD_CANNOSCALE_REFERENCE,
      }),
      adapter: await describeFile(options.adapterPath),
      case: Object.freeze({
        id: options.caseId,
        layout: names.layout,
        textValue: names.text,
        style: names.style,
        supportedScale: options.supportedScale,
        activeScale: options.activeScale,
        states: Object.freeze(MATRIX_STATES.map(({ id }) => id)),
        singleSession: true,
        cacheSchema: CACHE_SCHEMA,
        singleDrawingViewSwitch: true,
        cameras:
          "one model camera and one layout camera retained across every state",
      }),
      source,
      fixture: autoCadLog.fixture,
      states: Object.freeze(states),
      pathsIncluded: false,
    });
    await writeJsonExclusive(
      path.join(options.outputDirectory, `${options.caseId}.json`),
      report,
    );
    return report;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseAutoCadAnnotationArguments(process.argv.slice(2));
    const report = await qualifyAutoCadAnnotationMatrix(options);
    process.stdout.write(
      `${JSON.stringify({
        schema: report.schema,
        status: report.status,
        case: report.case,
        states: report.states.length,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "qualification failed"}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
