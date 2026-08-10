#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ENGINE_ASSET_CATALOG_SCHEMA =
  "dwg-viewer-engine-assets/1";
export const ENGINE_TARGETS = Object.freeze([
  "linux-x64",
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const LIBREDWG_VERSION = "0.14";
const MAX_ASSET_BYTES = 128 * 1024 * 1024;

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function describeFile(directory, name) {
  const filePath = path.join(directory, name);
  const metadata = await stat(filePath);
  if (
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > MAX_ASSET_BYTES
  ) {
    throw new Error(`engine release asset has an invalid size: ${name}`);
  }
  return {
    name,
    sha256: await sha256File(filePath),
    size: metadata.size,
  };
}

export async function createEngineCatalog({ directory, version }) {
  if (!path.isAbsolute(directory)) {
    throw new TypeError("engine asset directory must be absolute");
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid viewer version: ${version}`);
  }
  const targets = {};
  for (const target of ENGINE_TARGETS) {
    const executable = await describeFile(
      directory,
      `dwg-viewer-native-converter-${version}-${target}${
        target === "win32-x64" ? ".exe" : ""
      }`,
    );
    const source = await describeFile(
      directory,
      `dwg-viewer-libredwg-${LIBREDWG_VERSION}-${target}.tar.gz`,
    );
    targets[target] = {
      asset: executable.name,
      sha256: executable.sha256,
      size: executable.size,
      sourceAsset: source.name,
      sourceSha256: source.sha256,
      sourceSize: source.size,
    };
  }
  return Object.freeze({
    schema: ENGINE_ASSET_CATALOG_SCHEMA,
    viewerVersion: version,
    repository: "menaje/dwg-viewer",
    releaseTag: `v${version}`,
    engine: Object.freeze({
      id: "libredwg",
      version: LIBREDWG_VERSION,
      protocol: "dwg-engine-adapter/1",
      cacheSchema: "dwg-scene-cache/1.21",
      license: "GPL-3.0-or-later",
    }),
    targets: Object.freeze(targets),
  });
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!value || !new Set(["--directory", "--version", "--output"]).has(option)) {
      throw new Error(
        "usage: create-engine-catalog.mjs --directory PATH --version X.Y.Z --output PATH",
      );
    }
    options[option.slice(2)] = value;
  }
  if (!options.directory || !options.version || !options.output) {
    throw new Error(
      "usage: create-engine-catalog.mjs --directory PATH --version X.Y.Z --output PATH",
    );
  }
  return {
    directory: path.resolve(options.directory),
    version: options.version,
    output: path.resolve(options.output),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const catalog = await createEngineCatalog(options);
  await writeFile(
    options.output,
    `${JSON.stringify(catalog, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`cannot create engine catalog: ${error.message}\n`);
    process.exitCode = 1;
  });
}
