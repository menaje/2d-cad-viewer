# DWG engine decision

Status: accepted on 2026-07-31

Scope: open-source local DWG parsing and Scene Cache conversion

Decision: select GNU LibreDWG 0.14

## Decision

GNU LibreDWG 0.14 is the primary parser and converter for continued product
development. It is the only measured candidate that satisfies both the
large-drawing conversion target and hard limits while preserving the required
logical entities, blocks and Korean text.

`acadrust` 0.4.1 was used during the original comparison but exceeded the
memory hard limit. Its parser, writer and dependency have since been retired
and removed from the repository.

ACadSharp 3.6.51 is rejected for the large-drawing path. Its inspect-only
adapter is retained so the result can be reproduced, but a second Scene Cache
writer will not be implemented: parsing alone already exceeds the memory hard
limit, so adding a writer cannot make the candidate eligible.

Selection does not mean that the viewer is feature-complete. The follow-on
WIPEOUT milestone preserves every logical source entity in the reference
drawing. Scene Cache v1.11 also preserves the complete `SORTENTSTABLE` source
needed for correct masking, but block-local/nested ordering, background
composition and exact CAD text layout remain product work on the LibreDWG
path rather than reasons to keep the engine choice open.

## Reproducible evidence

All measurements used macOS arm64, one excluded warmup and three fresh measured
processes with the operating-system file cache left at its default. Reports
exclude the input name, drawing text, diagnostic messages, block names and
absolute coordinates. Private reports remain under the ignored
`benchmarks/results/` directory.

| Candidate | Measured phase | Wall min / median / max | Peak RSS min / median / max | Result |
| --- | --- | ---: | ---: | --- |
| LibreDWG 0.14 | Scene Cache v1.7 conversion | 2,930 / 2,941 / 2,957 ms | 591,560,704 / 591,659,008 / 591,740,928 B | pass |
| LibreDWG 0.14 | Scene Cache v1.10 conversion | 2,880 / 2,886 / 2,890 ms | 591,691,776 / 591,724,544 / 591,724,544 B | pass |
| LibreDWG 0.14 | Scene Cache v1.11 conversion | 2,983 / 2,999 / 3,009 ms | 591,773,696 / 591,822,848 / 591,822,848 B | pass |
| acadrust 0.4.1 | Scene Cache v1.7 conversion | 7,556 / 7,642 / 7,904 ms | 968,900,608 / 969,310,208 / 969,392,128 B | memory hard fail |
| ACadSharp 3.6.51 | parser inspection preflight | 4,012 / 4,014 / 4,098 ms | 1,441,251,328 / 1,452,392,448 / 1,452,474,368 B | memory hard fail |

ACadSharp's wall value is not a conversion comparison. The inspection phase
loads and normalizes the managed document model but does not write a cache.
Its memory result is sufficient for rejection because parsing is a mandatory
subset of conversion. The benchmark runner now records that case as
`hard_fail`; an inspect-only candidate below the hard limit would remain
`incomplete` until conversion was measured.

The ACadSharp adapter uses the exact, locked 3.6.51 NuGet package published on
2026-07-29. Its normalized output matches the 378,400 logical entity count,
entity-type histogram, 724 blocks, 3,659 block references, 234 layers, 30 text
styles, bounds presence and Korean text fingerprint: 690 text records contain
2,674 Hangul characters, with no NUL, U+FFFD or question-mark corruption
markers. Its non-entity object count is 3,570 rather than the reference 3,933,
so that part of the object model is not considered equivalent. This mismatch
does not affect the memory rejection.

LibreDWG's v1.7 writer produces a deterministic 175,985,184-byte valid cache.
It preserves 377,208 of 378,400 logical source entities (99.68%), the complete
required Korean text fingerprint and the current line, curve, spline and HATCH
display paths. The first line frame range-reads 5,001,757 bytes including a
fixed 4 MiB overview rather than loading the complete cache.

The follow-on v1.8 writer adds 621 POINT and 350 SOLID records and raises
coverage to 378,179 of 378,400 entities (99.94%). Its deterministic
176,113,616-byte cache measured 2,986 ms median conversion wall time and
591,511,552 bytes median peak RSS; maximums were 3,028 ms and 592,150,528
bytes. It therefore preserves the engine-selection result while reducing the
deferred count from 1,192 to 221.

The DIMENSION follow-on reuses the unchanged v1.8 kind-13 block-instance
record. All 171 picture-block references in the reference drawing resolve,
raising coverage to 378,350 of 378,400 entities (99.99%) and reducing the
deferred count to 50. The deterministic cache grows by exactly 23,256 bytes
to 176,136,872 bytes; the GPU batch and vertex sections are byte-identical to
the preceding cache. Three isolated measured conversions completed in
2,921 / 3,215 / 3,860 ms with 590,036,992 / 591,691,776 / 591,708,160 bytes
peak RSS (minimum / median / maximum). Output was deterministic and both gates
passed, so the extra bounded lookup and stream pass do not change the
engine-selection result.

The first-frame reader still performs eight reads. Metadata grows by the same
23,256 bytes, from 5,001,837 to 5,025,093 bytes including the unchanged 4 MiB
overview. Nested ownership expands the 171 source references into 2,668
direct picture occurrences and 380 downstream nested instances; the total
instance graph grows from 94,814 to 97,862 matrices, or 390,144 packed bytes.
A local Node qualification completed the path in 345.6 ms at about 123 MB
process RSS. An actual Chromium run produced the first usable line frame in
450.0 ms with the same 4.57 MiB GPU vertex footprint and no console warning or
error.

Scene Cache v1.9 adds kind 41 without changing any preceding section layout.
Kinds 2–40 remain byte-identical; only the kind-1 serialized-entity count
changes. All 34 3DFACE records in the reference drawing are preserved,
raising coverage to 378,384 of 378,400 entities (99.996%) and reducing
deferred entities to the 16 WIPEOUT records. The cache grows by 4,664 bytes to
176,141,536 bytes: 4,624 bytes of face records and one 40-byte directory
entry. Three clean
process-isolated conversions completed in 3,153 / 3,715 / 4,082 ms with
591,446,016 / 591,675,392 / 591,888,384 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both gates passed.

The first-frame reader still performs eight reads and does not touch kind 41.
Only the directory grows, so first-frame bytes increase by 40 from 5,025,093
to 5,025,133 while the 4 MiB overview is unchanged. The post-frame primitive
path reads 4,624 additional source bytes and adds 7,296 GPU bytes for 114
visible face edges; hidden and degenerate edges are omitted. An actual v1.9
Chromium run produced the first usable line frame in 464.0 ms, reported all
34 faces, used 4.58 MiB of GPU vertex buffers at drawing fit and emitted no
console warning or error.

Scene Cache v1.10 adds kinds 42–43 without changing kinds 2–41. It preserves
all 16 WIPEOUT records and 627 clip vertices in the reference drawing, growing
the deterministic cache by exactly 12,800 bytes to 176,154,336 bytes. Logical
source coverage reaches 378,400 of 378,400 with zero converter-deferred
entities. That is a source-preservation result: the 16 background masks remain
explicitly deferred because correct masking depends on block-local sort tables
and nested INSERT draw order. The drawing-wide frame setting is off, so no
WIPEOUT GPU vertices are generated for this drawing.

Three clean process-isolated v1.10 conversions completed in
2,880 / 2,886 / 2,890 ms with
591,691,776 / 591,724,544 / 591,724,544 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both target gates passed. The
first-frame path remains eight reads and grows only 80 bytes to 5,025,213
bytes; it reads neither WIPEOUT source section. The isolated primitive worker
uses nine bounded reads totaling 726,827 bytes. On the public
`example_2018.dwg` fixture, both engines produce byte-identical kinds 42–43
for two WIPEOUTs and 16 clip vertices plus the same frame setting. The enabled
public frames produce 16 edges in a 1,024-byte GPU payload.
An actual v1.10 Chromium run produced the reference drawing's first usable
line frame in 502.8 ms and reported all 16 source masks as deferred with no
console warning or error.

Scene Cache v1.11 adds kinds 44–45 for normalized draw-order tables and
entity/sort-handle pairs. The reference drawing contains 508 tables and
54,667 entries. Two directory entries, 20,320 table bytes and 874,672 entry
bytes grow the cache by exactly 895,072 bytes (0.51%) to 177,049,408 bytes;
kinds 1–43 remain byte-identical to v1.10. The archived cross-engine
qualification produced byte-identical kind-44 and kind-45 payloads.

Three isolated conversions completed in 2,983 / 2,999 / 3,009 ms with
591,773,696 / 591,822,848 / 591,822,848 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both target gates passed. Opening the
cache still uses two reads; the larger directory adds only 80 bytes. The
Webview does not read either draw-order body section until requested, at
which point two bounded reads total 894,992 bytes.

The completed mask stage combines those two reads with the already deferred
WIPEOUT entity/clip pools: four post-frame reads total 907,712 bytes. The 16
source masks expand through nested and array INSERTs to 2,206 order positions,
then triangulate to 590 triangles (55.3 KiB). A local qualification measured
about 13 ms for the order plan, 24 ms to attach bases while sharing the
existing 97,862 instance matrices, and 16.5 ms to patch the 131,072 overview
vertices in place.

An actual Chromium run reported a 459.7 ms first line frame, 41.0 ms for the
post-frame read/order/attachment stage, a 31.4 MB main-realm JS heap and
4.64 MiB of fitted-view GPU vertex buffers. At 5.95x zoom with the full
32 MiB detail cache selected, the reported JS heap was 148.4 MB and GPU vertex
buffers were 36.64 MiB. WebGL exposed a 24-bit depth buffer, returned no GL
error, and the console had no warning or error. The public fixture also
activates both naturally ordered WIPEOUTs as 12 triangles without requiring a
sort table.

A renderer-memory audit then replaced one `Float32Array` allocation per
instanced draw with a single 1.06 MiB bounded scratch buffer and exposed
current/peak heap and tracked WebGL counters. A repeat Chromium run produced a
517.4 ms first frame, 58.23 MiB fitted-view peak JavaScript heap and 4.64 MiB
tracked WebGL memory. At 5.95x zoom, 297 detail batches reached the intentional
32 MiB detail cap; peak JavaScript heap was 141.26 MiB and tracked WebGL memory
was 36.64 MiB. Returning to fit selected zero detail batches and reduced the
current heap to 44.66 MiB while retaining the bounded detail LRU. A separate
DevTools snapshot reported 20,761,368 bytes used heap, 22,401,296 bytes backing
storage and 4,621,392 bytes embedder heap after return. These counters remain
category measurements rather than a Chromium renderer-process RSS claim.
Console warnings/errors and the WebGL error flag remained zero.

The stable 0.14 release replaces the earlier 0.13.4 qualification pin. Its
normalized conversion report and cache are byte-identical to 0.13.4 on the
reference drawing, while median conversion wall time improves from 4,140 ms to
2,941 ms. The `0.14.xxxx` nightly tags are marked as prereleases and are not
used as a reproducible product dependency.

## Why LibreDWG

- It is the only candidate below the 600,000,000-byte target and
  800,000,000-byte hard limit.
- Its direct C-to-cache writer avoids a second full drawing object graph.
- Bounded repeated passes, 8,192-record sort runs and disk-backed Morton
  ordering keep conversion memory at the parser-dominated level.
- Korean strings and CP949 support are available in the native parse path,
  while SHX/BigFont glyph parsing stays lazy in the Webview.
- Public cross-engine fixtures validate all current HATCH modes and exact
  pattern-section payloads; POINT and SOLID sections also match byte for byte,
  both engines resolve all nine DIMENSION picture blocks in
  `example_2018.dwg`, and `2000/entities-3d.dwg` matches 3DFACE flags and WCS
  corners.

The memory margin to the 600,000,000-byte target is small. New LibreDWG
coverage must keep the current bounded streaming or disk-backed design; a
whole-drawing geometry array is not allowed.

## Perceived-loading follow-on

The selected Native engine can write a temporary overview-only Scene Cache
after its single LibreDWG parse and before the disk-backed detail sort. This
preserves the engine decision: it reuses the measured bounded C writer and
process lifetime instead of adopting the rejected multi-gigabyte WASM path.

On the reference drawing, the 4,914,376-byte preview was ready at 1,241 ms and
the full 177,049,408-byte cache at 3,312 ms. Chromium rendered them in 517.9 ms
and 502.6 ms respectively, putting the first usable line frame about 2.1
seconds earlier when the measured stages are combined. Preview peak JavaScript
heap was 29.41 MiB versus 60.16 MiB for the full-cache load. The final cache
retained its prior SHA-256, while repeating the bounded overview traversal
added roughly 0.3–0.4 seconds to total conversion.

The complete packaged-extension measurement makes this a speed-first option,
not the default. Four stabilized balanced runs initialized Webview content
after conversion and reached the first frame in 3,736–3,795 ms with
530,435,720–595,660,352 bytes incremental physical memory. A stabilized
progressive run reached 1,824 ms but used 664,686,480 bytes, missing the
600 MB target. During immediate VS Code startup overlap it used 919,359,496
bytes and failed the 800 MB hard limit. `dwgViewer.progressivePreview`
therefore defaults to `false`; users can explicitly trade memory for the
earlier frame without changing the chosen parser or canonical cache.

## WASM backend qualification

Issue #17 compiled the exact LibreDWG 0.14 parser and the same Scene Cache
v1.11 writer with checksum-pinned Emscripten 4.0.15. This avoided the
whole-drawing JavaScript model used by earlier third-party WASM candidates.
The generated WASM is 5,374,358 bytes.

The 37,961-byte public fixture produced a byte-identical Native/WASM cache.
The large drawing preserved the directory, record counts, every source string
table and 29 of 34 section bodies, but text placement, GPU line and HATCH
loop/vertex sections differed. Conversion itself took 3.57–3.86 seconds.
Default MEMFS execution peaked at 2.72 GB before copying the output and
2.98 GB while fingerprinting the complete cache. A real Chromium Worker
loaded the module and fixture in 33.7 ms but did not finish the small
conversion within 30 seconds. Node Worker termination completed in 2.12 ms.

The current candidate therefore passes small-fixture output and cancellation,
but fails large-output equality, browser execution and the 800 MB memory hard
gate. Compiler memory settings did not solve both time and memory. Reproduction
is under [`adapters/libredwg/wasm`](../adapters/libredwg/wasm/README.md).

## Native document query and writer admission

이 문서에서 기존에 “writer”라고 부른 구현은 DWG를 Scene Cache v1.21로
투영하는 읽기 전용 cache writer다. 원본 DWG를 수정해 새 DWG/DXF를 만드는
native document writer와는 별도다.

Issue #28의 raw DWG 경계는
[`dwg-native-document-adapter/0.1.0`](../specs/native-document-adapter.md)으로
분리했다. 현재 Native 경로는 Scene Cache의 source-precision record를
bounded range로 읽어 packed handle/owner/layer/bounds index를 만들며,
entity별 JavaScript graph를 노출하지 않는다. 이 `read`,
`query-entity`, `query-region`만 product `query-preview`다.

LibreDWG 0.14 raw writer의 public no-op rewrite/reopen preservation 결과는
production admission을 통과하지 못했다. 따라서 TEXT/LINE/POLYLINE,
layer/style, INSERT, basic create/delete, DWG/DXF write, unsupported-object
preservation과 reopen capability를 모두 파일 생성과 output reservation 전에
`blocked`한다. reference writer conformance가 no-op 및 변경 receipt의
intended/observed 일치를 통과하는 것은 실제 LibreDWG writer 승인 근거가
아니다. 기계 판독 판정과 fixture evidence는
[`compatibility/native-document-adapter.json`](../compatibility/native-document-adapter.json)에
있다.

## License and distribution boundary

The selected engine is GPL-licensed open-source software, not a permissively
licensed component.
[GNU LibreDWG 0.14](https://github.com/LibreDWG/libredwg/releases/tag/0.14)
is GPL-3.0-or-later. The adapter binary links to LibreDWG, so any distribution
of that binary must satisfy GPL-3.0-or-later, including the applicable license,
corresponding source and reproducible build material.

The Rust converter, Webview and VS Code extension code remain MPL-2.0 source
components. LibreDWG is confined to a separate executable and exchanges input
and versioned cache files through `dwg-engine-adapter/1`; it is not linked into
the extension host or Webview. The
[GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation) says
command-line and pipe boundaries normally indicate separate programs, while
also warning that the communication semantics can affect the legal analysis.
The project therefore does not treat process isolation alone as a legal
conclusion.

The repository now has a deterministic GPL package builder and a public
Linux x64/macOS arm64/macOS Intel x64/Windows x64 release workflow. It requires a stripped,
statically linked adapter, validates the adapter's bounded doctor report,
rejects dynamic LibreDWG dependencies and local build paths, and includes the
exact LibreDWG archive, adapter source, build scripts, license texts, manifest
and checksums. Corresponding source is therefore shipped in the same archive
rather than delegated to an unpinned external URL. The workflow reproduces all
four adapter archives and the VSIX, rejects a GPL adapter inside the VSIX,
emits combined checksums, and creates GitHub build-provenance attestations.
Only a qualified merge through `dev` → `prerelease` or
`prerelease` → `main` can publish the corresponding channel; the workflow
creates the matching immutable `v<version>` tag after Marketplace publication
succeeds.

The reviewed publication rules are:

1. an MPL-only VSIX must not bundle a prebuilt LibreDWG-linked adapter;
2. local development may build the adapter from checksum-pinned source with
   `adapters/libredwg/prepare.sh`;
3. the adapter may only be published as the separately identified
   GPL-3.0-or-later package produced by `adapters/libredwg/package.mjs`;
4. Windows packages require the native path/cancellation and latest VS Code
   display-scale qualification evidence from issue #25;
5. every supported release must pass the procedure in
   [`docs/distribution.md`](distribution.md), including provenance and
   checksum verification.

ACadSharp 3.6.51 is MIT-licensed, and the optional adapter uses a
checksum-pinned .NET SDK plus a content-hash-locked package. Its permissive
license does not offset its measured memory failure. This section is an
engineering distribution policy, not legal advice.

## Consequences

- Keep the completed v1.11 block-local/nested-INSERT mask buckets, WebGL depth
  composition and Canvas text clipping within their measured order/GPU
  limits; retain the source/frame path as the safe fallback.
- Continue Korean SHX/BigFont and exact MTEXT/OCS work in issues #5 and #7.
- Keep the retired acadrust implementation out of product and test builds.
- Keep the ACadSharp inspection adapter, package lock and parser preflight test;
  do not build an ACadSharp Scene Cache converter unless a future release
  materially changes the measured memory architecture.
- Keep the source-complete GPL package and four-target release workflow as the
  issue #6 release boundary; use the reviewed checksum and build-provenance
  gates before publication.
- Keep LibreDWG Native as the product default behind
  [`dwg-scene-engine/1`](../specs/scene-engine.md). Do not expose the rejected
  LibreDWG 0.14 MEMFS Worker in settings, fallback or the VSIX. Reconsider WASM
  only after direct disk-backed Worker storage removes the measured memory
  amplification and the same Scene Cache and renderer pass browser,
  performance, Korean-text and package qualification again.

## Primary sources

- [GNU LibreDWG 0.14 stable release](https://github.com/LibreDWG/libredwg/releases/tag/0.14)
- [GNU LibreDWG GPL-3.0-or-later statement](https://www.gnu.org/software/libredwg/manual/LibreDWG.html)
- [LibreDWG WASM API issue #1073](https://github.com/LibreDWG/libredwg/issues/1073)
- [Emscripten filesystem API and MEMFS/WORKERFS](https://emscripten.org/docs/api_reference/Filesystem-API.html)
- [ACadSharp source and DWG support table](https://github.com/DomCR/ACadSharp)
- [ACadSharp MIT license](https://github.com/DomCR/ACadSharp/blob/v3.6.51/LICENSE)
- [ACadSharp 3.6.51 package](https://www.nuget.org/packages/ACadSharp/3.6.51)
- [.NET license information](https://github.com/dotnet/core/blob/main/license-information.md)
- [GNU GPL FAQ on separate programs and aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
- [Autodesk 3DFACE DXF group codes](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-747865D5-51F0-45F2-BEFE-9572DBC5B151.htm)
- [Autodesk 3DFACE wireframe/shaded behavior](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-5E88BB23-9110-45FB-B54A-3FF2E2002585.htm)
- [Autodesk WIPEOUT DXF group codes](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-2229F9C4-3C80-4C67-9EDA-45ED684808DC.htm)
- [Autodesk WIPEOUTFRAME system variable](https://help.autodesk.com/view/ACD/2024/ENU/?guid=GUID-AF1A9E90-35FB-4A49-AA39-E3456B4F264D)
- [Autodesk object draw order](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-LT-MAC/files/GUID-8203C80A-3D51-49F0-B756-56FDF5D96697.htm)
- [Autodesk SORTENTSTABLE DXF contract](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-462F4378-F850-4E89-90F2-3C1880F55779.htm)
