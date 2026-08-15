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
  opendir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import {
  SceneCacheReader,
} from "../packages/dwg-scene-source/src/scene-cache.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPORT_SCHEMA = "dwg-reference-display-qualification/2";
const CONVERSION_SCHEMA = "dwg-scene-cache/1";
const DOCTOR_SCHEMA = "dwg-engine-doctor/1";
const AUTOCAD_PAIR_SCHEMA = "dwg-autocad-system-variable-pair/2";
const AUTOCAD_XREF_SCHEMA = "dwg-autocad-xref-state-matrix/2";
const AUTOCAD_ANNOTATION_SCHEMA =
  "dwg-autocad-annotation-scale-matrix/3";
const CURRENT_CACHE_SCHEMA = "dwg-scene-cache/1.26";
const WINDOWS_VSCODE_UI_SCHEMA = "dwg-windows-vscode-ui-qualification/1";
const MAX_EXTERNAL_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EXTERNAL_ARTIFACT_BYTES = 256 * 1024 * 1024;
const LIBREDWG_SOURCE_SHA256 =
  "62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275";
const WINDOWS_UI_DRAWING_SHA256 =
  "0e74f0aa84b1323c922345f067739c42ee26213dea010b407b87a94212271654";
const AUTOCAD_2026_VERSION_PATTERN =
  /^25\.1s(?:\s+\([^\r\n()]+\))?$/u;
const AUTODESK_SAMPLE_PAGE =
  "https://www.autodesk.com/support/technical/article/caas/tsarticles/ts/6XGQklp3ZcBFqljLPjrnQ9.html";
const AUTODESK_SAMPLE_BASE =
  "https://download.autodesk.com/us/samplefiles/acad/";
const AUTODESK_SAMPLES = Object.freeze([
  ["architectural_-_annotation_scaling_and_multileaders.dwg", "0e74f0aa84b1323c922345f067739c42ee26213dea010b407b87a94212271654"],
  ["architectural_example-imperial.dwg", "52d14a7bdb946099d3cf16fd276d19bd8924348fd02b2ddd0003cd4f6b34cce7"],
  ["blocks_and_tables_-_imperial.dwg", "3c95e8a82d5c8c251483fabc61efa8ca904f4e4bc8c2fce4786d74e812284d07"],
  ["blocks_and_tables_-_metric.dwg", "7d5507da05fb70ba55875d99e676524ca2caa0ed7a5582ad130c3c06e8d925f1"],
  ["civil_example-imperial.dwg", "45b419d0c7382eb271079b80c3237a52183f4fa09e7b495c3d7a65c6baa927dc"],
  ["colorwh.dwg", "7c70a76ce00647770b5026727fd0156a94a11d456db47db97d0bdf5a81acc344"],
  ["lineweights.dwg", "ad2656f141675aeda06ede347f8921516700b60a0f5ba17af042419be5397b4d"],
  ["mechanical_example-imperial.dwg", "854c8ebed8726add72ba4a9a2a19ba0d010372f5cadefb40e648cdf881cad858"],
  ["plot_screening_and_fill_patterns.dwg", "3eb8c946863ca733a289813589ecee8ea383aa63b4c5fa2a22fe31feacf02f71"],
  ["tablet.dwg", "7f203649dc8434ef7cf7a46f7f6def2a0192a1163ba34ebcf88ebfe69635ccd4"],
  ["title_block-ansi.dwg", "907398897552a090182f5446f18ad1ef82b91176764c8ccf08b5c5799546eeba"],
  ["title_block-arch.dwg", "59876d9e1fa9f4d64304d6e7e35cbfafa127e0b5363b3afbe6ed48ef3d2e867d"],
  ["title_block-iso.dwg", "b874d82c5ee04f8a4fa6e907408c4ed770ee8208740fe4e1eb0f96fb2f793bc2"],
  ["truetype.dwg", "1e105bc884972d3d80cd983965d8dfa17f6f392042ec6c5997d99ae347487a92"],
  ["visualization_-_aerial.dwg", "edf22e187337e37d2083b26d6d00ce30ed78d2fd31d6bf0e9869902325ad3ab1"],
  ["visualization_-_condominium_with_skylight.dwg", "1a94d2412b7aac3c1c3ab6fdb2b62c4e8b031e5868ad45d2169f571bfc7cf8d4"],
  ["visualization_-_conference_room.dwg", "0579e4b5746593ff41d9326e488b1faddc0f7cc10e7db5317fc1d5b86f0132c4"],
  ["visualization_-_sun_and_sky_demo.dwg", "fad5a9f95ac72c1ef572b2b69f831ee08492135acd5da5ff76af01b2ec506881"],
].map(([file, digest]) =>
  Object.freeze({ file, sha256: digest, url: `${AUTODESK_SAMPLE_BASE}${file}` }),
));
const MAX_ADAPTER_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CONVERSION_MS = 120_000;
const PUBLIC_FIXTURES = Object.freeze([
  "2004/HatchG.dwg",
  "2004/Underlay.dwg",
  "2013/ConstructionLine.dwg",
  "2013/Multiline.dwg",
  "2013/RAY.dwg",
  "2013/Text.dwg",
  "2013/gh109_1.dwg",
  "r11/ACEB10.dwg",
]);
const AUTOCAD_PROPERTY_FIXTURES = Object.freeze([
  Object.freeze({
    fixture: "2013/ConstructionLine.dwg",
    kind: "xline",
  }),
  Object.freeze({ fixture: "2013/RAY.dwg", kind: "ray" }),
]);
const AUTOCAD_BROWSER_REFERENCE_CASES = Object.freeze([
  Object.freeze({
    browser: "issue-40-construction-line-webview.png",
    drawing: "2013/ConstructionLine.dwg",
  }),
  Object.freeze({
    browser: "issue-40-multiline-webview.png",
    drawing: "2013/Multiline.dwg",
  }),
  Object.freeze({
    browser: "issue-40-ray-webview.png",
    drawing: "2013/RAY.dwg",
  }),
  Object.freeze({
    browser: "issue-40-text-webview.png",
    drawing: "2013/Text.dwg",
  }),
]);
const REQUIRED_BROWSER_EVIDENCE = Object.freeze([
  "issue-40-construction-line-webview.png",
  "issue-40-dark-background-webview.png",
  "issue-40-hatchg-webview.png",
  "issue-40-layout-ctb-webview.png",
  "issue-40-light-background-webview.png",
  "issue-40-model-webview.png",
  "issue-40-multiline-webview.png",
  "issue-40-ray-webview.png",
  "issue-40-stb-diagnostic-webview.png",
  "issue-40-text-webview.png",
  "issue-40-zoom-2x-webview.png",
]);
const PRESENTATION_FIELDS = Object.freeze([
  "fillMode",
  "attributeDisplayMode",
  "annotationAllVisible",
  "modelAnnotationScale",
  "modelSpaceLinetypeScale",
  "paperSpaceLinetypeScale",
  "lineWeightDisplay",
  "modelSpaceActive",
  "wipeoutFrame",
  "imageFrame",
  "xclipFrame",
  "oleFrame",
  "frame",
  "pdfFrame",
  "dwfFrame",
  "dgnFrame",
  "quickTextMode",
  "splineFrame",
  "displaySilhouettes",
  "externalReferenceOverrides",
  "retainExternalReferenceLayers",
  "rasterImageQualityHigh",
  "displaySilhouettesInBlocks",
]);
const AUTOCAD_PAIR_CONTRACTS = Object.freeze({
  FILLMODE: Object.freeze({ field: "fillMode", values: [0, 1] }),
  ATTMODE: Object.freeze({
    field: "attributeDisplayMode",
    values: [0, 1, 2],
  }),
  ANNOALLVISIBLE: Object.freeze({
    field: "annotationAllVisible",
    values: [0, 1],
  }),
  QTEXTMODE: Object.freeze({ field: "quickTextMode", values: [0, 1] }),
  SPLFRAME: Object.freeze({ field: "splineFrame", values: [0, 1] }),
  DISPSILH: Object.freeze({
    field: "displaySilhouettes",
    values: [0, 1],
  }),
  DISPSILHBLOCKS: Object.freeze({
    field: "displaySilhouettesInBlocks",
    values: [0, 1],
  }),
  IMAGEQUALITY: Object.freeze({
    field: "rasterImageQualityHigh",
    values: [0, 1],
  }),
  VISRETAIN: Object.freeze({
    field: "retainExternalReferenceLayers",
    values: [0, 1],
  }),
  XREFOVERRIDE: Object.freeze({
    field: "externalReferenceOverrides",
    values: [0, 1],
  }),
  FRAME: Object.freeze({ field: "frame", values: [0, 1, 2] }),
  IMAGEFRAME: Object.freeze({
    field: "imageFrame",
    values: [0, 1, 2],
  }),
  XCLIPFRAME: Object.freeze({
    field: "xclipFrame",
    values: [0, 1, 2],
  }),
  OLEFRAME: Object.freeze({
    field: "oleFrame",
    values: [0, 1, 2],
  }),
  PDFFRAME: Object.freeze({
    field: "pdfFrame",
    values: [0, 1, 2],
  }),
  DWFFRAME: Object.freeze({
    field: "dwfFrame",
    values: [0, 1, 2],
  }),
  DGNFRAME: Object.freeze({
    field: "dgnFrame",
    values: [0, 1, 2],
  }),
});

function requireValue(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function validateAutoCad2026Identity(acadVersion, platform) {
  assert.equal(typeof acadVersion, "string", "AutoCAD version is missing");
  assert.match(
    acadVersion,
    AUTOCAD_2026_VERSION_PATTERN,
    "qualification must run in AutoCAD 2026",
  );
  assert.equal(typeof platform, "string", "AutoCAD platform is missing");
  assert.match(
    platform,
    /(?:Microsoft\s+)?Windows/iu,
    "AutoCAD qualification must run on Windows",
  );
  return true;
}

export function parseArguments(values) {
  const options = {
    autoCadAnnotationEvidence: [],
    autoCadPairEvidence: [],
    autoCadXrefEvidence: [],
    browserEvidence: [],
  };
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "--browser-evidence") {
      options.browserEvidence.push(
        path.resolve(requireValue(values, index, option)),
      );
      index += 1;
      continue;
    }
    if (option === "--autocad-pair-evidence") {
      options.autoCadPairEvidence.push(
        path.resolve(requireValue(values, index, option)),
      );
      index += 1;
      continue;
    }
    if (option === "--autocad-annotation-evidence") {
      options.autoCadAnnotationEvidence.push(
        path.resolve(requireValue(values, index, option)),
      );
      index += 1;
      continue;
    }
    if (option === "--autocad-xref-evidence") {
      options.autoCadXrefEvidence.push(
        path.resolve(requireValue(values, index, option)),
      );
      index += 1;
      continue;
    }
    const key = {
      "--adapter": "adapterPath",
      "--corpus": "corpusPath",
      "--autodesk-samples": "autodeskSamplesPath",
      "--source-archive": "sourceArchivePath",
      "--output": "outputPath",
      "--observed-at": "observedAt",
      "--windows-vscode-evidence": "windowsVsCodeEvidencePath",
      "--windows-vsix": "windowsVsixPath",
      "--windows-companion-vsix": "windowsCompanionVsixPath",
    }[option];
    if (!key) {
      throw new Error(`unsupported option: ${option}`);
    }
    const value = requireValue(values, index, option);
    options[key] = key === "observedAt" ? value : path.resolve(value);
    index += 1;
  }
  for (const key of [
    "adapterPath",
    "corpusPath",
    "autodeskSamplesPath",
    "sourceArchivePath",
    "outputPath",
    "observedAt",
  ]) {
    if (!options[key]) {
      throw new Error(`${key} is required`);
    }
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(options.observedAt) ||
    !Number.isFinite(Date.parse(options.observedAt))
  ) {
    throw new Error("observedAt must be a whole-second UTC timestamp");
  }
  const windowsInputs = [
    options.windowsVsCodeEvidencePath,
    options.windowsVsixPath,
    options.windowsCompanionVsixPath,
  ].filter(Boolean);
  if (windowsInputs.length !== 0 && windowsInputs.length !== 3) {
    throw new Error(
      "Windows VS Code evidence, viewer VSIX and companion VSIX must be supplied together",
    );
  }
  return Object.freeze({
    ...options,
    autoCadAnnotationEvidence: Object.freeze(
      options.autoCadAnnotationEvidence,
    ),
    autoCadPairEvidence: Object.freeze(options.autoCadPairEvidence),
    autoCadXrefEvidence: Object.freeze(options.autoCadXrefEvidence),
    browserEvidence: Object.freeze(options.browserEvidence),
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

async function collectFiles(root, predicate) {
  const result = [];
  const visit = async (directory) => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(candidate);
      } else if (entry.isFile() && predicate(candidate)) {
        result.push(candidate);
      }
    }
  };
  await visit(root);
  result.sort((left, right) => left.localeCompare(right, "en"));
  return result;
}

function parseJsonLine(output, label) {
  const line = output
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error(`${label} produced no JSON report`);
  }
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${label} produced invalid JSON`);
  }
}

async function runAdapter(adapterPath, args, label) {
  const { stdout } = await execFile(adapterPath, args, {
    encoding: "utf8",
    maxBuffer: MAX_ADAPTER_OUTPUT_BYTES,
    timeout: MAX_CONVERSION_MS,
  });
  return parseJsonLine(stdout, label);
}

class FileRangeSource {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }

  static async open(filePath) {
    const handle = await open(filePath, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)) {
        throw new Error("scene cache is not a bounded file");
      }
      return new FileRangeSource(handle, metadata.size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(offset, length) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    ) {
      throw new RangeError("scene-cache range is outside the file");
    }
    const bytes = new Uint8Array(length);
    let cursor = 0;
    while (cursor < length) {
      const { bytesRead } = await this.handle.read(
        bytes,
        cursor,
        length - cursor,
        offset + cursor,
      );
      if (bytesRead === 0) {
        throw new Error("short scene-cache range read");
      }
      cursor += bytesRead;
    }
    return bytes.buffer;
  }

  async close() {
    await this.handle.close();
  }
}

function reasonTotal(coverage) {
  return Object.values(coverage?.deferred_reasons ?? {}).reduce(
    (total, value) => total + value,
    0,
  );
}

export function validateConversionReport(report) {
  assert.equal(report?.schema, CONVERSION_SCHEMA);
  assert.equal(report?.status, "ok");
  assert.equal(report?.cache?.format_major, 1);
  assert.equal(report?.cache?.format_minor, 26);
  assert.equal(report?.cache?.validated, true);
  assert.equal(report?.cache?.sections?.length, 51);
  const coverage = report?.coverage;
  assert.ok(coverage && typeof coverage === "object");
  for (const value of [
    coverage.total_entities,
    coverage.serialized_entities,
    coverage.deferred_entities,
    ...Object.values(coverage.deferred_reasons ?? {}),
  ]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  assert.equal(
    coverage.total_entities,
    coverage.serialized_entities + coverage.deferred_entities,
  );
  assert.equal(coverage.deferred_entities, reasonTotal(coverage));
  assert.equal(coverage.invalid_supported_entities, undefined);
  assert.equal(
    coverage.deferred_reasons.invalid_supported_entities,
    0,
    "a parsed member of a supported family must not be silently invalid",
  );
  assert.equal(report?.tables?.omitted_referenced_linetypes, 0);
  return report;
}

function addNumericTree(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Number.isSafeInteger(value) && value >= 0) {
      target[key] = (target[key] ?? 0) + value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] ??= {};
      addNumericTree(target[key], value);
    }
  }
  return target;
}

export function aggregateCoverage(reports) {
  const result = {};
  for (const report of reports) {
    addNumericTree(result, validateConversionReport(report).coverage);
  }
  assert.equal(
    result.total_entities,
    result.serialized_entities + result.deferred_entities,
  );
  assert.equal(result.deferred_entities, reasonTotal(result));
  return result;
}

function normalizedState(value) {
  if (value === null || value === undefined) {
    return "unavailable";
  }
  return String(value);
}

export function summarizePresentation(drawings) {
  const summary = Object.fromEntries(
    PRESENTATION_FIELDS.map((field) => [field, {}]),
  );
  for (const drawing of drawings) {
    for (const field of PRESENTATION_FIELDS) {
      const state = normalizedState(drawing[field]);
      summary[field][state] = (summary[field][state] ?? 0) + 1;
    }
  }
  return summary;
}

export function viewportModeSummary(layouts) {
  const summary = {
    total: 0,
    inactiveOrOff: 0,
    perspectiveDeferred: 0,
    frontClippingDeferred: 0,
    backClippingDeferred: 0,
    nonWireframeDeferred: 0,
  };
  for (const layout of layouts) {
    for (const viewport of layout.viewports) {
      summary.total += 1;
      if (
        (viewport.flags & 1) !== 0 ||
        viewport.on <= 0 ||
        (viewport.status & 0x20000) !== 0 ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.viewHeight <= 0
      ) {
        summary.inactiveOrOff += 1;
      }
      if ((viewport.status & 1) !== 0) {
        summary.perspectiveDeferred += 1;
      }
      if ((viewport.status & 2) !== 0) {
        summary.frontClippingDeferred += 1;
      }
      if ((viewport.status & 4) !== 0) {
        summary.backClippingDeferred += 1;
      }
      if (viewport.renderMode > 1) {
        summary.nonWireframeDeferred += 1;
      }
    }
  }
  return summary;
}

export function layoutAnnotationVisibilitySummary(layouts) {
  const summary = {
    model: { true: 0, false: 0, unavailable: 0 },
    paper: { true: 0, false: 0, unavailable: 0 },
  };
  for (const layout of layouts) {
    const kind = layout.index === 0 ? "model" : "paper";
    const state = normalizedState(layout.annotationAllVisible);
    if (!Object.hasOwn(summary[kind], state)) {
      throw new Error("layout contains an invalid ANNOALLVISIBLE value");
    }
    summary[kind][state] += 1;
  }
  return summary;
}

export function layoutPaperSpaceLinetypeScaleSummary(layouts) {
  const summary = { true: 0, false: 0 };
  for (const layout of layouts.filter((candidate) => candidate.index > 0)) {
    summary[(layout.flags & 1) !== 0 ? "true" : "false"] += 1;
  }
  return summary;
}

export function savedCurrentTabSummary(records) {
  const summary = {
    model: 0,
    paper: 0,
    paperResolved: 0,
    paperMissing: 0,
    paperAmbiguous: 0,
    paperLegacyNoLayouts: 0,
    paperExceptions: [],
  };
  for (const record of records) {
    if (record.drawing.modelSpaceActive) {
      summary.model += 1;
      continue;
    }
    summary.paper += 1;
    const matches = record.layouts.filter(
      (layout) =>
        record.blocks[layout.blockIndex]?.name.toUpperCase() ===
        "*PAPER_SPACE",
    );
    if (matches.length === 1) {
      summary.paperResolved += 1;
    } else if (
      matches.length === 0 &&
      record.layouts.length === 0 &&
      record.drawing.version < 1012
    ) {
      summary.paperLegacyNoLayouts += 1;
      summary.paperExceptions.push({
        fixture: record.fixture,
        state: "legacy-no-layouts",
      });
    } else if (matches.length === 0) {
      summary.paperMissing += 1;
      summary.paperExceptions.push({ fixture: record.fixture, state: "missing" });
    } else {
      summary.paperAmbiguous += 1;
      summary.paperExceptions.push({
        fixture: record.fixture,
        state: "ambiguous",
      });
    }
  }
  return summary;
}

function plotStyleSummary(layouts) {
  const summary = { empty: 0, ctb: 0, stb: 0, other: 0 };
  for (const layout of layouts.filter((candidate) => candidate.index > 0)) {
    const value = layout.styleSheet.trim().toLocaleLowerCase("en-US");
    if (!value) {
      summary.empty += 1;
    } else if (value.endsWith(".ctb")) {
      summary.ctb += 1;
    } else if (value.endsWith(".stb")) {
      summary.stb += 1;
    } else {
      summary.other += 1;
    }
  }
  return summary;
}

async function readCacheMetadata(cachePath, includeConstructionLines = false) {
  const source = await FileRangeSource.open(cachePath);
  try {
    const reader = await SceneCacheReader.open(source);
    const [drawing, blocks, layouts] = await Promise.all([
      reader.readDrawing(),
      reader.readBlocks(),
      reader.readLayouts(),
    ]);
    const constructionLines = [];
    if (includeConstructionLines) {
      const source = await reader.readCurveRefinementSource();
      for (let index = 0; index < source.constructionLines.length; index += 1) {
        constructionLines.push(
          source.constructionLines.readEntity(index, {
            point: [0, 0, 0],
            direction: [0, 0, 0],
          }),
        );
      }
    }
    return { drawing, blocks, layouts, constructionLines };
  } finally {
    await source.close();
  }
}

function safeRelative(root, filePath) {
  const relative = path.relative(root, filePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("qualification path is outside its declared root");
  }
  return relative.split(path.sep).join("/");
}

function pngDimensions(bytes) {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  ) {
    throw new Error("Browser evidence must be a PNG image");
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

export function describePng(bytes, file) {
  const dimensions = pngDimensions(bytes);
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
  return {
    file,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...dimensions,
  };
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function pngPixelSha256(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    bytes = Buffer.from(bytes);
  }
  pngDimensions(bytes);
  let cursor = 8;
  let header = null;
  let ended = false;
  const compressed = [];
  while (cursor + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(cursor);
    const typeOffset = cursor + 4;
    const dataOffset = cursor + 8;
    const end = dataOffset + length;
    if (
      length > MAX_EXTERNAL_ARTIFACT_BYTES ||
      end + 4 > bytes.byteLength
    ) {
      throw new Error("PNG chunk is outside the bounded image");
    }
    const type = bytes.toString("ascii", typeOffset, typeOffset + 4);
    if (type === "IHDR") {
      if (header || length !== 13) {
        throw new Error("PNG IHDR is invalid");
      }
      header = Object.freeze({
        width: bytes.readUInt32BE(dataOffset),
        height: bytes.readUInt32BE(dataOffset + 4),
        bitDepth: bytes[dataOffset + 8],
        colorType: bytes[dataOffset + 9],
        compression: bytes[dataOffset + 10],
        filter: bytes[dataOffset + 11],
        interlace: bytes[dataOffset + 12],
      });
    } else if (type === "IDAT") {
      compressed.push(bytes.subarray(dataOffset, end));
    } else if (type === "IEND") {
      if (length !== 0) {
        throw new Error("PNG IEND is invalid");
      }
      ended = true;
      cursor = end + 4;
      break;
    }
    cursor = end + 4;
  }
  if (!header || !ended || compressed.length === 0) {
    throw new Error("PNG raster chunks are incomplete");
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  if (
    header.bitDepth !== 8 ||
    !channels ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    throw new Error("PNG raster encoding is outside the qualification subset");
  }
  const rowBytes = header.width * channels;
  const expectedBytes = (rowBytes + 1) * header.height;
  if (
    !Number.isSafeInteger(rowBytes) ||
    !Number.isSafeInteger(expectedBytes) ||
    rowBytes <= 0 ||
    expectedBytes > MAX_EXTERNAL_ARTIFACT_BYTES
  ) {
    throw new Error("PNG raster exceeds the qualification limit");
  }
  const filtered = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expectedBytes,
  });
  if (filtered.byteLength !== expectedBytes) {
    throw new Error("PNG raster byte length differs from IHDR");
  }
  const raster = Buffer.allocUnsafe(rowBytes * header.height);
  for (let row = 0; row < header.height; row += 1) {
    const sourceOffset = row * (rowBytes + 1);
    const targetOffset = row * rowBytes;
    const filter = filtered[sourceOffset];
    if (filter > 4) {
      throw new Error("PNG row filter is invalid");
    }
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = filtered[sourceOffset + 1 + column];
      const left = column >= channels
        ? raster[targetOffset + column - channels]
        : 0;
      const above = row > 0
        ? raster[targetOffset + column - rowBytes]
        : 0;
      const upperLeft = row > 0 && column >= channels
        ? raster[targetOffset + column - rowBytes - channels]
        : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upperLeft);
      raster[targetOffset + column] = (raw + predictor) & 0xff;
    }
  }
  const identity = Buffer.allocUnsafe(10);
  identity.writeUInt32BE(header.width, 0);
  identity.writeUInt32BE(header.height, 4);
  identity[8] = header.colorType;
  identity[9] = channels;
  return createHash("sha256").update(identity).update(raster).digest("hex");
}

function evidenceFileName(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== path.basename(value) ||
    value.includes("\\")
  ) {
    throw new Error(`${label} must be a basename without a path`);
  }
  return value;
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

async function verifyExternalArtifact(
  filePath,
  descriptor,
  label,
  { png = false, requirePngDimensions = false } = {},
) {
  assert.ok(descriptor && typeof descriptor === "object");
  const file = evidenceFileName(descriptor.file, `${label} file`);
  assert.equal(path.basename(filePath), file, `${label} filename differs`);
  assert.ok(
    Number.isSafeInteger(descriptor.bytes) &&
      descriptor.bytes > 0 &&
      descriptor.bytes <= MAX_EXTERNAL_ARTIFACT_BYTES,
    `${label} byte length is invalid`,
  );
  assert.equal(validSha256(descriptor.sha256), true);
  const metadata = await stat(filePath);
  assert.equal(metadata.isFile(), true, `${label} is not a file`);
  assert.equal(metadata.size, descriptor.bytes, `${label} size differs`);
  const bytes = await readFile(filePath);
  assert.equal(sha256(bytes), descriptor.sha256, `${label} hash differs`);
  if (png) {
    const actual = describePng(bytes, file);
    if (requirePngDimensions) {
      assert.ok(
        Number.isSafeInteger(descriptor.width) && descriptor.width > 0,
        `${label} PNG width is invalid`,
      );
      assert.ok(
        Number.isSafeInteger(descriptor.height) && descriptor.height > 0,
        `${label} PNG height is invalid`,
      );
    }
    for (const key of ["file", "bytes", "sha256", "width", "height"]) {
      if (descriptor[key] !== undefined) {
        assert.equal(actual[key], descriptor[key], `${label} PNG ${key} differs`);
      }
    }
    return actual;
  }
  return Object.freeze({ file, bytes: bytes.byteLength, sha256: sha256(bytes) });
}

async function verifyPairArtifact(
  directory,
  descriptor,
  label,
  options = {},
) {
  const file = evidenceFileName(descriptor?.file, `${label} file`);
  return verifyExternalArtifact(
    path.join(directory, file),
    descriptor,
    label,
    options,
  );
}

function validateAutoCadAdapterDescriptor(value) {
  assert.ok(value && typeof value === "object", "AutoCAD adapter is missing");
  const file = evidenceFileName(value.file, "AutoCAD adapter file");
  assert.equal(
    path.extname(file).toLocaleLowerCase("en-US"),
    ".exe",
    "AutoCAD qualification adapter must target Windows",
  );
  assert.ok(
    Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= MAX_EXTERNAL_ARTIFACT_BYTES,
    "AutoCAD adapter byte count is invalid",
  );
  assert.equal(validSha256(value.sha256), true, "AutoCAD adapter hash is invalid");
  return Object.freeze({ file, bytes: value.bytes, sha256: value.sha256 });
}

export function summarizeAutoCadAdapterEvidence(evidence) {
  const adapters = evidence.map(({ report }) =>
    validateAutoCadAdapterDescriptor(report?.adapter),
  );
  assert.ok(
    new Set(
      adapters.map(
        ({ file, bytes, sha256: digest }) => `${file}\0${bytes}\0${digest}`,
      ),
    ).size <= 1,
    "AutoCAD evidence was generated by different adapter artifacts",
  );
  return adapters[0] ?? null;
}

function normalizedPairValue(variable, value) {
  return [
    "FILLMODE",
    "ANNOALLVISIBLE",
    "QTEXTMODE",
    "SPLFRAME",
    "DISPSILH",
    "DISPSILHBLOCKS",
    "IMAGEQUALITY",
    "VISRETAIN",
    "XREFOVERRIDE",
  ].includes(variable)
    ? Boolean(value)
    : value;
}

function relevantPairSourceCount(variable, state) {
  const coverage = state.conversion.coverage;
  const sections = state.conversion.sections;
  switch (variable) {
    case "FILLMODE":
      return (
        (coverage.hatches ?? 0) +
        (coverage.solids ?? 0) +
        (coverage.traces ?? 0)
      );
    case "ATTMODE":
      return (
        (coverage.attribute_definitions ?? 0) +
        (coverage.attributes ?? 0)
      );
    case "ANNOALLVISIBLE":
      return sections.text_annotation_contexts ?? 0;
    case "QTEXTMODE":
      return (
        (coverage.texts ?? 0) +
        (coverage.mtexts ?? 0) +
        (coverage.attribute_definitions ?? 0) +
        (coverage.attributes ?? 0)
      );
    case "SPLFRAME":
      return (
        (coverage.faces ?? 0) +
        (coverage.polyline_meshes ?? 0)
      );
    case "DISPSILH":
    case "DISPSILHBLOCKS":
      return (
        (coverage.regions ?? 0) +
        (coverage.solids_3d ?? 0) +
        (coverage.bodies ?? 0)
      );
    case "IMAGEQUALITY":
      return coverage.images ?? 0;
    case "VISRETAIN":
    case "XREFOVERRIDE":
      return sections.blocks ?? 0;
    case "IMAGEFRAME":
      return coverage.images ?? 0;
    case "XCLIPFRAME":
      return sections.insert_clips ?? 0;
    case "OLEFRAME":
      return coverage.ole2frames ?? 0;
    case "FRAME":
      return (
        (coverage.images ?? 0) +
        (coverage.wipeouts ?? 0) +
        (coverage.ole2frames ?? 0) +
        (sections.insert_clips ?? 0) +
        (coverage.deferred_reasons?.unsupported_underlays ?? 0)
      );
    case "PDFFRAME":
    case "DWFFRAME":
    case "DGNFRAME":
      return coverage.deferred_reasons?.unsupported_underlays ?? 0;
    default:
      return 0;
  }
}

export function validateAutoCadPairPixelStates(variable, states) {
  const hashes = new Map(
    states.map((state) => [state.value, state.referenceImage?.pixelSha256]),
  );
  for (const hash of hashes.values()) {
    assert.equal(validSha256(hash), true, "AutoCAD pair pixel hash is invalid");
  }
  const differs = (left, right) => {
    assert.notEqual(
      hashes.get(left),
      hashes.get(right),
      `${variable}=${left}/${right} did not change AutoCAD display pixels`,
    );
  };
  if (
    [
      "FILLMODE",
      "ANNOALLVISIBLE",
      "QTEXTMODE",
      "SPLFRAME",
      "DISPSILH",
      "DISPSILHBLOCKS",
      "IMAGEQUALITY",
      "VISRETAIN",
      "XREFOVERRIDE",
    ].includes(variable)
  ) {
    differs(0, 1);
  } else if (variable === "ATTMODE") {
    differs(0, 1);
    differs(1, 2);
    differs(0, 2);
  } else if (
    [
      "FRAME",
      "IMAGEFRAME",
      "XCLIPFRAME",
      "OLEFRAME",
      "PDFFRAME",
      "DWFFRAME",
      "DGNFRAME",
    ].includes(variable)
  ) {
    differs(0, 1);
    differs(0, 2);
    assert.equal(
      hashes.get(1),
      hashes.get(2),
      `${variable}=1/2 must have identical screen pixels; value 2 differs only when plotting`,
    );
  }
  return true;
}

export async function readAutoCadPairEvidence(filePath) {
  const metadata = await stat(filePath);
  assert.equal(metadata.isFile(), true, "AutoCAD pair report is not a file");
  assert.ok(
    metadata.size > 0 && metadata.size <= MAX_EXTERNAL_EVIDENCE_BYTES,
    "AutoCAD pair report is outside the size limit",
  );
  const bytes = await readFile(filePath);
  const report = JSON.parse(bytes.toString("utf8"));
  assert.equal(report.schema, AUTOCAD_PAIR_SCHEMA);
  assert.equal(report.status, "pass");
  assert.equal(report.pathsIncluded, false);
  assert.equal(report.target?.product, "Autodesk AutoCAD");
  validateAutoCad2026Identity(
    report.target?.acadVersion,
    report.target?.platform,
  );
  assert.equal(report.target?.displayMode, "saved current 2D view");
  validateAutoCadAdapterDescriptor(report.adapter);
  assert.match(report.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  assert.equal(Number.isFinite(Date.parse(report.observedAt)), true);
  assert.match(report.case?.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  const contract = AUTOCAD_PAIR_CONTRACTS[report.case?.variable];
  assert.ok(contract, "AutoCAD pair uses an unsupported variable");
  assert.ok(
    ["current", "model", "layout"].includes(report.case.space),
    "AutoCAD pair space is invalid",
  );
  if (report.case.space === "layout") {
    assert.equal(typeof report.case.layout, "string");
    assert.ok(report.case.layout.length > 0);
  } else {
    assert.equal(report.case.layout, null);
  }
  assert.equal(report.case.singleSession, true);
  assert.equal(
    report.case.camera,
    "one ZOOM Extents view retained across every state",
  );
  assert.ok(Array.isArray(report.case.values));
  assert.equal(new Set(report.case.values).size, report.case.values.length);
  assert.ok(report.case.values.length >= 2);
  assert.equal(
    report.case.values.every((value) => contract.values.includes(value)),
    true,
  );
  assert.ok(report.source && typeof report.source === "object");
  evidenceFileName(report.source.file, "AutoCAD pair source file");
  assert.ok(
    Number.isSafeInteger(report.source.bytes) && report.source.bytes > 0,
  );
  assert.equal(validSha256(report.source.sha256), true);
  assert.ok(Array.isArray(report.states));
  assert.deepEqual(
    report.states.map((state) => state.value),
    report.case.values,
  );
  const directory = path.dirname(filePath);
  for (const state of report.states) {
    const stem = `${report.case.id}-${state.value}`;
    assert.equal(state.drawing?.file, `${stem}.dwg`);
    assert.equal(state.referenceImage?.file, `${stem}.png`);
    assert.equal(state.autoCad?.value, state.value);
    assert.ok([0, 1].includes(state.autoCad?.tileMode));
    assert.equal(typeof state.autoCad?.tab, "string");
    assert.ok(state.autoCad.tab.length > 0);
    if (report.case.space === "model") {
      assert.equal(state.autoCad.tileMode, 1);
    } else if (report.case.space === "layout") {
      assert.equal(state.autoCad.tileMode, 0);
      assert.equal(state.autoCad.tab, report.case.layout);
    }
    assert.equal(state.autoCad.observed, String(state.value));
    const expected = normalizedPairValue(report.case.variable, state.value);
    assert.deepEqual(state.observedDrawingValue, {
      field: contract.field,
      value: expected,
    });
    const conversion = state.conversion;
    assert.ok(conversion && typeof conversion === "object");
    assert.equal(
      conversion.totalEntities,
      conversion.serializedEntities + conversion.deferredEntities,
    );
    assert.equal(conversion.coverage?.total_entities, conversion.totalEntities);
    assert.equal(
      conversion.coverage?.serialized_entities,
      conversion.serializedEntities,
    );
    assert.equal(
      conversion.coverage?.deferred_entities,
      conversion.deferredEntities,
    );
    assert.equal(conversion.invalidSupportedEntities, 0);
    assert.equal(
      conversion.coverage?.deferred_reasons?.invalid_supported_entities,
      0,
    );
    assert.ok(
      relevantPairSourceCount(report.case.variable, state) > 0,
      `${report.case.variable} pair has no relevant source content`,
    );
    const [, referenceImage] = await Promise.all([
      verifyPairArtifact(directory, state.drawing, "AutoCAD pair DWG"),
      verifyPairArtifact(
        directory,
        state.referenceImage,
        "AutoCAD pair reference image",
        { png: true, requirePngDimensions: true },
      ),
    ]);
    assert.equal(validSha256(state.referenceImage.pixelSha256), true);
    assert.equal(
      pngPixelSha256(
        await readFile(path.join(directory, state.referenceImage.file)),
      ),
      state.referenceImage.pixelSha256,
      "AutoCAD pair decoded pixels differ",
    );
    assert.equal(
      `${referenceImage.width}x${referenceImage.height}`,
      `${state.referenceImage.width}x${state.referenceImage.height}`,
    );
  }
  assert.equal(
    new Set(
      report.states.map((state) => state.conversion.totalEntities),
    ).size,
    1,
    "AutoCAD variable pair changed its logical entity count",
  );
  validateAutoCadPairPixelStates(report.case.variable, report.states);
  return Object.freeze({
    file: path.basename(filePath),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    report,
  });
}

export function summarizeAutoCadPairCoverage(evidence) {
  const orderedEvidence = [...evidence].sort((left, right) =>
    left.report.case.id.localeCompare(right.report.case.id, "en"),
  );
  const cases = orderedEvidence.map(({ report }) => ({
    id: report.case.id,
    variable: report.case.variable,
    values: report.case.values,
    space: report.case.space,
    layout: report.case.layout,
  }));
  assert.equal(
    new Set(cases.map(({ id }) => id)).size,
    cases.length,
    "AutoCAD pair case ids must be unique",
  );
  const covers = (variable, values, space = null) =>
    cases.some(
      (entry) =>
        entry.variable === variable &&
        (!space || entry.space === space) &&
        values.every((value) => entry.values.includes(value)),
    );
  const requirements = [
    ["FILLMODE-0-1", covers("FILLMODE", [0, 1])],
    ["ATTMODE-0-1-2", covers("ATTMODE", [0, 1, 2])],
    ["QTEXTMODE-0-1", covers("QTEXTMODE", [0, 1])],
    ["SPLFRAME-0-1", covers("SPLFRAME", [0, 1])],
    ["DISPSILH-0-1", covers("DISPSILH", [0, 1])],
    [
      "DISPSILHBLOCKS-0-1",
      covers("DISPSILHBLOCKS", [0, 1]),
    ],
    ["IMAGEQUALITY-0-1", covers("IMAGEQUALITY", [0, 1])],
    ["VISRETAIN-0-1", covers("VISRETAIN", [0, 1])],
    ["XREFOVERRIDE-0-1", covers("XREFOVERRIDE", [0, 1])],
    [
      "ANNOALLVISIBLE-model-0-1",
      covers("ANNOALLVISIBLE", [0, 1], "model"),
    ],
    [
      "ANNOALLVISIBLE-layout-0-1",
      covers("ANNOALLVISIBLE", [0, 1], "layout"),
    ],
    ["FRAME-0-1-2", covers("FRAME", [0, 1, 2])],
    ["IMAGEFRAME-0-1-2", covers("IMAGEFRAME", [0, 1, 2])],
    ["XCLIPFRAME-0-1-2", covers("XCLIPFRAME", [0, 1, 2])],
    ["OLEFRAME-0-1-2", covers("OLEFRAME", [0, 1, 2])],
  ];
  const missing = requirements
    .filter(([, covered]) => !covered)
    .map(([name]) => name);
  return Object.freeze({
    reports: orderedEvidence.map(({ file, sha256: digest, bytes }) => ({
      file,
      bytes,
      sha256: digest,
    })),
    cases: Object.freeze(cases.map((entry) => Object.freeze(entry))),
    missing: Object.freeze(missing),
    complete: missing.length === 0,
  });
}

function validateExternalConversionSummary(value, label) {
  assert.ok(value && typeof value === "object", `${label} is missing`);
  for (const key of [
    "totalEntities",
    "serializedEntities",
    "deferredEntities",
    "invalidSupportedEntities",
  ]) {
    assert.ok(
      Number.isSafeInteger(value[key]) && value[key] >= 0,
      `${label} ${key} is invalid`,
    );
  }
  assert.equal(
    value.totalEntities,
    value.serializedEntities + value.deferredEntities,
    `${label} source partition differs`,
  );
  assert.equal(value.coverage?.total_entities, value.totalEntities);
  assert.equal(
    value.coverage?.serialized_entities,
    value.serializedEntities,
  );
  assert.equal(
    value.coverage?.deferred_entities,
    value.deferredEntities,
  );
  assert.equal(value.invalidSupportedEntities, 0);
  assert.equal(
    value.coverage?.deferred_reasons?.invalid_supported_entities,
    0,
  );
  return value;
}

function relativeEvidencePath(value, label) {
  assert.equal(typeof value, "string", `${label} is missing`);
  assert.ok(value.length > 0 && value.length <= 260, `${label} is invalid`);
  assert.doesNotMatch(
    value,
    /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/u,
    `${label} discloses an absolute path`,
  );
  return value;
}

export async function readAutoCadXrefEvidence(filePath) {
  const metadata = await stat(filePath);
  assert.equal(metadata.isFile(), true, "AutoCAD XREF report is not a file");
  assert.ok(
    metadata.size > 0 && metadata.size <= MAX_EXTERNAL_EVIDENCE_BYTES,
    "AutoCAD XREF report is outside the size limit",
  );
  const bytes = await readFile(filePath);
  const report = JSON.parse(bytes.toString("utf8"));
  assert.equal(report.schema, AUTOCAD_XREF_SCHEMA);
  assert.equal(report.status, "pass");
  assert.equal(report.pathsIncluded, false);
  assert.equal(report.target?.product, "Autodesk AutoCAD");
  validateAutoCad2026Identity(
    report.target?.acadVersion,
    report.target?.platform,
  );
  assert.equal(report.target?.displayMode, "2D Wireframe model space");
  validateAutoCadAdapterDescriptor(report.adapter);
  assert.match(report.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  assert.equal(Number.isFinite(Date.parse(report.observedAt)), true);
  assert.match(report.case?.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assert.match(report.case?.xrefName, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
  assert.deepEqual(report.case?.states, [
    "loaded",
    "unloaded",
    "unresolved",
  ]);
  assert.equal(report.case?.singleSession, true);
  assert.equal(
    report.case?.camera,
    "one ZOOM Extents view retained across every state",
  );
  const directory = path.dirname(filePath);
  const hostFile = `${report.case.id}-source-host.dwg`;
  const childFile = `${report.case.id}-source-child.dwg`;
  assert.equal(report.sources?.host?.file, hostFile);
  assert.equal(report.sources?.child?.file, childFile);
  await Promise.all([
    verifyPairArtifact(directory, report.sources.host, "AutoCAD XREF host source"),
    verifyPairArtifact(directory, report.sources.child, "AutoCAD XREF child source"),
  ]);
  const childConversion = validateExternalConversionSummary(
    report.sources.child.conversion,
    "AutoCAD XREF child conversion",
  );
  assert.ok(
    childConversion.totalEntities > 0 &&
      childConversion.serializedEntities > 0,
    "AutoCAD XREF child contains no displayable source content",
  );
  assert.ok(Array.isArray(report.states));
  assert.deepEqual(
    report.states.map(({ id }) => id),
    report.case.states,
  );
  const expectedStates = new Map([
    ["loaded", { loaded: true, resolved: true, displayed: true }],
    ["unloaded", { loaded: false, resolved: true, displayed: false }],
    ["unresolved", { loaded: false, resolved: false, displayed: false }],
  ]);
  const drawings = [];
  for (const state of report.states) {
    const expected = expectedStates.get(state.id);
    assert.ok(expected);
    assert.deepEqual(state.expected, expected);
    assert.equal(state.drawing?.file, `${report.case.id}-${state.id}.dwg`);
    assert.equal(
      state.referenceImage?.file,
      `${report.case.id}-${state.id}.png`,
    );
    assert.equal(state.autoCad?.id, state.id);
    assert.equal(state.autoCad?.tileMode, 1);
    assert.equal(typeof state.autoCad?.tab, "string");
    assert.ok(state.autoCad.tab.length > 0);
    assert.ok([0, 1].includes(state.autoCad.resolvedProbe));
    const storedPath = relativeEvidencePath(
      state.autoCad.storedPath,
      "AutoCAD XREF stored path",
    ).replaceAll("\\", "/");
    assert.equal(
      storedPath.endsWith(
        state.id === "unresolved"
          ? `${report.case.id}-intentionally-missing.dwg`
          : childFile,
      ),
      true,
    );
    assert.deepEqual(state.observedXref, {
      name: report.case.xrefName,
      pathKind: "relative",
      loaded: expected.loaded,
      resolved: expected.resolved,
      referenceCount: state.observedXref.referenceCount,
    });
    assert.ok(
      Number.isSafeInteger(state.observedXref.referenceCount) &&
        state.observedXref.referenceCount > 0,
    );
    validateExternalConversionSummary(
      state.conversion,
      `AutoCAD XREF ${state.id} conversion`,
    );
    const [drawing] = await Promise.all([
      verifyPairArtifact(directory, state.drawing, "AutoCAD XREF state DWG"),
      verifyPairArtifact(
        directory,
        state.referenceImage,
        "AutoCAD XREF reference image",
        { png: true, requirePngDimensions: true },
      ),
    ]);
    assert.equal(validSha256(state.referenceImage.pixelSha256), true);
    assert.equal(
      pngPixelSha256(
        await readFile(path.join(directory, state.referenceImage.file)),
      ),
      state.referenceImage.pixelSha256,
      "AutoCAD XREF decoded pixels differ",
    );
    drawings.push(drawing);
  }
  assert.equal(
    new Set(report.states.map((state) => state.conversion.totalEntities)).size,
    1,
    "AutoCAD XREF state changed the logical host entity count",
  );
  assert.equal(
    new Set(drawings.map(({ sha256: digest }) => digest)).size,
    drawings.length,
    "AutoCAD XREF state DWGs are not distinct",
  );
  assert.notEqual(
    report.states[0].referenceImage.pixelSha256,
    report.states[1].referenceImage.pixelSha256,
    "AutoCAD loaded and unloaded reference pixels do not differ",
  );
  assert.equal(
    report.states[1].referenceImage.pixelSha256,
    report.states[2].referenceImage.pixelSha256,
    "AutoCAD unloaded and unresolved reference pixels differ",
  );
  return Object.freeze({
    file: path.basename(filePath),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    report,
  });
}

export function summarizeAutoCadXrefCoverage(evidence) {
  const orderedEvidence = [...evidence].sort((left, right) =>
    left.report.case.id.localeCompare(right.report.case.id, "en"),
  );
  assert.equal(
    new Set(orderedEvidence.map(({ report }) => report.case.id)).size,
    orderedEvidence.length,
    "AutoCAD XREF case ids must be unique",
  );
  return Object.freeze({
    reports: Object.freeze(
      orderedEvidence.map(({ file, sha256: digest, bytes }) =>
        Object.freeze({ file, bytes, sha256: digest }),
      ),
    ),
    cases: Object.freeze(
      orderedEvidence.map(({ report }) =>
        Object.freeze({
          id: report.case.id,
          xrefName: report.case.xrefName,
          states: Object.freeze([...report.case.states]),
        }),
      ),
    ),
    missing: Object.freeze(
      orderedEvidence.length > 0
        ? []
        : ["loaded-unloaded-unresolved"],
    ),
    complete: orderedEvidence.length > 0,
  });
}

function scaleEquivalent(left, right) {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <=
      Math.max(1, Math.abs(left), Math.abs(right)) * 1e-6
  );
}

function validateAnnotationScale(value, label) {
  assert.ok(value && typeof value === "object", `${label} is missing`);
  assert.equal(typeof value.name, "string", `${label} name is missing`);
  assert.match(
    value.name,
    /^[A-Za-z0-9][A-Za-z0-9 .:_/-]{0,63}$/u,
    `${label} name is invalid`,
  );
  assert.doesNotMatch(value.name, /\\/u, `${label} name is invalid`);
  positiveFinite(value.value, `${label} value`);
  return value;
}

export async function readAutoCadAnnotationEvidence(filePath) {
  const metadata = await stat(filePath);
  assert.equal(
    metadata.isFile(),
    true,
    "AutoCAD annotation report is not a file",
  );
  assert.ok(
    metadata.size > 0 && metadata.size <= MAX_EXTERNAL_EVIDENCE_BYTES,
    "AutoCAD annotation report is outside the size limit",
  );
  const bytes = await readFile(filePath);
  const report = JSON.parse(bytes.toString("utf8"));
  assert.equal(report.schema, AUTOCAD_ANNOTATION_SCHEMA);
  assert.equal(report.status, "pass");
  assert.equal(report.pathsIncluded, false);
  assert.equal(report.target?.product, "Autodesk AutoCAD");
  validateAutoCad2026Identity(
    report.target?.acadVersion,
    report.target?.platform,
  );
  validateAutoCadAdapterDescriptor(report.adapter);
  assert.equal(
    report.target?.displayMode,
    "2D Wireframe model and layout",
  );
  assert.match(report.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  assert.equal(Number.isFinite(Date.parse(report.observedAt)), true);
  assert.match(report.case?.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assert.equal(typeof report.case?.layout, "string");
  assert.ok(report.case.layout.length > 0 && report.case.layout.length <= 255);
  assert.equal(typeof report.case?.style, "string");
  assert.ok(report.case.style.length > 0 && report.case.style.length <= 255);
  assert.equal(typeof report.case?.textValue, "string");
  assert.ok(
    report.case.textValue.length > 0 && report.case.textValue.length <= 255,
  );
  const supportedScale = validateAnnotationScale(
    report.case?.supportedScale,
    "AutoCAD annotation supported scale",
  );
  const activeScale = validateAnnotationScale(
    report.case?.activeScale,
    "AutoCAD annotation active scale",
  );
  assert.equal(
    supportedScale.name !== activeScale.name &&
      !scaleEquivalent(supportedScale.value, activeScale.value),
    true,
    "AutoCAD annotation supported and active scales must differ",
  );
  const matrix = Object.freeze([
    Object.freeze({ id: "m0-l0", model: 0, layout: 0 }),
    Object.freeze({ id: "m1-l0", model: 1, layout: 0 }),
    Object.freeze({ id: "m1-l1", model: 1, layout: 1 }),
    Object.freeze({ id: "m0-l1", model: 0, layout: 1 }),
  ]);
  assert.deepEqual(
    report.case?.states,
    matrix.map(({ id }) => id),
  );
  assert.equal(report.case?.singleSession, true);
  assert.equal(report.case?.cacheSchema, CURRENT_CACHE_SCHEMA);
  assert.equal(report.case?.singleDrawingViewSwitch, true);
  assert.equal(
    report.case?.cameras,
    "one model camera and one layout camera retained across every state",
  );
  assert.deepEqual(report.fixture, {
    textHandle: report.fixture?.textHandle,
    viewportHandle: report.fixture?.viewportHandle,
    styleName: report.case.style,
    layoutName: report.case.layout,
    textValue: report.case.textValue,
  });
  assert.match(report.fixture.textHandle, /^[A-F0-9]+$/u);
  assert.match(report.fixture.viewportHandle, /^[A-F0-9]+$/u);

  const directory = path.dirname(filePath);
  assert.equal(report.source?.file, `${report.case.id}-source.dwg`);
  await verifyPairArtifact(
    directory,
    report.source,
    "AutoCAD annotation source DWG",
  );
  assert.ok(Array.isArray(report.states));
  assert.deepEqual(
    report.states.map(({ id }) => id),
    matrix.map(({ id }) => id),
  );
  const drawings = [];
  const imageDimensions = { model: [], layout: [] };
  const imagePixels = new Map();
  const entityCounts = [];
  for (const expected of matrix) {
    const state = report.states.find(({ id }) => id === expected.id);
    assert.ok(state);
    assert.deepEqual(state.values, {
      model: expected.model,
      layout: expected.layout,
    });
    assert.deepEqual(Object.keys(state.views ?? {}).sort(), ["layout", "model"]);
    for (const space of ["model", "layout"]) {
      const view = state.views[space];
      const stem = `${report.case.id}-${expected.id}-${space}`;
      assert.equal(view.drawing?.file, `${stem}.dwg`);
      assert.equal(view.referenceImage?.file, `${stem}.png`);
      assert.deepEqual(view.autoCad, {
        id: expected.id,
        space,
        model: expected.model,
        layout: expected.layout,
        tab: view.autoCad?.tab,
        tileMode: space === "model" ? 1 : 0,
        annotationAllVisible: expected[space],
        currentScale: activeScale.name,
        currentScaleValue: view.autoCad?.currentScaleValue,
      });
      assert.equal(typeof view.autoCad.tab, "string");
      assert.ok(view.autoCad.tab.length > 0);
      if (space === "layout") {
        assert.equal(view.autoCad.tab, report.case.layout);
      }
      assert.equal(
        scaleEquivalent(view.autoCad.currentScaleValue, activeScale.value),
        true,
      );
      assert.equal(
        view.observed?.modelAnnotationAllVisible,
        Boolean(expected.model),
      );
      assert.equal(
        view.observed?.layoutAnnotationAllVisible,
        Boolean(expected.layout),
      );
      assert.equal(
        view.observed?.activeAnnotationAllVisible,
        Boolean(expected[space]),
      );
      assert.equal(view.observed?.currentPaperLayout, report.case.layout);
      assert.equal(view.observed?.textHandle, report.fixture.textHandle);
      assert.ok(Array.isArray(view.observed?.textContextScales));
      assert.equal(
        view.observed.textContextScales.some((value) =>
          scaleEquivalent(value, supportedScale.value),
        ),
        true,
      );
      assert.equal(
        view.observed.textContextScales.some((value) =>
          scaleEquivalent(value, activeScale.value),
        ),
        false,
      );
      assert.equal(
        scaleEquivalent(
          view.observed.viewportAnnotationScale,
          activeScale.value,
        ),
        true,
      );
      if (space === "model") {
        assert.equal(
          scaleEquivalent(
            view.observed.modelAnnotationScale,
            activeScale.value,
          ),
          true,
        );
      }
      const conversion = validateExternalConversionSummary(
        view.conversion,
        `AutoCAD annotation ${expected.id} ${space} conversion`,
      );
      assert.ok(
        Number.isSafeInteger(conversion.sections?.text_annotation_contexts) &&
          conversion.sections.text_annotation_contexts > 0,
        "AutoCAD annotation conversion lacks text annotation contexts",
      );
      entityCounts.push(conversion.totalEntities);
      const [drawing, referenceImage] = await Promise.all([
        verifyPairArtifact(
          directory,
          view.drawing,
          "AutoCAD annotation state DWG",
        ),
        verifyPairArtifact(
          directory,
          view.referenceImage,
          "AutoCAD annotation reference image",
          { png: true, requirePngDimensions: true },
        ),
      ]);
      assert.equal(validSha256(view.referenceImage.pixelSha256), true);
      const imagePath = path.join(directory, view.referenceImage.file);
      assert.equal(
        pngPixelSha256(await readFile(imagePath)),
        view.referenceImage.pixelSha256,
        "AutoCAD annotation decoded pixels differ",
      );
      drawings.push(drawing);
      imageDimensions[space].push(
        `${referenceImage.width}x${referenceImage.height}`,
      );
      imagePixels.set(
        `${expected.id}:${space}`,
        view.referenceImage.pixelSha256,
      );
    }
  }
  assert.equal(
    new Set(entityCounts).size,
    1,
    "AutoCAD annotation state changed the logical entity count",
  );
  assert.equal(
    new Set(drawings.map(({ sha256: digest }) => digest)).size,
    drawings.length,
    "AutoCAD annotation state DWGs are not distinct",
  );
  for (const space of ["model", "layout"]) {
    assert.equal(
      new Set(imageDimensions[space]).size,
      1,
      `AutoCAD annotation ${space} camera dimensions changed`,
    );
  }
  const pixel = (id, space) => imagePixels.get(`${id}:${space}`);
  assert.notEqual(pixel("m0-l0", "model"), pixel("m1-l0", "model"));
  assert.notEqual(pixel("m1-l0", "layout"), pixel("m1-l1", "layout"));
  assert.equal(pixel("m1-l0", "model"), pixel("m1-l1", "model"));
  assert.equal(pixel("m0-l0", "model"), pixel("m0-l1", "model"));
  assert.equal(pixel("m1-l1", "layout"), pixel("m0-l1", "layout"));
  assert.equal(pixel("m0-l0", "layout"), pixel("m1-l0", "layout"));
  return Object.freeze({
    file: path.basename(filePath),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    report,
  });
}

export function summarizeAutoCadAnnotationCoverage(evidence) {
  const orderedEvidence = [...evidence].sort((left, right) =>
    left.report.case.id.localeCompare(right.report.case.id, "en"),
  );
  assert.equal(
    new Set(orderedEvidence.map(({ report }) => report.case.id)).size,
    orderedEvidence.length,
    "AutoCAD annotation case ids must be unique",
  );
  const generatedMatrixComplete = orderedEvidence.length > 0;
  const singleDrawingViewSwitchComplete =
    generatedMatrixComplete &&
    orderedEvidence.every(({ report }) =>
      report.case?.cacheSchema === CURRENT_CACHE_SCHEMA &&
      report.case?.singleDrawingViewSwitch === true &&
      Array.isArray(report.states) &&
      report.states.length === 4 &&
      report.states.every((state) =>
        ["model", "layout"].every((space) => {
          const observed = state.views?.[space]?.observed;
          return (
            observed?.modelAnnotationAllVisible ===
              Boolean(state.values?.model) &&
            observed?.layoutAnnotationAllVisible ===
              Boolean(state.values?.layout) &&
            observed?.activeAnnotationAllVisible ===
              Boolean(state.values?.[space]) &&
            observed?.currentPaperLayout === report.case.layout
          );
        }),
      ),
    );
  const missing = [];
  if (!generatedMatrixComplete) {
    missing.push("generated-model-layout-2x2-matrix");
  }
  if (!singleDrawingViewSwitchComplete) {
    missing.push("single-drawing-model-layout-view-switch");
  }
  return Object.freeze({
    reports: Object.freeze(
      orderedEvidence.map(({ file, sha256: digest, bytes }) =>
        Object.freeze({ file, bytes, sha256: digest }),
      ),
    ),
    cases: Object.freeze(
      orderedEvidence.map(({ report }) =>
        Object.freeze({
          id: report.case.id,
          layout: report.case.layout,
          supportedScale: Object.freeze({ ...report.case.supportedScale }),
          activeScale: Object.freeze({ ...report.case.activeScale }),
          states: Object.freeze([...report.case.states]),
        }),
      ),
    ),
    generatedMatrixComplete,
    singleDrawingViewSwitchComplete,
    missing: Object.freeze(missing),
    complete:
      generatedMatrixComplete && singleDrawingViewSwitchComplete,
  });
}

function positiveFinite(value, label) {
  assert.ok(Number.isFinite(value) && value > 0, `${label} must be positive`);
  return value;
}

function passBoolean(value, label) {
  assert.equal(value, true, `${label} did not pass`);
}

export async function readWindowsVsCodeEvidence(
  reportPath,
  vsixPath,
  companionVsixPath,
) {
  const metadata = await stat(reportPath);
  assert.equal(metadata.isFile(), true, "Windows VS Code report is not a file");
  assert.ok(
    metadata.size > 0 && metadata.size <= MAX_EXTERNAL_EVIDENCE_BYTES,
    "Windows VS Code report is outside the size limit",
  );
  const bytes = await readFile(reportPath);
  const report = JSON.parse(bytes.toString("utf8"));
  assert.equal(report.schema, WINDOWS_VSCODE_UI_SCHEMA);
  assert.equal(report.status, "pass");
  assert.equal(report.pathsIncluded, false);
  assert.deepEqual(report.cleanup, {
    perScaleProcessTreeTermination: "enforced",
    perScaleProfileRemoval: "enforced",
    privateRootRemoval: "enforced-before-success-return",
  });
  assert.equal(report.target?.platform, "win32");
  assert.equal(report.target?.architecture, "x64");
  assert.equal(report.target?.vscodeChannel, "stable");
  assert.match(
    report.target?.vscodeVersion,
    /^\d+\.\d+\.\d+(?:[-+].*)?$/u,
  );
  assert.equal(typeof report.target?.os, "string");
  assert.ok(report.target.os.length > 0 && report.target.os.length <= 160);
  passBoolean(report.target?.packagedVsixInstalled, "packaged viewer VSIX");
  passBoolean(
    report.target?.packagedCompanionVsixInstalled,
    "packaged companion VSIX",
  );
  assert.equal(report.input?.pathDisclosure, "none");
  assert.ok(
    Number.isSafeInteger(report.input?.drawingBytes) &&
      report.input.drawingBytes > 0,
  );
  assert.equal(validSha256(report.input?.drawingSha256), true);
  assert.equal(
    report.input.drawingSha256,
    WINDOWS_UI_DRAWING_SHA256,
    "Windows UI input is not the pinned Autodesk annotation sample",
  );
  const viewerVsix = {
    file: path.basename(vsixPath),
    bytes: report.input?.vsixBytes,
    sha256: report.input?.vsixSha256,
  };
  const companionVsix = {
    file: path.basename(companionVsixPath),
    bytes: report.input?.companionVsixBytes,
    sha256: report.input?.companionVsixSha256,
  };
  assert.equal(path.extname(viewerVsix.file).toLowerCase(), ".vsix");
  assert.equal(path.extname(companionVsix.file).toLowerCase(), ".vsix");
  await Promise.all([
    verifyExternalArtifact(vsixPath, viewerVsix, "packaged viewer VSIX"),
    verifyExternalArtifact(
      companionVsixPath,
      companionVsix,
      "packaged companion VSIX",
    ),
  ]);

  assert.ok(Array.isArray(report.cases));
  const expectedScales = [100, 125, 150, 200];
  assert.deepEqual(
    report.cases.map((entry) => entry.scalePercent),
    expectedScales,
  );
  const screenshots = [];
  for (const entry of report.cases) {
    const requestedScale = entry.scalePercent / 100;
    assert.equal(entry.status, "pass");
    assert.equal(entry.requestedDeviceScaleFactor, requestedScale);
    positiveFinite(
      entry.interactionEditorCssSize?.width,
      "Windows interaction editor width",
    );
    positiveFinite(
      entry.interactionEditorCssSize?.height,
      "Windows interaction editor height",
    );
    assert.equal(entry.interaction?.status, "pass");
    for (const key of [
      "selection",
      "coordinate",
      "distance",
      "fit",
      "clear",
    ]) {
      passBoolean(entry.interaction[key], `Windows interaction ${key}`);
    }
    assert.ok(entry.interaction.fitZoom?.before > 1.01);
    assert.ok(Math.abs(entry.interaction.fitZoom?.after - 1) <= 0.01);
    assert.equal(entry.layout?.status, "pass");
    assert.ok(Number.isSafeInteger(entry.layout.views) && entry.layout.views >= 2);
    passBoolean(
      entry.layout.pendingReviewStateCleared,
      "Windows layout review-state cleanup",
    );
    assert.ok(Array.isArray(entry.widths));
    assert.deepEqual(
      entry.widths.map((width) => width.label),
      ["normal", "narrow"],
    );
    for (const width of entry.widths) {
      assert.equal(width.status, "pass");
      positiveFinite(width.editorCssSize?.width, "Windows editor width");
      positiveFinite(width.editorCssSize?.height, "Windows editor height");
      assert.ok(
        Math.abs(width.actualDevicePixelRatio - requestedScale) <= 0.08,
      );
      assert.ok(
        Number.isFinite(width.reviewToolbarCoverage) &&
          width.reviewToolbarCoverage >= 0 &&
          width.reviewToolbarCoverage < 0.22,
      );
      const expectedFile =
        `windows-vscode-${entry.scalePercent}-${width.label}.png`;
      assert.equal(width.screenshot?.file, expectedFile);
      assert.ok(width.screenshot.bytes > 10_000);
      screenshots.push(
        await verifyPairArtifact(
          path.dirname(reportPath),
          width.screenshot,
          "packaged Windows screenshot",
          { png: true },
        ),
      );
    }
  }
  assert.equal(
    new Set(screenshots.map(({ file }) => file)).size,
    screenshots.length,
  );
  return Object.freeze({
    file: path.basename(reportPath),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    target: Object.freeze({ ...report.target }),
    input: Object.freeze({
      drawingBytes: report.input.drawingBytes,
      drawingSha256: report.input.drawingSha256,
      viewerVsix: Object.freeze(viewerVsix),
      companionVsix: Object.freeze(companionVsix),
    }),
    displayScalesPercent: Object.freeze(expectedScales),
    screenshots: Object.freeze(screenshots),
    cleanup: Object.freeze({ ...report.cleanup }),
  });
}

function jpegDimensions(bytes) {
  if (bytes.byteLength < 11 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("AutoCAD reference evidence must be a JPEG image");
  }
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
    0xce, 0xcf,
  ]);
  let cursor = 2;
  while (cursor + 4 <= bytes.byteLength) {
    while (cursor < bytes.byteLength && bytes[cursor] !== 0xff) {
      cursor += 1;
    }
    while (cursor < bytes.byteLength && bytes[cursor] === 0xff) {
      cursor += 1;
    }
    if (cursor >= bytes.byteLength) {
      break;
    }
    const marker = bytes[cursor];
    cursor += 1;
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda || cursor + 2 > bytes.byteLength) {
      break;
    }
    const segmentLength = bytes.readUInt16BE(cursor);
    if (segmentLength < 2 || cursor + segmentLength > bytes.byteLength) {
      break;
    }
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return {
        width: bytes.readUInt16BE(cursor + 5),
        height: bytes.readUInt16BE(cursor + 3),
      };
    }
    cursor += segmentLength;
  }
  throw new Error("AutoCAD reference JPEG dimensions are unavailable");
}

export function describeJpeg(bytes, file) {
  const dimensions = jpegDimensions(bytes);
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
  return {
    file,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...dimensions,
  };
}

export function parseAutoCadVectorProperty(text, property) {
  assert.match(property, /^[A-Za-z][A-Za-z0-9]*$/u);
  const match = new RegExp(
    `^;\\s+${property}\\s*=\\s*\\(([^)]+)\\)\\s*$`,
    "mu",
  ).exec(text);
  if (!match) {
    throw new Error(`AutoCAD property ${property} is unavailable`);
  }
  const values = match[1].trim().split(/\s+/u).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`AutoCAD property ${property} is invalid`);
  }
  return values;
}

export async function describeBrowserEvidence(paths) {
  const result = [];
  for (const filePath of paths) {
    result.push(
      describePng(await readFile(filePath), path.basename(filePath)),
    );
  }
  result.sort((left, right) => left.file.localeCompare(right.file, "en"));
  return result;
}

async function assertSourceArchive(sourceArchivePath) {
  const metadata = await stat(sourceArchivePath);
  assert.equal(metadata.isFile(), true);
  const digest = await sha256File(sourceArchivePath);
  assert.equal(digest, LIBREDWG_SOURCE_SHA256);
  return { bytes: metadata.size, sha256: digest };
}

async function corpusProvenance(corpusPath) {
  const [dwgs, texts, screenshots] = await Promise.all([
    collectFiles(corpusPath, (file) => path.extname(file).toLowerCase() === ".dwg"),
    collectFiles(corpusPath, (file) => path.extname(file).toLowerCase() === ".txt"),
    collectFiles(corpusPath, (file) => path.extname(file).toLowerCase() === ".jpg"),
  ]);
  const dwgByStem = new Map(
    dwgs.map((filePath) => [
      safeRelative(corpusPath, filePath)
        .replace(/\.dwg$/iu, "")
        .toLocaleLowerCase("en-US"),
      filePath,
    ]),
  );
  let autoCadMetadata = 0;
  const autoCadMetadataByDwg = new Map();
  for (const filePath of texts) {
    const text = await readFile(filePath, "utf8");
    const prefix = text.slice(0, 128);
    if (/^\[ AutoCAD - /u.test(prefix)) {
      autoCadMetadata += 1;
      const fixture = safeRelative(corpusPath, filePath);
      const key = fixture
        .replace(/\.txt$/iu, "")
        .toLocaleLowerCase("en-US");
      const dwgPath = dwgByStem.get(key);
      assert.ok(dwgPath, `AutoCAD metadata has no paired DWG: ${fixture}`);
      autoCadMetadataByDwg.set(safeRelative(corpusPath, dwgPath), {
        fixture,
        sha256: sha256(Buffer.from(text, "utf8")),
        text,
      });
    }
  }
  const autoCadReferenceImages = [];
  for (const filePath of screenshots) {
    const fixture = safeRelative(corpusPath, filePath);
    const key = fixture
      .replace(/\.jpe?g$/iu, "")
      .toLocaleLowerCase("en-US");
    const dwgPath = dwgByStem.get(key);
    assert.ok(dwgPath, `AutoCAD reference image has no paired DWG: ${fixture}`);
    autoCadReferenceImages.push({
      ...describeJpeg(await readFile(filePath), fixture),
      drawing: safeRelative(corpusPath, dwgPath),
    });
  }
  assert.equal(dwgs.length, 141);
  assert.equal(texts.length, 91);
  assert.equal(autoCadMetadata, 91);
  assert.equal(screenshots.length, 75);
  assert.equal(autoCadMetadataByDwg.size, 91);
  assert.equal(autoCadReferenceImages.length, 75);
  return {
    dwgs,
    textFiles: texts.length,
    autoCadMetadata,
    autoCadMetadataByDwg,
    screenshots: screenshots.length,
    autoCadReferenceImages,
  };
}

async function officialAutodeskProvenance(samplesPath) {
  const dwgs = await collectFiles(
    samplesPath,
    (file) => path.extname(file).toLowerCase() === ".dwg",
  );
  assert.equal(dwgs.length, AUTODESK_SAMPLES.length);
  const byName = new Map(
    dwgs.map((filePath) => [path.basename(filePath), filePath]),
  );
  const files = [];
  for (const sample of AUTODESK_SAMPLES) {
    const filePath = byName.get(sample.file);
    assert.ok(filePath, `missing Autodesk sample: ${sample.file}`);
    const metadata = await stat(filePath);
    assert.equal(metadata.isFile(), true);
    const digest = await sha256File(filePath);
    assert.equal(digest, sample.sha256);
    files.push({
      file: sample.file,
      url: sample.url,
      bytes: metadata.size,
      sha256: digest,
    });
  }
  assert.deepEqual(
    [...byName.keys()].sort((left, right) => left.localeCompare(right, "en")),
    AUTODESK_SAMPLES.map((sample) => sample.file).sort((left, right) =>
      left.localeCompare(right, "en"),
    ),
  );
  return { dwgs, files };
}

async function convertCorpus({ adapterPath, corpusPath, dwgs, temporaryRoot }) {
  const records = new Array(dwgs.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= dwgs.length) {
        return;
      }
      const inputPath = dwgs[index];
      const fixture = safeRelative(corpusPath, inputPath);
      const cachePath = path.join(temporaryRoot, `${index}.scene-cache`);
      const report = validateConversionReport(
        await runAdapter(adapterPath, ["convert", inputPath, cachePath], fixture),
      );
      const { drawing, blocks, layouts, constructionLines } =
        await readCacheMetadata(
        cachePath,
        AUTOCAD_PROPERTY_FIXTURES.some(
          (candidate) => candidate.fixture === fixture,
        ),
      );
      assert.equal(drawing.totalEntities, report.coverage.total_entities);
      assert.equal(
        drawing.serializedEntities,
        report.coverage.serialized_entities,
      );
      records[index] = {
        fixture,
        inputSha256: await sha256File(inputPath),
        cacheSha256: await sha256File(cachePath),
        report,
        drawing,
        blocks,
        layouts,
        constructionLines,
      };
    }
  };
  await Promise.all([worker(), worker()]);
  return records;
}

function maximumVectorError(expected, actual) {
  assert.equal(expected.length, 3);
  assert.equal(actual.length, 3);
  return Math.max(
    ...expected.map((value, index) => Math.abs(value - actual[index])),
  );
}

function autoCadPropertyChecks(records, provenance) {
  const byFixture = new Map(records.map((record) => [record.fixture, record]));
  return AUTOCAD_PROPERTY_FIXTURES.map(({ fixture, kind }) => {
    const record = byFixture.get(fixture);
    const metadata = provenance.autoCadMetadataByDwg.get(fixture);
    assert.ok(record && metadata, `missing AutoCAD property fixture: ${fixture}`);
    assert.equal(record.constructionLines.length, 1);
    const actual = record.constructionLines[0];
    assert.equal(actual.kind, kind);
    const expectedPoint = parseAutoCadVectorProperty(
      metadata.text,
      "BasePoint",
    );
    const expectedDirection = parseAutoCadVectorProperty(
      metadata.text,
      "DirectionVector",
    );
    const pointMaximumAbsoluteError = maximumVectorError(
      expectedPoint,
      actual.point,
    );
    const directionMaximumAbsoluteError = maximumVectorError(
      expectedDirection,
      actual.direction,
    );
    assert.ok(pointMaximumAbsoluteError <= 0.0001);
    assert.ok(directionMaximumAbsoluteError <= 0.000001);
    return {
      fixture,
      kind,
      metadataFixture: metadata.fixture,
      metadataSha256: metadata.sha256,
      pointMaximumAbsoluteError,
      directionMaximumAbsoluteError,
      status: "pass",
    };
  });
}

function autoCadReferenceReviews(provenance, browserEvidence) {
  const browserByName = new Map(
    browserEvidence.map((entry) => [path.posix.basename(entry.file), entry]),
  );
  const referenceByDrawing = new Map(
    provenance.autoCadReferenceImages.map((entry) => [entry.drawing, entry]),
  );
  return AUTOCAD_BROWSER_REFERENCE_CASES.map(({ browser, drawing }) => {
    const browserImage = browserByName.get(browser);
    const autoCadImage = referenceByDrawing.get(drawing);
    if (!browserImage || !autoCadImage) {
      return { browser, drawing, status: "pending" };
    }
    return {
      drawing,
      browserEvidence: browserImage,
      autoCadReference: autoCadImage,
      comparison:
        "manual object-content and placement review; AutoCAD grid, UCS and cursor pixels are excluded",
      status: "pass",
    };
  });
}

export function summarizeBrowserEvidenceCoverage(evidence) {
  const supplied = evidence
    .map(({ file }) => path.posix.basename(file))
    .sort((left, right) => left.localeCompare(right, "en"));
  assert.equal(
    new Set(supplied).size,
    supplied.length,
    "Browser evidence basenames must be unique",
  );
  const suppliedSet = new Set(supplied);
  const missing = REQUIRED_BROWSER_EVIDENCE.filter(
    (file) => !suppliedSet.has(file),
  );
  return Object.freeze({
    required: REQUIRED_BROWSER_EVIDENCE,
    supplied: Object.freeze(supplied),
    missing: Object.freeze(missing),
    complete: missing.length === 0,
  });
}

export function referenceDisplayQualificationStatus() {
  // Required conversion, partition and fixture checks fail closed before the
  // report is built. Proprietary-viewer captures and platform UI runs remain
  // useful supplemental evidence, but they do not decide this source-neutral
  // display qualification status.
  return "pass-with-explicit-boundaries";
}

function plotStyleFixtures(records) {
  return records.flatMap((record) =>
    record.layouts
      .filter((layout) => layout.index > 0 && layout.styleSheet.trim())
      .map((layout) => {
        const style = layout.styleSheet
          .trim()
          .toLocaleLowerCase("en-US");
        return {
          fixture: record.fixture,
          layoutIndex: layout.index,
          kind: style.endsWith(".stb")
            ? "stb"
            : style.endsWith(".ctb")
              ? "ctb"
              : "other",
        };
      }),
  );
}

function fixtureEvidence(record) {
  return {
    fixture: record.fixture,
    inputSha256: record.inputSha256,
    cacheSha256: record.cacheSha256,
    inputBytes: record.report.input.size_bytes,
    cacheBytes: record.report.cache.size_bytes,
    coverage: record.report.coverage,
    sections: Object.fromEntries(
      record.report.cache.sections
        .filter((section) => section.records > 0)
        .map((section) => [section.kind, section.records]),
    ),
    drawing: Object.fromEntries(
      PRESENTATION_FIELDS.map((field) => [field, record.drawing[field]]),
    ),
    layouts: record.layouts.length,
    annotationAllVisible: layoutAnnotationVisibilitySummary(record.layouts),
    viewports: viewportModeSummary(record.layouts),
    plotStyles: plotStyleSummary(record.layouts),
  };
}

function buildEvidence({
  observedAt,
  doctor,
  sourceArchive,
  provenance,
  records,
  officialProvenance,
  officialRecords,
  autoCadAnnotationEvidence,
  autoCadPairEvidence,
  autoCadXrefEvidence,
  browserEvidence,
  windowsVsCodeEvidence,
}) {
  const coverage = aggregateCoverage(records.map((record) => record.report));
  const officialCoverage = aggregateCoverage(
    officialRecords.map((record) => record.report),
  );
  const fixtureByName = new Map(records.map((record) => [record.fixture, record]));
  const selectedFixtures = PUBLIC_FIXTURES.map((name) => {
    const record = fixtureByName.get(name);
    assert.ok(record, `missing required public fixture: ${name}`);
    return fixtureEvidence(record);
  });
  const allLayouts = records.flatMap((record) => record.layouts);
  const autoCadReferenceReview = autoCadReferenceReviews(
    provenance,
    browserEvidence,
  );
  const browserEvidenceCoverage = summarizeBrowserEvidenceCoverage(
    browserEvidence,
  );
  const autoCadBrowserReferenceComplete = autoCadReferenceReview.every(
    (entry) => entry.status === "pass",
  );
  const autoCadSystemVariablePairs = summarizeAutoCadPairCoverage(
    autoCadPairEvidence,
  );
  const autoCadAnnotationScaleMatrix =
    summarizeAutoCadAnnotationCoverage(autoCadAnnotationEvidence);
  const autoCadXrefStateMatrix = summarizeAutoCadXrefCoverage(
    autoCadXrefEvidence,
  );
  const autoCadAdapter = summarizeAutoCadAdapterEvidence([
    ...autoCadPairEvidence,
    ...autoCadAnnotationEvidence,
    ...autoCadXrefEvidence,
  ]);
  return {
    schema: REPORT_SCHEMA,
    status: referenceDisplayQualificationStatus(),
    observedAt,
    scope: {
      repository: "menaje/2d-cad-viewer",
      referenceBasis:
        "documented DWG 2D display semantics and reproducible public or synthetic fixtures",
      commercialProductComparisonRequired: false,
      loadingPerformanceExcluded: true,
      deploymentPerformed: false,
    },
    adapter: doctor,
    publicCorpus: {
      source: "GNU LibreDWG 0.14 test/test-data",
      sourceArchive,
      drawings: provenance.dwgs.length,
      autoCadMetadataFiles: provenance.autoCadMetadata,
      autoCadScreenshots: provenance.screenshots,
      autoCadReferenceImages: provenance.autoCadReferenceImages,
      converted: records.length,
      failed: 0,
    },
    officialAutodeskSamples: {
      sourcePage: AUTODESK_SAMPLE_PAGE,
      files: officialProvenance.files,
      converted: officialRecords.length,
      failed: 0,
      coverage: officialCoverage,
      fixtures: officialRecords.map(fixtureEvidence),
    },
    conversion: {
      cacheSchema: "dwg-scene-cache/1.26",
      sectionCount: 51,
      coverage,
      deferredReasonPartitionExact: true,
      referencedLinetypesOmitted: records.reduce(
        (total, record) =>
          total + record.report.tables.omitted_referenced_linetypes,
        0,
      ),
      diagnostics: records.reduce(
        (total, record) => total + record.report.diagnostics,
        0,
      ),
    },
    presentationStates: summarizePresentation(
      records.map((record) => record.drawing),
    ),
    layoutState: {
      layouts: allLayouts.length,
      savedCurrentTab: savedCurrentTabSummary(records),
      annotationAllVisible: layoutAnnotationVisibilitySummary(allLayouts),
      paperSpaceLinetypeScale:
        layoutPaperSpaceLinetypeScaleSummary(allLayouts),
      plotStyles: plotStyleSummary(allLayouts),
      viewports: viewportModeSummary(allLayouts),
      plotStyleFixtures: plotStyleFixtures(records),
    },
    autoCadObjectPropertyChecks: autoCadPropertyChecks(records, provenance),
    autoCadReferenceReview,
    autoCadAdapter,
    autoCadSystemVariablePairs,
    autoCadAnnotationScaleMatrix,
    autoCadXrefStateMatrix,
    packagedWindowsVsCode: windowsVsCodeEvidence,
    selectedFixtures,
    browserEvidence,
    browserEvidenceRetention: {
      mode: "metadata-only",
      imagesIncluded: false,
      redistributionRightsRequiredForPublication: true,
    },
    browserEvidenceCoverage,
    gates: {
      publicCorpusConversion: "pass",
      officialAutodeskSamples: "pass",
      sourceSerializedDeferredPartition: "pass",
      invalidSupportedEntities: "pass-zero",
    },
    supplementalEvidence: {
      browserRepresentativePixels: browserEvidenceCoverage.complete
        ? "observed-complete-matrix"
        : browserEvidenceCoverage.supplied.length > 0
          ? "observed-incomplete-matrix"
          : "not-run",
      autoCadSystemVariablePairs: autoCadSystemVariablePairs.complete
        ? "observed-autocad-generated-same-camera-pairs"
        : autoCadSystemVariablePairs.reports.length > 0
          ? "observed-incomplete-external-fixtures"
          : "not-run",
      autoCadAnnotationScaleMatrix: autoCadAnnotationScaleMatrix.complete
        ? "observed-autocad-generated-model-layout-view-switch"
        : autoCadAnnotationScaleMatrix.generatedMatrixComplete
          ? "observed-incomplete-model-layout-view-switch"
          : "not-run",
      autoCadXrefStateMatrix: autoCadXrefStateMatrix.complete
        ? "observed-autocad-generated-loaded-unloaded-unresolved"
        : "not-run",
      autoCadReferencePixels: autoCadBrowserReferenceComplete
        ? "observed-public-reference-set-and-browser-review"
        : "not-run",
    },
    platformGates: {
      packagedWindowsVsCodeCurrentRevision: windowsVsCodeEvidence
        ? "pass-packaged-current-artifacts"
        : "pending-windows-execution",
    },
    explicitBoundaries: {
      namedStb:
        "identified and reported; named per-entity style application is not rendered",
      underlayContent:
        "PDF/DWF/DGN content and placement are deferred; drawing-wide frame settings are preserved",
      proxyGraphics:
        "PROXYSHOW=1 with an explicit supported-opcode allowlist; unsupported streams are deferred atomically",
      threeDimensionalVisualStyles:
        "outside the 2D Wireframe renderer and counted as unsupported_3d_entities",
      preR13PaperSpace:
        "TILEMODE=0 is preserved, but a pre-R13 drawing without LAYOUT objects has no qualified paper-layout/view contract and falls back to the model view",
    },
    pathsIncluded: false,
  };
}

async function writeJsonExclusive(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function qualify(options) {
  await Promise.all([
    access(options.adapterPath, 1),
    access(options.corpusPath, 4),
    access(options.autodeskSamplesPath, 4),
    access(options.sourceArchivePath, 4),
    ...options.autoCadAnnotationEvidence.map((filePath) => access(filePath, 4)),
    ...options.autoCadPairEvidence.map((filePath) => access(filePath, 4)),
    ...options.autoCadXrefEvidence.map((filePath) => access(filePath, 4)),
    ...options.browserEvidence.map((filePath) => access(filePath, 4)),
    ...(options.windowsVsCodeEvidencePath
      ? [
          access(options.windowsVsCodeEvidencePath, 4),
          access(options.windowsVsixPath, 4),
          access(options.windowsCompanionVsixPath, 4),
        ]
      : []),
  ]);
  const doctor = await runAdapter(options.adapterPath, ["doctor"], "adapter doctor");
  assert.equal(doctor?.schema, DOCTOR_SCHEMA);
  assert.equal(doctor?.status, "ok");
  assert.equal(doctor?.cache?.schema, "dwg-scene-cache/1.26");
  const [
    sourceArchive,
    provenance,
    officialProvenance,
    autoCadAnnotationEvidence,
    autoCadPairEvidence,
    autoCadXrefEvidence,
    browserEvidence,
    windowsVsCodeEvidence,
  ] = await Promise.all([
    assertSourceArchive(options.sourceArchivePath),
    corpusProvenance(options.corpusPath),
    officialAutodeskProvenance(options.autodeskSamplesPath),
    Promise.all(
      options.autoCadAnnotationEvidence.map(readAutoCadAnnotationEvidence),
    ),
    Promise.all(options.autoCadPairEvidence.map(readAutoCadPairEvidence)),
    Promise.all(options.autoCadXrefEvidence.map(readAutoCadXrefEvidence)),
    describeBrowserEvidence(options.browserEvidence),
    options.windowsVsCodeEvidencePath
      ? readWindowsVsCodeEvidence(
          options.windowsVsCodeEvidencePath,
          options.windowsVsixPath,
          options.windowsCompanionVsixPath,
        )
      : null,
  ]);
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "dwg-reference-display-"),
  );
  try {
    const publicTemporaryRoot = path.join(temporaryRoot, "public");
    const officialTemporaryRoot = path.join(temporaryRoot, "autodesk");
    await Promise.all([
      mkdir(publicTemporaryRoot),
      mkdir(officialTemporaryRoot),
    ]);
    const records = await convertCorpus({
      adapterPath: options.adapterPath,
      corpusPath: options.corpusPath,
      dwgs: provenance.dwgs,
      temporaryRoot: publicTemporaryRoot,
    });
    const officialRecords = await convertCorpus({
      adapterPath: options.adapterPath,
      corpusPath: options.autodeskSamplesPath,
      dwgs: officialProvenance.dwgs,
      temporaryRoot: officialTemporaryRoot,
    });
    const evidence = buildEvidence({
      observedAt: options.observedAt,
      doctor,
      sourceArchive,
      provenance,
      records,
      officialProvenance,
      officialRecords,
      autoCadAnnotationEvidence,
      autoCadPairEvidence,
      autoCadXrefEvidence,
      browserEvidence,
      windowsVsCodeEvidence,
    });
    await writeJsonExclusive(options.outputPath, evidence);
    return evidence;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const evidence = await qualify(options);
    process.stdout.write(
      `${JSON.stringify({
        schema: evidence.schema,
        status: evidence.status,
        drawings: evidence.publicCorpus.drawings,
        officialAutodeskSamples: evidence.officialAutodeskSamples.converted,
        coverage: evidence.conversion.coverage,
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
