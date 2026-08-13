// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArguments,
  summarizeIntegers,
} from "./benchmark-macos-native.mjs";

const required = [
  "--adapter",
  "/private/tmp/libredwg-adapter",
  "--fixture",
  "/Volumes/corpus/fixture.dwg",
  "--work-root",
  "/private/tmp/new-work",
  "--report",
  "/private/tmp/new-work/report.json",
  "--source-location",
  "mounted-network",
];

test("parses bounded Intel macOS performance options", () => {
  assert.deepEqual(parseArguments(required), {
    adapterPath: "/private/tmp/libredwg-adapter",
    fixturePath: "/Volumes/corpus/fixture.dwg",
    workRoot: "/private/tmp/new-work",
    reportPath: "/private/tmp/new-work/report.json",
    sourceLocation: "mounted-network",
    mode: "full",
    runs: 3,
    warmups: 1,
    workers: undefined,
    maxMedianWallMs: undefined,
    maxMedianPreviewMs: undefined,
    maxPeakRssBytes: undefined,
  });
  assert.deepEqual(
    parseArguments([
      ...required,
      "--mode",
      "progressive",
      "--runs",
      "5",
      "--warmups",
      "0",
      "--workers",
      "6",
      "--max-median-wall-ms",
      "9000",
      "--max-median-preview-ms",
      "5500",
      "--max-peak-rss-bytes",
      "1300000000",
    ]),
    {
      adapterPath: "/private/tmp/libredwg-adapter",
      fixturePath: "/Volumes/corpus/fixture.dwg",
      workRoot: "/private/tmp/new-work",
      reportPath: "/private/tmp/new-work/report.json",
      sourceLocation: "mounted-network",
      mode: "progressive",
      runs: 5,
      warmups: 0,
      workers: 6,
      maxMedianWallMs: 9000,
      maxMedianPreviewMs: 5500,
      maxPeakRssBytes: 1300000000,
    },
  );
});

test("rejects unbounded or mismatched macOS performance options", () => {
  assert.equal(
    parseArguments([...required, "--runs", "0"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--workers", "9"]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--source-location", "private-path"]),
    undefined,
  );
  assert.equal(
    parseArguments([
      ...required,
      "--max-median-preview-ms",
      "5500",
    ]),
    undefined,
  );
  assert.equal(
    parseArguments([...required, "--max-median-wall-ms", "9s"]),
    undefined,
  );
});

test("summarizes macOS measurements with the upper middle value", () => {
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
  assert.throws(
    () => summarizeIntegers([]),
    /non-negative safe integers/u,
  );
  assert.throws(
    () => summarizeIntegers([1, -1]),
    /non-negative safe integers/u,
  );
});
