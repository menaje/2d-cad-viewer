// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createDeterministicTarGzip,
  GPL_3_0_SHA256,
  licenseExtractionArguments,
  LIBREDWG_SOURCE_SHA256,
  LIBREDWG_VERSION,
  MPL_2_0_SHA256,
} from "./package.mjs";

const execFileAsync = promisify(execFile);

test("pins the unmodified official MPL text and separate project notice", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
  const [license, notice] = await Promise.all([
    readFile(path.join(repositoryRoot, "LICENSE")),
    readFile(path.join(repositoryRoot, "NOTICE"), "utf8"),
  ]);

  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    MPL_2_0_SHA256,
  );
  assert.match(notice, /Copyright 2026 dwg-viewer contributors/u);
});

test("pins the unmodified GPLv3 text conveyed with LibreDWG", async () => {
  const license = await readFile(
    path.join(
      path.resolve(import.meta.dirname, "..", ".."),
      "apps",
      "vscode-libredwg-adapter",
      "LICENSE.txt",
    ),
  );
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    GPL_3_0_SHA256,
  );
});

test("creates a deterministic archive with fixed paths and executable modes", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dwg-adapter-package-test-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "adapter.tar.gz");
  const files = [
    {
      name: "package/bin/libredwg-adapter",
      data: Buffer.from("binary"),
      mode: 0o755,
    },
    {
      name: "package/source/README.txt",
      data: Buffer.from("source"),
      mode: 0o644,
    },
  ];
  const first = createDeterministicTarGzip(files);
  const second = createDeterministicTarGzip([...files].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(4), 0);
  assert.equal(first[9], 255);
  await writeFile(archivePath, first);

  const listing = await execFileAsync(
    "tar",
    ["-tvzf", archivePath],
    { encoding: "utf8" },
  );
  assert.match(
    listing.stdout,
    /-rwxr-xr-x.*package\/bin\/libredwg-adapter/u,
  );
  assert.match(
    listing.stdout,
    /-rw-r--r--.*package\/source\/README\.txt/u,
  );
  assert.doesNotMatch(listing.stdout, /\/private\/|\/Users\//u);
});

test("rejects traversal, absolute, backslash, and duplicate archive paths", () => {
  for (const name of [
    "../escape",
    "/absolute",
    "folder\\windows",
  ]) {
    assert.throws(
      () =>
        createDeterministicTarGzip([
          { name, data: Buffer.alloc(0), mode: 0o644 },
        ]),
      /unsafe archive path/u,
    );
  }
  assert.throws(
    () =>
      createDeterministicTarGzip([
        { name: "same", data: Buffer.alloc(0), mode: 0o644 },
        { name: "same", data: Buffer.alloc(0), mode: 0o644 },
      ]),
    /duplicate archive path/u,
  );
});

test("forces local GNU tar handling for Windows drive archives", () => {
  assert.deepEqual(
    licenseExtractionArguments(
      String.raw`D:\a\_temp\libredwg-0.14.tar.xz`,
      "win32",
    ),
    [
      "--force-local",
      "-xOf",
      "D:/a/_temp/libredwg-0.14.tar.xz",
      "libredwg-0.14/COPYING",
    ],
  );
  assert.deepEqual(
    licenseExtractionArguments("/tmp/libredwg-0.14.tar.xz", "linux"),
    [
      "-xOf",
      "/tmp/libredwg-0.14.tar.xz",
      "libredwg-0.14/COPYING",
    ],
  );
});

test("bounds the expanded Windows PE dependency audit", async () => {
  const packageSource = await readFile(
    path.join(import.meta.dirname, "package.mjs"),
    "utf8",
  );
  assert.match(
    packageSource,
    /const MAX_DEPENDENCY_AUDIT_BYTES = 32 \* 1024 \* 1024;/u,
  );
  assert.match(
    packageSource,
    /maxBuffer: MAX_DEPENDENCY_AUDIT_BYTES,/u,
  );
  assert.match(packageSource, /timeout: 30_000,/u);
});

test("keeps package and source preparation pins synchronized", async () => {
  const [prepareScript, buildScript, nativeEngineSource] = await Promise.all([
    readFile(path.join(import.meta.dirname, "prepare.sh"), "utf8"),
    readFile(path.join(import.meta.dirname, "build.sh"), "utf8"),
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "apps",
        "vscode-extension",
        "src",
        "native-cache.ts",
      ),
      "utf8",
    ),
  ]);
  assert.match(
    prepareScript,
    new RegExp(`LIBREDWG_VERSION=${LIBREDWG_VERSION.replace(".", "\\.")}`, "u"),
  );
  assert.match(
    prepareScript,
    new RegExp(`LIBREDWG_SHA256=${LIBREDWG_SOURCE_SHA256}`, "u"),
  );
  assert.match(prepareScript, /--disable-shared/u);
  assert.match(prepareScript, /--enable-static/u);
  assert.match(
    buildScript,
    new RegExp(`LIBREDWG_VERSION=${LIBREDWG_VERSION.replace(".", "\\.")}`, "u"),
  );
  assert.match(buildScript, /--exact-version="\$LIBREDWG_VERSION"/u);
  assert.match(buildScript, /static_library=.*libredwg\.a/u);
  assert.match(buildScript, /"\$static_library" -lm/u);
  assert.match(buildScript, /MINGW\*.*MSYS\*.*CYGWIN\*/u);
  assert.match(buildScript, /-static -static-libgcc/u);
  assert.match(buildScript, /"\$strip" "\$output"/u);
  assert.match(
    nativeEngineSource,
    new RegExp(
      `LIBREDWG_NATIVE_ENGINE_VERSION = "${LIBREDWG_VERSION.replace(".", "\\.")}"`,
      "u",
    ),
  );
});

test("uses native Windows isolation and a path-safe piped input contract", async () => {
  const [adapterSource, sceneCacheSource, hostSource] = await Promise.all([
    readFile(
      path.join(import.meta.dirname, "libredwg_adapter.c"),
      "utf8",
    ),
    readFile(
      path.join(import.meta.dirname, "libredwg_scene_cache.c"),
      "utf8",
    ),
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "apps",
        "vscode-extension",
        "src",
        "native-cache.ts",
      ),
      "utf8",
    ),
  ]);
  assert.match(adapterSource, /DWG_VIEWER_NULL_DEVICE "NUL"/u);
  assert.match(adapterSource, /QueryPerformanceCounter/u);
  assert.match(adapterSource, /DWG_VIEWER_STDIN_SOURCE_SIZE/u);
  assert.match(
    adapterSource,
    /_setmode \(_fileno \(stdin\), _O_BINARY\)/u,
  );
  assert.match(adapterSource, /dwg_read_file \(path, dwg\)/u);
  assert.match(sceneCacheSource, /CreateFileW/u);
  assert.match(sceneCacheSource, /FILE_FLAG_DELETE_ON_CLOSE/u);
  assert.match(sceneCacheSource, /_O_NOINHERIT/u);
  assert.match(sceneCacheSource, /_lseeki64/u);
  assert.match(hostSource, /adapterInputPath = "-"/u);
  assert.match(hostSource, /windowsChildPath/u);
  assert.match(hostSource, /createReadStream\(inputPath\)/u);
});

test("serializes sparse viewport layer overrides in Scene Cache v1.21", async () => {
  const [sceneCacheSource, sceneCacheHeader] = await Promise.all([
    readFile(
      path.join(import.meta.dirname, "libredwg_scene_cache.c"),
      "utf8",
    ),
    readFile(
      path.join(import.meta.dirname, "libredwg_scene_cache.h"),
      "utf8",
    ),
  ]);

  assert.match(
    sceneCacheHeader,
    /LIBREDWG_SCENE_CACHE_VERSION_MINOR 21u/u,
  );
  assert.match(
    sceneCacheHeader,
    /LIBREDWG_SCENE_SECTION_COUNT 49/u,
  );
  assert.match(
    sceneCacheSource,
    /SECTION_VIEWPORT_LAYER_OVERRIDES = 58/u,
  );
  for (const key of [
    "ADSK_XREC_LAYER_COLOR_OVR",
    "ADSK_XREC_LAYER_ALPHA_OVR",
    "ADSK_XREC_LAYER_LINETYPE_OVR",
    "ADSK_XREC_LAYER_LINEWT_OVR",
  ]) {
    assert.match(sceneCacheSource, new RegExp(key, "u"));
  }
  assert.match(sceneCacheSource, /item->type == 335/u);
  assert.match(sceneCacheSource, /"viewport_layer_overrides"/u);
  assert.match(
    sceneCacheSource,
    /write_viewport_layer_override_section \(\s*&writer, dwg, tables, &sections\[46\]\)/u,
  );
});

test("extracts bounded bitmap and composite EMF previews from OLE frames", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  assert.match(sceneCacheSource, /MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD/u);
  assert.match(sceneCacheSource, /MAX_EMBEDDED_EMF_RECORDS 200000u/u);
  assert.match(sceneCacheSource, /MAX_EMBEDDED_WMFC_CHUNKS 65536u/u);
  assert.match(sceneCacheSource, /reconstruct_wmfc_emf/u);
  assert.match(sceneCacheSource, /validate_embedded_emf/u);
  assert.match(sceneCacheSource, /identifier != 0x43464d57u/u);
  assert.match(sceneCacheSource, /signature != 0x464d4520u/u);
  assert.match(
    sceneCacheSource,
    /frame->data\[0\] == 0x80u \|\| frame->data\[0\] == 0x81u/u,
  );
  assert.match(sceneCacheSource, /EMBEDDED_IMAGE_MIME_EMF = 2u/u);
  assert.match(
    sceneCacheSource,
    /write_embedded_image_record_section \([\s\S]*?&task->sections\[47\]/u,
  );
  assert.match(
    sceneCacheSource,
    /write_embedded_image_byte_section \([\s\S]*?&task->sections\[48\]/u,
  );
});

test("keeps Windows in the reproducible attested release set", async () => {
  const [releaseWorkflow, distributionGuide] = await Promise.all([
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        ".github",
        "workflows",
        "release.yml",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "docs",
        "distribution.md",
      ),
      "utf8",
    ),
  ]);
  assert.match(releaseWorkflow, /runner: windows-2025/u);
  assert.match(releaseWorkflow, /target: win32-x64/u);
  assert.match(
    releaseWorkflow,
    /dwg-viewer-libredwg-0\.14-win32-x64\.tar\.gz/u,
  );
  assert.match(
    releaseWorkflow,
    /Build, diagnose, reproduce, and verify Windows package/u,
  );
  assert.match(distributionGuide, /Windows native-path/u);
  assert.doesNotMatch(
    distributionGuide,
    /Windows artifacts are not published/u,
  );
});

test("builds Intel macOS converter artifacts on the standard x64 runner", async () => {
  const [releaseWorkflow, qualificationWorkflow, distributionGuide] =
    await Promise.all([
      readFile(
        path.join(
          import.meta.dirname,
          "..",
          "..",
          ".github",
          "workflows",
          "release.yml",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          import.meta.dirname,
          "..",
          "..",
          ".github",
          "workflows",
          "libredwg-adapter.yml",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          import.meta.dirname,
          "..",
          "..",
          "docs",
          "distribution.md",
        ),
        "utf8",
      ),
    ]);
  for (const workflow of [releaseWorkflow, qualificationWorkflow]) {
    assert.match(workflow, /runner: macos-15-intel/u);
    assert.match(workflow, /target: darwin-x64/u);
  }
  assert.match(
    releaseWorkflow,
    /dwg-viewer-libredwg-0\.14-darwin-x64\.tar\.gz/u,
  );
  assert.match(distributionGuide, /macOS Intel\s+x64/u);
});

test("normalizes legacy inspection text before corpus metrics", async () => {
  const adapterSource = await readFile(
    path.join(import.meta.dirname, "libredwg_adapter.c"),
    "utf8",
  );
  assert.match(
    adapterSource,
    /inspect_text_entity \(const Dwg_Data \*dwg,/u,
  );
  assert.match(
    adapterSource,
    /converted = bit_TV_to_utf8 \(text, dwg->header\.codepage\);/u,
  );
  assert.match(
    adapterSource,
    /text_include \(summary, source\);/u,
  );
});

test("stores SOLID quadrilaterals in perimeter order", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );
  const mapping = sceneCacheSource.match(
    /AutoCAD records the third SOLID corner[\s\S]*?for \(corner_index = 0; corner_index < 4; corner_index\+\+\)/u,
  );

  assert.ok(mapping, "SOLID corner mapping is missing");
  assert.match(mapping[0], /corners\[2\]\[0\] = solid->corner4\.x;/u);
  assert.match(mapping[0], /corners\[2\]\[1\] = solid->corner4\.y;/u);
  assert.match(mapping[0], /corners\[3\]\[0\] = solid->corner3\.x;/u);
  assert.match(mapping[0], /corners\[3\]\[1\] = solid->corner3\.y;/u);
});

test("uses denser bounded chords for HATCH curves without bloating standalone previews", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  assert.match(
    sceneCacheSource,
    /#define MAX_CIRCULAR_SEGMENTS 16u/u,
  );
  assert.match(
    sceneCacheSource,
    /#define MAX_HATCH_CIRCULAR_SEGMENTS 64u/u,
  );
  assert.match(
    sceneCacheSource,
    /#define HATCH_SPLINE_SEGMENTS_PER_SPAN 8u/u,
  );
  assert.match(
    sceneCacheSource,
    /iterate_hatch_polyline_path[\s\S]*?hatch_bulge_segment_count \(bulge\)/u,
  );
  assert.match(
    sceneCacheSource,
    /iterate_hatch_edge[\s\S]*?hatch_curve_segment_count \(sweep\)/u,
  );
  assert.match(
    sceneCacheSource,
    /read_hatch_fit_sampling[\s\S]*?HATCH_SPLINE_SEGMENTS_PER_SPAN/u,
  );
  assert.match(
    sceneCacheSource,
    /evaluate_hatch_fit_boundary[\s\S]*?start_tangent_basis[\s\S]*?end_tangent_basis/u,
  );
  assert.match(
    sceneCacheSource,
    /hatch_fit_explicit_tangent \([\s\S]*?segment->start_tangent[\s\S]*?segment->end_tangent/u,
  );
});

test("applies the pinned LibreDWG patches to every converter build", async () => {
  const [
    packageSource,
    prepareScript,
    wasmBuildScript,
    acdsPatchSource,
    highCompressionPatchSource,
  ] = await Promise.all([
      readFile(path.join(import.meta.dirname, "package.mjs"), "utf8"),
      readFile(path.join(import.meta.dirname, "prepare.sh"), "utf8"),
      readFile(
        path.join(import.meta.dirname, "wasm", "build.sh"),
        "utf8",
      ),
      readFile(
        path.join(import.meta.dirname, "libredwg-acds-sab.patch"),
        "utf8",
      ),
      readFile(
        path.join(
          import.meta.dirname,
          "libredwg-r2007-high-compression.patch",
        ),
        "utf8",
      ),
    ]);

  assert.match(packageSource, /"libredwg-acds-sab\.patch"/u);
  assert.match(
    packageSource,
    /"libredwg-r2007-high-compression\.patch"/u,
  );
  assert.match(
    prepareScript,
    /patch_tool=\$\{DWG_VIEWER_PATCH:-patch\}/u,
  );
  assert.match(
    prepareScript,
    /"\$patch_tool" --batch --forward -d "\$libredwg_source" -p1/u,
  );
  assert.match(
    wasmBuildScript,
    /patch --batch --forward -d "libredwg-\$LIBREDWG_VERSION" -p1/u,
  );
  assert.match(prepareScript, /libredwg-r2007-high-compression\.patch/u);
  assert.match(wasmBuildScript, /libredwg-r2007-high-compression\.patch/u);
  assert.match(acdsPatchSource, /ACIS BinaryFile/u);
  assert.match(acdsPatchSource, /ASM BinaryFile/u);
  assert.match(acdsPatchSource, /sol->sab_size/u);
  assert.match(
    highCompressionPatchSource,
    /MAX_R2007_SECTION_DECOMP_SIZE/u,
  );
  assert.match(highCompressionPatchSource, /section->data_size > MAX_/u);
});

test("rejects a silent LibreDWG parse that contains no drawing objects", async () => {
  const adapterSource = await readFile(
    path.join(import.meta.dirname, "libredwg_adapter.c"),
    "utf8",
  );

  assert.equal(
    adapterSource.match(/dwg\.num_objects == 0/gu)?.length,
    2,
  );
  assert.equal(
    adapterSource.match(/LibreDWG parse produced no drawing objects/gu)
      ?.length,
    2,
  );
});

test("streams bounded proxy table graphics into lines and UTF-8 text", async () => {
  const [adapterSource, sceneCacheSource, sceneCacheHeader] =
    await Promise.all([
      readFile(
        path.join(import.meta.dirname, "libredwg_adapter.c"),
        "utf8",
      ),
      readFile(
        path.join(import.meta.dirname, "libredwg_scene_cache.c"),
        "utf8",
      ),
      readFile(
        path.join(import.meta.dirname, "libredwg_scene_cache.h"),
        "utf8",
      ),
    ]);

  assert.match(
    sceneCacheSource,
    /#define MAX_PROXY_GRAPHIC_BYTES \(64u \* 1024u \* 1024u\)/u,
  );
  assert.match(
    sceneCacheSource,
    /next_proxy_graphic_chunk[\s\S]*?chunk_size < 8u[\s\S]*?chunk_size & 3u/u,
  );
  assert.match(
    sceneCacheSource,
    /PROXY_GRAPHIC_POLYLINE_WITH_NORMALS = 32/u,
  );
  assert.match(
    sceneCacheSource,
    /PROXY_GRAPHIC_UNICODE_TEXT2 = 38/u,
  );
  assert.match(sceneCacheSource, /proxy_read_utf16_string/u);
  assert.match(sceneCacheSource, /iterate_proxy_graphic_segments/u);
  assert.match(sceneCacheSource, /for_each_scene_text_source/u);
  assert.doesNotMatch(sceneCacheSource, /TextSourceList/u);
  assert.match(sceneCacheHeader, /uint64_t proxy_graphics;/u);
  assert.match(adapterSource, /proxy_graphics/u);
  assert.match(
    adapterSource,
    /object->klass && object->klass->dxfname/u,
  );
});
