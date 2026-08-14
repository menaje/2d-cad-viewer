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
} from "./qualify-reference-display.mjs";

const execFile = promisify(execFileCallback);
const REPORT_SCHEMA = "dwg-autocad-xref-state-matrix/2";
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const AUTOCAD_STARTUP_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Customization/files/GUID-5510017F-4656-478F-BD4C-AB6B1998BF55.htm";
const AUTOCAD_PNGOUT_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-DC273B67-42AC-4A2A-9001-4825FF268E5D.htm";
const AUTOCAD_XREF_REFERENCE =
  "https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-70599862-DF52-4291-B64B-8A4C45599F39.htm";
const EXPECTED_STATES = Object.freeze([
  Object.freeze({ id: "loaded", loaded: true, resolved: true }),
  Object.freeze({ id: "unloaded", loaded: false, resolved: true }),
  Object.freeze({ id: "unresolved", loaded: false, resolved: false }),
]);

function requiredValue(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseAutoCadXrefArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    const key = {
      "--adapter": "adapterPath",
      "--autocad": "autoCadPath",
      "--case-id": "caseId",
      "--child": "childPath",
      "--host": "hostPath",
      "--observed-at": "observedAt",
      "--output-dir": "outputDirectory",
      "--xref-name": "xrefName",
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
    "childPath",
    "hostPath",
    "observedAt",
    "outputDirectory",
    "xrefName",
  ]) {
    if (!result[key]) {
      throw new Error(`${key} is required`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result.caseId)) {
    throw new Error("caseId must be a lowercase kebab-case identifier");
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(result.xrefName)) {
    throw new Error("xrefName must be a bounded AutoCAD identifier");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(
      result.observedAt,
    ) ||
    !Number.isFinite(Date.parse(result.observedAt))
  ) {
    throw new Error("observedAt must be a whole-second UTC timestamp");
  }
  return Object.freeze({
    adapterPath: path.resolve(result.adapterPath),
    autoCadPath: path.resolve(result.autoCadPath),
    caseId: result.caseId,
    childPath: path.resolve(result.childPath),
    hostPath: path.resolve(result.hostPath),
    observedAt: result.observedAt,
    outputDirectory: path.resolve(result.outputDirectory),
    xrefName: result.xrefName,
  });
}

function lispString(value) {
  return value.replaceAll("\\", "/").replaceAll('"', '\\"');
}

function stateStem(caseId, state) {
  return `${caseId}-${state}`;
}

export function createAutoCadXrefScript({
  caseId,
  childFile,
  outputDirectory,
  xrefName,
}) {
  const output = lispString(outputDirectory);
  const child = lispString(path.join(outputDirectory, childFile));
  const relativeChild = `./${lispString(childFile)}`;
  const missingChild = `./${caseId}-intentionally-missing.dwg`;
  const logPath = `${output}/${caseId}-autocad.tsv`;
  const readyPath = `${output}/${caseId}.ready`;
  const capture = (state) => {
    const stem = stateStem(caseId, state);
    return [
      `(command "_.PNGOUT" "${output}/${stem}.png" "")`,
      `(vla-SaveAs dwgv-doc "${output}/${stem}.dwg")`,
      `(dwgv-write (strcat "STATE\\t${state}\\t" (getvar "CTAB") "\\t" (itoa (getvar "TILEMODE")) "\\t" (vla-get-Path dwgv-block) "\\t" (itoa (dwgv-resolved-probe dwgv-block))))`,
    ];
  };
  return [
    "(vl-load-com)",
    "(setq dwgv-doc (vla-get-ActiveDocument (vlax-get-acad-object)))",
    `(setq dwgv-log "${logPath}")`,
    "(defun dwgv-write (value / stream) (setq stream (open dwgv-log \"a\")) (write-line value stream) (close stream))",
    "(defun dwgv-resolved-probe (block / value) (setq value (vl-catch-all-apply 'vla-get-XRefDatabase (list block))) (if (vl-catch-all-error-p value) 0 1))",
    "(dwgv-write (strcat \"ACADVER\\t\" (getvar \"ACADVER\")))",
    "(dwgv-write (strcat \"PLATFORM\\t\" (getvar \"PLATFORM\")))",
    "(setvar \"CMDECHO\" 0)",
    "(setvar \"FILEDIA\" 0)",
    "(setvar \"CMDDIA\" 0)",
    "(setvar \"BACKGROUNDPLOT\" 0)",
    "(setvar \"TILEMODE\" 1)",
    `(if (tblsearch "BLOCK" "${lispString(xrefName)}") (progn (dwgv-write "ERROR\\txref-name-exists") (command "_.QUIT")))`,
    `(setq dwgv-reference (vla-AttachExternalReference (vla-get-ModelSpace dwgv-doc) "${child}" "${lispString(xrefName)}" (vlax-3d-point 0 0 0) 1.0 1.0 1.0 0.0 :vlax-false))`,
    `(setq dwgv-block (vla-Item (vla-get-Blocks dwgv-doc) "${lispString(xrefName)}"))`,
    `(vla-put-Path dwgv-block "${relativeChild}")`,
    "(vla-Reload dwgv-block)",
    "(command \"_.ZOOM\" \"_Extents\")",
    "(command \"_.REGENALL\")",
    ...capture("loaded"),
    "(vla-Unload dwgv-block)",
    "(command \"_.REGENALL\")",
    ...capture("unloaded"),
    `(vla-put-Path dwgv-block "${missingChild}")`,
    "(setq dwgv-reload-result (vl-catch-all-apply 'vla-Reload (list dwgv-block)))",
    "(dwgv-write (strcat \"UNRESOLVED_RELOAD_FAILED\\t\" (if (vl-catch-all-error-p dwgv-reload-result) \"1\" \"0\")))",
    "(command \"_.REGENALL\")",
    ...capture("unresolved"),
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

async function readCacheState(cachePath, xrefName) {
  const bytes = await readFile(cachePath);
  assert.ok(bytes.byteLength <= MAX_SOURCE_BYTES);
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(arrayBuffer),
  );
  const [drawing, blocks] = await Promise.all([
    reader.readDrawing(),
    reader.readBlocks(),
  ]);
  const xrefs = blocks.filter((block) => (block.flags & (1 << 2)) !== 0);
  assert.equal(xrefs.length, 1, "generated host must contain exactly one XREF");
  const xref = xrefs[0];
  assert.equal(
    xref.name.toLocaleLowerCase("en-US"),
    xrefName.toLocaleLowerCase("en-US"),
  );
  return Object.freeze({ drawing, xref });
}

export function parseAutoCadXrefLog(value) {
  const lines = value.trim().split(/\r?\n/u).filter(Boolean);
  const property = (name) =>
    lines.find((line) => line.startsWith(`${name}\t`))?.split("\t")[1];
  assert.equal(property("ACADVER")?.length > 0, true);
  assert.equal(property("PLATFORM")?.length > 0, true);
  validateAutoCad2026Identity(
    property("ACADVER"),
    property("PLATFORM"),
  );
  assert.equal(property("ERROR"), undefined);
  assert.equal(property("UNRESOLVED_RELOAD_FAILED"), "1");
  const states = lines
    .filter((line) => line.startsWith("STATE\t"))
    .map((line) => {
      const [, id, tab, tileMode, storedPath, resolvedProbe] =
        line.split("\t");
      return Object.freeze({
        id,
        tab,
        tileMode: Number(tileMode),
        storedPath,
        resolvedProbe: Number(resolvedProbe),
      });
    });
  assert.deepEqual(
    states.map(({ id }) => id),
    EXPECTED_STATES.map(({ id }) => id),
  );
  assert.equal(states.every(({ tileMode }) => tileMode === 1), true);
  return Object.freeze({
    acadVersion: property("ACADVER"),
    platform: property("PLATFORM"),
    states: Object.freeze(states),
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

export async function qualifyAutoCadXrefMatrix(options) {
  await Promise.all([
    ensureBoundedFile(options.hostPath),
    ensureBoundedFile(options.childPath),
    ensureBoundedFile(options.adapterPath, true),
    ensureBoundedFile(options.autoCadPath, true),
  ]);
  await mkdir(options.outputDirectory);
  const hostCopy = path.join(
    options.outputDirectory,
    `${options.caseId}-source-host.dwg`,
  );
  const childCopy = path.join(
    options.outputDirectory,
    `${options.caseId}-source-child.dwg`,
  );
  await Promise.all([
    copyFile(options.hostPath, hostCopy),
    copyFile(options.childPath, childCopy),
  ]);
  const scriptPath = path.join(
    options.outputDirectory,
    `${options.caseId}.scr`,
  );
  await writeFile(
    scriptPath,
    createAutoCadXrefScript({
      ...options,
      childFile: path.basename(childCopy),
    }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await execFile(
    options.autoCadPath,
    [hostCopy, "/nologo", "/nossm", "/b", scriptPath],
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
  const autoCadLog = parseAutoCadXrefLog(
    await readFile(
      path.join(
        options.outputDirectory,
        `${options.caseId}-autocad.tsv`,
      ),
      "utf8",
    ),
  );
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "dwg-autocad-xref-matrix-"),
  );
  try {
    const childCachePath = path.join(temporaryRoot, "child.cache");
    const childConversion = validateConversionReport(
      await runAdapter(options.adapterPath, [
        "convert",
        childCopy,
        childCachePath,
      ]),
    );
    assert.ok(
      childConversion.coverage.total_entities > 0 &&
        childConversion.coverage.serialized_entities > 0,
      "XREF child must contain displayable source content",
    );
    const states = [];
    for (const expected of EXPECTED_STATES) {
      const stem = stateStem(options.caseId, expected.id);
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
      const cache = await readCacheState(cachePath, options.xrefName);
      assert.equal(cache.xref.xrefLoaded, expected.loaded);
      assert.equal(cache.xref.xrefResolved, expected.resolved);
      assert.ok(cache.xref.referenceCount > 0);
      assert.ok(cache.xref.xrefPath.length > 0);
      assert.equal(path.isAbsolute(cache.xref.xrefPath), false);
      assert.equal(
        cache.xref.xrefPath
          .replaceAll("\\", "/")
          .endsWith(
            expected.id === "unresolved"
              ? `${options.caseId}-intentionally-missing.dwg`
              : path.basename(childCopy),
          ),
        true,
      );
      const pngBytes = await readFile(pngPath);
      states.push(
        Object.freeze({
          id: expected.id,
          autoCad: autoCadLog.states.find(
            (state) => state.id === expected.id,
          ),
          expected: Object.freeze({
            loaded: expected.loaded,
            resolved: expected.resolved,
            displayed: expected.loaded && expected.resolved,
          }),
          drawing: await describeFile(dwgPath),
          referenceImage: Object.freeze({
            ...describePng(pngBytes, path.basename(pngPath)),
            pixelSha256: pngPixelSha256(pngBytes),
          }),
          observedXref: Object.freeze({
            name: cache.xref.name,
            pathKind: "relative",
            loaded: cache.xref.xrefLoaded,
            resolved: cache.xref.xrefResolved,
            referenceCount: cache.xref.referenceCount,
          }),
          conversion: Object.freeze({
            totalEntities: conversion.coverage.total_entities,
            serializedEntities: conversion.coverage.serialized_entities,
            deferredEntities: conversion.coverage.deferred_entities,
            coverage: Object.freeze({ ...conversion.coverage }),
            invalidSupportedEntities:
              conversion.coverage.deferred_reasons
                .invalid_supported_entities,
          }),
        }),
      );
    }
    assert.equal(
      new Set(states.map((state) => state.conversion.totalEntities)).size,
      1,
      "XREF state changes must retain the logical host entity count",
    );
    assert.notEqual(
      states[0].referenceImage.pixelSha256,
      states[1].referenceImage.pixelSha256,
      "loaded and unloaded AutoCAD pixels must differ",
    );
    assert.equal(
      states[1].referenceImage.pixelSha256,
      states[2].referenceImage.pixelSha256,
      "unloaded and unresolved AutoCAD pixels must match",
    );
    const report = Object.freeze({
      schema: REPORT_SCHEMA,
      status: "pass",
      observedAt: options.observedAt,
      target: Object.freeze({
        product: "Autodesk AutoCAD",
        acadVersion: autoCadLog.acadVersion,
        platform: autoCadLog.platform,
        displayMode: "2D Wireframe model space",
      }),
      references: Object.freeze({
        startupScript: AUTOCAD_STARTUP_REFERENCE,
        pngOut: AUTOCAD_PNGOUT_REFERENCE,
        xrefCommand: AUTOCAD_XREF_REFERENCE,
      }),
      adapter: await describeFile(options.adapterPath),
      case: Object.freeze({
        id: options.caseId,
        xrefName: options.xrefName,
        states: Object.freeze(EXPECTED_STATES.map(({ id }) => id)),
        singleSession: true,
        camera: "one ZOOM Extents view retained across every state",
      }),
      sources: Object.freeze({
        host: await describeFile(hostCopy),
        child: Object.freeze({
          ...(await describeFile(childCopy)),
          conversion: Object.freeze({
            totalEntities: childConversion.coverage.total_entities,
            serializedEntities:
              childConversion.coverage.serialized_entities,
            deferredEntities:
              childConversion.coverage.deferred_entities,
            coverage: Object.freeze({ ...childConversion.coverage }),
            invalidSupportedEntities:
              childConversion.coverage.deferred_reasons
                .invalid_supported_entities,
          }),
        }),
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
    const options = parseAutoCadXrefArguments(process.argv.slice(2));
    const report = await qualifyAutoCadXrefMatrix(options);
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
