// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArguments,
  summarizeIntegers,
} from "./benchmark-windows-native.mjs";

const required = [
  "--adapter",
  "C:\\adapter.exe",
  "--fixture",
  "Y:\\fixture.dwg",
  "--work-root",
  "D:\\new-work",
  "--report",
  "D:\\new-work\\report.json",
  "--location-kind",
  "mapped-network-drive",
];

test("parses bounded Windows native performance options", () => {
  assert.deepEqual(parseArguments(required), {
    adapterPath: "C:\\adapter.exe",
    fixturePath: "Y:\\fixture.dwg",
    workRoot: "D:\\new-work",
    reportPath: "D:\\new-work\\report.json",
    locationKind: "mapped-network-drive",
    runs: 3,
    warmups: 1,
    workers: undefined,
    maxMedianWallMs: undefined,
    maxPeakPrivateBytes: undefined,
  });
  assert.equal(
    parseArguments([...required, "--runs", "0"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--workers", "9"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--location-kind", "private-path"]),
    undefined,
  );
  assert.deepEqual(
    parseArguments([
      ...required,
      "--max-median-wall-ms",
      "12000",
      "--max-peak-private-bytes",
      "1500000000",
    ]),
    {
      adapterPath: "C:\\adapter.exe",
      fixturePath: "Y:\\fixture.dwg",
      workRoot: "D:\\new-work",
      reportPath: "D:\\new-work\\report.json",
      locationKind: "mapped-network-drive",
      runs: 3,
      warmups: 1,
      workers: undefined,
      maxMedianWallMs: 12000,
      maxPeakPrivateBytes: 1500000000,
    },
  );
  assert.equal(
    parseArguments([...required, "--max-median-wall-ms", "1ms"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--runs", "3runs"]),
    undefined,
  );
});

test("summarizes integer measurements with the upper middle value", () => {
  assert.deepEqual(summarizeIntegers([9, 3, 7]), {
    minimum: 3,
    median: 7,
    maximum: 9,
  });
  assert.deepEqual(summarizeIntegers([9, 3, 7, 5]), {
    minimum: 3,
    median: 7,
    maximum: 9,
  });
  assert.throws(() => summarizeIntegers([]), /non-negative safe integers/u);
  assert.throws(
    () => summarizeIntegers([1, -1]),
    /non-negative safe integers/u,
  );
});
