// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, open } from "node:fs/promises";
import path from "node:path";

export const ADAPTER_PROTOCOL = "dwg-engine-adapter/1";
export const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;

export function boundedInteger(value, minimum, maximum) {
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
    ? parsed
    : undefined;
}

export function parseFlagPairs(values) {
  if (values.length % 2 !== 0) {
    return undefined;
  }
  const raw = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value || raw[flag] !== undefined) {
      return undefined;
    }
    raw[flag] = value;
  }
  return raw;
}

export function absolutePath(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return path.resolve(value);
}

export async function mustNotExist(filePath, label) {
  try {
    await access(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists`);
}

export function appendBounded(chunks, value, state, maximum, label) {
  const bytes = Buffer.from(value);
  if (state.bytes + bytes.length > maximum) {
    throw new Error(`${label} exceeded its bounded capture`);
  }
  chunks.push(bytes);
  state.bytes += bytes.length;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function reportFingerprint(report) {
  return createHash("sha256")
    .update(JSON.stringify({
      cache: report.cache,
      coverage: report.coverage,
      tables: report.tables,
      gpuLines: report.gpu_lines,
      hatchFills: report.hatch_fills,
      diagnostics: report.diagnostics,
    }))
    .digest("hex");
}

export function summarizeIntegers(values) {
  if (
    values.length === 0 ||
    values.some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new TypeError(
      "summary values must be non-negative safe integers",
    );
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minimum: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    maximum: sorted.at(-1),
  };
}

export async function writeNewJson(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function verifyDwg(filePath) {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat({ bigint: true });
    const bytes = Buffer.alloc(6);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (
      !metadata.isFile() ||
      bytesRead !== bytes.length ||
      !/^AC\d{4}$/u.test(bytes.toString("ascii"))
    ) {
      throw new Error("fixture is not a readable DWG file");
    }
    return metadata;
  } finally {
    await handle.close();
  }
}
