#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  CACHE_VERSION_MAJOR,
  CACHE_VERSION_MINOR,
  MemoryRangeSource,
  SceneCacheReader,
  SectionKind,
  ViewportLayerOverrideFlags,
} from "../packages/dwg-scene-source/src/index.mjs";

const execFileAsync = promisify(execFile);
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION = Object.freeze({
  layoutName: "Layout1",
  layerName: "TARGET",
  linetypeName: "DASHED",
  color: 0xc0112233,
  transparency: 0x27000000,
  lineWeight: 50,
});

function parseUnsignedInteger(value, label, maximum = 0xffffffff) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new TypeError(`${label} must be an integer from 0 through ${maximum}`);
  }
  return parsed >>> 0;
}

function normalizeExpectation(expectation = {}) {
  const merged = {
    ...DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION,
    ...expectation,
  };
  for (const field of ["layoutName", "layerName", "linetypeName"]) {
    if (typeof merged[field] !== "string" || merged[field].length === 0) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  return Object.freeze({
    layoutName: merged.layoutName,
    layerName: merged.layerName,
    linetypeName: merged.linetypeName,
    color: parseUnsignedInteger(merged.color, "color"),
    transparency: parseUnsignedInteger(
      merged.transparency,
      "transparency",
    ),
    lineWeight: parseUnsignedInteger(merged.lineWeight, "lineWeight", 211),
  });
}

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new TypeError("cache must be an ArrayBuffer or typed-array view");
}

export async function inspectViewportLayerOverrideCache(
  cache,
  expectation,
) {
  const expected = normalizeExpectation(expectation);
  const buffer = toArrayBuffer(cache);
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(buffer),
  );
  assert.equal(reader.header.major, CACHE_VERSION_MAJOR);
  assert.equal(reader.header.minor, CACHE_VERSION_MINOR);

  const overrideSection = reader.sections.get(
    SectionKind.ViewportLayerOverrides,
  );
  assert.ok(overrideSection);
  assert.equal(
    overrideSection.recordCount,
    4,
    "fixture must contain exactly four viewport layer override records",
  );

  const [layouts, layers, linetypes] = await Promise.all([
    reader.readLayouts(),
    reader.readLayers(),
    reader.readLinetypes(),
  ]);
  const layerIndex = layers.findIndex(
    (layer) => layer.name === expected.layerName,
  );
  assert.notEqual(
    layerIndex,
    -1,
    `layer ${expected.layerName} was not found`,
  );
  const matchingLayouts = layouts.filter(
    (layout) => layout.name === expected.layoutName,
  );
  assert.equal(
    matchingLayouts.length,
    1,
    `expected one layout named ${expected.layoutName}`,
  );
  const matchingLinetypes = linetypes.filter(
    (linetype) => linetype.name === expected.linetypeName,
  );
  assert.equal(
    matchingLinetypes.length,
    1,
    `expected one linetype named ${expected.linetypeName}`,
  );

  const matchingViewports = matchingLayouts[0].viewports.filter(
    (viewport) =>
      viewport.layerOverrides.some(
        (override) => override.layerIndex === layerIndex,
      ),
  );
  assert.equal(
    matchingViewports.length,
    1,
    "expected one viewport with the target layer override",
  );
  const viewport = matchingViewports[0];
  assert.equal(
    viewport.layerOverrides.length,
    1,
    "fixture viewport must override exactly one layer",
  );
  const override = viewport.layerOverrides[0];
  assert.deepEqual(override, {
    layerIndex,
    flags:
      ViewportLayerOverrideFlags.Color |
      ViewportLayerOverrideFlags.Transparency |
      ViewportLayerOverrideFlags.Linetype |
      ViewportLayerOverrideFlags.LineWeight,
    color: expected.color,
    transparency: expected.transparency,
    linetypeCode: matchingLinetypes[0].code,
    lineWeight: expected.lineWeight,
  });

  return Object.freeze({
    cacheVersion: `${reader.header.major}.${reader.header.minor}`,
    sectionCount: reader.sections.size,
    overrideRecordCount: overrideSection.recordCount,
    layoutName: matchingLayouts[0].name,
    viewportHandle: `0x${viewport.handle.toString(16)}`,
    layerName: layers[layerIndex].name,
    linetypeName: matchingLinetypes[0].name,
    override: Object.freeze({ ...override }),
  });
}

export function parseArguments(values) {
  if (values[0] === "--") {
    values = values.slice(1);
  }
  if (values.length % 2 !== 0) {
    return undefined;
  }
  const allowed = new Set([
    "--adapter",
    "--fixture",
    "--layout",
    "--layer",
    "--linetype",
    "--color",
    "--transparency",
    "--lineweight",
  ]);
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || !value || parsed.has(flag)) {
      return undefined;
    }
    parsed.set(flag, value);
  }
  if (!parsed.has("--adapter") || !parsed.has("--fixture")) {
    return undefined;
  }
  return Object.freeze({
    adapterPath: parsed.get("--adapter"),
    fixturePath: parsed.get("--fixture"),
    expectation: Object.freeze({
      layoutName:
        parsed.get("--layout") ??
        DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION.layoutName,
      layerName:
        parsed.get("--layer") ??
        DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION.layerName,
      linetypeName:
        parsed.get("--linetype") ??
        DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION.linetypeName,
      color: parseUnsignedInteger(
        parsed.get("--color") ??
          DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION.color,
        "color",
      ),
      transparency: parseUnsignedInteger(
        parsed.get("--transparency") ??
          DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION.transparency,
        "transparency",
      ),
      lineWeight: parseUnsignedInteger(
        parsed.get("--lineweight") ??
          DEFAULT_VIEWPORT_LAYER_OVERRIDE_EXPECTATION.lineWeight,
        "lineweight",
        211,
      ),
    }),
  });
}

function absoluteFile(value, label) {
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

async function readJsonProcess(adapterPath, arguments_) {
  const { stdout } = await execFileAsync(adapterPath, arguments_, {
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
}

export async function qualifyViewportLayerOverrideFixture({
  adapterPath,
  fixturePath,
  expectation,
}) {
  const adapter = absoluteFile(adapterPath, "adapter");
  const fixture = absoluteFile(fixturePath, "fixture");
  const [adapterMetadata, fixtureMetadata] = await Promise.all([
    stat(adapter),
    stat(fixture),
  ]);
  assert.equal(adapterMetadata.isFile(), true, "adapter must be a file");
  assert.equal(fixtureMetadata.isFile(), true, "fixture must be a file");
  assert.ok(
    fixtureMetadata.size <= MAX_FIXTURE_BYTES,
    `fixture exceeds the ${MAX_FIXTURE_BYTES}-byte qualification limit`,
  );
  const fixtureBytes = await readFile(fixture);

  const workRoot = await mkdtemp(
    path.join(os.tmpdir(), "dwg-viewport-layer-overrides-"),
  );
  const cachePath = path.join(workRoot, "fixture.scene-cache");
  try {
    const doctor = await readJsonProcess(adapter, ["doctor"]);
    assert.equal(doctor.schema, "dwg-engine-doctor/1");
    assert.equal(doctor.status, "ok");
    assert.equal(doctor.protocol, "dwg-engine-adapter/1");
    assert.equal(
      doctor.cache?.schema,
      `dwg-scene-cache/${CACHE_VERSION_MAJOR}.${CACHE_VERSION_MINOR}`,
    );

    const conversion = await readJsonProcess(adapter, [
      "convert",
      fixture,
      cachePath,
    ]);
    assert.equal(conversion.schema, "dwg-scene-cache/1");
    assert.equal(conversion.status, "ok");
    assert.equal(conversion.cache?.format_major, CACHE_VERSION_MAJOR);
    assert.equal(conversion.cache?.format_minor, CACHE_VERSION_MINOR);
    assert.equal(conversion.cache?.validated, true);
    const overrideSection = conversion.cache?.sections?.find(
      (section) => section.kind === "viewport_layer_overrides",
    );
    assert.equal(overrideSection?.records, 4);

    const cacheMetadata = await stat(cachePath);
    assert.ok(
      cacheMetadata.size <= MAX_CACHE_BYTES,
      `cache exceeds the ${MAX_CACHE_BYTES}-byte qualification limit`,
    );
    const cacheBytes = await readFile(cachePath);
    const observed = await inspectViewportLayerOverrideCache(
      cacheBytes,
      expectation,
    );
    return Object.freeze({
      schema: "dwg-viewport-layer-overrides-qualification/1",
      status: "pass",
      fixture: Object.freeze({
        name: path.basename(fixture),
        bytes: fixtureMetadata.size,
        sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
      }),
      adapter: Object.freeze({
        engine: doctor.engine,
        target: doctor.target,
      }),
      cache: Object.freeze({
        bytes: cacheBytes.byteLength,
        parseMilliseconds: conversion.performance?.parse_ms,
        writeMilliseconds: conversion.performance?.write_ms,
        totalMilliseconds: conversion.performance?.total_ms,
      }),
      observed,
    });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      "usage: qualify-viewport-layer-overrides.mjs " +
        "--adapter ABSOLUTE_ADAPTER --fixture ABSOLUTE_DWG " +
        "[--layout NAME --layer NAME --linetype NAME " +
        "--color UINT32 --transparency UINT32 --lineweight 0..211]\n",
    );
    process.exitCode = 2;
    return;
  }
  const report = await qualifyViewportLayerOverrideFixture(parsed);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
