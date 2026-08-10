// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewportLayerOverrideProperty,
} from "../packages/dwg-scene-source/src/index.mjs";
import {
  makeFixtureCache,
} from "../packages/webview/test/cache-fixture.mjs";
import {
  inspectViewportLayerOverrideCache,
  parseArguments,
} from "./qualify-viewport-layer-overrides.mjs";

const expectation = Object.freeze({
  layoutName: "배치1",
  layerName: "0",
  linetypeName: "DASHED",
  color: 0xc040c4ff,
  transparency: 0x27000000,
  lineWeight: 50,
});

function makeOverrideCache(rows = [
  {
    viewportHandle: 2002,
    layerIndex: 0,
    property: ViewportLayerOverrideProperty.Color,
    value: expectation.color,
  },
  {
    viewportHandle: 2002,
    layerIndex: 0,
    property: ViewportLayerOverrideProperty.Transparency,
    value: expectation.transparency,
  },
  {
    viewportHandle: 2002,
    layerIndex: 0,
    property: ViewportLayerOverrideProperty.Linetype,
    value: 3,
  },
  {
    viewportHandle: 2002,
    layerIndex: 0,
    property: ViewportLayerOverrideProperty.LineWeight,
    value: expectation.lineWeight,
  },
]) {
  return makeFixtureCache({
    lineWeightDisplay: true,
    viewportLayerOverrides: rows,
  });
}

test("qualifies all four viewport layer override properties", async () => {
  const result = await inspectViewportLayerOverrideCache(
    makeOverrideCache(),
    expectation,
  );

  assert.deepEqual(result, {
    cacheVersion: "1.20",
    sectionCount: 47,
    overrideRecordCount: 4,
    lineWeightDisplay: true,
    layoutName: "배치1",
    viewportCount: 2,
    viewportHandle: "0x7d2",
    viewportId: 2,
    layerName: "0",
    linetypeName: "DASHED",
    override: {
      layerIndex: 0,
      flags: 15,
      color: 0xc040c4ff,
      transparency: 0x27000000,
      linetypeCode: 3,
      lineWeight: 50,
    },
  });
});

test("rejects an incomplete viewport layer override fixture", async () => {
  const incomplete = makeOverrideCache().slice(0);
  const directory = new DataView(incomplete);
  const sectionCount = directory.getUint32(16, true);
  let overrideEntryOffset = -1;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = 64 + index * 40;
    if (directory.getUint32(offset, true) === 58) {
      overrideEntryOffset = offset;
      break;
    }
  }
  assert.notEqual(overrideEntryOffset, -1);
  directory.setBigUint64(overrideEntryOffset + 24, 3n, true);
  directory.setBigUint64(overrideEntryOffset + 16, 72n, true);

  await assert.rejects(
    inspectViewportLayerOverrideCache(incomplete, expectation),
    /exactly four viewport layer override records/u,
  );
});

test("parses reusable fixture expectations", () => {
  assert.deepEqual(
    parseArguments([
      "--",
      "--fixture",
      "/tmp/fixture.dwg",
      "--adapter",
      "/tmp/libredwg-adapter",
      "--layout",
      "Sheet A",
      "--color",
      "0xc040c4ff",
      "--lineweight",
      "50",
    ]),
    {
      adapterPath: "/tmp/libredwg-adapter",
      fixturePath: "/tmp/fixture.dwg",
      expectation: {
        layoutName: "Sheet A",
        layerName: "TARGET",
        linetypeName: "DASHED",
        color: 0xc040c4ff,
        transparency: 0x27000000,
        lineWeight: 50,
      },
    },
  );
  assert.equal(parseArguments(["--adapter", "/tmp/adapter"]), undefined);
  assert.equal(
    parseArguments([
      "--adapter",
      "/tmp/adapter",
      "--fixture",
      "/tmp/fixture.dwg",
      "--unknown",
      "value",
    ]),
    undefined,
  );
});
