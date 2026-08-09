import { open } from "node:fs/promises";

const CACHE_MAGIC = Buffer.from([68, 87, 71, 83, 67, 78, 49, 0]);
const CACHE_VERSION_MAJOR = 1;
const CACHE_VERSION_MINOR = 19;
const CACHE_HEADER_SIZE = 64;
const CACHE_HEADER_FLAG_PREVIEW = 1;
const DIRECTORY_ENTRY_SIZE = 40;
const TEXT_ENTITY_SECTION_KIND = 22;
const TEXT_ENTITY_RECORD_SIZE = 336;
const STRING_TABLE_HEADER_SIZE = 16;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_TEXT_SECTION_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_ENTITIES = 262_144;
const MAX_TEXT_VALUE_BYTES = 1024 * 1024;
const MAX_TEXT_SEARCH_QUERY_LENGTH = 512;
const MAX_REGULAR_EXPRESSION_QUANTIFIERS = 32;
const MAX_REGULAR_EXPRESSION_REPETITION = 10_000n;
const WORD_CHARACTER_CLASS = String.raw`\p{L}\p{N}_`;

export type DwgTextKind = "TEXT" | "MTEXT" | "ATTDEF" | "ATTRIB";

export interface SceneCacheTextRecord {
  handle: string;
  kind: DwgTextKind;
  value: string;
  tag: string;
  prompt: string;
  searchText: string;
  layerIndex: number;
  insertionPoint: readonly [number, number, number];
  height: number;
  hidden: boolean;
}

export interface SceneCacheTextMatch extends SceneCacheTextRecord {
  snippet: string;
}

export interface TextSearchOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  useRegularExpression?: boolean;
  maximumResults?: number;
}

export interface TextSearchValidationOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  useRegularExpression?: boolean;
}

interface SectionEntry {
  offset: number;
  byteLength: number;
  recordCount: number;
  recordSize: number;
  flags: number;
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the safe integer range`);
  }
  return Number(value);
}

async function readExact(
  file: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let cursor = 0;
  while (cursor < length) {
    const { bytesRead } = await file.read(
      buffer,
      cursor,
      length - cursor,
      position + cursor,
    );
    if (bytesRead === 0) {
      throw new Error("scene cache ended before the requested range");
    }
    cursor += bytesRead;
  }
  return buffer;
}

function parseTextSectionEntry(
  directory: Buffer,
  entryCount: number,
  fileSize: number,
): SectionEntry | undefined {
  for (let index = 0; index < entryCount; index += 1) {
    const offset = index * DIRECTORY_ENTRY_SIZE;
    if (directory.readUInt32LE(offset) !== TEXT_ENTITY_SECTION_KIND) {
      continue;
    }
    const recordSize = directory.readUInt32LE(offset + 4);
    const sectionOffset = safeNumber(
      directory.readBigUInt64LE(offset + 8),
      "text section offset",
    );
    const byteLength = safeNumber(
      directory.readBigUInt64LE(offset + 16),
      "text section length",
    );
    const recordCount = safeNumber(
      directory.readBigUInt64LE(offset + 24),
      "text record count",
    );
    const flags = directory.readUInt32LE(offset + 32);
    if (
      recordSize !== TEXT_ENTITY_RECORD_SIZE ||
      (flags & 1) === 0 ||
      byteLength > MAX_TEXT_SECTION_BYTES ||
      recordCount > MAX_TEXT_ENTITIES ||
      sectionOffset < CACHE_HEADER_SIZE ||
      sectionOffset > fileSize ||
      byteLength > fileSize - sectionOffset
    ) {
      throw new Error("scene cache text section is invalid");
    }
    return {
      offset: sectionOffset,
      byteLength,
      recordCount,
      recordSize,
      flags,
    };
  }
  return undefined;
}

function decodeReference(
  section: Buffer,
  recordOffset: number,
  referenceOffset: number,
  stringOffset: number,
  decoder: TextDecoder,
): string {
  const relativeOffset = section.readUInt32LE(
    recordOffset + referenceOffset,
  );
  const byteLength = section.readUInt32LE(
    recordOffset + referenceOffset + 4,
  );
  if (byteLength > MAX_TEXT_VALUE_BYTES) {
    throw new Error("scene cache text value is too large");
  }
  const start = stringOffset + relativeOffset;
  const end = start + byteLength;
  if (start < stringOffset || end < start || end > section.byteLength) {
    throw new Error("scene cache text value points outside its string table");
  }
  return decoder.decode(section.subarray(start, end));
}

function replacePercentCodes(value: string): string {
  return value
    .replace(/%%d/giu, "°")
    .replace(/%%p/giu, "±")
    .replace(/%%c/giu, "⌀");
}

export function plainDwgText(value: string, isMText = false): string {
  const source = replacePercentCodes(value.slice(0, 65_536));
  if (!isMText) {
    return source.normalize("NFC");
  }
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{" || character === "}") {
      continue;
    }
    if (character !== "\\") {
      result += character;
      continue;
    }
    const command = source[index + 1];
    if (command === undefined) {
      break;
    }
    if (command === "\\" || command === "{" || command === "}") {
      result += command;
      index += 1;
      continue;
    }
    if (command === "P" || command === "X") {
      result += "\n";
      index += 1;
      continue;
    }
    if (command === "~") {
      result += " ";
      index += 1;
      continue;
    }
    if (
      command === "U" &&
      source[index + 2] === "+" &&
      /^[0-9a-f]{4}$/iu.test(source.slice(index + 3, index + 7))
    ) {
      result += String.fromCodePoint(
        Number.parseInt(source.slice(index + 3, index + 7), 16),
      );
      index += 6;
      continue;
    }
    if (command === "S") {
      const end = source.indexOf(";", index + 2);
      if (end === -1) {
        break;
      }
      result += source
        .slice(index + 2, end)
        .replaceAll("#", "/")
        .replaceAll("^", "/");
      index = end;
      continue;
    }
    if ("AaCcFfHhQqTtWwPp".includes(command)) {
      const end = source.indexOf(";", index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if ("LlOoKk".includes(command)) {
      index += 1;
      continue;
    }
    result += command;
    index += 1;
  }
  return result.normalize("NFC");
}

function textKind(value: number): DwgTextKind {
  const kinds: readonly DwgTextKind[] = [
    "TEXT",
    "MTEXT",
    "ATTDEF",
    "ATTRIB",
  ];
  const kind = kinds[value];
  if (!kind) {
    throw new Error(`scene cache contains unsupported text kind ${value}`);
  }
  return kind;
}

export async function readSceneCacheTextIndex(
  cachePath: string,
): Promise<readonly SceneCacheTextRecord[]> {
  const file = await open(cachePath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < CACHE_HEADER_SIZE) {
      throw new Error("scene cache file is too short");
    }
    const header = await readExact(file, CACHE_HEADER_SIZE, 0);
    if (!header.subarray(0, CACHE_MAGIC.length).equals(CACHE_MAGIC)) {
      throw new Error("scene cache magic is invalid");
    }
    if (
      header.readUInt16LE(8) !== CACHE_VERSION_MAJOR ||
      header.readUInt16LE(10) !== CACHE_VERSION_MINOR ||
      header.readUInt32LE(12) !== CACHE_HEADER_SIZE
    ) {
      throw new Error("scene cache version is unsupported");
    }
    if (
      (header.readUInt32LE(24) & ~CACHE_HEADER_FLAG_PREVIEW) !== 0
    ) {
      throw new Error("scene cache header flags are unsupported");
    }
    const entryCount = header.readUInt32LE(16);
    const entrySize = header.readUInt32LE(20);
    const directoryOffset = safeNumber(
      header.readBigUInt64LE(32),
      "scene cache directory offset",
    );
    const declaredFileSize = safeNumber(
      header.readBigUInt64LE(40),
      "scene cache file size",
    );
    if (
      entryCount > MAX_DIRECTORY_ENTRIES ||
      entrySize !== DIRECTORY_ENTRY_SIZE ||
      declaredFileSize !== metadata.size ||
      directoryOffset < CACHE_HEADER_SIZE ||
      directoryOffset +
        entryCount * DIRECTORY_ENTRY_SIZE >
        declaredFileSize
    ) {
      throw new Error("scene cache directory is invalid");
    }
    const directory = await readExact(
      file,
      entryCount * DIRECTORY_ENTRY_SIZE,
      directoryOffset,
    );
    const entry = parseTextSectionEntry(
      directory,
      entryCount,
      declaredFileSize,
    );
    if (!entry || entry.recordCount === 0) {
      return Object.freeze([]);
    }
    const minimumBytes =
      STRING_TABLE_HEADER_SIZE + entry.recordCount * entry.recordSize;
    if (entry.byteLength < minimumBytes) {
      throw new Error("scene cache text section is truncated");
    }
    const section = await readExact(file, entry.byteLength, entry.offset);
    const recordCount = section.readUInt32LE(0);
    const recordSize = section.readUInt32LE(4);
    const stringOffset = safeNumber(
      section.readBigUInt64LE(8),
      "scene cache text string offset",
    );
    if (
      recordCount !== entry.recordCount ||
      recordSize !== entry.recordSize ||
      stringOffset < minimumBytes ||
      stringOffset > section.byteLength
    ) {
      throw new Error("scene cache text string table is invalid");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const records: SceneCacheTextRecord[] = [];
    for (let index = 0; index < recordCount; index += 1) {
      const offset = STRING_TABLE_HEADER_SIZE + index * recordSize;
      const kind = textKind(section.readUInt16LE(offset + 32));
      const value = decodeReference(
        section,
        offset,
        40,
        stringOffset,
        decoder,
      );
      const tag = decodeReference(
        section,
        offset,
        48,
        stringOffset,
        decoder,
      );
      const prompt = decodeReference(
        section,
        offset,
        56,
        stringOffset,
        decoder,
      );
      const displayValue = plainDwgText(value, kind === "MTEXT");
      const searchText = [displayValue, tag, prompt]
        .filter(Boolean)
        .join("\n")
        .normalize("NFC");
      const insertionPoint = [
        section.readDoubleLE(offset + 72),
        section.readDoubleLE(offset + 80),
        section.readDoubleLE(offset + 88),
      ] as const;
      if (!insertionPoint.every(Number.isFinite)) {
        continue;
      }
      const commonFlags = section.readUInt16LE(offset + 26);
      const sourceFlags = section.readInt32LE(offset + 268);
      records.push(
        Object.freeze({
          handle: section
            .readBigUInt64LE(offset)
            .toString(16)
            .toUpperCase(),
          kind,
          value: displayValue,
          tag: tag.normalize("NFC"),
          prompt: prompt.normalize("NFC"),
          searchText,
          layerIndex: section.readUInt32LE(offset + 16),
          insertionPoint,
          height: section.readDoubleLE(offset + 168),
          hidden:
            (commonFlags & 1) !== 0 ||
            ((kind === "ATTDEF" || kind === "ATTRIB") &&
              (sourceFlags & 1) !== 0),
        }),
      );
    }
    return Object.freeze(records);
  } finally {
    await file.close();
  }
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

interface RegularExpressionAtomRisk {
  hasAlternation: boolean;
  hasQuantifier: boolean;
  signature: string;
  zeroWidth: boolean;
}

interface RegularExpressionGroupRisk {
  adjacentRepetition?: RegularExpressionAtomRisk;
  branchHasConsumingAtom: boolean;
  hasAlternation: boolean;
  hasConsumingAtom: boolean;
  hasEmptyAlternative: boolean;
  hasQuantifier: boolean;
  lastAtom?: RegularExpressionAtomRisk;
  previousWasQuantifier: boolean;
  startOffset: number;
  zeroWidth: boolean;
}

interface ParsedRegularExpressionQuantifier {
  endOffset: number;
  maximum?: bigint;
  minimum: bigint;
}

function parseRegularExpressionQuantifier(
  pattern: string,
  offset: number,
): ParsedRegularExpressionQuantifier | undefined {
  const character = pattern[offset];
  if (character === "*") {
    return { endOffset: offset, minimum: 0n };
  }
  if (character === "+") {
    return { endOffset: offset, minimum: 1n };
  }
  if (character === "?") {
    return { endOffset: offset, minimum: 0n, maximum: 1n };
  }
  if (character !== "{") {
    return undefined;
  }
  const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(offset));
  if (!match) {
    return undefined;
  }
  const minimum = BigInt(match[1]);
  const maximum =
    match[2] === undefined
      ? minimum
      : match[2] === ""
        ? undefined
        : BigInt(match[2]);
  return {
    endOffset: offset + match[0].length - 1,
    minimum,
    maximum,
  };
}

function beginRegularExpressionAtom(
  group: RegularExpressionGroupRisk,
  atom: RegularExpressionAtomRisk,
): void {
  if (
    group.lastAtom &&
    !group.lastAtom.hasQuantifier &&
    !group.lastAtom.zeroWidth
  ) {
    group.adjacentRepetition = undefined;
  }
  group.lastAtom = atom;
  group.hasAlternation ||= atom.hasAlternation;
  group.hasQuantifier ||= atom.hasQuantifier;
  group.previousWasQuantifier = false;
  if (!atom.zeroWidth) {
    group.hasConsumingAtom = true;
    group.branchHasConsumingAtom = true;
  }
}

function escapedAtomSignature(raw: string): string {
  return /^[\\][dDsSwW]$/u.test(raw)
    ? `escape:${raw[1]}`
    : raw.length === 2 && String.raw`\()[]{}.*+?|^$-`.includes(raw[1])
      ? `literal:${raw[1]}`
      : `escape:${raw}`;
}

function escapeClassMatchesLiteral(
  signature: string,
  literal: string,
): boolean | undefined {
  switch (signature) {
    case "escape:d":
      return /^\d$/u.test(literal);
    case "escape:D":
      return !/^\d$/u.test(literal);
    case "escape:s":
      return /^\s$/u.test(literal);
    case "escape:S":
      return !/^\s$/u.test(literal);
    case "escape:w":
      return /^[A-Z0-9_]$/iu.test(literal);
    case "escape:W":
      return !/^[A-Z0-9_]$/iu.test(literal);
    default:
      return undefined;
  }
}

function quantifiedAtomsMayOverlap(
  left: RegularExpressionAtomRisk,
  right: RegularExpressionAtomRisk,
): boolean {
  if (left.signature === right.signature) {
    return true;
  }
  if (left.signature === "any" || right.signature === "any") {
    return true;
  }
  if (
    left.signature.startsWith("literal:") &&
    right.signature.startsWith("literal:")
  ) {
    return false;
  }
  if (left.signature.startsWith("literal:")) {
    return (
      escapeClassMatchesLiteral(
        right.signature,
        left.signature.slice("literal:".length),
      ) ?? true
    );
  }
  if (right.signature.startsWith("literal:")) {
    return (
      escapeClassMatchesLiteral(
        left.signature,
        right.signature.slice("literal:".length),
      ) ?? true
    );
  }
  const pair = [left.signature, right.signature].sort().join("|");
  return !new Set([
    "escape:D|escape:d",
    "escape:S|escape:s",
    "escape:W|escape:d",
    "escape:W|escape:w",
    "escape:d|escape:s",
    "escape:s|escape:w",
  ]).has(pair);
}

function regularExpressionRisk(
  pattern: string,
  matchCase: boolean,
): string | undefined {
  const groups: RegularExpressionGroupRisk[] = [
    {
      branchHasConsumingAtom: false,
      hasAlternation: false,
      hasConsumingAtom: false,
      hasEmptyAlternative: false,
      hasQuantifier: false,
      previousWasQuantifier: false,
      startOffset: 0,
      zeroWidth: false,
    },
  ];
  let quantifierCount = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      if (
        (/^[1-9]$/u.test(pattern[index + 1] ?? "") ||
          (pattern[index + 1] === "k" && pattern[index + 2] === "<"))
      ) {
        return "역참조(\\1 또는 \\k<name>)는 사용할 수 없습니다.";
      }
      let endOffset = Math.min(index + 1, pattern.length - 1);
      if (
        ["p", "P", "u"].includes(pattern[index + 1] ?? "") &&
        pattern[index + 2] === "{"
      ) {
        const closingBrace = pattern.indexOf("}", index + 3);
        if (closingBrace >= 0) {
          endOffset = closingBrace;
        }
      }
      const raw = pattern.slice(index, endOffset + 1);
      beginRegularExpressionAtom(groups.at(-1)!, {
        hasAlternation: false,
        hasQuantifier: false,
        signature: escapedAtomSignature(raw),
        zeroWidth: raw === String.raw`\b` || raw === String.raw`\B`,
      });
      index = endOffset;
      continue;
    }
    if (character === "[") {
      let endOffset = index + 1;
      for (; endOffset < pattern.length; endOffset += 1) {
        if (pattern[endOffset] === "\\") {
          endOffset += 1;
          continue;
        }
        if (pattern[endOffset] === "]") {
          break;
        }
      }
      beginRegularExpressionAtom(groups.at(-1)!, {
        hasAlternation: false,
        hasQuantifier: false,
        signature: `class:${pattern.slice(index, endOffset + 1)}`,
        zeroWidth: false,
      });
      index = Math.min(endOffset, pattern.length - 1);
      continue;
    }
    if (character === "(") {
      const prefix = pattern.slice(index + 1, index + 4);
      const zeroWidth =
        prefix.startsWith("?=") ||
        prefix.startsWith("?!") ||
        prefix.startsWith("?<=") ||
        prefix.startsWith("?<!");
      groups.push({
        branchHasConsumingAtom: false,
        hasAlternation: false,
        hasConsumingAtom: false,
        hasEmptyAlternative: false,
        hasQuantifier: false,
        previousWasQuantifier: false,
        startOffset: index,
        zeroWidth,
      });
      if (
        pattern[index + 1] === "?" &&
        [":", "=", "!"].includes(pattern[index + 2] ?? "")
      ) {
        index += 2;
        continue;
      }
      if (
        pattern[index + 2] === "<" &&
        (pattern[index + 3] === "=" || pattern[index + 3] === "!")
      ) {
        index += 3;
        continue;
      }
      if (pattern[index + 2] === "<") {
        const nameEnd = pattern.indexOf(">", index + 3);
        if (nameEnd >= 0) {
          index = nameEnd;
        }
      }
      continue;
    }
    if (character === ")") {
      if (groups.length > 1) {
        const group = groups.pop();
        if (group) {
          group.hasEmptyAlternative ||= !group.branchHasConsumingAtom;
          beginRegularExpressionAtom(groups.at(-1)!, {
            hasAlternation: group.hasAlternation,
            hasQuantifier: group.hasQuantifier,
            signature: `group:${pattern.slice(
              group.startOffset,
              index + 1,
            )}`,
            zeroWidth:
              group.zeroWidth ||
              group.hasEmptyAlternative ||
              !group.hasConsumingAtom,
          });
        }
      }
      continue;
    }
    if (character === "|") {
      const group = groups.at(-1)!;
      group.hasAlternation = true;
      group.hasEmptyAlternative ||= !group.branchHasConsumingAtom;
      group.branchHasConsumingAtom = false;
      group.lastAtom = undefined;
      group.adjacentRepetition = undefined;
      group.previousWasQuantifier = false;
      continue;
    }

    const quantifier = parseRegularExpressionQuantifier(pattern, index);
    const group = groups.at(-1)!;
    if (quantifier && group.lastAtom) {
      if (character === "?" && group.previousWasQuantifier) {
        group.previousWasQuantifier = false;
        continue;
      }
      quantifierCount += 1;
      if (quantifierCount > MAX_REGULAR_EXPRESSION_QUANTIFIERS) {
        return `반복 지정자는 ${MAX_REGULAR_EXPRESSION_QUANTIFIERS}개까지 사용할 수 있습니다.`;
      }
      if (
        quantifier.minimum > MAX_REGULAR_EXPRESSION_REPETITION ||
        (quantifier.maximum !== undefined &&
          quantifier.maximum > MAX_REGULAR_EXPRESSION_REPETITION)
      ) {
        return `반복 횟수는 ${MAX_REGULAR_EXPRESSION_REPETITION.toLocaleString()}회 이하여야 합니다.`;
      }
      if (group.lastAtom.zeroWidth) {
        return "폭이 없는 조건은 반복할 수 없습니다.";
      }
      const isExactOne =
        quantifier.minimum === 1n && quantifier.maximum === 1n;
      const isRepetition =
        quantifier.maximum === undefined || quantifier.maximum > 1n;
      if (isRepetition && group.lastAtom.hasQuantifier) {
        return "반복식 안에 다른 반복식을 중첩할 수 없습니다.";
      }
      if (isRepetition && group.lastAtom.hasAlternation) {
        return "선택식(|) 전체를 반복할 수 없습니다.";
      }
      if (
        isRepetition &&
        group.adjacentRepetition &&
        quantifiedAtomsMayOverlap(
          group.adjacentRepetition,
          group.lastAtom,
        )
      ) {
        return "서로 겹칠 수 있는 반복식 사이에는 고정 문자를 넣거나 반복 횟수를 제한해야 합니다.";
      }
      if (isRepetition) {
        group.adjacentRepetition = group.lastAtom;
      } else if (quantifier.minimum > 0n) {
        group.adjacentRepetition = undefined;
      }
      group.hasQuantifier ||= !isExactOne;
      group.lastAtom = {
        ...group.lastAtom,
        hasQuantifier: !isExactOne,
      };
      group.previousWasQuantifier = true;
      index = quantifier.endOffset;
      continue;
    }

    const codePoint = pattern.codePointAt(index)!;
    const literal = String.fromCodePoint(codePoint);
    beginRegularExpressionAtom(group, {
      hasAlternation: false,
      hasQuantifier: false,
      signature:
        character === "."
          ? "any"
          : `literal:${
              matchCase ? literal : literal.toLocaleLowerCase("ko-KR")
            }`,
      zeroWidth: character === "^" || character === "$",
    });
    index += literal.length - 1;
  }
  return undefined;
}

function regularExpressionSource(query: string, wholeWord: boolean): string {
  return wholeWord
    ? `(?<![${WORD_CHARACTER_CLASS}])(?:${query})(?![${WORD_CHARACTER_CLASS}])`
    : query;
}

function compileTextSearchRegularExpression(
  query: string,
  matchCase: boolean,
  wholeWord: boolean,
): RegExp {
  return new RegExp(
    regularExpressionSource(query, wholeWord),
    matchCase ? "u" : "iu",
  );
}

export function validateSceneCacheTextQuery(
  query: string,
  {
    matchCase = false,
    wholeWord = false,
    useRegularExpression = false,
  }: TextSearchValidationOptions = {},
): string | undefined {
  const normalizedQuery = query.normalize("NFC");
  if (normalizedQuery.length > MAX_TEXT_SEARCH_QUERY_LENGTH) {
    return `검색어는 ${MAX_TEXT_SEARCH_QUERY_LENGTH}자 이하여야 합니다.`;
  }
  if (!useRegularExpression || normalizedQuery.length === 0) {
    return undefined;
  }
  const risk = regularExpressionRisk(normalizedQuery, matchCase);
  if (risk) {
    return `안전하지 않은 정규식입니다. ${risk}`;
  }
  let expression: RegExp;
  try {
    expression = compileTextSearchRegularExpression(
      normalizedQuery,
      matchCase,
      wholeWord,
    );
  } catch {
    return "정규식 문법이 올바르지 않습니다.";
  }
  expression.lastIndex = 0;
  if (expression.test("")) {
    return "빈 문자열과 일치하는 정규식은 사용할 수 없습니다.";
  }
  return undefined;
}

function makeSnippet(value: string, matchIndex: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  const start = Math.max(0, Math.min(matchIndex - 36, normalized.length - 120));
  return `${start > 0 ? "…" : ""}${normalized.slice(start, start + 120)}${
    start + 120 < normalized.length ? "…" : ""
  }`;
}

export function findSceneCacheTextMatches(
  records: readonly SceneCacheTextRecord[],
  query: string,
  {
    matchCase = false,
    wholeWord = false,
    useRegularExpression = false,
    maximumResults = 2_000,
  }: TextSearchOptions = {},
): readonly SceneCacheTextMatch[] {
  const normalizedQuery = query.normalize("NFC");
  if (
    normalizedQuery.length === 0 ||
    validateSceneCacheTextQuery(normalizedQuery, {
      matchCase,
      wholeWord,
      useRegularExpression,
    }) !== undefined ||
    !Number.isSafeInteger(maximumResults) ||
    maximumResults <= 0
  ) {
    return Object.freeze([]);
  }
  const expression = useRegularExpression
    ? compileTextSearchRegularExpression(
        normalizedQuery,
        matchCase,
        wholeWord,
      )
    : undefined;
  const needle = matchCase
    ? normalizedQuery
    : normalizedQuery.toLocaleLowerCase("ko-KR");
  const matches: SceneCacheTextMatch[] = [];
  for (const record of records) {
    if (expression) {
      expression.lastIndex = 0;
      const match = expression.exec(record.searchText);
      if (!match) {
        continue;
      }
      matches.push(
        Object.freeze({
          ...record,
          snippet: makeSnippet(record.searchText, match.index),
        }),
      );
      if (matches.length >= maximumResults) {
        break;
      }
      continue;
    }
    const haystack = matchCase
      ? record.searchText
      : record.searchText.toLocaleLowerCase("ko-KR");
    let matchIndex = haystack.indexOf(needle);
    while (matchIndex >= 0 && wholeWord) {
      const before = haystack[matchIndex - 1];
      const after = haystack[matchIndex + needle.length];
      if (!isWordCharacter(before) && !isWordCharacter(after)) {
        break;
      }
      matchIndex = haystack.indexOf(needle, matchIndex + needle.length);
    }
    if (matchIndex < 0) {
      continue;
    }
    matches.push(
      Object.freeze({
        ...record,
        snippet: makeSnippet(record.searchText, matchIndex),
      }),
    );
    if (matches.length >= maximumResults) {
      break;
    }
  }
  return Object.freeze(matches);
}
