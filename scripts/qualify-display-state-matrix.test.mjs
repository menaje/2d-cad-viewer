// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildDisplayStateMatrixFixtureCaches,
  buildDisplayStateMatrixReport,
  validateDisplayStateMatrix,
} from "./qualify-display-state-matrix.mjs";

function casesByFamily(report, family) {
  return report.cases.filter((value) => value.family === family);
}

test("qualifies a deterministic redistributable display-state matrix", async () => {
  const first = await buildDisplayStateMatrixReport();
  const second = await buildDisplayStateMatrixReport();

  assert.equal(validateDisplayStateMatrix(first), true);
  assert.deepEqual(first, second);
  assert.equal(first.fixturePolicy.privateInput, false);
  assert.equal(
    first.cases.every(
      (value) =>
        value.inventory.sourceEntities > 0 &&
        value.inventory.deferredEntities === 0,
    ),
    true,
  );
});

test("exports the exact path-free caches for packaged host qualification", async () => {
  const report = await buildDisplayStateMatrixReport();
  const fixtures = buildDisplayStateMatrixFixtureCaches();

  assert.equal(fixtures.length, 20);
  assert.deepEqual(
    fixtures.map(({ id, family }) => ({ id, family })),
    report.cases.map(({ id, family }) => ({ id, family })),
  );
  assert.equal(
    fixtures.every(
      ({ cache }, index) =>
        cache.byteLength === report.cases[index].source.bytes &&
        createHash("sha256").update(cache).digest("hex") ===
          report.cases[index].source.sha256,
    ),
    true,
  );
});

test("binds every saved state to the production display decision", async () => {
  const report = await buildDisplayStateMatrixReport();

  assert.deepEqual(
    casesByFamily(report, "FILLMODE").map(
      (value) => value.display.hatchFillVisible,
    ),
    [false, true],
  );
  assert.deepEqual(
    casesByFamily(report, "ATTMODE").map((value) => value.display),
    [
      { normal: false, invisible: false },
      { normal: true, invisible: false },
      { normal: true, invisible: true },
    ],
  );
  assert.deepEqual(
    casesByFamily(report, "annotation").map((value) => [
      value.display.model.missingScaleRepresentationVisible,
      value.display.layout.missingScaleRepresentationVisible,
    ]),
    [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ],
  );
  assert.deepEqual(
    casesByFamily(report, "FRAME").map((value) => value.display),
    [
      { effective: 0, screenVisible: false, plotVisible: false },
      { effective: 1, screenVisible: true, plotVisible: true },
      { effective: 2, screenVisible: true, plotVisible: false },
      { effective: 0, screenVisible: false, plotVisible: false },
      { effective: 1, screenVisible: true, plotVisible: true },
      { effective: 2, screenVisible: true, plotVisible: false },
    ],
  );
  assert.deepEqual(
    casesByFamily(report, "layout").map((value) => value.display),
    [
      { activeKind: "model", restoration: "restored-model" },
      { activeKind: "layout", restoration: "restored-paper" },
    ],
  );
  assert.deepEqual(
    casesByFamily(report, "XREF").map((value) => value.display),
    [
      { state: "loaded", displayable: true },
      { state: "unloaded", displayable: false },
      { state: "unresolved", displayable: false },
    ],
  );
});
