// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  aggregateCoverage,
  describeJpeg,
  describePng,
  displayParityQualificationStatus,
  layoutAnnotationVisibilitySummary,
  parseArguments,
  parseAutoCadVectorProperty,
  pngPixelSha256,
  readAutoCadAnnotationEvidence,
  readAutoCadPairEvidence,
  readAutoCadXrefEvidence,
  readWindowsVsCodeEvidence,
  summarizeAutoCadAnnotationCoverage,
  summarizeAutoCadAdapterEvidence,
  summarizeBrowserEvidenceCoverage,
  summarizeAutoCadPairCoverage,
  summarizeAutoCadXrefCoverage,
  summarizePresentation,
  validateAutoCad2026Identity,
  validateAutoCadPairPixelStates,
  validateConversionReport,
  viewportModeSummary,
} from "./qualify-autocad-display-parity.mjs";

test("accepts only AutoCAD 2026 on Windows for external display evidence", () => {
  assert.equal(
    validateAutoCad2026Identity(
      "25.1s (LMS Tech)",
      "Microsoft Windows NT Version 10.0 (x64)",
    ),
    true,
  );
  assert.throws(
    () => validateAutoCad2026Identity("25.0s", "Microsoft Windows 11"),
    /AutoCAD 2026/u,
  );
  assert.throws(
    () => validateAutoCad2026Identity("25.1s", "Mac OS X"),
    /Windows/u,
  );
});

test("requires every AutoCAD matrix to use one Windows adapter artifact", () => {
  const evidence = (sha256) => ({
    report: {
      adapter: {
        file: "libredwg-adapter.exe",
        bytes: 123456,
        sha256,
      },
    },
  });
  assert.deepEqual(
    summarizeAutoCadAdapterEvidence([
      evidence("a".repeat(64)),
      evidence("a".repeat(64)),
    ]),
    {
      file: "libredwg-adapter.exe",
      bytes: 123456,
      sha256: "a".repeat(64),
    },
  );
  assert.equal(summarizeAutoCadAdapterEvidence([]), null);
  assert.throws(
    () =>
      summarizeAutoCadAdapterEvidence([
        evidence("a".repeat(64)),
        evidence("b".repeat(64)),
      ]),
    /different adapter artifacts/u,
  );
});

function qualificationPng(width, height, rgb) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const result = Buffer.alloc(12 + data.byteLength);
    result.writeUInt32BE(data.byteLength, 0);
    result.write(type, 4, 4, "ascii");
    data.copy(result, 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 3 + 1);
    rows[offset] = 0;
    for (let column = 0; column < width; column += 1) {
      rows.set(rgb, offset + 1 + column * 3);
    }
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function report(overrides = {}) {
  return {
    schema: "dwg-scene-cache/1",
    status: "ok",
    cache: {
      format_major: 1,
      format_minor: 26,
      validated: true,
      sections: Array.from({ length: 51 }, () => ({})),
    },
    coverage: {
      total_entities: 7,
      serialized_entities: 5,
      deferred_entities: 2,
      lines: 5,
      deferred_reasons: {
        unresolved_dimensions: 1,
        unsupported_underlays: 1,
        unsupported_proxy_graphics: 0,
        unsupported_3d_entities: 0,
        invalid_supported_entities: 0,
        unsupported_other_entities: 0,
      },
    },
    tables: { omitted_referenced_linetypes: 0 },
    ...overrides,
  };
}

test("parses bounded qualification inputs and repeated external evidence", () => {
  const options = parseArguments([
    "--adapter",
    "adapter",
    "--corpus",
    "corpus",
    "--autodesk-samples",
    "autodesk-samples",
    "--source-archive",
    "source.tar.xz",
    "--browser-evidence",
    "one.png",
    "--browser-evidence",
    "two.png",
    "--autocad-pair-evidence",
    "fillmode.json",
    "--autocad-pair-evidence",
    "attmode.json",
    "--autocad-xref-evidence",
    "xref.json",
    "--autocad-annotation-evidence",
    "annotation.json",
    "--windows-vscode-evidence",
    "windows/report.json",
    "--windows-vsix",
    "viewer.vsix",
    "--windows-companion-vsix",
    "companion.vsix",
    "--output",
    "report.json",
    "--observed-at",
    "2026-08-12T12:00:00Z",
  ]);
  assert.equal(options.browserEvidence.length, 2);
  assert.equal(options.autoCadPairEvidence.length, 2);
  assert.equal(options.autoCadXrefEvidence.length, 1);
  assert.equal(options.autoCadAnnotationEvidence.length, 1);
  assert.equal(
    options.windowsVsCodeEvidencePath,
    path.resolve("windows/report.json"),
  );
  assert.equal(options.observedAt, "2026-08-12T12:00:00Z");
  assert.throws(
    () => parseArguments(["--adapter", "adapter"]),
    /corpusPath is required/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "--adapter",
        "adapter",
        "--corpus",
        "corpus",
        "--autodesk-samples",
        "autodesk-samples",
        "--source-archive",
        "source.tar.xz",
        "--output",
        "report.json",
        "--observed-at",
        "today",
      ]),
    /whole-second UTC/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "--adapter",
        "adapter",
        "--corpus",
        "corpus",
        "--autodesk-samples",
        "autodesk-samples",
        "--source-archive",
        "source.tar.xz",
        "--windows-vscode-evidence",
        "report.json",
        "--output",
        "report.json",
        "--observed-at",
        "2026-08-12T12:00:00Z",
      ]),
    /must be supplied together/u,
  );
});

test("requires the complete Browser display matrix", () => {
  const required = [
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
  ];
  const complete = summarizeBrowserEvidenceCoverage(
    required.map((file) => ({ file: `compatibility/evidence/${file}` })),
  );
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
  const incomplete = summarizeBrowserEvidenceCoverage(
    required.slice(0, -1).map((file) => ({ file })),
  );
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missing, [required.at(-1)]);
  assert.throws(
    () => summarizeBrowserEvidenceCoverage([
      { file: "one/issue-40-model-webview.png" },
      { file: "two/issue-40-model-webview.png" },
    ]),
    /basenames must be unique/u,
  );
});

test("promotes qualification status only after every external gate closes", () => {
  const complete = {
    annotationComplete: true,
    browserComplete: true,
    pairsComplete: true,
    windowsComplete: true,
    xrefComplete: true,
  };
  assert.equal(
    displayParityQualificationStatus(complete),
    "pass-with-explicit-boundaries",
  );
  for (const key of Object.keys(complete)) {
    assert.equal(
      displayParityQualificationStatus({ ...complete, [key]: false }),
      "pass-with-explicit-external-gates",
    );
  }
});

test("requires an AutoCAD loaded, unloaded and unresolved XREF matrix", () => {
  const incomplete = summarizeAutoCadXrefCoverage([]);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missing, ["loaded-unloaded-unresolved"]);
  const complete = summarizeAutoCadXrefCoverage([
    {
      file: "xref.json",
      bytes: 123,
      sha256: "0".repeat(64),
      report: {
        case: {
          id: "xref-matrix",
          xrefName: "DWGV_XREF",
          states: ["loaded", "unloaded", "unresolved"],
        },
      },
    },
  ]);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(complete.cases, [
    {
      id: "xref-matrix",
      xrefName: "DWGV_XREF",
      states: ["loaded", "unloaded", "unresolved"],
    },
  ]);
  assert.throws(
    () =>
      summarizeAutoCadXrefCoverage([
        complete.reports[0] && {
          file: "one.json",
          bytes: 1,
          sha256: "0".repeat(64),
          report: complete.cases[0] && {
            case: complete.cases[0],
          },
        },
        {
          file: "two.json",
          bytes: 1,
          sha256: "1".repeat(64),
          report: { case: complete.cases[0] },
        },
      ]),
    /case ids must be unique/u,
  );
});

test("keeps the AutoCAD annotation gate open until one drawing can switch views", () => {
  const absent = summarizeAutoCadAnnotationCoverage([]);
  assert.equal(absent.generatedMatrixComplete, false);
  assert.equal(absent.complete, false);
  assert.deepEqual(absent.missing, [
    "generated-model-layout-2x2-matrix",
    "single-drawing-model-layout-view-switch",
  ]);
  const partial = summarizeAutoCadAnnotationCoverage([
    {
      file: "annotation.json",
      bytes: 123,
      sha256: "0".repeat(64),
      report: {
        case: {
          id: "annotation-matrix",
          layout: "DWGV_LAYOUT_ANNOTATION_MATRIX",
          supportedScale: { name: "1:1", value: 1 },
          activeScale: { name: "1:2", value: 2 },
          states: ["m0-l0", "m1-l0", "m1-l1", "m0-l1"],
        },
      },
    },
  ]);
  assert.equal(partial.generatedMatrixComplete, true);
  assert.equal(partial.singleDrawingViewSwitchComplete, false);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, [
    "single-drawing-model-layout-view-switch",
  ]);
  const stateValues = [
    ["m0-l0", 0, 0],
    ["m1-l0", 1, 0],
    ["m1-l1", 1, 1],
    ["m0-l1", 0, 1],
  ];
  const complete = summarizeAutoCadAnnotationCoverage([
    {
      ...partial.reports[0],
      report: {
        case: {
          ...partial.cases[0],
          cacheSchema: "dwg-scene-cache/1.26",
          singleDrawingViewSwitch: true,
        },
        states: stateValues.map(([id, model, layout]) => ({
          id,
          values: { model, layout },
          views: Object.fromEntries(
            ["model", "layout"].map((space) => [
              space,
              {
                observed: {
                  activeAnnotationAllVisible: Boolean(
                    space === "model" ? model : layout,
                  ),
                  modelAnnotationAllVisible: Boolean(model),
                  layoutAnnotationAllVisible: Boolean(layout),
                },
              },
            ]),
          ),
        })),
      },
    },
  ]);
  assert.equal(complete.singleDrawingViewSwitchComplete, true);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
  assert.throws(
    () =>
      summarizeAutoCadAnnotationCoverage([
        {
          ...partial.reports[0],
          report: { case: partial.cases[0] },
        },
        {
          ...partial.reports[0],
          file: "duplicate.json",
          report: { case: partial.cases[0] },
        },
      ]),
    /case ids must be unique/u,
  );
});

function pairEvidence(id, variable, values, space = "current") {
  return {
    file: `${id}.json`,
    bytes: 123,
    sha256: "0".repeat(64),
    report: {
      case: {
        id,
        variable,
        values,
        space,
        layout: space === "layout" ? "Sheet 1" : null,
      },
    },
  };
}

test("requires every AutoCAD system-variable pair before closing the gate", () => {
  const incomplete = summarizeAutoCadPairCoverage([
    pairEvidence("fillmode", "FILLMODE", [0, 1]),
  ]);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missing.includes("ATTMODE-0-1-2"));

  const complete = summarizeAutoCadPairCoverage([
    pairEvidence("oleframe", "OLEFRAME", [0, 1, 2]),
    pairEvidence("annotation-layout", "ANNOALLVISIBLE", [0, 1], "layout"),
    pairEvidence("xclipframe", "XCLIPFRAME", [0, 1, 2]),
    pairEvidence("frame", "FRAME", [0, 1, 2]),
    pairEvidence("annotation-model", "ANNOALLVISIBLE", [0, 1], "model"),
    pairEvidence("imageframe", "IMAGEFRAME", [0, 1, 2]),
    pairEvidence("attmode", "ATTMODE", [0, 1, 2]),
    pairEvidence("fillmode", "FILLMODE", [0, 1]),
    pairEvidence("qtextmode", "QTEXTMODE", [0, 1]),
    pairEvidence("splframe", "SPLFRAME", [0, 1]),
    pairEvidence("dispsilh", "DISPSILH", [0, 1]),
    pairEvidence("dispsilhblocks", "DISPSILHBLOCKS", [0, 1]),
    pairEvidence("imagequality", "IMAGEQUALITY", [0, 1]),
    pairEvidence("visretain", "VISRETAIN", [0, 1]),
    pairEvidence("xrefoverride", "XREFOVERRIDE", [0, 1]),
  ]);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(
    complete.cases.map(({ id }) => id),
    [
      "annotation-layout",
      "annotation-model",
      "attmode",
      "dispsilh",
      "dispsilhblocks",
      "fillmode",
      "frame",
      "imageframe",
      "imagequality",
      "oleframe",
      "qtextmode",
      "splframe",
      "visretain",
      "xclipframe",
      "xrefoverride",
    ],
  );
  assert.throws(
    () =>
      summarizeAutoCadPairCoverage([
        pairEvidence("duplicate", "FILLMODE", [0, 1]),
        pairEvidence("duplicate", "ATTMODE", [0, 1, 2]),
      ]),
    /case ids must be unique/u,
  );
});

test("requires the documented AutoCAD screen-pixel transitions", () => {
  const states = (...hashes) =>
    hashes.map((hash, value) => ({
      value,
      referenceImage: { pixelSha256: hash.repeat(64) },
    }));
  assert.equal(
    validateAutoCadPairPixelStates("FILLMODE", states("0", "1")),
    true,
  );
  assert.equal(
    validateAutoCadPairPixelStates("ATTMODE", states("0", "1", "2")),
    true,
  );
  assert.equal(
    validateAutoCadPairPixelStates("IMAGEFRAME", states("0", "1", "1")),
    true,
  );
  assert.equal(
    validateAutoCadPairPixelStates("QTEXTMODE", states("0", "1")),
    true,
  );
  assert.equal(
    validateAutoCadPairPixelStates("IMAGEQUALITY", states("0", "1")),
    true,
  );
  assert.throws(
    () => validateAutoCadPairPixelStates("FILLMODE", states("0", "0")),
    /did not change/u,
  );
  assert.throws(
    () => validateAutoCadPairPixelStates("FRAME", states("0", "1", "2")),
    /identical screen pixels/u,
  );
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("verifies AutoCAD pair reports and every sibling artifact", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dwg-autocad-pair-test-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const states = [];
  for (const value of [0, 1]) {
    const stem = `fillmode-${value}`;
    const drawingBytes = Buffer.from(`AC1032 fillmode ${value}`, "ascii");
    const pngBytes = qualificationPng(
      2,
      2,
      value === 0 ? [16, 32, 48] : [200, 180, 160],
    );
    await Promise.all([
      writeFile(path.join(directory, `${stem}.dwg`), drawingBytes),
      writeFile(path.join(directory, `${stem}.png`), pngBytes),
    ]);
    states.push({
      value,
      autoCad: { value, tileMode: 1, tab: "Model", observed: String(value) },
      drawing: {
        file: `${stem}.dwg`,
        bytes: drawingBytes.byteLength,
        sha256: digest(drawingBytes),
      },
      referenceImage: {
        ...describePng(pngBytes, `${stem}.png`),
        pixelSha256: pngPixelSha256(pngBytes),
      },
      conversion: {
        totalEntities: 1,
        serializedEntities: 1,
        deferredEntities: 0,
        coverage: {
          total_entities: 1,
          serialized_entities: 1,
          deferred_entities: 0,
          hatches: 1,
          deferred_reasons: { invalid_supported_entities: 0 },
        },
        sections: {},
        invalidSupportedEntities: 0,
      },
      observedDrawingValue: { field: "fillMode", value: Boolean(value) },
    });
  }
  const report = {
    schema: "dwg-autocad-system-variable-pair/2",
    status: "pass",
    observedAt: "2026-08-12T12:00:00Z",
    target: {
      product: "Autodesk AutoCAD",
      acadVersion: "25.1s",
      platform: "Microsoft Windows 11",
      displayMode: "saved current 2D view",
    },
    adapter: {
      file: "libredwg-adapter.exe",
      bytes: 123456,
      sha256: "a".repeat(64),
    },
    case: {
      id: "fillmode",
      variable: "FILLMODE",
      values: [0, 1],
      space: "current",
      layout: null,
      singleSession: true,
      camera: "one ZOOM Extents view retained across every state",
    },
    source: {
      file: "HatchG.dwg",
      bytes: 10,
      sha256: "1".repeat(64),
    },
    states,
    pathsIncluded: false,
  };
  const reportPath = path.join(directory, "fillmode.json");
  await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  const evidence = await readAutoCadPairEvidence(reportPath);
  assert.equal(evidence.file, "fillmode.json");
  assert.equal(evidence.report.states.length, 2);

  await writeFile(path.join(directory, "fillmode-1.dwg"), "tampered");
  await assert.rejects(
    readAutoCadPairEvidence(reportPath),
    /size differs|hash differs/u,
  );
});

test("verifies an AutoCAD XREF matrix and every sibling artifact", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dwg-autocad-xref-test-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const caseId = "xref-matrix";
  const hostBytes = Buffer.from("AC1032 empty host", "ascii");
  const childBytes = Buffer.from("AC1032 displayable child", "ascii");
  await Promise.all([
    writeFile(path.join(directory, `${caseId}-source-host.dwg`), hostBytes),
    writeFile(path.join(directory, `${caseId}-source-child.dwg`), childBytes),
  ]);
  const conversion = {
    totalEntities: 1,
    serializedEntities: 1,
    deferredEntities: 0,
    coverage: {
      total_entities: 1,
      serialized_entities: 1,
      deferred_entities: 0,
      deferred_reasons: { invalid_supported_entities: 0 },
    },
    invalidSupportedEntities: 0,
  };
  const stateContracts = [
    ["loaded", true, true, true],
    ["unloaded", false, true, false],
    ["unresolved", false, false, false],
  ];
  const states = [];
  for (let index = 0; index < stateContracts.length; index += 1) {
    const [id, loaded, resolved, displayed] = stateContracts[index];
    const drawingBytes = Buffer.from(`AC1032 ${id}`, "ascii");
    const pngBytes = qualificationPng(
      2,
      2,
      index === 0
        ? Buffer.from([255, 255, 255])
        : Buffer.from([0, 0, 0]),
    );
    const drawingFile = `${caseId}-${id}.dwg`;
    const imageFile = `${caseId}-${id}.png`;
    await Promise.all([
      writeFile(path.join(directory, drawingFile), drawingBytes),
      writeFile(path.join(directory, imageFile), pngBytes),
    ]);
    states.push({
      id,
      autoCad: {
        id,
        tab: "Model",
        tileMode: 1,
        storedPath:
          id === "unresolved"
            ? `.\\${caseId}-intentionally-missing.dwg`
            : `.\\${caseId}-source-child.dwg`,
        resolvedProbe: id === "loaded" ? 1 : 0,
      },
      expected: { loaded, resolved, displayed },
      drawing: {
        file: drawingFile,
        bytes: drawingBytes.byteLength,
        sha256: digest(drawingBytes),
      },
      referenceImage: {
        ...describePng(pngBytes, imageFile),
        pixelSha256: pngPixelSha256(pngBytes),
      },
      observedXref: {
        name: "DWGV_XREF",
        pathKind: "relative",
        loaded,
        resolved,
        referenceCount: 1,
      },
      conversion,
    });
  }
  const report = {
    schema: "dwg-autocad-xref-state-matrix/2",
    status: "pass",
    observedAt: "2026-08-12T12:00:00Z",
    target: {
      product: "Autodesk AutoCAD",
      acadVersion: "25.1s",
      platform: "Microsoft Windows 11",
      displayMode: "2D Wireframe model space",
    },
    adapter: {
      file: "libredwg-adapter.exe",
      bytes: 123456,
      sha256: "a".repeat(64),
    },
    case: {
      id: caseId,
      xrefName: "DWGV_XREF",
      states: stateContracts.map(([id]) => id),
      singleSession: true,
      camera: "one ZOOM Extents view retained across every state",
    },
    sources: {
      host: {
        file: `${caseId}-source-host.dwg`,
        bytes: hostBytes.byteLength,
        sha256: digest(hostBytes),
      },
      child: {
        file: `${caseId}-source-child.dwg`,
        bytes: childBytes.byteLength,
        sha256: digest(childBytes),
        conversion,
      },
    },
    states,
    pathsIncluded: false,
  };
  const reportPath = path.join(directory, `${caseId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  const evidence = await readAutoCadXrefEvidence(reportPath);
  assert.equal(evidence.report.states.length, 3);

  report.states[2].referenceImage.pixelSha256 =
    report.states[0].referenceImage.pixelSha256;
  await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  await assert.rejects(
    readAutoCadXrefEvidence(reportPath),
    /decoded pixels differ|unloaded and unresolved reference pixels differ/u,
  );
  report.states[2].referenceImage.pixelSha256 =
    report.states[1].referenceImage.pixelSha256;

  report.states[2].autoCad.storedPath = "C:\\private\\missing.dwg";
  await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  await assert.rejects(
    readAutoCadXrefEvidence(reportPath),
    /absolute path/u,
  );
});

test("verifies an AutoCAD annotation 2x2 matrix and decoded pixels", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dwg-autocad-annotation-evidence-test-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const caseId = "annotation-matrix";
  const sourceBytes = Buffer.from("AC1032 annotation source", "ascii");
  await writeFile(
    path.join(directory, `${caseId}-source.dwg`),
    sourceBytes,
  );
  const artifact = (file, bytes) => ({
    file,
    bytes: bytes.byteLength,
    sha256: digest(bytes),
  });
  const conversion = {
    totalEntities: 6,
    serializedEntities: 6,
    deferredEntities: 0,
    coverage: {
      total_entities: 6,
      serialized_entities: 6,
      deferred_entities: 0,
      deferred_reasons: { invalid_supported_entities: 0 },
    },
    sections: { text_annotation_contexts: 1 },
    invalidSupportedEntities: 0,
  };
  const modelOff = qualificationPng(2, 2, Buffer.from([0, 0, 0]));
  const modelOn = qualificationPng(2, 2, Buffer.from([255, 0, 0]));
  const layoutOff = qualificationPng(3, 2, Buffer.from([0, 0, 0]));
  const layoutOn = qualificationPng(3, 2, Buffer.from([0, 0, 255]));
  const contracts = [
    ["m0-l0", 0, 0],
    ["m1-l0", 1, 0],
    ["m1-l1", 1, 1],
    ["m0-l1", 0, 1],
  ];
  const states = [];
  for (const [id, model, layout] of contracts) {
    const views = {};
    for (const space of ["model", "layout"]) {
      const stem = `${caseId}-${id}-${space}`;
      const drawingBytes = Buffer.from(`AC1032 ${id} ${space}`, "ascii");
      const pngBytes = space === "model"
        ? model
          ? modelOn
          : modelOff
        : layout
          ? layoutOn
          : layoutOff;
      await Promise.all([
        writeFile(path.join(directory, `${stem}.dwg`), drawingBytes),
        writeFile(path.join(directory, `${stem}.png`), pngBytes),
      ]);
      views[space] = {
        autoCad: {
          id,
          space,
          model,
          layout,
          tab: space === "model"
            ? "Model"
            : "DWGV_LAYOUT_ANNOTATION_MATRIX",
          tileMode: space === "model" ? 1 : 0,
          annotationAllVisible: space === "model" ? model : layout,
          currentScale: "1:2",
          currentScaleValue: 2,
        },
        drawing: artifact(`${stem}.dwg`, drawingBytes),
        referenceImage: {
          ...describePng(pngBytes, `${stem}.png`),
          pixelSha256: pngPixelSha256(pngBytes),
        },
        observed: {
          activeAnnotationAllVisible: Boolean(
            space === "model" ? model : layout,
          ),
          modelAnnotationAllVisible: Boolean(model),
          layoutAnnotationAllVisible: Boolean(layout),
          modelAnnotationScale: space === "model" ? 2 : 0,
          viewportAnnotationScale: 2,
          textHandle: "1A",
          textContextScales: [1],
        },
        conversion,
      };
    }
    states.push({ id, values: { model, layout }, views });
  }
  const report = {
    schema: "dwg-autocad-annotation-scale-matrix/2",
    status: "pass",
    observedAt: "2026-08-12T12:00:00Z",
    target: {
      product: "Autodesk AutoCAD",
      acadVersion: "25.1s",
      platform: "Microsoft Windows 11",
      displayMode: "2D Wireframe model and layout",
    },
    adapter: {
      file: "libredwg-adapter.exe",
      bytes: 123456,
      sha256: "a".repeat(64),
    },
    case: {
      id: caseId,
      layout: "DWGV_LAYOUT_ANNOTATION_MATRIX",
      textValue: "DWGV_ANNOTATION_ANNOTATION_MATRIX",
      style: "DWGV_ANNOTATIVE_ANNOTATION_MATRIX",
      supportedScale: { name: "1:1", value: 1 },
      activeScale: { name: "1:2", value: 2 },
      states: contracts.map(([id]) => id),
      singleSession: true,
      cacheSchema: "dwg-scene-cache/1.26",
      singleDrawingViewSwitch: true,
      cameras:
        "one model camera and one layout camera retained across every state",
    },
    source: artifact(`${caseId}-source.dwg`, sourceBytes),
    fixture: {
      textHandle: "1A",
      viewportHandle: "2B",
      styleName: "DWGV_ANNOTATIVE_ANNOTATION_MATRIX",
      layoutName: "DWGV_LAYOUT_ANNOTATION_MATRIX",
      textValue: "DWGV_ANNOTATION_ANNOTATION_MATRIX",
    },
    states,
    pathsIncluded: false,
  };
  const reportPath = path.join(directory, `${caseId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  const evidence = await readAutoCadAnnotationEvidence(reportPath);
  assert.equal(evidence.report.states.length, 4);

  report.states[2].views.layout.referenceImage.pixelSha256 =
    report.states[1].views.layout.referenceImage.pixelSha256;
  await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  await assert.rejects(
    readAutoCadAnnotationEvidence(reportPath),
    /decoded pixels differ|Expected "actual" to be strictly unequal/u,
  );
});

test("binds packaged Windows evidence to the exact VSIX artifacts", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dwg-windows-vscode-evidence-test-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const viewerPath = path.join(directory, "viewer.vsix");
  const companionPath = path.join(directory, "companion.vsix");
  const viewerBytes = Buffer.from("packaged viewer", "utf8");
  const companionBytes = Buffer.from("packaged companion", "utf8");
  await Promise.all([
    writeFile(viewerPath, viewerBytes),
    writeFile(companionPath, companionBytes),
  ]);
  const pngBytes = Buffer.alloc(10_024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngBytes);
  pngBytes.writeUInt32BE(1_400, 16);
  pngBytes.writeUInt32BE(900, 20);
  const cases = [];
  for (const scalePercent of [100, 125, 150, 200]) {
    const requestedDeviceScaleFactor = scalePercent / 100;
    const widths = [];
    for (const label of ["normal", "narrow"]) {
      const file = `windows-vscode-${scalePercent}-${label}.png`;
      await writeFile(path.join(directory, file), pngBytes);
      widths.push({
        label,
        status: "pass",
        editorCssSize: {
          width: label === "normal" ? 1_050 : 520,
          height: 800,
        },
        actualDevicePixelRatio: requestedDeviceScaleFactor,
        reviewToolbarCoverage: 0.1,
        screenshot: {
          file,
          bytes: pngBytes.byteLength,
          sha256: digest(pngBytes),
        },
      });
    }
    cases.push({
      scalePercent,
      requestedDeviceScaleFactor,
      status: "pass",
      interactionEditorCssSize: { width: 1_050, height: 800 },
      interaction: {
        status: "pass",
        selection: true,
        coordinate: true,
        distance: true,
        fit: true,
        clear: true,
        fitZoom: { before: 1.43, after: 1 },
      },
      layout: {
        status: "pass",
        views: 3,
        pendingReviewStateCleared: true,
      },
      widths,
    });
  }
  const report = {
    schema: "dwg-windows-vscode-ui-qualification/1",
    status: "pass",
    target: {
      platform: "win32",
      architecture: "x64",
      os: "Windows_NT 10.0.26100",
      vscodeChannel: "stable",
      vscodeVersion: "1.103.0",
      packagedVsixInstalled: true,
      packagedCompanionVsixInstalled: true,
    },
    input: {
      drawingBytes: 42,
      drawingSha256:
        "0e74f0aa84b1323c922345f067739c42ee26213dea010b407b87a94212271654",
      vsixBytes: viewerBytes.byteLength,
      vsixSha256: digest(viewerBytes),
      companionVsixBytes: companionBytes.byteLength,
      companionVsixSha256: digest(companionBytes),
      pathDisclosure: "none",
    },
    cases,
    cleanup: {
      perScaleProcessTreeTermination: "enforced",
      perScaleProfileRemoval: "enforced",
      privateRootRemoval: "enforced-before-success-return",
    },
    pathsIncluded: false,
  };
  const reportPath = path.join(directory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report)}\n`);
  const evidence = await readWindowsVsCodeEvidence(
    reportPath,
    viewerPath,
    companionPath,
  );
  assert.deepEqual(evidence.displayScalesPercent, [100, 125, 150, 200]);
  assert.equal(evidence.screenshots.length, 8);
  assert.equal(evidence.input.viewerVsix.sha256, digest(viewerBytes));

  await writeFile(viewerPath, "tampered viewer");
  await assert.rejects(
    readWindowsVsCodeEvidence(reportPath, viewerPath, companionPath),
    /size differs|hash differs/u,
  );
});

test("requires exact source, serialized and deferred partitions", () => {
  assert.equal(validateConversionReport(report()).coverage.total_entities, 7);
  assert.throws(
    () =>
      validateConversionReport(
        report({
          coverage: {
            ...report().coverage,
            serialized_entities: 4,
          },
        }),
      ),
    /Expected values to be strictly equal/u,
  );
  assert.throws(
    () =>
      validateConversionReport(
        report({
          coverage: {
            ...report().coverage,
            deferred_reasons: {
              ...report().coverage.deferred_reasons,
              invalid_supported_entities: 1,
            },
          },
        }),
      ),
    /Expected values to be strictly equal/u,
  );
});

test("aggregates every numeric coverage branch", () => {
  const aggregate = aggregateCoverage([report(), report()]);
  assert.equal(aggregate.total_entities, 14);
  assert.equal(aggregate.serialized_entities, 10);
  assert.equal(aggregate.deferred_entities, 4);
  assert.equal(aggregate.lines, 10);
  assert.equal(aggregate.deferred_reasons.unsupported_underlays, 2);
});

test("counts unavailable and concrete presentation states separately", () => {
  const summary = summarizePresentation([
    {
      fillMode: true,
      attributeDisplayMode: 1,
      annotationAllVisible: true,
      modelAnnotationScale: 1,
      modelSpaceLinetypeScale: false,
      paperSpaceLinetypeScale: true,
      lineWeightDisplay: false,
      modelSpaceActive: true,
      wipeoutFrame: null,
      imageFrame: 1,
      xclipFrame: 2,
      oleFrame: null,
      frame: null,
      pdfFrame: null,
      dwfFrame: null,
      dgnFrame: null,
    },
    {
      fillMode: false,
      attributeDisplayMode: 2,
      annotationAllVisible: false,
      modelAnnotationScale: 50,
      modelSpaceLinetypeScale: true,
      paperSpaceLinetypeScale: false,
      lineWeightDisplay: true,
      modelSpaceActive: false,
      wipeoutFrame: 0,
      imageFrame: 0,
      xclipFrame: 0,
      oleFrame: 0,
      frame: 0,
      pdfFrame: 0,
      dwfFrame: 0,
      dgnFrame: 0,
    },
  ]);
  assert.deepEqual(summary.fillMode, { true: 1, false: 1 });
  assert.deepEqual(summary.attributeDisplayMode, { 1: 1, 2: 1 });
  assert.deepEqual(summary.modelAnnotationScale, { 1: 1, 50: 1 });
  assert.deepEqual(summary.wipeoutFrame, { unavailable: 1, 0: 1 });
});

test("separates viewport visibility from unsupported 3D display modes", () => {
  const viewports = [
    {
      flags: 0,
      on: 1,
      status: 0,
      width: 10,
      height: 10,
      viewHeight: 10,
      renderMode: 1,
    },
    {
      flags: 1,
      on: 2,
      status: 1 | 2 | 4,
      width: 10,
      height: 10,
      viewHeight: 10,
      renderMode: 2,
    },
    {
      flags: 0,
      on: 0,
      status: 0x20000,
      width: 10,
      height: 10,
      viewHeight: 10,
      renderMode: 0,
    },
  ];
  assert.deepEqual(viewportModeSummary([{ viewports }]), {
    total: 3,
    inactiveOrOff: 2,
    perspectiveDeferred: 1,
    frontClippingDeferred: 1,
    backClippingDeferred: 1,
    nonWireframeDeferred: 1,
  });
});

test("counts model and paper ANNOALLVISIBLE independently", () => {
  assert.deepEqual(
    layoutAnnotationVisibilitySummary([
      { index: 0, annotationAllVisible: true },
      { index: 1, annotationAllVisible: false },
      { index: 2, annotationAllVisible: true },
      { index: 3, annotationAllVisible: null },
    ]),
    {
      model: { true: 1, false: 0, unavailable: 0 },
      paper: { true: 1, false: 1, unavailable: 1 },
    },
  );
  assert.throws(
    () =>
      layoutAnnotationVisibilitySummary([
        { index: 1, annotationAllVisible: 1 },
      ]),
    /invalid ANNOALLVISIBLE/u,
  );
});

test("hashes a bounded PNG and reads its dimensions", () => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(1280, 16);
  bytes.writeUInt32BE(720, 20);
  const result = describePng(bytes, "evidence.png");
  assert.equal(result.file, "evidence.png");
  assert.equal(result.bytes, 24);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => describePng(Buffer.alloc(24), "bad.png"), /PNG/u);
});

test("hashes decoded PNG pixels independently of chunk encoding", () => {
  const red = qualificationPng(2, 2, Buffer.from([255, 0, 0]));
  const redWithAncillaryChunk = Buffer.concat([
    red.subarray(0, red.byteLength - 12),
    Buffer.from([0, 0, 0, 3, 116, 69, 88, 116, 97, 98, 99, 0, 0, 0, 0]),
    red.subarray(red.byteLength - 12),
  ]);
  const blue = qualificationPng(2, 2, Buffer.from([0, 0, 255]));
  assert.equal(pngPixelSha256(red), pngPixelSha256(redWithAncillaryChunk));
  assert.notEqual(pngPixelSha256(red), pngPixelSha256(blue));
  assert.throws(() => pngPixelSha256(Buffer.alloc(24)), /PNG/u);
});

test("hashes a baseline AutoCAD JPEG and reads its dimensions", () => {
  const bytes = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x01, 0x01,
    0x11, 0x00,
    0xff, 0xd9,
  ]);
  const result = describeJpeg(bytes, "2013/Line.jpg");
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => describeJpeg(Buffer.alloc(24), "bad.jpg"), /JPEG/u);
});

test("parses bounded AutoCAD ActiveX vector properties", () => {
  const text = [
    "[ AutoCAD - Mon May 26 16:49:08 2014  ]",
    ";   BasePoint = (34.684 48.4498 0.0)",
    ";   DirectionVector = (-0.018621 -0.999827 0.0)",
  ].join("\n");
  assert.deepEqual(parseAutoCadVectorProperty(text, "BasePoint"), [
    34.684,
    48.4498,
    0,
  ]);
  assert.deepEqual(parseAutoCadVectorProperty(text, "DirectionVector"), [
    -0.018621,
    -0.999827,
    0,
  ]);
  assert.throws(
    () => parseAutoCadVectorProperty(text, "Missing"),
    /unavailable/u,
  );
});
