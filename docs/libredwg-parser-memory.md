# LibreDWG parser object-graph memory

This note records the reproducible, platform-neutral fixture and the current
macOS arm64 parser-allocation decision. It does not generalize one machine's
result to macOS x64, Windows x64 or Linux x64.

## Synthetic workload and baseline

The repository generator streams an R2000 ASCII DXF containing 100,000 `LINE`
entities. A fixture-only, write-enabled LibreDWG 0.14 executable converts it to
a 5,738,218-byte DWG. The product adapter then serialized all 100,000 entities,
with no deferred entity or diagnostic, into two byte-identical 19,400,096-byte
Scene Caches. The source generator, write-enabled fixture tool and output DWG
are not product artifacts.

One warmup followed by five measured macOS arm64 processes produced this local
baseline:

| Metric | Median |
| --- | ---: |
| Process wall time | 183 ms |
| Adapter parse time | 79 ms |
| Adapter total time | 178 ms |
| Process peak RSS | 94,830,592 bytes |
| Parse-boundary peak RSS | 85,884,928 bytes |

This is a warm source-page-cache measurement. It is useful for a bounded A/B
decision, not an uncached storage or cross-platform performance claim.

## Allocation attribution

The path-free object-graph probe retains only the parsed `Dwg_Data` during a
bounded inspection window. With `MallocStackLogging=1`, macOS `heap` attributed
the dominant live allocations as follows:

| Allocation family | Observed live allocation |
| --- | ---: |
| `Dwg_Object` slot vector | 131,072 slots x 184 bytes = 24,117,248 bytes; 5,714,672 bytes are unused slots |
| Common entity wrappers | 100,004 records x 296 bytes logically; 100,000 dominant allocations in the 320-byte malloc class, about 30.5 MiB |
| Typed `LINE` bodies | 100,000 records x 112 bytes logically; allocations use the 128-byte malloc class, about 12.2 MiB |
| Reference records | 100,035 records x 48 bytes logically; reference-creation allocations occupy the 64-byte malloc class |
| Handle hash storage | about 2.88 MiB |
| Reference pointer vector | about 0.87 MiB |

The parsed graph reported 100,014 objects, 131,072 allocated object slots,
100,004 entity wrappers and 100,035 retained object-reference pointers. The
probe now reports both logical payload bytes and vector slack, rather than
inferring logical sizes from allocator buckets. Physical footprint was about
80.9 MB without stack logging and 87.3 MB with it. Stack logging changes the
footprint, so its value is attribution evidence rather than the performance
baseline.

Full Xcode Instruments was unavailable on the measuring host; command-line
developer tools exposed `heap` but not a usable `xctrace` Allocations template.
The checked-in probe makes the same object/count/size snapshot reproducible,
while Instruments remains a pending tool-specific capture.

## Decode-buffer lifetime audit

LibreDWG 0.14's public file reader allocates the complete source `Bit_Chain`,
decodes it, and frees that source allocation before `dwg_read_file` returns.
R2004 and R2007 readers allocate decompressed section chains for the current
section or object/handle pair and release those chains on both success and
error exits. The retained post-parse graph therefore does not contain the
source file buffer or a generic decompressed-section buffer. Thumbnail bytes,
decoded strings, proxy graphics and typed large payloads are object-owned
data, not accidental aliases into the released source chain.

This rules out a low-risk "free the input after parse" patch: the pinned
reader already does that. Reducing the transient overlap during decode would
require a section-streaming API and ownership changes inside LibreDWG, with a
separate bound for every compressed page and error path. It cannot be achieved
by the Scene Cache writer after `dwg_read_file` returns.

## Selective-decode and release boundary

The Scene Cache projection requires more than the final visible entity bodies.
A fail-closed selective decoder would have to retain these field families:

| Family | Required data |
| --- | --- |
| Identity and topology | object type, fixed type, handle, owner, object index, block/entity chains and resolved references |
| Presentation | layer, linetype, color, transparency, lineweight, visibility, paper/model ownership, extrusion and transforms |
| Tables and contexts | layer/style/linetype/block/layout/viewport rows, dictionaries, XRECORD/application data, annotation contexts and draw order |
| 2D projection | typed geometry for every supported entity, proxy display records, HATCH, text, image/OLE metadata and clipping |
| Preservation and diagnostics | unknown/proxy envelopes, unsupported type identity, EED/XDATA, external-resource handles and bounded raw payload metadata |

LibreDWG 0.14 decodes a typed body while walking each object stream; it does
not expose a first-pass object envelope plus an offset/length-backed body. Its
declared `DWG_OPTS_MINIMAL` is not a DWG selective-decode contract. Skipping an
apparently unsupported body would also remove information used later for
handle resolution, block traversal or structured deferred diagnostics. The
safe prototype boundary is consequently an upstream two-stage decoder:

1. decode and validate every object envelope and reference;
2. retain immutable source/section backing with checked offset and length;
3. materialize only a declared field family, preserving unknown records as
   opaque bounded spans;
4. project immutable Scene Cache rows; and
5. release a payload only after every section consumer has completed.

The current writer performs several deterministic passes over the same graph,
including parallel section groups, so freeing bodies during today's projection
would create use-after-free risk. No early-release or selective-decode patch is
enabled without that ownership contract.

## Structural prototype decision

A read-only reference-interning prototype replaced repeated non-global
`Dwg_Object_Ref` allocations with shared entries while retaining unique and
global references. The synthetic source coverage stayed at 100,000 serialized
entities and zero deferred entities. One warmup plus five measured processes
gave:

| Metric | Baseline | Prototype | Change |
| --- | ---: | ---: | ---: |
| Process wall median | 183 ms | 191 ms | +4.4% |
| Parse median | 79 ms | 77 ms | -2.5% |
| Adapter total median | 178 ms | 187 ms | +5.1% |
| Process peak RSS median | 94,830,592 | 89,735,168 | -5.4% |
| Parse peak RSS median | 85,884,928 | 80,740,352 | -6.0% |

The prototype reduced retained reference storage, but the object-slot vector,
entity wrappers and typed payloads remained dominant. It missed the 25% parser
peak-memory admission target and regressed wall time instead of approaching the
15% improvement target. The experiment is therefore rejected and is not part
of the adapter's checksum-pinned patch stack. The product keeps upstream
LibreDWG 0.14 plus the existing small reviewed patches; no downstream fork is
created from this result.

### Object-vector growth prototype

A second temporary prototype changed the `Dwg_Object` vector from power-of-two
growth to bounded 6.25% growth. On the same 100,000-`LINE` input it reduced the
final capacity from 131,072 to 100,966 slots and reduced unused slot storage
from 5,714,672 to 175,168 bytes. The current-source baseline and candidate
produced byte-identical Scene Caches. One warmup plus five measured processes
gave:

| Metric | Baseline | Prototype | Change |
| --- | ---: | ---: | ---: |
| Process wall median | 142 ms | 138 ms | -2.8% |
| Parse median | 80 ms | 91 ms | +13.8% |
| Process peak RSS median | 94,863,360 | 96,092,160 | +1.3% |
| Parse peak RSS median | 85,901,312 | 85,901,312 | 0% |

The allocator retained or moved earlier vector generations, so smaller final
slack did not reduce parse peak RSS; the additional reallocations materially
regressed parse latency. The candidate was rejected and is not retained in the
patch stack.

## ACIS/SAB materialization decision

For SAT v1 solids, LibreDWG retains both encrypted blocks and one decoded
`acis_data` copy. The public probe fixture contained one solid with 1,330 bytes
in each representation plus 12 bytes of block metadata. SAB v2 uses one
decoded/binary payload, while newer ACDS data is copied into the owning solid.
The Scene Cache ACIS edge path reads `acis_data` during geometry projection, so
discarding it before projection is not valid.

An offset/length-backed ACIS payload would depend on the same durable source or
decompressed-section ownership required by selective decode. The current file
and section chains are intentionally freed before the adapter receives the
graph, and the available public payload is too small to justify a separate
fork. Lazy ACIS materialization is therefore feasible only as part of the
upstream two-stage decoder, not as an adapter-local pointer substitution.

## Malformed-input safety

The macOS arm64 sanitizer profile builds the exact pinned source, reviewed
patches and current adapter with AddressSanitizer and UndefinedBehaviorSanitizer.
A deterministic local sweep ran one valid public fixture and 24 bounded
truncation/overwrite/bit-mutation cases. Twelve mutations remained valid and
produced validated caches; twelve failed closed. There were no sanitizer
diagnostics or timeouts. A separately suspended converter was terminated with
`SIGKILL`, its possible partial destination was removed, and all per-case files
were removed before the path-free report was published. Leak detection is
disabled because the
isolated converter deliberately lets the operating system reclaim large
successful parse graphs at process exit; this gate detects memory safety and
undefined behavior, not retained-process leaks.

## Reproduction

Build the adapter and exact diagnostic library from the checksum-pinned source,
generate the synthetic DWG, and run the repeat benchmark:

```bash
LIBREDWG_SOURCE_ARCHIVE=/absolute/path/to/libredwg-0.14.tar.xz \
  adapters/libredwg/prepare.sh \
  /absolute/new/adapter-build \
  /absolute/new/libredwg-adapter
tests/fixtures/build-libredwg-dxf2dwg.sh \
  /absolute/path/to/libredwg-0.14.tar.xz \
  /absolute/new/dxf2dwg-build \
  /absolute/new/dxf2dwg
node scripts/qualify-generated-large-dwg.mjs \
  --adapter /absolute/new/libredwg-adapter \
  --dxf2dwg /absolute/new/dxf2dwg \
  --work-root /absolute/new/generated-large-work \
  --report /absolute/new/generated-large-report.json \
  --entities 100000 \
  --minimum-dwg-bytes 5000000
node scripts/benchmark-macos-native.mjs \
  --adapter /absolute/new/libredwg-adapter \
  --fixture /absolute/new/generated-large-work/generated-large.dwg \
  --work-root /absolute/new/macos-repeat \
  --report /absolute/new/macos-repeat.json \
  --source-location local-disk \
  --mode full --warmups 1 --runs 5
```

Build and attach the allocation probe using the commands in
[`tests/fixtures/README.md`](../tests/fixtures/README.md). Generated reports
contain counts, sizes and normalized timing only. Do not publish raw heap
content, input paths, drawing text, handles, bounds or private fingerprints.

The same fixture guide contains the macOS sanitizer build and qualification
commands. Sanitizer binaries and reports are local evidence and are not part of
the product package.

## Target status

| Target | Status | Current evidence |
| --- | --- | --- |
| macOS arm64 | Measured; both structural prototypes rejected | Synthetic large-input baseline, allocation categories, deterministic output and sanitizer sweep reproduced; reference interning and object-vector growth failed admission |
| macOS x64 | Pending | Requires a physical Intel run and target-specific allocation capture |
| Windows x64 | Pending | Requires physical Windows ETW/WPA plus crash-stress evidence |
| Linux x64 | Pending | Requires native allocation profiler and target sanitizer qualification |

An unmeasured target is pending, never pass. Neither measured prototype meets
the admission bar, so propagating either one to other targets would add
qualification cost without a viable candidate. The product remains on the
checksum-pinned upstream source plus the existing reviewed compatibility
patches; no parser-memory patch or downstream fork is admitted.
