#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  open,
  readFile,
  stat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const LIBREDWG_VERSION = "0.14";
export const LIBREDWG_SOURCE_SHA256 =
  "62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275";
export const GPL_3_0_SHA256 =
  "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903";
export const MPL_2_0_SHA256 =
  "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04";
const PACKAGE_SCHEMA = "dwg-libredwg-package/1";
const DOCTOR_SCHEMA = "dwg-engine-doctor/1";
const ADAPTER_PROTOCOL = "dwg-engine-adapter/1";
const CACHE_SCHEMA = "dwg-scene-cache/1.21";
const MAX_ADAPTER_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_DEPENDENCY_AUDIT_BYTES = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

const ADAPTER_SOURCE_FILES = Object.freeze([
  "README.md",
  "build.sh",
  "prepare.sh",
  "package.mjs",
  "libredwg-acds-sab.patch",
  "libredwg-r2007-high-compression.patch",
  "libredwg_adapter.c",
  "libredwg_scene_cache.c",
  "libredwg_scene_cache.h",
]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function safeIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 40 &&
    /^[a-zA-Z0-9._+-]+$/u.test(value)
  );
}

function configuredExecutable(environmentName, fallback) {
  const configured = process.env[environmentName]?.trim();
  if (!configured) {
    return fallback;
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(`${environmentName} must be an absolute executable path`);
  }
  return configured;
}

function writeString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) {
    throw new Error(`tar header value is too long: ${value}`);
  }
  encoded.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) {
    throw new Error("tar header number is too large");
  }
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function splitTarPath(value) {
  if (Buffer.byteLength(value, "utf8") <= 100) {
    return { name: value, prefix: "" };
  }
  for (let index = value.lastIndexOf("/"); index > 0; ) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
    index = value.lastIndexOf("/", index - 1);
  }
  throw new Error(`tar path is too long: ${value}`);
}

function tarHeader(entry) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(entry.name);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  header.write(encodedChecksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function addDirectoryEntries(files) {
  const directories = new Set();
  for (const file of files) {
    const components = file.name.split("/");
    for (let index = 1; index < components.length; index += 1) {
      directories.add(`${components.slice(0, index).join("/")}/`);
    }
  }
  return [
    ...[...directories].sort().map((name) => ({
      name,
      data: Buffer.alloc(0),
      mode: 0o755,
      type: "directory",
    })),
    ...files,
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export function createDeterministicTarGzip(inputFiles) {
  const names = new Set();
  const files = inputFiles.map((entry) => {
    if (
      typeof entry.name !== "string" ||
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name.split("/").some((part) => part === "" || part === "..")
    ) {
      throw new Error(`unsafe archive path: ${entry.name}`);
    }
    if (names.has(entry.name)) {
      throw new Error(`duplicate archive path: ${entry.name}`);
    }
    names.add(entry.name);
    return {
      name: entry.name,
      data: Buffer.from(entry.data),
      mode: entry.mode === 0o755 ? 0o755 : 0o644,
      type: "file",
    };
  });

  const chunks = [];
  for (const entry of addDirectoryEntries(files)) {
    chunks.push(tarHeader(entry));
    if (entry.data.byteLength > 0) {
      chunks.push(entry.data);
      const padding = (512 - (entry.data.byteLength % 512)) % 512;
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding));
      }
    }
  }
  chunks.push(Buffer.alloc(1_024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
  archive.writeUInt32LE(0, 4);
  archive[9] = 255;
  return archive;
}

function parseDoctorReport(output) {
  let report;
  try {
    report = JSON.parse(output.trim());
  } catch {
    throw new Error("adapter doctor returned invalid JSON");
  }
  if (
    report?.schema !== DOCTOR_SCHEMA ||
    report?.status !== "ok" ||
    report?.protocol !== ADAPTER_PROTOCOL ||
    report?.engine?.id !== "libredwg" ||
    report?.engine?.version !== LIBREDWG_VERSION ||
    report?.engine?.license !== "GPL-3.0-or-later" ||
    report?.engine?.linkage !== "static" ||
    report?.cache?.schema !== CACHE_SCHEMA ||
    !safeIdentifier(report?.target?.platform) ||
    !safeIdentifier(report?.target?.architecture)
  ) {
    throw new Error("adapter doctor report is not release-compatible");
  }
  return report;
}

async function runDoctor(adapterPath) {
  let result;
  try {
    result = await execFileAsync(adapterPath, ["doctor"], {
      cwd: path.dirname(adapterPath),
      env: {
        ...process.env,
        DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
        DWG_VIEWER_BENCHMARK_PHASE: "doctor",
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 5_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error("adapter self-diagnosis failed", { cause: error });
  }
  return parseDoctorReport(result.stdout);
}

async function assertNoDynamicLibreDwg(adapterPath, platform) {
  let command;
  let args;
  if (platform === "darwin") {
    command = "otool";
    args = ["-L", adapterPath];
  } else if (platform === "linux") {
    command = "readelf";
    args = ["-d", adapterPath];
  } else if (platform === "win32") {
    command = configuredExecutable(
      "DWG_VIEWER_OBJDUMP",
      "objdump",
    );
    args = ["-p", adapterPath];
  } else {
    throw new Error(`unsupported adapter target: ${platform}`);
  }
  let output;
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      // GNU objdump includes the PE base-relocation table in `-p` output.
      // A statically linked Windows adapter can legitimately exceed Node's
      // default buffer even though the imported-DLL list is small.
      maxBuffer: MAX_DEPENDENCY_AUDIT_BYTES,
      timeout: 30_000,
      windowsHide: true,
    });
    output = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    throw new Error(`cannot audit adapter dependencies with ${command}`, {
      cause: error,
    });
  }
  if (/libredwg(?:[.-][a-zA-Z0-9.]+)?\.(?:dylib|so|dll)/iu.test(output)) {
    throw new Error("adapter has a dynamic LibreDWG dependency");
  }
}

function assertNoBuildPaths(adapter) {
  const forbiddenFragments = [
    "/private/",
    "/tmp/",
    "/Users/",
    "/home/",
    "/workspace/",
    "/Volumes/",
    "/__w/",
    "\\Users\\",
    "\\runner\\",
    "\\workspace\\",
    ":\\a\\",
  ];
  for (const fragment of forbiddenFragments) {
    if (adapter.includes(Buffer.from(fragment, "utf8"))) {
      throw new Error(
        "adapter contains a local build path; strip it before packaging",
      );
    }
  }
}

async function readBoundedRegularFile(filePath, maximumBytes, label) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  return readFile(filePath);
}

export function licenseExtractionArguments(
  sourceArchive,
  platform = process.platform,
) {
  const archivePath =
    platform === "win32"
      ? sourceArchive.replaceAll("\\", "/")
      : sourceArchive;
  return [
    ...(platform === "win32" ? ["--force-local"] : []),
    "-xOf",
    archivePath,
    `libredwg-${LIBREDWG_VERSION}/COPYING`,
  ];
}

async function extractGplLicense(sourceArchive) {
  let result;
  try {
    result = await execFileAsync(
      configuredExecutable("DWG_VIEWER_TAR", "tar"),
      licenseExtractionArguments(sourceArchive),
      {
        encoding: "utf8",
        maxBuffer: 128 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error("cannot extract LibreDWG's GPL license", {
      cause: error,
    });
  }
  const license = Buffer.from(result.stdout, "utf8");
  if (sha256(license) !== GPL_3_0_SHA256) {
    throw new Error("LibreDWG source contains an unexpected license file");
  }
  return license;
}

function packageReadme(report, executableName) {
  return Buffer.from(
    `DWG Viewer LibreDWG adapter ${LIBREDWG_VERSION}

This is the separately distributed GPL-enabled conversion engine for the
MPL-licensed DWG Viewer VS Code extension. It runs locally and does not upload
drawings.

Target: ${report.target.platform}-${report.target.architecture}
Adapter protocol: ${ADAPTER_PROTOCOL}
Scene Cache: ${CACHE_SCHEMA}

Install
-------
1. Keep this extracted folder in a location you control.
2. In VS Code, run "DWG Viewer: LibreDWG 변환기 선택".
3. Select bin/${executableName}. The extension runs a bounded self-diagnosis
   before saving the setting.

Manual diagnosis
-----------------
Run:

  bin/${executableName} doctor

License and source
------------------
The linked adapter executable is distributed under GPL-3.0-or-later.
LICENSES/GPL-3.0-or-later.txt contains the license. Complete source used for
this package is included under source/, including the checksum-pinned
LibreDWG ${LIBREDWG_VERSION} release archive and the DWG Viewer adapter source.
LICENSES/MPL-2.0.txt contains the unmodified MPL 2.0 text applicable to that
adapter source, and NOTICE contains the DWG Viewer copyright notice.

Rebuild from the included source
--------------------------------
From this extracted folder, choose two paths that do not exist and run:

  LIBREDWG_SOURCE_ARCHIVE="$PWD/source/libredwg-${LIBREDWG_VERSION}.tar.xz" \\
    source/dwg-viewer/adapters/libredwg/prepare.sh \\
    /new/private/build-directory /existing/output-parent/libredwg-adapter

A C11 compiler, make, tar, a SHA-256 tool, and either pkg-config/pkgconf or
curl are required. The prepare script validates the included LibreDWG archive
before building and does not install a system package.
`,
    "utf8",
  );
}

function thirdPartyNotices() {
  return Buffer.from(
    `DWG Viewer LibreDWG adapter notices

GNU LibreDWG ${LIBREDWG_VERSION}
  Project: https://www.gnu.org/software/libredwg/
  Source release: https://github.com/LibreDWG/libredwg/releases/tag/${LIBREDWG_VERSION}
  License: GPL-3.0-or-later
  Exact source: source/libredwg-${LIBREDWG_VERSION}.tar.xz

DWG Viewer adapter source
  Project: https://github.com/menaje/dwg-viewer
  Source: source/dwg-viewer/adapters/libredwg/
  Source license: source/dwg-viewer/LICENSE
  Project notice: source/dwg-viewer/NOTICE

The adapter executable is statically linked with LibreDWG and is conveyed
under GPL-3.0-or-later. The MPL-2.0 DWG Viewer VSIX is a separate artifact and
is not included in this archive. This notice records the project's engineering
distribution policy and is not legal advice.
`,
    "utf8",
  );
}

function fileEntry(name, data, mode = 0o644) {
  return { name, data: Buffer.from(data), mode };
}

async function writeNewFile(outputPath, data) {
  const handle = await open(outputPath, "wx", 0o644);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

export async function createLibreDwgPackage({
  adapterPath,
  sourceArchive,
  outputPath,
}) {
  for (const [label, value] of Object.entries({
    adapterPath,
    sourceArchive,
    outputPath,
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new Error(`${label} must be an absolute path`);
    }
  }
  const outputParent = path.dirname(outputPath);
  const outputParentMetadata = await stat(outputParent);
  if (!outputParentMetadata.isDirectory()) {
    throw new Error("package output parent is not a directory");
  }
  try {
    await access(outputPath);
    throw new Error("refusing to overwrite package output");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (process.platform !== "win32") {
    await access(adapterPath, constants.X_OK);
  }

  const [adapter, source, report, gplLicense] = await Promise.all([
    readBoundedRegularFile(
      adapterPath,
      MAX_ADAPTER_BYTES,
      "adapter executable",
    ),
    readBoundedRegularFile(
      sourceArchive,
      MAX_SOURCE_BYTES,
      "LibreDWG source archive",
    ),
    runDoctor(adapterPath),
    extractGplLicense(sourceArchive),
  ]);
  if (sha256(source) !== LIBREDWG_SOURCE_SHA256) {
    throw new Error("LibreDWG source archive checksum mismatch");
  }
  assertNoBuildPaths(adapter);
  await assertNoDynamicLibreDwg(adapterPath, report.target.platform);

  const executableName =
    report.target.platform === "win32"
      ? "libredwg-adapter.exe"
      : "libredwg-adapter";
  const packageRoot =
    `dwg-viewer-libredwg-${LIBREDWG_VERSION}-` +
    `${report.target.platform}-${report.target.architecture}`;
  const [rootLicense, rootNotice, rootPackageJson] = await Promise.all([
    readFile(path.join(repositoryRoot, "LICENSE")),
    readFile(path.join(repositoryRoot, "NOTICE")),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ]);
  if (sha256(rootLicense) !== MPL_2_0_SHA256) {
    throw new Error("repository MPL-2.0 license text is not canonical");
  }
  const packageVersion = JSON.parse(rootPackageJson).version;
  if (!safeIdentifier(packageVersion)) {
    throw new Error("repository package version is invalid");
  }
  const sourceFiles = await Promise.all(
    ADAPTER_SOURCE_FILES.map(async (name) =>
      fileEntry(
        `${packageRoot}/source/dwg-viewer/adapters/libredwg/${name}`,
        await readFile(path.join(scriptDirectory, name)),
        name.endsWith(".sh") || name.endsWith(".mjs") ? 0o755 : 0o644,
      ),
    ),
  );
  const payload = [
    fileEntry(
      `${packageRoot}/bin/${executableName}`,
      adapter,
      0o755,
    ),
    fileEntry(`${packageRoot}/README.txt`, packageReadme(report, executableName)),
    fileEntry(
      `${packageRoot}/THIRD_PARTY_NOTICES.txt`,
      thirdPartyNotices(),
    ),
    fileEntry(`${packageRoot}/NOTICE`, rootNotice),
    fileEntry(
      `${packageRoot}/LICENSES/GPL-3.0-or-later.txt`,
      gplLicense,
    ),
    fileEntry(`${packageRoot}/LICENSES/MPL-2.0.txt`, rootLicense),
    fileEntry(
      `${packageRoot}/source/libredwg-${LIBREDWG_VERSION}.tar.xz`,
      source,
    ),
    fileEntry(
      `${packageRoot}/source/dwg-viewer/LICENSE`,
      rootLicense,
    ),
    fileEntry(
      `${packageRoot}/source/dwg-viewer/NOTICE`,
      rootNotice,
    ),
    fileEntry(
      `${packageRoot}/source/dwg-viewer/package.json`,
      rootPackageJson,
    ),
    ...sourceFiles,
  ];
  const manifest = {
    schema: PACKAGE_SCHEMA,
    package_version: packageVersion,
    adapter: {
      protocol: report.protocol,
      engine: report.engine,
      cache: report.cache,
    },
    target: report.target,
    binary_license: "GPL-3.0-or-later",
    corresponding_source: "included",
    files: payload
      .map((entry) => ({
        path: entry.name.slice(packageRoot.length + 1),
        size_bytes: entry.data.byteLength,
        sha256: sha256(entry.data),
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
  const manifestEntry = fileEntry(
    `${packageRoot}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  payload.push(manifestEntry);
  const checksums = payload
    .map(
      (entry) =>
        `${sha256(entry.data)}  ${entry.name.slice(packageRoot.length + 1)}`,
    )
    .sort((left, right) => left.localeCompare(right, "en"))
    .join("\n");
  payload.push(
    fileEntry(`${packageRoot}/SHA256SUMS`, `${checksums}\n`),
  );

  const archive = createDeterministicTarGzip(payload);
  await writeNewFile(outputPath, archive);
  return {
    outputPath,
    bytes: archive.byteLength,
    sha256: sha256(archive),
    target: report.target,
  };
}

function usage() {
  process.stderr.write(
    "usage: node adapters/libredwg/package.mjs " +
      "--adapter ABSOLUTE_PATH --libredwg-source ABSOLUTE_PATH " +
      "--output NEW_ABSOLUTE_PATH.tar.gz\n",
  );
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      !value ||
      (flag !== "--adapter" &&
        flag !== "--libredwg-source" &&
        flag !== "--output")
    ) {
      return undefined;
    }
    parsed[flag] = value;
  }
  if (
    Object.keys(parsed).length !== 3 ||
    !parsed["--adapter"] ||
    !parsed["--libredwg-source"] ||
    !parsed["--output"]
  ) {
    return undefined;
  }
  return parsed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    usage();
    process.exitCode = 2;
  } else {
    createLibreDwgPackage({
      adapterPath: path.resolve(args["--adapter"]),
      sourceArchive: path.resolve(args["--libredwg-source"]),
      outputPath: path.resolve(args["--output"]),
    })
      .then((result) => {
        process.stdout.write(
          `${JSON.stringify({
            schema: PACKAGE_SCHEMA,
            status: "ok",
            bytes: result.bytes,
            sha256: result.sha256,
            target: result.target,
          })}\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(
          `cannot package LibreDWG adapter: ${error.message}\n`,
        );
        process.exitCode = 1;
      });
  }
}
