#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const ASSET_SCHEMA = "dwg-public-korean-corpus-assets/1";
const PROVENANCE_SCHEMA = "dwg-public-korean-corpus-provenance/1";
const DATA_PORTAL_HOST = "www.data.go.kr";
const DOWNLOAD_PATH = "/cmm/cmm/fileDownload.do";
const MAX_SOURCES = 16;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const KOGL_TYPE_1_PATTERN =
  /공공저작물\s*:\s*출처표시\s*\(\s*제\s*1유형\s*\)/u;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const DWG_VERSIONS = new Set([
  "AC1015",
  "AC1018",
  "AC1021",
  "AC1024",
  "AC1027",
  "AC1032",
]);
const DISCIPLINES = new Set([
  "architecture",
  "civil",
  "mep",
  "other",
]);

let crcTable;

function boundedString(value, label, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function trustedUrl(value, label, expectedPath) {
  let url;
  try {
    url = new URL(boundedString(value, label, 2_048));
  } catch {
    throw new TypeError(`${label} is not a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== DATA_PORTAL_HOST ||
    (expectedPath && url.pathname !== expectedPath) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new TypeError(`${label} is outside the trusted data portal`);
  }
  return url.href;
}

function licenseTermsUrl(value, label) {
  let url;
  try {
    url = new URL(boundedString(value, label, 2_048));
  } catch {
    throw new TypeError(`${label} is not a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.copyright.or.kr" ||
    url.pathname !== "/gov/nuri/guide/index.do" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new TypeError(`${label} is not the pinned KOGL guide`);
  }
  return url.href;
}

function uniqueEnumList(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new TypeError(`${label} contains an unsupported value`);
    }
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return Object.freeze(result.sort());
}

function downloadParameters(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["atchFileId", "dataNm", "fileDetailSn"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`${label} has unexpected fields`);
  }
  const atchFileId = boundedString(
    value.atchFileId,
    `${label}.atchFileId`,
    80,
  );
  if (!/^FILE_[0-9]{15}$/u.test(atchFileId)) {
    throw new TypeError(`${label}.atchFileId is invalid`);
  }
  const fileDetailSn = boundedString(
    value.fileDetailSn,
    `${label}.fileDetailSn`,
    8,
  );
  if (!/^[1-9][0-9]{0,7}$/u.test(fileDetailSn)) {
    throw new TypeError(`${label}.fileDetailSn is invalid`);
  }
  return Object.freeze({
    atchFileId,
    fileDetailSn,
    dataNm: boundedString(value.dataNm, `${label}.dataNm`, 300),
  });
}

export function validateAssetManifest(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.schema !== ASSET_SCHEMA ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    value.sources.length > MAX_SOURCES
  ) {
    throw new TypeError(`invalid ${ASSET_SCHEMA} manifest`);
  }
  const ids = new Set();
  const sources = value.sources.map((candidate, index) => {
    const label = `sources[${index}]`;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new TypeError(`${label} must be an object`);
    }
    const id = boundedString(candidate.id, `${label}.id`, 64);
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/u.test(id) || ids.has(id)) {
      throw new TypeError(`${label}.id is invalid or duplicated`);
    }
    ids.add(id);
    const license = candidate.license;
    if (
      typeof license !== "object" ||
      license === null ||
      Array.isArray(license) ||
      license.id !== "KOGL-Type-1"
    ) {
      throw new TypeError(`${label}.license must be KOGL-Type-1`);
    }
    const download = candidate.download;
    if (
      typeof download !== "object" ||
      download === null ||
      Array.isArray(download)
    ) {
      throw new TypeError(`${label}.download must be an object`);
    }
    const expected = candidate.expected;
    if (
      typeof expected !== "object" ||
      expected === null ||
      Array.isArray(expected) ||
      !DISCIPLINES.has(expected.discipline)
    ) {
      throw new TypeError(`${label}.expected is invalid`);
    }
    const sha256 = boundedString(
      download.sha256,
      `${label}.download.sha256`,
      64,
    );
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new TypeError(`${label}.download.sha256 is invalid`);
    }
    return Object.freeze({
      id,
      title: boundedString(candidate.title, `${label}.title`, 300),
      publisher: boundedString(
        candidate.publisher,
        `${label}.publisher`,
        200,
      ),
      catalogUrl: trustedUrl(
        candidate.catalogUrl,
        `${label}.catalogUrl`,
      ),
      license: Object.freeze({
        id: license.id,
        name: boundedString(
          license.name,
          `${label}.license.name`,
          120,
        ),
        termsUrl: licenseTermsUrl(
          license.termsUrl,
          `${label}.license.termsUrl`,
        ),
      }),
      download: Object.freeze({
        endpoint: trustedUrl(
          download.endpoint,
          `${label}.download.endpoint`,
          DOWNLOAD_PATH,
        ),
        parameters: downloadParameters(
          download.parameters,
          `${label}.download.parameters`,
        ),
        sizeBytes: boundedInteger(
          download.sizeBytes,
          `${label}.download.sizeBytes`,
          1,
          MAX_ARCHIVE_BYTES,
        ),
        sha256,
      }),
      expected: Object.freeze({
        dwgFiles: boundedInteger(
          expected.dwgFiles,
          `${label}.expected.dwgFiles`,
          1,
          MAX_ARCHIVE_ENTRIES,
        ),
        versions: uniqueEnumList(
          expected.versions,
          DWG_VERSIONS,
          `${label}.expected.versions`,
        ),
        discipline: expected.discipline,
      }),
    });
  });
  return Object.freeze({
    schema: ASSET_SCHEMA,
    sources: Object.freeze(sources),
  });
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

export function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = optionValue(argv, index, option);
    if (option === "--manifest") {
      result.manifestPath = value;
    } else if (option === "--output") {
      result.outputPath = value;
    } else {
      throw new TypeError(`unknown option: ${option}`);
    }
  }
  for (const key of ["manifestPath", "outputPath"]) {
    if (!result[key] || !path.isAbsolute(result[key])) {
      throw new TypeError(`${key} must be an absolute path`);
    }
  }
  if (result.manifestPath === result.outputPath) {
    throw new TypeError("manifestPath and outputPath must differ");
  }
  return Object.freeze(result);
}

export function buildDownloadUrl(source) {
  const url = new URL(source.download.endpoint);
  for (const [key, value] of Object.entries(
    source.download.parameters,
  )) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

async function readBoundedResponse(response, expectedBytes) {
  if (!response || response.ok !== true) {
    throw new Error(
      `download returned HTTP ${response?.status ?? "unknown"}`,
    );
  }
  const contentLength = response.headers?.get?.("content-length");
  if (
    contentLength !== null &&
    contentLength !== undefined &&
    contentLength !== String(expectedBytes)
  ) {
    throw new Error("download Content-Length does not match the pin");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error("download response has no readable body");
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!(value instanceof Uint8Array)) {
      throw new Error("download returned a non-binary body");
    }
    total += value.byteLength;
    if (total > expectedBytes || total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error("download exceeds its pinned size");
    }
    chunks.push(Buffer.from(value));
  }
  if (total !== expectedBytes) {
    throw new Error("download size does not match the pin");
  }
  return Buffer.concat(chunks, total);
}

async function verifyCatalogLicense(source, fetchImplementation) {
  const response = await fetchImplementation(source.catalogUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent":
        "2d-cad-viewer-public-corpus/1 (+https://github.com/menaje/2d-cad-viewer)",
    },
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response || response.ok !== true) {
    throw new Error(
      `${source.id} catalog returned HTTP ${
        response?.status ?? "unknown"
      }`,
    );
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error(`${source.id} catalog has no readable body`);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!(value instanceof Uint8Array)) {
      throw new Error(
        `${source.id} catalog returned a non-binary body`,
      );
    }
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error(
        `${source.id} catalog exceeds the response limit`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  if (!KOGL_TYPE_1_PATTERN.test(text)) {
    throw new Error(
      `${source.id} catalog no longer declares KOGL Type 1`,
    );
  }
}

async function downloadArchive(source, fetchImplementation) {
  const response = await fetchImplementation(buildDownloadUrl(source), {
    headers: {
      Accept: "application/zip, application/octet-stream",
      "User-Agent":
        "2d-cad-viewer-public-corpus/1 (+https://github.com/menaje/2d-cad-viewer)",
    },
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  const archive = await readBoundedResponse(
    response,
    source.download.sizeBytes,
  );
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== source.download.sha256) {
    throw new Error(`${source.id} archive SHA-256 does not match`);
  }
  return archive;
}

function makeCrcTable() {
  return Object.freeze(
    Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value =
          (value & 1) !== 0
            ? 0xedb88320 ^ (value >>> 1)
            : value >>> 1;
      }
      return value >>> 0;
    }),
  );
}

export function crc32(bytes) {
  crcTable ??= makeCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (
    let offset = archive.length - 22;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (
      archive.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE &&
      offset + 22 + archive.readUInt16LE(offset + 20) ===
        archive.length
    ) {
      return offset;
    }
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function readCentralDirectory(archive) {
  if (archive.length < 22) {
    throw new Error("ZIP archive is too short");
  }
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries === 0xffff ||
    totalEntries > MAX_ARCHIVE_ENTRIES ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== eocd
  ) {
    throw new Error("ZIP64, split, empty, or malformed archives are unsupported");
  }
  const entries = [];
  const localOffsets = new Set();
  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + 46 > eocd ||
      archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE
    ) {
      throw new Error("ZIP central directory is malformed");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const entryDisk = archive.readUInt16LE(cursor + 34);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > eocd ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      entryDisk !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      compressedSize > MAX_ENTRY_BYTES ||
      uncompressedSize > MAX_ENTRY_BYTES ||
      localOffsets.has(localOffset)
    ) {
      throw new Error("ZIP entry is encrypted, unsupported, or malformed");
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error("ZIP expanded size exceeds the corpus limit");
    }
    localOffsets.add(localOffset);
    entries.push(
      Object.freeze({
        flags,
        method,
        checksum,
        compressedSize,
        uncompressedSize,
        localOffset,
      }),
    );
    cursor = next;
  }
  if (cursor !== eocd) {
    throw new Error("ZIP central directory size is inconsistent");
  }
  return Object.freeze(entries);
}

function inflateEntry(archive, entry) {
  const offset = entry.localOffset;
  if (
    offset + 30 > archive.length ||
    archive.readUInt32LE(offset) !== ZIP_LOCAL_SIGNATURE
  ) {
    throw new Error("ZIP local header is missing");
  }
  const flags = archive.readUInt16LE(offset + 6);
  const method = archive.readUInt16LE(offset + 8);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (
    (flags & 1) !== 0 ||
    method !== entry.method ||
    dataEnd > archive.length
  ) {
    throw new Error("ZIP local entry does not match its central record");
  }
  const compressed = archive.subarray(dataOffset, dataEnd);
  const result =
    entry.method === 0
      ? Buffer.from(compressed)
      : Buffer.from(
          inflateRawSync(compressed, {
            maxOutputLength: Math.max(entry.uncompressedSize, 1),
          }),
        );
  if (
    result.length !== entry.uncompressedSize ||
    crc32(result) !== entry.checksum
  ) {
    throw new Error("ZIP entry size or CRC-32 does not match");
  }
  return result;
}

export function extractDwgEntries(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE_BYTES) {
    throw new TypeError("archive must be a bounded Buffer");
  }
  const drawings = [];
  for (const entry of readCentralDirectory(archive)) {
    const bytes = inflateEntry(archive, entry);
    if (bytes.length < 6) {
      continue;
    }
    const version = bytes.subarray(0, 6).toString("ascii");
    if (/^AC[0-9]{4}$/u.test(version)) {
      if (!DWG_VERSIONS.has(version)) {
        throw new Error(`unsupported DWG version in public archive: ${version}`);
      }
      drawings.push(Object.freeze({ bytes, version }));
    }
  }
  return Object.freeze(drawings);
}

function equalStringSets(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function writeSource(outputPath, source, archive) {
  const drawings = extractDwgEntries(archive);
  const versions = [
    ...new Set(drawings.map(({ version }) => version)),
  ].sort();
  if (
    drawings.length !== source.expected.dwgFiles ||
    !equalStringSets(versions, source.expected.versions)
  ) {
    throw new Error(`${source.id} DWG inventory does not match the pin`);
  }
  const files = [];
  for (let index = 0; index < drawings.length; index += 1) {
    const name = `${source.id}-${String(index + 1).padStart(3, "0")}.dwg`;
    await writeFile(path.join(outputPath, name), drawings[index].bytes, {
      flag: "wx",
      mode: 0o600,
    });
    files.push(name);
  }
  return Object.freeze({
    id: source.id,
    title: source.title,
    publisher: source.publisher,
    catalogUrl: source.catalogUrl,
    license: source.license,
    catalogLicenseVerified: true,
    discipline: source.expected.discipline,
    archive: Object.freeze({
      sizeBytes: source.download.sizeBytes,
      sha256: source.download.sha256,
    }),
    extracted: Object.freeze({
      dwgFiles: drawings.length,
      versions: Object.freeze(versions),
      files: Object.freeze(files),
      archiveEntryNamesPublished: false,
      dwgBytesModified: false,
    }),
  });
}

export async function fetchPublicCorpus(
  manifest,
  outputPath,
  dependencies = {},
) {
  if (!path.isAbsolute(outputPath)) {
    throw new TypeError("outputPath must be absolute");
  }
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("a fetch implementation is required");
  }
  await mkdir(outputPath, { mode: 0o700 });
  let completed = false;
  try {
    const sources = [];
    for (const source of manifest.sources) {
      await verifyCatalogLicense(source, fetchImplementation);
      const archive = await downloadArchive(
        source,
        fetchImplementation,
      );
      sources.push(await writeSource(outputPath, source, archive));
    }
    const provenance = Object.freeze({
      schema: PROVENANCE_SCHEMA,
      attribution:
        "출처: 국가유산청·국립문화유산연구원, 공공데이터포털. 공공누리 제1유형(출처표시).",
      transformation:
        "ZIP entry names were replaced with deterministic ASCII fixture names; DWG bytes were not modified.",
      sources: Object.freeze(sources),
      summary: Object.freeze({
        sources: sources.length,
        dwgFiles: sources.reduce(
          (total, source) => total + source.extracted.dwgFiles,
          0,
        ),
        versions: Object.freeze([
          ...new Set(
            sources.flatMap((source) => source.extracted.versions),
          ),
        ].sort()),
      }),
    });
    await writeFile(
      path.join(outputPath, "PUBLIC-CORPUS-PROVENANCE.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    completed = true;
    return provenance;
  } finally {
    if (!completed) {
      await rm(outputPath, { recursive: true, force: false });
    }
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  const manifest = validateAssetManifest(
    JSON.parse(await readFile(options.manifestPath, "utf8")),
  );
  const report = await fetchPublicCorpus(
    manifest,
    options.outputPath,
  );
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Public Korean corpus fetch failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    process.exitCode = 1;
  });
}

export {
  ASSET_SCHEMA,
  PROVENANCE_SCHEMA,
};
