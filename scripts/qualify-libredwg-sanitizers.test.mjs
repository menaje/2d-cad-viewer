// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMutations,
  buildQualificationReport,
  hasSanitizerDiagnostic,
  parseArguments,
  REPORT_SCHEMA,
} from "./qualify-libredwg-sanitizers.mjs";

const required = [
  "--adapter",
  "/tmp/sanitized-adapter",
  "--fixture",
  "/tmp/public-fixture.dwg",
  "--work-root",
  "/tmp/new-sanitizer-work",
  "--report",
  "/tmp/new-sanitizer-work/report.json",
];

test("parses bounded sanitizer qualification options", () => {
  assert.deepEqual(parseArguments(required), {
    adapterPath: "/tmp/sanitized-adapter",
    fixturePath: "/tmp/public-fixture.dwg",
    workRoot: "/tmp/new-sanitizer-work",
    reportPath: "/tmp/new-sanitizer-work/report.json",
    mutations: 24,
  });
  assert.equal(
    parseArguments([...required, "--mutations", "7"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--mutations", "65"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--unknown", "1"]),
    undefined,
  );
});

test("builds deterministic bounded malformed inputs", () => {
  const source = Buffer.alloc(512, 0x5a);
  source.write("AC1015", 0, "ascii");
  const first = buildMutations(source, 24);
  const second = buildMutations(source, 24);
  assert.equal(first.length, 24);
  assert.deepEqual(
    first.map((entry) => entry.bytes),
    second.map((entry) => entry.bytes),
  );
  assert.ok(first.every((entry) => entry.bytes.length <= source.length));
  assert.ok(first.some((entry) => entry.bytes.length < source.length));
  assert.ok(first.some((entry) => entry.bytes.length === source.length));
  assert.throws(
    () => buildMutations(Buffer.alloc(57), 24),
    /bounded DWG buffer/u,
  );
});

test("recognizes AddressSanitizer and UBSan diagnostics", () => {
  assert.equal(
    hasSanitizerDiagnostic("", "ERROR: AddressSanitizer: heap-use-after-free"),
    true,
  );
  assert.equal(
    hasSanitizerDiagnostic("", "decode.c:1: runtime error: shift exponent"),
    true,
  );
  assert.equal(
    hasSanitizerDiagnostic("{\"status\":\"ok\"}", ""),
    false,
  );
});

test("builds a path-free sanitizer report", () => {
  const report = buildQualificationReport({
    mutations: 24,
    acceptedMutations: 3,
    rejectedMutations: 21,
    targetPlatform: "darwin",
    targetArchitecture: "arm64",
  });
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.status, "pass");
  assert.equal(report.cases.cancellation, 1);
  assert.equal(report.cases.malformedAccepted, 3);
  assert.equal(report.cases.malformedRejected, 21);
  assert.equal(report.cases.sanitizerDiagnostics, 0);
  assert.equal(JSON.stringify(report).includes("/tmp/"), false);
  assert.throws(
    () => buildQualificationReport({
      mutations: 24,
      acceptedMutations: 2,
      rejectedMutations: 21,
    }),
    /Expected values to be strictly equal/u,
  );
});
