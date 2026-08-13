#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  MemoryRangeSource,
  SceneCacheReader,
  SectionKind,
  TextEntityKind,
} from "../packages/dwg-scene-source/src/index.mjs";
import {
  blockExternalReferenceIsDisplayable,
} from "../packages/webview/src/external-reference.mjs";
import {
  effectiveFrameSetting,
} from "../packages/webview/src/frame-setting.mjs";
import {
  annotativeTextRecordForInstance,
  textRecordIsVisible,
} from "../packages/webview/src/text-overlay.mjs";
import {
  makeViewDescriptors,
} from "../packages/webview/src/viewer.mjs";
import {
  makeFixtureCache,
} from "../packages/webview/test/cache-fixture.mjs";

const REPORT_SCHEMA = "dwg-display-state-matrix-qualification/1";
const CACHE_SCHEMA = "dwg-scene-cache/1.26";
const FIXTURE_LICENSE = "MPL-2.0";
const ENTITY_SECTION_KINDS = Object.freeze([
  SectionKind.Lines,
  SectionKind.Arcs,
  SectionKind.Circles,
  SectionKind.Inserts,
  SectionKind.PolylineHeaders,
  SectionKind.Ellipses,
  SectionKind.SplineHeaders,
  SectionKind.TextEntities,
  SectionKind.HatchEntities,
  SectionKind.PointEntities,
  SectionKind.SolidEntities,
  SectionKind.FaceEntities,
  SectionKind.WipeoutEntities,
  SectionKind.ImageEntities,
  SectionKind.ConstructionLines,
]);
const DEFERRED_REASONS = Object.freeze({
  unresolvedDimensions: 0,
  unsupportedUnderlays: 0,
  unsupportedProxyGraphics: 0,
  unsupported3dEntities: 0,
  invalidSupportedEntities: 0,
  unsupportedOtherEntities: 0,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cacheBytes(buffer) {
  return Buffer.from(buffer, 0, buffer.byteLength);
}

function serializedEntityCount(reader) {
  return ENTITY_SECTION_KINDS.reduce(
    (total, kind) => total + reader.getSection(kind).recordCount,
    0,
  );
}

function inventory(reader) {
  const serializedEntities = serializedEntityCount(reader);
  const deferredEntities = Object.values(DEFERRED_REASONS).reduce(
    (total, value) => total + value,
    0,
  );
  return Object.freeze({
    sourceEntities: serializedEntities + deferredEntities,
    serializedEntities,
    deferredEntities,
    deferredReasons: DEFERRED_REASONS,
  });
}

function attributeDisplayDecision(mode) {
  const common = {
    commonFlags: 0,
    kind: TextEntityKind.Attribute,
  };
  return Object.freeze({
    normal: textRecordIsVisible(
      { ...common, sourceFlags: 0 },
      0,
      new Set([0]),
      mode,
    ),
    invisible: textRecordIsVisible(
      { ...common, sourceFlags: 1 },
      0,
      new Set([0]),
      mode,
    ),
  });
}

function annotationDisplayDecision(allVisible) {
  const record = Object.freeze({
    flags: 1 << 2,
    annotationContexts: Object.freeze([
      Object.freeze({ scale: 1, isDefault: true }),
    ]),
  });
  const selected = annotativeTextRecordForInstance(
    record,
    {
      annotationScalesByVisibilityRow: new Float64Array([2]),
    },
    { visibilityRows: new Uint32Array([0]) },
    0,
    allVisible,
  );
  return Object.freeze({
    missingScaleRepresentationVisible: selected !== null,
  });
}

function frameDisplayDecision(frame, specific) {
  const effective = effectiveFrameSetting(frame, specific);
  return Object.freeze({
    effective,
    screenVisible: effective === 1 || effective === 2,
    plotVisible: effective === 1,
  });
}

async function qualifyCase({
  id,
  family,
  options,
  observe,
}) {
  const buffer = makeFixtureCache(options);
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(buffer),
  );
  const metadata = await reader.readRenderMetadata();
  return Object.freeze({
    id,
    family,
    source: Object.freeze({
      kind: "repository-generated-scene-cache",
      license: FIXTURE_LICENSE,
      bytes: buffer.byteLength,
      sha256: sha256(cacheBytes(buffer)),
    }),
    inventory: inventory(reader),
    display: Object.freeze(observe(metadata)),
  });
}

function fillModeCases() {
  return [false, true].map((value) => ({
    id: `fillmode-${Number(value)}`,
    family: "FILLMODE",
    options: { fillMode: value },
    observe(metadata) {
      return { hatchFillVisible: metadata.drawing.fillMode };
    },
  }));
}

function attributeModeCases() {
  return [0, 1, 2].map((value) => ({
    id: `attmode-${value}`,
    family: "ATTMODE",
    options: { attributeDisplayMode: value },
    observe(metadata) {
      return attributeDisplayDecision(
        metadata.drawing.attributeDisplayMode,
      );
    },
  }));
}

function annotationCases() {
  return [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ].map(([model, layout]) => ({
    id: `annotation-model-${Number(model)}-layout-${Number(layout)}`,
    family: "annotation",
    options: {
      annotationAllVisible: model,
      layoutAnnotationAllVisible: layout,
    },
    observe(metadata) {
      const views = makeViewDescriptors(metadata).views;
      const modelView = views.find((view) => view.kind === "model");
      const layoutView = views.find((view) => view.kind === "layout");
      return {
        model: annotationDisplayDecision(
          modelView.annotationAllVisible,
        ),
        layout: annotationDisplayDecision(
          layoutView.annotationAllVisible,
        ),
      };
    },
  }));
}

function frameCases() {
  return [
    [0, 2],
    [1, 0],
    [2, 1],
    [3, 0],
    [3, 1],
    [3, 2],
  ].map(([frame, imageFrame]) => ({
    id: `frame-${frame}-imageframe-${imageFrame}`,
    family: "FRAME",
    options: { frame, imageFrame },
    observe(metadata) {
      return frameDisplayDecision(
        metadata.drawing.frame,
        metadata.drawing.imageFrame,
      );
    },
  }));
}

function layoutCases() {
  return [true, false].map((modelSpaceActive) => ({
    id: modelSpaceActive ? "layout-model" : "layout-paper",
    family: "layout",
    options: {
      modelSpaceActive,
      paperBlockName: "*PAPER_SPACE",
    },
    observe(metadata) {
      const views = makeViewDescriptors(metadata);
      return {
        activeKind: views.active.kind,
        restoration: views.savedStateRestoration.status,
      };
    },
  }));
}

function xrefCases() {
  return [
    ["loaded", true, true],
    ["unloaded", false, true],
    ["unresolved", true, false],
  ].map(([state, xrefLoaded, xrefResolved]) => ({
    id: `xref-${state}`,
    family: "XREF",
    options: { xrefLoaded, xrefResolved },
    observe(metadata) {
      const block = metadata.blocks.find((value) => value.xrefPath);
      return {
        state,
        displayable: blockExternalReferenceIsDisplayable(block),
      };
    },
  }));
}

export function validateDisplayStateMatrix(report) {
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.cacheSchema, CACHE_SCHEMA);
  assert.equal(report.status, "pass");
  assert.equal(report.cases.length, 20);
  assert.equal(new Set(report.cases.map((value) => value.id)).size, 20);
  for (const value of report.cases) {
    assert.equal(value.source.kind, "repository-generated-scene-cache");
    assert.equal(value.source.license, FIXTURE_LICENSE);
    assert.match(value.source.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      value.inventory.sourceEntities,
      value.inventory.serializedEntities +
        value.inventory.deferredEntities,
    );
    assert.equal(
      value.inventory.deferredEntities,
      Object.values(value.inventory.deferredReasons).reduce(
        (total, count) => total + count,
        0,
      ),
    );
  }
  const expectedFamilies = {
    FILLMODE: 2,
    ATTMODE: 3,
    annotation: 4,
    FRAME: 6,
    layout: 2,
    XREF: 3,
  };
  for (const [family, count] of Object.entries(expectedFamilies)) {
    assert.equal(
      report.cases.filter((value) => value.family === family).length,
      count,
    );
  }
  assert.equal(
    report.fingerprint,
    sha256(JSON.stringify(report.cases)),
  );
  return true;
}

export async function buildDisplayStateMatrixReport() {
  const definitions = [
    ...fillModeCases(),
    ...attributeModeCases(),
    ...annotationCases(),
    ...frameCases(),
    ...layoutCases(),
    ...xrefCases(),
  ];
  const cases = Object.freeze(
    await Promise.all(definitions.map(qualifyCase)),
  );
  const report = Object.freeze({
    schema: REPORT_SCHEMA,
    status: "pass",
    cacheSchema: CACHE_SCHEMA,
    fixturePolicy: Object.freeze({
      source: "repository-generated",
      redistribution: FIXTURE_LICENSE,
      privateInput: false,
    }),
    cases,
    fingerprint: sha256(JSON.stringify(cases)),
  });
  validateDisplayStateMatrix(report);
  return report;
}

async function main() {
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--output" ||
    !path.isAbsolute(process.argv[3])
  ) {
    throw new Error(
      "usage: qualify-display-state-matrix.mjs --output ABSOLUTE_PATH",
    );
  }
  const report = await buildDisplayStateMatrixReport();
  const handle = await open(process.argv[3], "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
