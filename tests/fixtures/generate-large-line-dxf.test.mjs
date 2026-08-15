// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  generateLargeLineDxf,
  parseArguments,
  REPORT_SCHEMA,
} from "./generate-large-line-dxf.mjs";

test("parses bounded deterministic fixture options", () => {
  assert.deepEqual(
    parseArguments([
      "--output",
      "/tmp/large.dxf",
      "--entities",
      "250000",
      "--columns",
      "500",
    ]),
    {
      outputPath: "/tmp/large.dxf",
      entityCount: 250_000,
      columns: 500,
    },
  );
  assert.equal(
    parseArguments(["--output", "/tmp/large.dxf", "--entities", "0"]),
    undefined,
  );
  assert.equal(
    parseArguments(["--output", "/tmp/large.dxf", "--entities", "1000001"]),
    undefined,
  );
  assert.equal(
    parseArguments(["--output", "/tmp/large.dxf", "--unknown", "1"]),
    undefined,
  );
});

test("generates a path-free byte-deterministic R2000 LINE fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-large-dxf-"));
  try {
    const firstPath = path.join(root, "first.dxf");
    const secondPath = path.join(root, "second.dxf");
    const first = await generateLargeLineDxf({
      outputPath: firstPath,
      entityCount: 5,
      columns: 3,
    });
    const second = await generateLargeLineDxf({
      outputPath: secondPath,
      entityCount: 5,
      columns: 3,
    });
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(firstPath),
      readFile(secondPath),
    ]);

    assert.deepEqual(first, second);
    assert.deepEqual(firstBytes, secondBytes);
    assert.equal(first.schema, REPORT_SCHEMA);
    assert.equal(first.license, "MPL-2.0");
    assert.equal(first.entityCount, 5);
    assert.equal(first.bytes, firstBytes.length);
    assert.equal(JSON.stringify(first).includes(root), false);
    assert.equal(
      (firstBytes.toString("ascii").match(/\nLINE\n/gu) ?? []).length,
      5,
    );
    assert.match(firstBytes.toString("ascii"), /\nAC1015\n/u);
    assert.match(firstBytes.toString("ascii"), /\nEOF\n$/u);
    await assert.rejects(
      generateLargeLineDxf({
        outputPath: firstPath,
        entityCount: 1,
      }),
      /already exists/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
