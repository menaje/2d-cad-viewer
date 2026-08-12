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
  assert.match(notice, /Copyright 2026 2d-cad-viewer contributors/u);
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

test("uses native Windows isolation and an inherited input handle", async () => {
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
  assert.match(adapterSource, /K32GetProcessMemoryInfo/u);
  assert.match(adapterSource, /PeakWorkingSetSize/u);
  assert.match(adapterSource, /counters\.WorkingSetSize/u);
  assert.match(adapterSource, /PeakPagefileUsage/u);
  assert.match(adapterSource, /counters\.PrivateUsage/u);
  assert.match(adapterSource, /GetProcessIoCounters/u);
  assert.match(adapterSource, /parse_working_set_bytes/u);
  assert.match(adapterSource, /parse_private_bytes/u);
  assert.match(adapterSource, /parse_peak_private_bytes/u);
  assert.match(adapterSource, /peak_private_bytes/u);
  assert.match(hostSource, /openWindowsInput/u);
  assert.match(hostSource, /windowsChildPath/u);
  assert.match(
    hostSource,
    /inheritedInput \? inheritedInput\.handle\.fd : "ignore"/u,
  );
  assert.match(
    hostSource,
    /DWG_VIEWER_INPUT_TRANSPORT:[\s\S]*"inherited-file-handle"/u,
  );
  assert.match(hostSource, /adapterInputPath = "-"/u);
  assert.doesNotMatch(hostSource, /stageWindowsInput|copyFile\(|stagedPath/u);
  assert.match(
    sceneCacheSource,
    /block->blkisxref\s*\|\| \(block->xref_pname/u,
  );
});

test("streams merged spatial runs directly into the GPU section encoder", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );
  const mergeFunction = sceneCacheSource.match(
    /merge_spatial_sort_runs \([\s\S]*?\n\}/u,
  );
  const storeBuilder = sceneCacheSource.match(
    /build_spatial_segment_store \([\s\S]*?\n\}/u,
  );

  assert.ok(mergeFunction, "spatial run merge is missing");
  assert.match(
    sceneCacheSource,
    /#define SPATIAL_MERGE_BUFFER_RECORDS 64u/u,
  );
  assert.match(
    sceneCacheSource,
    /random_access \? FILE_FLAG_RANDOM_ACCESS[\s\S]*?FILE_FLAG_SEQUENTIAL_SCAN/u,
  );
  assert.match(mergeFunction[0], /LineSegmentConsumer consumer/u);
  assert.match(
    mergeFunction[0],
    /consumer \(consumer_context,[\s\S]*?\.segment\)/u,
  );
  assert.doesNotMatch(mergeFunction[0], /fwrite|FILE \*output/u);
  assert.ok(storeBuilder, "spatial run store builder is missing");
  assert.equal(
    storeBuilder[0].match(/open_spatial_run_file/g)?.length,
    1,
  );
  assert.match(storeBuilder[0], /store->runs = builder\.runs/u);
  assert.doesNotMatch(storeBuilder[0], /sorted_file/u);
});

test("writes full-cache GPU vertices directly into the final cache", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );
  const gpuWriter = sceneCacheSource.match(
    /write_gpu_sections \([\s\S]*?\n\}/u,
  );

  assert.ok(gpuWriter, "GPU section writer is missing");
  assert.match(gpuWriter[0], /int split_output/u);
  assert.match(gpuWriter[0], /int direct_output/u);
  assert.match(gpuWriter[0], /batch_writer = &staging_writer/u);
  assert.match(gpuWriter[0], /vertex_writer = writer/u);
  assert.match(gpuWriter[0], /\*prefix_file = staging_file/u);
  assert.match(
    sceneCacheSource,
    /if \(group == 3u\)[\s\S]*?tasks\[group\]\.file = writer->file;[\s\S]*?tasks\[group\]\.direct_output = 1;/u,
  );
  assert.match(
    sceneCacheSource,
    /if \(tasks\[group\]\.direct_output\)\s*continue;/u,
  );
});

test("serializes sparse viewport layer overrides in Scene Cache v1.26", async () => {
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
    /LIBREDWG_SCENE_CACHE_VERSION_MINOR 26u/u,
  );
  assert.match(
    sceneCacheHeader,
    /LIBREDWG_SCENE_SECTION_COUNT 51/u,
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

test("preserves saved presentation controls and XREF load state", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  for (const setting of [
    "ATTMODE",
    "IMAGEFRAME",
    "XCLIPFRAME",
    "OLEFRAME",
    "ANNOALLVISIBLE",
    "MSLTSCALE",
    "CANNOSCALE",
    "PDFFRAME",
    "DWFFRAME",
    "DGNFRAME",
  ]) {
    assert.match(sceneCacheSource, new RegExp(setting, "u"));
  }
  assert.match(
    sceneCacheSource,
    /copy_variable_dictionary_value[\s\S]*?copy_versioned_text/u,
  );
  assert.match(
    sceneCacheSource,
    /model_annotation_scale[\s\S]*?copy_variable_dictionary_value \(dwg, "CANNOSCALE"\)/u,
  );
  assert.match(sceneCacheSource, /block->xref_loaded/u);
  assert.match(sceneCacheSource, /block->is_xref_resolved/u);
  assert.match(
    sceneCacheSource,
    /tables->presentation_settings >> 6/u,
  );
  assert.match(sceneCacheSource, /AcadAnnoAV/u);
  assert.match(
    sceneCacheSource,
    /eed->data->code != 70u[\s\S]*?eed->data->u\.eed_70\.rs/u,
  );
  assert.match(
    sceneCacheSource,
    /write_u16 \(writer, annotation_all_visible\)/u,
  );
  assert.match(
    sceneCacheSource,
    /has_layout_annotation_all_visible\s*\? layout_annotation_all_visible\s*:\s*1u/u,
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

test("expands rectangular INSERT clips before transforming them", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  assert.match(
    sceneCacheSource,
    /serialized_insert_clip_vertex_count[\s\S]*?filter->num_clip_verts == 2[\s\S]*?\? 4u/u,
  );
  assert.match(
    sceneCacheSource,
    /insert_clip_source_vertex[\s\S]*?minimum_x[\s\S]*?maximum_y/u,
  );
  assert.match(
    sceneCacheSource,
    /insert_clip_source_vertex \([\s\S]*?local_x = inverse\[0\]/u,
  );
  assert.doesNotMatch(
    sceneCacheSource,
    /flags = vertex_count == 2 \? 1u : 0u/u,
  );
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

test("reflects clockwise HATCH curve angles into the OCS math basis", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );
  const parameterNormalization = sceneCacheSource.match(
    /hatch_curve_parameters \([\s\S]*?\n\}/u,
  );

  assert.ok(parameterNormalization, "HATCH curve normalization is missing");
  assert.match(
    parameterNormalization[0],
    /if \(!is_ccw\)[\s\S]*?start = -start;[\s\S]*?end = -end;[\s\S]*?normalized_curve_sweep \(end, start, &magnitude\)/u,
  );
  assert.match(
    parameterNormalization[0],
    /\*first = start;[\s\S]*?\*sweep = -magnitude;[\s\S]*?return 1;/u,
  );
  assert.match(
    parameterNormalization[0],
    /\*first = start;[\s\S]*?normalized_curve_sweep \(start, end, sweep\)/u,
  );
});

test("applies the pinned LibreDWG patches to every converter build", async () => {
  const [
    packageSource,
    prepareScript,
    wasmBuildScript,
    acdsPatchSource,
    highCompressionPatchSource,
    seekableStdinPatchSource,
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
      readFile(
        path.join(import.meta.dirname, "libredwg-seekable-stdin.patch"),
        "utf8",
      ),
    ]);

  assert.match(packageSource, /"libredwg-acds-sab\.patch"/u);
  assert.match(
    packageSource,
    /"libredwg-r2007-high-compression\.patch"/u,
  );
  assert.match(packageSource, /"libredwg-seekable-stdin\.patch"/u);
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
  assert.match(prepareScript, /libredwg-seekable-stdin\.patch/u);
  assert.match(wasmBuildScript, /libredwg-seekable-stdin\.patch/u);
  assert.match(
    prepareScript,
    /command -v sha256sum[\s\S]*command -v shasum/u,
  );
  assert.match(prepareScript, /if \[ "\$jobs" -gt 8 \]/u);
  assert.match(acdsPatchSource, /ACIS BinaryFile/u);
  assert.match(acdsPatchSource, /ASM BinaryFile/u);
  assert.match(acdsPatchSource, /sol->sab_size/u);
  assert.match(
    highCompressionPatchSource,
    /MAX_R2007_SECTION_DECOMP_SIZE/u,
  );
  assert.match(highCompressionPatchSource, /section->data_size > MAX_/u);
  assert.match(seekableStdinPatchSource, /seekable_stdin/u);
  assert.match(seekableStdinPatchSource, /S_ISREG \(attrib\.st_mode\)/u);
  assert.match(seekableStdinPatchSource, /dat_read_file/u);
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

test("uses the BLOCK entity name for current paper layout identity", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  assert.match(
    sceneCacheSource,
    /copy_block_name[\s\S]*?block->block_entity[\s\S]*?DWG_TYPE_BLOCK[\s\S]*?"BLOCK", "name"/u,
  );
  assert.match(
    sceneCacheSource,
    /entry->name = copy_block_name \([\s\S]*?BLOCK_HEADER\);/u,
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
  assert.match(
    sceneCacheSource,
    /iterate_proxy_graphic_segments[\s\S]*?!proxy_graphic_has_supported_display \(object\)[\s\S]*?return 1;/u,
  );
  assert.doesNotMatch(sceneCacheSource, /TextSourceList/u);
  assert.match(sceneCacheHeader, /uint64_t proxy_graphics;/u);
  assert.match(adapterSource, /proxy_graphics/u);
  assert.match(sceneCacheHeader, /uint64_t unsupported_underlays;/u);
  assert.match(sceneCacheHeader, /uint64_t unsupported_proxy_graphics;/u);
  assert.match(sceneCacheHeader, /uint64_t unsupported_3d_entities;/u);
  assert.ok(adapterSource.includes('\\"deferred_reasons\\"'));
  assert.ok(adapterSource.includes('\\"proxyshow\\":1'));
  assert.match(
    adapterSource,
    /\[6,7,14,18,22,23,29,30,31,32,38\]/u,
  );
  assert.match(
    adapterSource,
    /object->klass && object->klass->dxfname/u,
  );
});

test("serializes pre-R13 simple linetype dashes without dereferencing modern records", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  assert.match(
    sceneCacheSource,
    /serialized_linetype_dash_count[\s\S]*?header\.version < R_13b1[\s\S]*?count > 12u/u,
  );
  assert.match(
    sceneCacheSource,
    /linetype->dashes_r11\[dash_index\]/u,
  );
  assert.match(
    sceneCacheSource,
    /dwg->header\.version < R_13b1[\s\S]*?texts\[cursor\] = strdup \(""\)/u,
  );
});

test("preserves qualified MLINE fills and fails closed on fill cuts", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  assert.match(
    sceneCacheSource,
    /write_mline_fill_records[\s\S]*?style->flag & 1u/u,
  );
  assert.match(
    sceneCacheSource,
    /write_mline_fill_segment[\s\S]*?parameter_count != 0u/u,
  );
  assert.doesNotMatch(
    sceneCacheSource,
    /write_mline_fill_segment[\s\S]*?areafillparms\[/u,
  );
  assert.match(
    sceneCacheSource,
    /write_solid_surface_record[\s\S]*?&style->fill_color/u,
  );
  assert.match(
    sceneCacheSource,
    /write_mline_round_fill_cap[\s\S]*?const size_t chords = 12u/u,
  );
  assert.match(
    sceneCacheSource,
    /SOLID\/MLINE fill source exceeds its record limit/u,
  );
  assert.match(
    sceneCacheSource,
    /MLINE area-fill boundary is unsupported or incomplete/u,
  );
});

test("preserves HATCH background TrueColor from its named application data", async () => {
  const sceneCacheSource = await readFile(
    path.join(import.meta.dirname, "libredwg_scene_cache.c"),
    "utf8",
  );

  assert.match(sceneCacheSource, /HATCHBACKGROUNDCOLOR/u);
  assert.match(
    sceneCacheSource,
    /eed->data->code != 71u[\s\S]*?0x00ffffffu/u,
  );
  assert.match(sceneCacheSource, /HATCH_FLAG_BACKGROUND_COLOR/u);
  assert.match(sceneCacheSource, /write_u32 \(writer, background_color\)/u);
});
