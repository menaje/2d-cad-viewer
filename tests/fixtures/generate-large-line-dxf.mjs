#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REPORT_SCHEMA = "dwg-generated-large-line-dxf/1";
const DEFAULT_ENTITY_COUNT = 250_000;
const DEFAULT_COLUMNS = 1_000;
const MAX_ENTITY_COUNT = 1_000_000;
const MAX_COLUMNS = 10_000;
const BATCH_ENTITIES = 2_048;

function boundedInteger(value, minimum, maximum) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
    ? parsed
    : undefined;
}

export function parseArguments(values) {
  if (values.length % 2 !== 0) {
    return undefined;
  }
  const raw = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value || raw.has(flag)) {
      return undefined;
    }
    raw.set(flag, value);
  }
  if (
    !raw.has("--output") ||
    [...raw.keys()].some(
      (flag) => !["--output", "--entities", "--columns"].includes(flag),
    )
  ) {
    return undefined;
  }
  const entityCount = boundedInteger(
    raw.get("--entities") ?? String(DEFAULT_ENTITY_COUNT),
    1,
    MAX_ENTITY_COUNT,
  );
  const columns = boundedInteger(
    raw.get("--columns") ?? String(DEFAULT_COLUMNS),
    1,
    MAX_COLUMNS,
  );
  if (entityCount === undefined || columns === undefined) {
    return undefined;
  }
  return {
    outputPath: raw.get("--output"),
    entityCount,
    columns,
  };
}

function pair(code, value) {
  return `${code}\n${value}\n`;
}

function linetype(handle, name, description = "") {
  return [
    pair(0, "LTYPE"),
    pair(5, handle),
    pair(330, 5),
    pair(100, "AcDbSymbolTableRecord"),
    pair(100, "AcDbLinetypeTableRecord"),
    pair(2, name),
    pair(70, 0),
    pair(3, description),
    pair(72, 65),
    pair(73, 0),
    pair(40, 0),
  ].join("");
}

function blockRecord(handle, name) {
  return [
    pair(0, "BLOCK_RECORD"),
    pair(5, handle),
    pair(330, 1),
    pair(100, "AcDbSymbolTableRecord"),
    pair(100, "AcDbBlockTableRecord"),
    pair(2, name),
  ].join("");
}

function block(handle, endHandle, owner, name, paperSpace = false) {
  const paper = paperSpace ? pair(67, 1) : "";
  return [
    pair(0, "BLOCK"),
    pair(5, handle),
    pair(330, owner),
    pair(100, "AcDbEntity"),
    paper,
    pair(8, 0),
    pair(100, "AcDbBlockBegin"),
    pair(2, name),
    pair(70, 0),
    pair(10, 0),
    pair(20, 0),
    pair(30, 0),
    pair(3, name),
    pair(1, ""),
    pair(0, "ENDBLK"),
    pair(5, endHandle),
    pair(330, owner),
    pair(100, "AcDbEntity"),
    paper,
    pair(8, 0),
    pair(100, "AcDbBlockEnd"),
  ].join("");
}

function prefix(entityCount, columns) {
  const rows = Math.ceil(entityCount / columns);
  const handseed = (0x100 + entityCount + 1)
    .toString(16)
    .toUpperCase();
  return [
    pair(0, "SECTION"),
    pair(2, "HEADER"),
    pair(9, "$ACADVER"),
    pair(1, "AC1015"),
    pair(9, "$DWGCODEPAGE"),
    pair(3, "ANSI_1252"),
    pair(9, "$HANDSEED"),
    pair(5, handseed),
    pair(9, "$EXTMIN"),
    pair(10, 0),
    pair(20, 0),
    pair(30, 0),
    pair(9, "$EXTMAX"),
    pair(10, columns * 2),
    pair(20, rows * 2),
    pair(30, 0),
    pair(0, "ENDSEC"),
    pair(0, "SECTION"),
    pair(2, "TABLES"),
    pair(0, "TABLE"),
    pair(2, "LTYPE"),
    pair(5, 5),
    pair(330, 0),
    pair(100, "AcDbSymbolTable"),
    pair(70, 3),
    linetype("14", "ByBlock"),
    linetype("15", "ByLayer"),
    linetype("16", "Continuous", "Solid line"),
    pair(0, "ENDTAB"),
    pair(0, "TABLE"),
    pair(2, "LAYER"),
    pair(5, 2),
    pair(330, 0),
    pair(100, "AcDbSymbolTable"),
    pair(70, 1),
    pair(0, "LAYER"),
    pair(5, 10),
    pair(330, 2),
    pair(100, "AcDbSymbolTableRecord"),
    pair(100, "AcDbLayerTableRecord"),
    pair(2, 0),
    pair(70, 0),
    pair(62, 7),
    pair(6, "Continuous"),
    pair(370, -3),
    pair(0, "ENDTAB"),
    pair(0, "TABLE"),
    pair(2, "BLOCK_RECORD"),
    pair(5, 1),
    pair(330, 0),
    pair(100, "AcDbSymbolTable"),
    pair(70, 2),
    blockRecord("1F", "*Model_Space"),
    blockRecord("55", "*Paper_Space"),
    pair(0, "ENDTAB"),
    pair(0, "ENDSEC"),
    pair(0, "SECTION"),
    pair(2, "BLOCKS"),
    block("20", "21", "1F", "*Model_Space"),
    block("57", "58", "55", "*Paper_Space", true),
    pair(0, "ENDSEC"),
    pair(0, "SECTION"),
    pair(2, "ENTITIES"),
  ].join("");
}

function lineEntity(index, columns) {
  const x = (index % columns) * 2;
  const y = Math.floor(index / columns) * 2;
  const handle = (0x100 + index).toString(16).toUpperCase();
  return [
    pair(0, "LINE"),
    pair(5, handle),
    pair(330, "1F"),
    pair(100, "AcDbEntity"),
    pair(8, "0"),
    pair(100, "AcDbLine"),
    pair(10, x),
    pair(20, y),
    pair(30, 0),
    pair(11, x + 1),
    pair(21, y + 1),
    pair(31, 0),
  ].join("");
}

async function writeFully(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("DXF output made no write progress");
    }
    offset += result.bytesWritten;
  }
}

export async function generateLargeLineDxf({
  outputPath,
  entityCount = DEFAULT_ENTITY_COUNT,
  columns = DEFAULT_COLUMNS,
}) {
  if (
    !path.isAbsolute(outputPath) ||
    path.extname(outputPath).toLowerCase() !== ".dxf"
  ) {
    throw new Error("output must be a new absolute .dxf path");
  }
  if (
    !Number.isSafeInteger(entityCount) ||
    entityCount < 1 ||
    entityCount > MAX_ENTITY_COUNT ||
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    columns > MAX_COLUMNS
  ) {
    throw new Error("entity count or column count is outside the bounded range");
  }
  const parent = await stat(path.dirname(outputPath));
  if (!parent.isDirectory()) {
    throw new Error("output parent must be a directory");
  }

  const digest = createHash("sha256");
  const handle = await open(outputPath, "wx", 0o600);
  let complete = false;
  let bytesWritten = 0;
  const append = async (value) => {
    const bytes = Buffer.from(value, "ascii");
    await writeFully(handle, bytes);
    digest.update(bytes);
    bytesWritten += bytes.length;
  };
  try {
    await append(prefix(entityCount, columns));
    for (let start = 0; start < entityCount; start += BATCH_ENTITIES) {
      const entities = [];
      const end = Math.min(start + BATCH_ENTITIES, entityCount);
      for (let index = start; index < end; index += 1) {
        entities.push(lineEntity(index, columns));
      }
      await append(entities.join(""));
    }
    await append(`${pair(0, "ENDSEC")}${pair(0, "EOF")}`);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) {
      await unlink(outputPath).catch(() => {});
    }
  }

  return Object.freeze({
    schema: REPORT_SCHEMA,
    license: "MPL-2.0",
    format: "ASCII DXF R2000",
    entityType: "LINE",
    entityCount,
    columns,
    bytes: bytesWritten,
    sha256: digest.digest("hex"),
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(
      "usage: generate-large-line-dxf.mjs --output NEW_ABSOLUTE_DXF " +
        "[--entities 1..1000000] [--columns 1..10000]",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const report = await generateLargeLineDxf(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
