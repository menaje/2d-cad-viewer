#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GPL_3_0_SHA256,
  LIBREDWG_SOURCE_SHA256,
  LIBREDWG_VERSION,
  MPL_2_0_SHA256,
} from "../../../adapters/libredwg/package.mjs";

const SOURCE_PACKAGE_SCHEMA = "dwg-libredwg-package/1";
const EXTENSION_PACKAGE_SCHEMA = "dwg-libredwg-extension/1";
const MAX_PACKAGE_FILE_BYTES = 128 * 1024 * 1024;
const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const TARGETS = Object.freeze({
  "linux-x64": {
    platform: "linux",
    architecture: "x64",
    executable: "libredwg-adapter",
  },
  "darwin-arm64": {
    platform: "darwin",
    architecture: "arm64",
    executable: "libredwg-adapter",
  },
  "darwin-x64": {
    platform: "darwin",
    architecture: "x64",
    executable: "libredwg-adapter",
  },
  "win32-x64": {
    platform: "win32",
    architecture: "x64",
    executable: "libredwg-adapter.exe",
  },
});

const REQUIRED_SOURCE_PATHS = Object.freeze([
  `source/libredwg-${LIBREDWG_VERSION}.tar.xz`,
  "source/dwg-viewer/LICENSE",
  "source/dwg-viewer/NOTICE",
  "source/dwg-viewer/package.json",
  "source/dwg-viewer/adapters/libredwg/README.md",
  "source/dwg-viewer/adapters/libredwg/build.sh",
  "source/dwg-viewer/adapters/libredwg/prepare.sh",
  "source/dwg-viewer/adapters/libredwg/scripts/prepare-common.sh",
  "source/dwg-viewer/adapters/libredwg/scripts/platform/linux.sh",
  "source/dwg-viewer/adapters/libredwg/scripts/platform/macos.sh",
  "source/dwg-viewer/adapters/libredwg/scripts/platform/windows.sh",
  "source/dwg-viewer/adapters/libredwg/package.mjs",
  "source/dwg-viewer/adapters/libredwg/libredwg_adapter.c",
  "source/dwg-viewer/adapters/libredwg/libredwg_scene_cache.c",
  "source/dwg-viewer/adapters/libredwg/libredwg_scene_cache.h",
]);

const GENERATED_PATHS = Object.freeze([
  "native",
  "source",
  "LICENSES",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "manifest.json",
  "SHA256SUMS",
]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function regularFileMetadata(root, relativePath) {
  if (!safeRelativePath(relativePath)) {
    throw new Error(`unsafe package path: ${relativePath}`);
  }
  const absolutePath = path.join(root, ...relativePath.split("/"));
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.size > MAX_PACKAGE_FILE_BYTES) {
    throw new Error(`invalid package file: ${relativePath}`);
  }
  return { absolutePath, metadata };
}

async function hashFile(absolutePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(absolutePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

function parseChecksums(text) {
  const result = new Map();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    if (!match || !safeRelativePath(match[2]) || result.has(match[2])) {
      throw new Error("source package contains invalid checksums");
    }
    result.set(match[2], match[1]);
  }
  return result;
}

async function verifySourcePackage({
  packageRoot,
  target,
  expectedSourceSha256,
  extensionVersion,
}) {
  const targetDescriptor = TARGETS[target];
  if (!targetDescriptor) {
    throw new Error(`unsupported VS Code target: ${target}`);
  }
  if (!path.isAbsolute(packageRoot)) {
    throw new Error("package root must be absolute");
  }

  const manifestPath = path.join(packageRoot, "manifest.json");
  const manifestData = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestData.toString("utf8"));
  } catch {
    throw new Error("source package manifest is not valid JSON");
  }
  if (
    manifest?.schema !== SOURCE_PACKAGE_SCHEMA ||
    manifest?.package_version !== extensionVersion ||
    manifest?.binary_license !== "GPL-3.0-or-later" ||
    manifest?.corresponding_source !== "included" ||
    manifest?.adapter?.protocol !== "dwg-engine-adapter/1" ||
    manifest?.adapter?.engine?.id !== "libredwg" ||
    manifest?.adapter?.engine?.version !== LIBREDWG_VERSION ||
    manifest?.adapter?.engine?.license !== "GPL-3.0-or-later" ||
    manifest?.adapter?.engine?.linkage !== "static" ||
    manifest?.target?.platform !== targetDescriptor.platform ||
    manifest?.target?.architecture !== targetDescriptor.architecture ||
    !Array.isArray(manifest?.files)
  ) {
    throw new Error("source package is not companion-extension compatible");
  }

  const files = new Map();
  for (const entry of manifest.files) {
    if (
      !safeRelativePath(entry?.path) ||
      !Number.isSafeInteger(entry?.size_bytes) ||
      entry.size_bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(entry?.sha256 ?? "") ||
      files.has(entry.path)
    ) {
      throw new Error("source package manifest contains an invalid file");
    }
    files.set(entry.path, entry);
  }

  const requiredPaths = [
    `bin/${targetDescriptor.executable}`,
    "README.txt",
    "NOTICE",
    "THIRD_PARTY_NOTICES.txt",
    "LICENSES/GPL-3.0-or-later.txt",
    "LICENSES/MPL-2.0.txt",
    ...REQUIRED_SOURCE_PATHS,
  ];
  for (const requiredPath of requiredPaths) {
    if (!files.has(requiredPath)) {
      throw new Error(`source package is missing ${requiredPath}`);
    }
  }

  for (const [relativePath, entry] of files) {
    const { absolutePath, metadata } = await regularFileMetadata(
      packageRoot,
      relativePath,
    );
    if (
      metadata.size !== entry.size_bytes ||
      (await hashFile(absolutePath)) !== entry.sha256
    ) {
      throw new Error(`source package checksum mismatch: ${relativePath}`);
    }
  }

  const checksums = parseChecksums(
    await readFile(path.join(packageRoot, "SHA256SUMS"), "utf8"),
  );
  const expectedChecksumPaths = new Set([...files.keys(), "manifest.json"]);
  if (
    checksums.size !== expectedChecksumPaths.size ||
    [...expectedChecksumPaths].some((item) => !checksums.has(item))
  ) {
    throw new Error("source package checksum set is incomplete");
  }
  for (const [relativePath, expectedHash] of checksums) {
    const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
    if ((await hashFile(absolutePath)) !== expectedHash) {
      throw new Error(`source package checksum mismatch: ${relativePath}`);
    }
  }
  if (checksums.get("manifest.json") !== sha256(manifestData)) {
    throw new Error("source package manifest checksum mismatch");
  }

  const [
    gplLicense,
    mplLicense,
    sourceArchive,
    sourceLicense,
    sourceNotice,
    packageNotice,
    sourceManifest,
  ] =
    await Promise.all([
      readFile(path.join(packageRoot, "LICENSES", "GPL-3.0-or-later.txt")),
      readFile(path.join(packageRoot, "LICENSES", "MPL-2.0.txt")),
      readFile(
        path.join(
          packageRoot,
          "source",
          `libredwg-${LIBREDWG_VERSION}.tar.xz`,
        ),
      ),
      readFile(path.join(packageRoot, "source", "dwg-viewer", "LICENSE")),
      readFile(path.join(packageRoot, "source", "dwg-viewer", "NOTICE")),
      readFile(path.join(packageRoot, "NOTICE")),
      readFile(path.join(packageRoot, "source", "dwg-viewer", "package.json"), "utf8"),
    ]);
  if (sha256(gplLicense) !== GPL_3_0_SHA256) {
    throw new Error("source package GPL text is not the pinned original");
  }
  if (sha256(mplLicense) !== MPL_2_0_SHA256) {
    throw new Error("source package MPL text is not the pinned original");
  }
  if (!sourceLicense.equals(mplLicense) || !sourceNotice.equals(packageNotice)) {
    throw new Error("source package license or notice copies differ");
  }
  if (sha256(sourceArchive) !== expectedSourceSha256) {
    throw new Error("source package LibreDWG archive checksum mismatch");
  }
  if (JSON.parse(sourceManifest).version !== extensionVersion) {
    throw new Error("source package repository version mismatch");
  }

  return { files, manifest, targetDescriptor };
}

async function copyPayloadFile(packageRoot, destinationRoot, from, to, mode) {
  const source = path.join(packageRoot, ...from.split("/"));
  const destination = path.join(destinationRoot, ...to.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (mode !== undefined && process.platform !== "win32") {
    await chmod(destination, mode);
  }
}

export async function prepareCompanionPackage({
  packageRoot,
  target,
  destinationRoot = extensionRoot,
  expectedSourceSha256 = LIBREDWG_SOURCE_SHA256,
}) {
  if (!path.isAbsolute(destinationRoot)) {
    throw new Error("destination root must be absolute");
  }
  const [extensionManifestData, readme, packagedLicense] = await Promise.all([
    readFile(path.join(destinationRoot, "package.json")),
    readFile(path.join(destinationRoot, "README.md")),
    readFile(path.join(destinationRoot, "LICENSE.txt")),
  ]);
  const extensionManifest = JSON.parse(extensionManifestData.toString("utf8"));
  if (
    extensionManifest.name !== "dwg-viewer-libredwg" ||
    extensionManifest.publisher !== "menaje" ||
    extensionManifest.license !== "GPL-3.0-or-later" ||
    !Array.isArray(extensionManifest.extensionKind) ||
    !extensionManifest.extensionKind.includes("workspace")
  ) {
    throw new Error("companion extension manifest is invalid");
  }
  if (sha256(packagedLicense) !== GPL_3_0_SHA256) {
    throw new Error("companion extension GPL text is not the pinned original");
  }

  const verified = await verifySourcePackage({
    packageRoot,
    target,
    expectedSourceSha256,
    extensionVersion: extensionManifest.version,
  });
  const packagedGpl = await readFile(
    path.join(packageRoot, "LICENSES", "GPL-3.0-or-later.txt"),
  );
  if (!packagedLicense.equals(packagedGpl)) {
    throw new Error("companion and source-package GPL texts differ");
  }

  for (const generatedPath of GENERATED_PATHS) {
    await rm(path.join(destinationRoot, generatedPath), {
      force: true,
      recursive: true,
    });
  }

  const mappings = [];
  for (const sourcePath of verified.files.keys()) {
    if (sourcePath.startsWith("source/") || sourcePath.startsWith("LICENSES/")) {
      mappings.push({ from: sourcePath, to: sourcePath });
    }
  }
  mappings.push(
    {
      from: `bin/${verified.targetDescriptor.executable}`,
      to: `native/${target}/${verified.targetDescriptor.executable}`,
      mode: 0o755,
    },
    { from: "NOTICE", to: "NOTICE" },
    {
      from: "THIRD_PARTY_NOTICES.txt",
      to: "THIRD_PARTY_NOTICES.md",
    },
  );
  for (const mapping of mappings) {
    await copyPayloadFile(
      packageRoot,
      destinationRoot,
      mapping.from,
      mapping.to,
      mapping.mode,
    );
  }

  const distributedFiles = [
    {
      path: "package.json",
      size_bytes: extensionManifestData.byteLength,
      sha256: sha256(extensionManifestData),
    },
    {
      path: "README.md",
      size_bytes: readme.byteLength,
      sha256: sha256(readme),
    },
    {
      path: "LICENSE.txt",
      size_bytes: packagedLicense.byteLength,
      sha256: sha256(packagedLicense),
    },
  ];
  for (const mapping of mappings) {
    const sourceEntry = verified.files.get(mapping.from);
    distributedFiles.push({
      path: mapping.to,
      size_bytes: sourceEntry.size_bytes,
      sha256: sourceEntry.sha256,
    });
  }
  distributedFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const companionManifest = {
    schema: EXTENSION_PACKAGE_SCHEMA,
    extension_version: extensionManifest.version,
    adapter: verified.manifest.adapter,
    target: verified.manifest.target,
    binary_license: "GPL-3.0-or-later",
    corresponding_source: "included",
    files: distributedFiles,
  };
  const companionManifestData = Buffer.from(
    `${JSON.stringify(companionManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(destinationRoot, "manifest.json"), companionManifestData);

  const checksums = [
    ...distributedFiles.map((entry) => `${entry.sha256}  ${entry.path}`),
    `${sha256(companionManifestData)}  manifest.json`,
  ]
    .sort((left, right) => left.localeCompare(right, "en"))
    .join("\n");
  await writeFile(path.join(destinationRoot, "SHA256SUMS"), `${checksums}\n`);

  return {
    target,
    executablePath: path.join(
      destinationRoot,
      "native",
      target,
      verified.targetDescriptor.executable,
    ),
    files: distributedFiles.length + 2,
  };
}

function parseArguments(values) {
  if (values[0] === "--") {
    values = values.slice(1);
  }
  if (values.length !== 4) {
    return undefined;
  }
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || (flag !== "--package-root" && flag !== "--target")) {
      return undefined;
    }
    parsed[flag] = value;
  }
  return parsed["--package-root"] && parsed["--target"] ? parsed : undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    process.stderr.write(
      "usage: node scripts/prepare-package.mjs " +
        "--package-root ABSOLUTE_PATH --target TARGET\n",
    );
    process.exitCode = 2;
  } else {
    prepareCompanionPackage({
      packageRoot: path.resolve(args["--package-root"]),
      target: args["--target"],
    })
      .then((result) => {
        process.stdout.write(
          `${JSON.stringify({ status: "ok", ...result })}\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(
          `cannot prepare LibreDWG companion extension: ${error.message}\n`,
        );
        process.exitCode = 1;
      });
  }
}
