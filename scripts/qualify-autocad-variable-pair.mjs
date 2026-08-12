#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
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
  validateAutoCadPairPixelStates,
  validateConversionReport,
} from "./qualify-autocad-display-parity.mjs";

const execFile = promisify(execFileCallback);
const REPORT_SCHEMA = "dwg-autocad-system-variable-pair/2";
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const AUTOCAD_STARTUP_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Customization/files/GUID-5510017F-4656-478F-BD4C-AB6B1998BF55.htm";
const AUTOCAD_PNGOUT_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-DC273B67-42AC-4A2A-9001-4825FF268E5D.htm";

const VARIABLE_CONTRACTS = Object.freeze({
  FILLMODE: Object.freeze({
    field: "fillMode",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  ATTMODE: Object.freeze({
    field: "attributeDisplayMode",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
  ANNOALLVISIBLE: Object.freeze({
    field: "annotationAllVisible",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  QTEXTMODE: Object.freeze({
    field: "quickTextMode",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  SPLFRAME: Object.freeze({
    field: "splineFrame",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  DISPSILH: Object.freeze({
    field: "displaySilhouettes",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  DISPSILHBLOCKS: Object.freeze({
    field: "displaySilhouettesInBlocks",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  IMAGEQUALITY: Object.freeze({
    field: "rasterImageQualityHigh",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  VISRETAIN: Object.freeze({
    field: "retainExternalReferenceLayers",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  XREFOVERRIDE: Object.freeze({
    field: "externalReferenceOverrides",
    values: Object.freeze([0, 1]),
    normalize: Boolean,
  }),
  FRAME: Object.freeze({
    field: "frame",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
  IMAGEFRAME: Object.freeze({
    field: "imageFrame",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
  XCLIPFRAME: Object.freeze({
    field: "xclipFrame",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
  OLEFRAME: Object.freeze({
    field: "oleFrame",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
  PDFFRAME: Object.freeze({
    field: "pdfFrame",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
  DWFFRAME: Object.freeze({
    field: "dwfFrame",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
  DGNFRAME: Object.freeze({
    field: "dgnFrame",
    values: Object.freeze([0, 1, 2]),
    normalize: Number,
  }),
});

function requiredValue(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseValues(value, contract) {
  const result = value.split(",").map((entry) => Number(entry));
  if (
    result.length < 2 ||
    new Set(result).size !== result.length ||
    result.some(
      (entry) =>
        !Number.isInteger(entry) || !contract.values.includes(entry),
    )
  ) {
    throw new Error(
      `values must be distinct members of ${contract.values.join(",")}`,
    );
  }
  return Object.freeze(result);
}

export function parseAutoCadPairArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const key = {
      "--adapter": "adapterPath",
      "--autocad": "autoCadPath",
      "--case-id": "caseId",
      "--drawing": "drawingPath",
      "--observed-at": "observedAt",
      "--output-dir": "outputDirectory",
      "--layout": "layoutName",
      "--space": "space",
      "--values": "rawValues",
      "--variable": "variable",
    }[option];
    if (!key || result[key] !== undefined) {
      throw new Error(`unsupported or repeated option: ${option}`);
    }
    result[key] = requiredValue(values, index, option);
    index += 1;
  }
  for (const key of [
    "adapterPath",
    "autoCadPath",
    "caseId",
    "drawingPath",
    "observedAt",
    "outputDirectory",
    "rawValues",
    "variable",
  ]) {
    if (!result[key]) {
      throw new Error(`${key} is required`);
    }
  }
  const variable = result.variable.toUpperCase();
  const contract = VARIABLE_CONTRACTS[variable];
  if (!contract) {
    throw new Error(`unsupported AutoCAD variable: ${result.variable}`);
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
  const space = result.space ?? "current";
  if (!["current", "model", "layout"].includes(space)) {
    throw new Error("space must be current, model or layout");
  }
  if (result.layoutName && space !== "layout") {
    throw new Error("layout is accepted only with --space layout");
  }
  return Object.freeze({
    adapterPath: path.resolve(result.adapterPath),
    autoCadPath: path.resolve(result.autoCadPath),
    caseId: result.caseId,
    drawingPath: path.resolve(result.drawingPath),
    observedAt: result.observedAt,
    outputDirectory: path.resolve(result.outputDirectory),
    layoutName: result.layoutName,
    space,
    values: parseValues(result.rawValues, contract),
    variable,
  });
}

function lispString(value) {
  return value
    .replaceAll("\\", "/")
    .replaceAll('"', '\\"');
}

function stateStem(caseId, value) {
  return `${caseId}-${value}`;
}

function autoCadSettingCommand(variable) {
  if (variable === "IMAGEQUALITY") {
    return '  (command "_.IMAGEQUALITY" (if (= (car dwgv-state) 0) "_Draft" "_High"))';
  }
  return `  (setvar "${variable}" (car dwgv-state))`;
}

function autoCadReloadCommand(variable) {
  return variable === "VISRETAIN"
    ? '  (command "_.-XREF" "_Reload" "*")'
    : null;
}

function autoCadObservedExpression(variable) {
  return variable === "IMAGEQUALITY"
    ? '(cdr (assoc 71 (dictsearch (namedobjdict) "ACAD_IMAGE_VARS")))'
    : `(getvar "${variable}")`;
}

export function createAutoCadPairScript({
  caseId,
  layoutName,
  outputDirectory,
  space = "current",
  values,
  variable,
}) {
  const output = lispString(outputDirectory);
  const logPath = `${output}/${caseId}-autocad.tsv`;
  const readyPath = `${output}/${caseId}.ready`;
  const states = values
    .map((value) => `(${value} "${stateStem(caseId, value)}")`)
    .join(" ");
  const settingCommand = autoCadSettingCommand(variable);
  const reloadCommand = autoCadReloadCommand(variable);
  const observedExpression = autoCadObservedExpression(variable);
  const context = [];
  if (space === "model") {
    context.push("(setvar \"TILEMODE\" 1)");
  } else if (space === "layout") {
    context.push("(setvar \"TILEMODE\" 0)");
    if (layoutName) {
      context.push(`(setvar "CTAB" "${lispString(layoutName)}")`);
    }
  }
  return [
    "(vl-load-com)",
    "(setq dwgv-doc (vla-get-ActiveDocument (vlax-get-acad-object)))",
    `(setq dwgv-log "${logPath}")`,
    "(defun dwgv-write (value / stream) (setq stream (open dwgv-log \"a\")) (write-line value stream) (close stream))",
    `(dwgv-write (strcat "ACADVER\\t" (getvar "ACADVER")))`,
    `(dwgv-write (strcat "PLATFORM\\t" (getvar "PLATFORM")))`,
    "(setvar \"CMDECHO\" 0)",
    "(setvar \"FILEDIA\" 0)",
    "(setvar \"CMDDIA\" 0)",
    "(setvar \"BACKGROUNDPLOT\" 0)",
    ...context,
    "(command \"_.ZOOM\" \"_Extents\")",
    `(foreach dwgv-state '(${states})`,
    settingCommand,
    ...(reloadCommand ? [reloadCommand] : []),
    "  (command \"_.REGENALL\")",
    `  (command "_.PNGOUT" (strcat "${output}/" (cadr dwgv-state) ".png") "")`,
    `  (vla-SaveAs dwgv-doc (strcat "${output}/" (cadr dwgv-state) ".dwg"))`,
    `  (dwgv-write (strcat "STATE\\t" (itoa (car dwgv-state)) "\\t" (getvar "CTAB") "\\t" (itoa (getvar "TILEMODE")) "\\t" (vl-princ-to-string ${observedExpression})))`,
    ")",
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

async function readDrawing(cachePath) {
  const bytes = await readFile(cachePath);
  assert.ok(bytes.byteLength <= MAX_SOURCE_BYTES);
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(arrayBuffer),
  );
  return reader.readDrawing();
}

export function expectedDrawingVariable(variable, value) {
  const contract = VARIABLE_CONTRACTS[variable];
  if (!contract || !contract.values.includes(value)) {
    throw new Error("unsupported AutoCAD variable value");
  }
  return Object.freeze({
    field: contract.field,
    value: contract.normalize(value),
  });
}

function parseAutoCadLog(value, expectedStates) {
  const lines = value.trim().split(/\r?\n/u).filter(Boolean);
  const property = (name) =>
    lines.find((line) => line.startsWith(`${name}\t`))?.split("\t")[1];
  const states = lines
    .filter((line) => line.startsWith("STATE\t"))
    .map((line) => {
      const [, rawValue, tab, tileMode, observed] = line.split("\t");
      return {
        value: Number(rawValue),
        tab,
        tileMode: Number(tileMode),
        observed,
      };
    });
  assert.equal(property("ACADVER")?.length > 0, true);
  assert.equal(property("PLATFORM")?.length > 0, true);
  validateAutoCad2026Identity(
    property("ACADVER"),
    property("PLATFORM"),
  );
  assert.deepEqual(
    states.map(({ value }) => value),
    expectedStates,
  );
  return Object.freeze({
    acadVersion: property("ACADVER"),
    platform: property("PLATFORM"),
    states: Object.freeze(states.map((state) => Object.freeze(state))),
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

export async function qualifyAutoCadVariablePair(options) {
  const [sourceMetadata] = await Promise.all([
    ensureBoundedFile(options.drawingPath),
    ensureBoundedFile(options.adapterPath, true),
    ensureBoundedFile(options.autoCadPath, true),
  ]);
  await mkdir(options.outputDirectory);
  const scriptPath = path.join(
    options.outputDirectory,
    `${options.caseId}.scr`,
  );
  await writeFile(scriptPath, createAutoCadPairScript(options), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  await execFile(
    options.autoCadPath,
    [
      options.drawingPath,
      "/nologo",
      "/nossm",
      "/b",
      scriptPath,
    ],
    {
      encoding: "utf8",
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: false,
    },
  );

  const readyPath = path.join(
    options.outputDirectory,
    `${options.caseId}.ready`,
  );
  assert.equal((await readFile(readyPath, "utf8")).trim(), "pass");
  const autoCadLog = parseAutoCadLog(
    await readFile(
      path.join(
        options.outputDirectory,
        `${options.caseId}-autocad.tsv`,
      ),
      "utf8",
    ),
    options.values,
  );
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "dwg-autocad-variable-pair-"),
  );
  try {
    const states = [];
    for (const value of options.values) {
      const stem = stateStem(options.caseId, value);
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
      const drawing = await readDrawing(cachePath);
      const expected = expectedDrawingVariable(options.variable, value);
      assert.deepEqual(
        drawing[expected.field],
        expected.value,
        `${options.variable}=${value} did not survive AutoCAD save and conversion`,
      );
      const [dwg, pngBytes] = await Promise.all([
        describeFile(dwgPath),
        readFile(pngPath),
      ]);
      states.push(
        Object.freeze({
          value,
          autoCad: autoCadLog.states.find(
            (state) => state.value === value,
          ),
          drawing: dwg,
          referenceImage: Object.freeze({
            ...describePng(pngBytes, path.basename(pngPath)),
            pixelSha256: pngPixelSha256(pngBytes),
          }),
          conversion: Object.freeze({
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
              conversion.coverage.deferred_reasons
                .invalid_supported_entities,
          }),
          observedDrawingValue: Object.freeze({
            field: expected.field,
            value: drawing[expected.field],
          }),
        }),
      );
    }
    validateAutoCadPairPixelStates(options.variable, states);

    const source = await readFile(options.drawingPath);
    const report = Object.freeze({
      schema: REPORT_SCHEMA,
      status: "pass",
      observedAt: options.observedAt,
      target: Object.freeze({
        product: "Autodesk AutoCAD",
        acadVersion: autoCadLog.acadVersion,
        platform: autoCadLog.platform,
        displayMode: "saved current 2D view",
      }),
      references: Object.freeze({
        startupScript: AUTOCAD_STARTUP_REFERENCE,
        pngOut: AUTOCAD_PNGOUT_REFERENCE,
      }),
      adapter: await describeFile(options.adapterPath),
      case: Object.freeze({
        id: options.caseId,
        variable: options.variable,
        values: options.values,
        space: options.space,
        layout: options.layoutName ?? null,
        singleSession: true,
        camera: "one ZOOM Extents view retained across every state",
      }),
      source: Object.freeze({
        file: path.basename(options.drawingPath),
        bytes: sourceMetadata.size,
        sha256: sha256(source),
      }),
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
    const options = parseAutoCadPairArguments(process.argv.slice(2));
    const report = await qualifyAutoCadVariablePair(options);
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
