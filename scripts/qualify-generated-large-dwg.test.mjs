// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQualificationReport,
  parseArguments,
  REPORT_SCHEMA,
  validateAdapterReport,
} from "./qualify-generated-large-dwg.mjs";

const required = [
  "--adapter",
  "/tmp/libredwg-adapter",
  "--dxf2dwg",
  "/tmp/dxf2dwg",
  "--work-root",
  "/tmp/new-large-work",
  "--report",
  "/tmp/new-large-report.json",
];

function adapterReport(entityCount, totalMs = 30) {
  return {
    schema: "dwg-scene-cache/1",
    status: "ok",
    cache: {
      validated: true,
      size_bytes: 12_000_000,
      sections: [{ kind: "lines", records: entityCount }],
    },
    coverage: {
      total_entities: entityCount,
      serialized_entities: entityCount,
      deferred_entities: 0,
      lines: entityCount,
    },
    gpu_lines: { vertices: entityCount * 2 },
    performance: {
      parse_ms: 10,
      write_ms: 20,
      total_ms: totalMs,
      peak_rss_bytes: 100_000_000,
    },
    diagnostics: 0,
  };
}

test("parses bounded generated-large qualification options", () => {
  assert.deepEqual(parseArguments(required), {
    adapterPath: "/tmp/libredwg-adapter",
    dxf2dwgPath: "/tmp/dxf2dwg",
    workRoot: "/tmp/new-large-work",
    reportPath: "/tmp/new-large-report.json",
    entityCount: 100_000,
    minimumDwgBytes: 5_000_000,
  });
  assert.equal(
    parseArguments([...required, "--entities", "0"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--minimum-dwg-bytes", "5MB"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--unknown", "1"]),
    undefined,
  );
});

test("requires complete lossless LINE coverage", () => {
  validateAdapterReport(adapterReport(100_000), 100_000);
  const deferred = adapterReport(100_000);
  deferred.coverage.deferred_entities = 1;
  assert.throws(
    () => validateAdapterReport(deferred, 100_000),
    /Expected values to be strictly equal/u,
  );
});

test("builds a path-free deterministic two-run report", () => {
  const generator = {
    schema: "dwg-generated-large-line-dxf/1",
    license: "MPL-2.0",
    format: "ASCII DXF R2000",
    entityType: "LINE",
    entityCount: 100_000,
    columns: 1_000,
    bytes: 9_111_277,
    sha256: "a".repeat(64),
  };
  const first = adapterReport(100_000, 30);
  const second = adapterReport(100_000, 32);
  const report = buildQualificationReport({
    generator,
    dwgBytes: 5_700_000,
    dwgSha256: "b".repeat(64),
    minimumDwgBytes: 5_000_000,
    adapterReports: [first, second],
    cacheBytes: [12_000_000, 12_000_000],
    cacheSha256: ["c".repeat(64), "c".repeat(64)],
    platform: "darwin",
    architecture: "arm64",
  });

  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.status, "pass");
  assert.equal(report.fixturePolicy.privateInput, false);
  assert.equal(report.sceneCache.coverage.deferredEntities, 0);
  assert.equal(report.performance[0].total_ms, 30);
  assert.equal(report.performance[1].total_ms, 32);
  assert.match(report.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(report).includes("/tmp/"), false);
});

test("rejects non-deterministic cache output", () => {
  assert.throws(
    () => buildQualificationReport({
      generator: {
        schema: "dwg-generated-large-line-dxf/1",
        license: "MPL-2.0",
        format: "ASCII DXF R2000",
        entityType: "LINE",
        entityCount: 1,
        bytes: 1,
        sha256: "a".repeat(64),
      },
      dwgBytes: 100,
      dwgSha256: "b".repeat(64),
      minimumDwgBytes: 1,
      adapterReports: [adapterReport(1), adapterReport(1)],
      cacheBytes: [10, 11],
      cacheSha256: ["c".repeat(64), "d".repeat(64)],
    }),
    /Expected values to be strictly equal/u,
  );
});
