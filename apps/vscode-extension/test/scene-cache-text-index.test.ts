import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findSceneCacheTextMatches,
  plainDwgText,
  readSceneCacheTextIndex,
  validateSceneCacheTextQuery,
} from "../src/scene-cache-text-index";

const HEADER_SIZE = 64;
const DIRECTORY_ENTRY_SIZE = 40;
const TEXT_RECORD_SIZE = 336;

interface TextFixtureRow {
  handle: bigint;
  kind: number;
  value: string;
  tag?: string;
  prompt?: string;
  point: readonly [number, number, number];
  sourceFlags?: number;
}

function fixtureCache(
  rows: readonly TextFixtureRow[],
  versionMinor = 24,
): Buffer {
  const encoder = new TextEncoder();
  const encodedRows = rows.map((row) =>
    [row.value, row.tag ?? "", row.prompt ?? ""].map((value) =>
      encoder.encode(value),
    ),
  );
  const stringsLength = encodedRows
    .flat()
    .reduce((total, value) => total + value.byteLength, 0);
  const stringOffset = 16 + rows.length * TEXT_RECORD_SIZE;
  const section = Buffer.alloc(stringOffset + stringsLength);
  section.writeUInt32LE(rows.length, 0);
  section.writeUInt32LE(TEXT_RECORD_SIZE, 4);
  section.writeBigUInt64LE(BigInt(stringOffset), 8);
  let stringCursor = 0;
  rows.forEach((row, index) => {
    const offset = 16 + index * TEXT_RECORD_SIZE;
    section.writeBigUInt64LE(row.handle, offset);
    section.writeBigUInt64LE(100n, offset + 8);
    section.writeUInt32LE(0, offset + 16);
    section.writeUInt16LE(row.kind, offset + 32);
    section.writeUInt32LE(0, offset + 36);
    encodedRows[index].forEach((value, referenceIndex) => {
      section.writeUInt32LE(
        stringCursor,
        offset + 40 + referenceIndex * 8,
      );
      section.writeUInt32LE(
        value.byteLength,
        offset + 44 + referenceIndex * 8,
      );
      section.set(value, stringOffset + stringCursor);
      stringCursor += value.byteLength;
    });
    row.point.forEach((value, axis) => {
      section.writeDoubleLE(value, offset + 72 + axis * 8);
    });
    section.writeDoubleLE(2.5, offset + 168);
    section.writeInt32LE(row.sourceFlags ?? 0, offset + 268);
  });

  const sectionOffset = HEADER_SIZE + DIRECTORY_ENTRY_SIZE;
  const fileSize = sectionOffset + section.byteLength;
  const cache = Buffer.alloc(fileSize);
  cache.set([68, 87, 71, 83, 67, 78, 49, 0], 0);
  cache.writeUInt16LE(1, 8);
  cache.writeUInt16LE(versionMinor, 10);
  cache.writeUInt32LE(HEADER_SIZE, 12);
  cache.writeUInt32LE(1, 16);
  cache.writeUInt32LE(DIRECTORY_ENTRY_SIZE, 20);
  cache.writeBigUInt64LE(BigInt(HEADER_SIZE), 32);
  cache.writeBigUInt64LE(BigInt(fileSize), 40);
  cache.writeUInt32LE(22, HEADER_SIZE);
  cache.writeUInt32LE(TEXT_RECORD_SIZE, HEADER_SIZE + 4);
  cache.writeBigUInt64LE(BigInt(sectionOffset), HEADER_SIZE + 8);
  cache.writeBigUInt64LE(
    BigInt(section.byteLength),
    HEADER_SIZE + 16,
  );
  cache.writeBigUInt64LE(BigInt(rows.length), HEADER_SIZE + 24);
  cache.writeUInt32LE(1, HEADER_SIZE + 32);
  section.copy(cache, sectionOffset);
  return cache;
}

test("normalizes common MTEXT controls into searchable display text", () => {
  assert.equal(
    plainDwgText("{\\H1.2x;배관}\\P점검 \\S1#2; %%d", true),
    "배관\n점검 1/2 °",
  );
});

test("reads TEXT, MTEXT, ATTDEF, and ATTRIB records from a bounded cache section", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dwg-text-index-"),
  );
  const cachePath = path.join(directory, "fixture.dwg.cache");
  try {
    await writeFile(
      cachePath,
      fixtureCache([
        {
          handle: 0x101n,
          kind: 0,
          value: "회의실",
          point: [10, 20, 0],
        },
        {
          handle: 0x102n,
          kind: 1,
          value: "{\\H1.2x;배관}\\P점검",
          point: [30, 40, 0],
        },
        {
          handle: 0x103n,
          kind: 2,
          value: "문 번호",
          tag: "DOOR_NO",
          prompt: "번호 입력",
          point: [50, 60, 0],
        },
        {
          handle: 0x104n,
          kind: 3,
          value: "A-101",
          point: [70, 80, 0],
          sourceFlags: 1,
        },
      ]),
    );

    const records = await readSceneCacheTextIndex(cachePath);

    assert.deepEqual(
      records.map((record) => ({
        handle: record.handle,
        kind: record.kind,
        value: record.value,
        hidden: record.hidden,
      })),
      [
        {
          handle: "101",
          kind: "TEXT",
          value: "회의실",
          hidden: false,
        },
        {
          handle: "102",
          kind: "MTEXT",
          value: "배관\n점검",
          hidden: false,
        },
        {
          handle: "103",
          kind: "ATTDEF",
          value: "문 번호",
          hidden: false,
        },
        {
          handle: "104",
          kind: "ATTRIB",
          value: "A-101",
          hidden: true,
        },
      ],
    );
    assert.deepEqual(records[2].insertionPoint, [50, 60, 0]);
    assert.match(records[2].searchText, /DOOR_NO/u);
    assert.match(records[2].searchText, /번호 입력/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("finds normalized text with case and whole-word options", () => {
  const records = [
    {
      handle: "1",
      kind: "TEXT" as const,
      value: "Room A ROOM-2",
      tag: "",
      prompt: "",
      searchText: "Room A ROOM-2",
      layerIndex: 0,
      insertionPoint: [0, 0, 0] as const,
      height: 1,
      hidden: false,
    },
  ];

  assert.equal(findSceneCacheTextMatches(records, "room").length, 1);
  assert.equal(
    findSceneCacheTextMatches(records, "room", {
      matchCase: true,
    }).length,
    0,
  );
  assert.equal(
    findSceneCacheTextMatches(records, "Room A", {
      wholeWord: true,
    }).length,
    1,
  );
  assert.equal(
    findSceneCacheTextMatches(records, "Room", {
      wholeWord: true,
    }).length,
    1,
  );
});

test("finds cache text with bounded regular expressions", () => {
  const records = [
    {
      handle: "1",
      kind: "TEXT" as const,
      value: "Room A-101",
      tag: "",
      prompt: "",
      searchText: "Room A-101",
      layerIndex: 0,
      insertionPoint: [0, 0, 0] as const,
      height: 1,
      hidden: false,
    },
    {
      handle: "2",
      kind: "TEXT" as const,
      value: "ROOM B-02",
      tag: "",
      prompt: "",
      searchText: "ROOM B-02",
      layerIndex: 0,
      insertionPoint: [1, 1, 0] as const,
      height: 1,
      hidden: false,
    },
    {
      handle: "3",
      kind: "TEXT" as const,
      value: "bedroom A-102",
      tag: "",
      prompt: "",
      searchText: "bedroom A-102",
      layerIndex: 0,
      insertionPoint: [2, 2, 0] as const,
      height: 1,
      hidden: false,
    },
    {
      handle: "4",
      kind: "ATTDEF" as const,
      value: "문 번호",
      tag: "DOOR_NO",
      prompt: "번호 입력",
      searchText: "문 번호\nDOOR_NO\n번호 입력",
      layerIndex: 0,
      insertionPoint: [3, 3, 0] as const,
      height: 1,
      hidden: false,
    },
  ];

  assert.deepEqual(
    findSceneCacheTextMatches(records, String.raw`room\s+[A-Z]-\d{2,3}`, {
      useRegularExpression: true,
      wholeWord: true,
    }).map(({ handle }) => handle),
    ["1", "2"],
  );
  assert.deepEqual(
    findSceneCacheTextMatches(records, String.raw`ROOM\s+B`, {
      useRegularExpression: true,
      matchCase: true,
    }).map(({ handle }) => handle),
    ["2"],
  );
  assert.deepEqual(
    findSceneCacheTextMatches(records, String.raw`DOOR_(?:NO|ID)`, {
      useRegularExpression: true,
      maximumResults: 1,
    }).map(({ handle }) => handle),
    ["4"],
  );
});

test("validates regular expression syntax and rejects risky patterns", () => {
  const options = { useRegularExpression: true };

  assert.equal(
    validateSceneCacheTextQuery(
      String.raw`^(?:ROOM|회의실)-[A-Z]\d{2,3}$`,
      options,
    ),
    undefined,
  );
  assert.match(
    validateSceneCacheTextQuery("[abc", options) ?? "",
    /문법/u,
  );
  assert.match(
    validateSceneCacheTextQuery(String.raw`(?:a+)+`, options) ?? "",
    /중첩/u,
  );
  assert.match(
    validateSceneCacheTextQuery(String.raw`(?:a|aa)+`, options) ?? "",
    /선택식/u,
  );
  assert.match(
    validateSceneCacheTextQuery(String.raw`a+a+$`, options) ?? "",
    /고정 문자/u,
  );
  assert.match(
    validateSceneCacheTextQuery(String.raw`(a)\1`, options) ?? "",
    /역참조/u,
  );
  assert.match(
    validateSceneCacheTextQuery("a{10001}", options) ?? "",
    /반복 횟수/u,
  );
  assert.match(
    validateSceneCacheTextQuery("a*", options) ?? "",
    /빈 문자열/u,
  );
  assert.equal(
    validateSceneCacheTextQuery(String.raw`\s+\d+`, options),
    undefined,
  );
  assert.equal(
    validateSceneCacheTextQuery(String.raw`ROOM(?:-A|-B)?`, options),
    undefined,
  );
  assert.equal(
    findSceneCacheTextMatches(
      [
        {
          handle: "1",
          kind: "TEXT",
          value: "aaaaaaaaaaaaaaaa",
          tag: "",
          prompt: "",
          searchText: "aaaaaaaaaaaaaaaa",
          layerIndex: 0,
          insertionPoint: [0, 0, 0],
          height: 1,
          hidden: false,
        },
      ],
      String.raw`(?:a+)+`,
      options,
    ).length,
    0,
  );
});

test("accepts the cache window and rejects an unsupported revision or header flag", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "dwg-text-index-version-"),
  );
  try {
    const previousRevisionPath = path.join(directory, "previous.cache");
    await writeFile(previousRevisionPath, fixtureCache([], 21));
    assert.deepEqual(
      await readSceneCacheTextIndex(previousRevisionPath),
      [],
    );

    const futureRevisionPath = path.join(directory, "future.cache");
    await writeFile(futureRevisionPath, fixtureCache([], 25));
    await assert.rejects(
      readSceneCacheTextIndex(futureRevisionPath),
      /version is unsupported/u,
    );

    const cache = fixtureCache([]);
    const oldRevisionPath = path.join(directory, "old.cache");
    cache.writeUInt16LE(17, 10);
    await writeFile(oldRevisionPath, cache);
    await assert.rejects(
      readSceneCacheTextIndex(oldRevisionPath),
      /version is unsupported/u,
    );

    const flaggedPath = path.join(directory, "flagged.cache");
    cache.writeUInt16LE(24, 10);
    cache.writeUInt32LE(2, 24);
    await writeFile(flaggedPath, cache);
    await assert.rejects(
      readSceneCacheTextIndex(flaggedPath),
      /header flags are unsupported/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
