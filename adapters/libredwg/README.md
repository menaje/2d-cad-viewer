# LibreDWG engine adapter

This process-isolated adapter implements the `dwg-engine-adapter/1` inspection
and conversion contract. It traverses LibreDWG's object model directly instead
of creating a full JSON dump.

The `convert` path writes Scene Cache v1.26 without a whole-drawing intermediate
model. It repeatedly traverses LibreDWG objects and streams sections and
bounded GPU batches directly to a new cache file. For large drawings, it
spills fixed-size detail records into private unnamed temporary files, sorts
8,192-record runs, and performs one buffered merge into group-local XY Morton
order. The in-memory sort working set stays bounded to one fixed run buffer per
selected worker; the temporary files are mode `0600`, close-on-exec, and
removed automatically.
GPU batch metadata and its packed 36-byte vertices are generated together in
one geometry pass, with each bounded batch written as one vertex buffer rather
than one field at a time. The full-cache vertex body is written directly to
its final range and only the small batch directory is staged and appended.
Section bodies retain their deterministic byte layout even though those two
physical ranges no longer follow kind order.
HATCH sections use repeated bounded passes and retain at most one 65,536-point
ring (about 1.5 MiB) while streaming. Pattern-definition lines and dash values
are streamed in separate bounded passes, and no whole-drawing fill or pattern
mesh is built in the converter. DIMENSION picture blocks reuse the existing
fixed-size block-instance stream and do not copy their geometry.

The current conversion coverage is corpus-qualified rather than format-wide:

- layer, linetype, block, style and entity strings are converted from the
  DWG code page to valid UTF-8 before serialization, including `ANSI_949`;
- block names are read from each BLOCK entity, which is the canonical DXF
  source, rather than trusting a duplicated LibreDWG BLOCK_HEADER name. This
  keeps the active `*PAPER_SPACE` block distinct from inactive
  `*PAPER_SPACE0...` layout blocks;
- the anonymous `inspect` contract applies the same legacy code-page
  conversion before Hangul and corruption metrics, so private corpus
  inventory does not reject valid pre-R2007 Korean drawings as malformed
  UTF-8;
- XREF block records retain the original relative, drive, UNC or POSIX path
  for host-side resolution without changing the source drawing;
- LINE, ARC, CIRCLE, INSERT/MINSERT, LWPOLYLINE, 2D/3D POLYLINE and
  ELLIPSE source records plus SPLINE headers and knot/weight/control/fit pools
  are preserved;
- all seven DIMENSION families use their resolved anonymous picture block as
  a one-by-one identity instance; unresolved targets remain deferred;
- text-style names, SHX/BigFont filenames and UTF-8 TEXT, MTEXT, ATTDEF and
  attached ATTRIB source records are preserved, including bounded MTEXT column
  height pools;
- LINE, normalized polyline, ARC, CIRCLE, ELLIPSE, SPLINE and bounded HATCH
  boundary geometry are emitted as renderable, instanced GPU batches;
- circular curves and polyline bulges are converted to bounded chords with at
  most 16 segments per revolution, while exact curve records, vertices and
  bulges remain in the source pools;
- valid SPLINE definitions use one segment for linear spans or two per
  non-empty curved knot span, capped at 256 segments per entity; malformed
  definitions fall back to bounded fit/control-point chords;
- HATCH line, circular, elliptic, bulge and spline boundaries use a denser
  bounded pass: circular curves and bulges use at most 64 segments per
  revolution, curved spline spans use eight segments, and fit-point-only
  boundary splines use a tangent-aware cubic interpolation with periodic
  closure; one HATCH remains capped at 65,536 segments and reports expose
  rendered boundary segments and any capped entities;
- bounded HATCH entity records retain pattern/gradient metadata, closed `f64`
  rings, gradient colors, seed points and the named
  `HATCHBACKGROUNDCOLOR` application-data value; rings are capped at 65,536
  vertices per HATCH and 1,048,576 vertices globally;
- pattern-definition lines retain their resolved angle, base, offset and dash
  sequence in packed source sections; one HATCH is capped at 4,096 definition
  lines and 65,536 dash values, with global caps of 262,144 and 1,048,576;
- POINT retains WCS location, normal, thickness, X-axis angle and drawing
  `PDMODE`/`PDSIZE`; SOLID retains four OCS corners in 1-2-4-3 perimeter
  order, normal, thickness and drawing `FILLMODE`;
- TRACE retains the same 1-2-4-3 perimeter order as SOLID, and finite RAY
  display extends only in its forward direction;
- POLYLINE mesh rows and columns retain their declared M/N topology and closed
  directions; MLINE display retains styled parallel elements, start/end caps,
  joined miters and qualified uncut style fills. A filled MLINE carrying area
  fill parameters fails conversion closed until their exact boundary meaning
  is qualified;
- REGION, 3DSOLID and BODY display reads bounded SAT plus ACIS/ASM SAB topology
  and emits transformed straight, elliptic and exact rational NURBS edge
  chords. The checksum-pinned LibreDWG 0.14 source is patched during every
  Native and WASM build so complete ACDS SAB payloads are extracted before an
  optional schema decoder can reject them;
- an unsupported class with valid official proxy graphics can still display
  safely: bounded model transforms, colors, lineweights, linetypes,
  polylines/polygons and UTF-16 `UNICODE_TEXT2` records are streamed into the
  ordinary line and text sections. This currently preserves the complete
  `ACAD_TABLE` display found in the private qualification corpus without
  enabling LibreDWG's unstable TABLE object decoder;
- proxy display follows AutoCAD's default `PROXYSHOW=1` policy because that
  registry preference is not stored in the DWG. Conversion reports the exact
  supported opcode set: polyline (6), polygon (7), color (14), linetype (18),
  TrueColor (22), lineweight (23), matrix push/pop (29–31), polyline with
  normals (32), and Unicode text (38). A malformed stream or a proxy with no
  supported display primitive is counted in
  `coverage.deferred_reasons.unsupported_proxy_graphics`; no guessed geometry
  or bounding box is substituted;
- 3DFACE retains four WCS corners and all four invisible-edge bits; its current
  wireframe display emits only visible, non-degenerate edges;
- WIPEOUT retains its image basis, display properties, exact rectangular or
  polygonal clip vertices, definition handles and the drawing-wide frame
  setting; a missing WIPEOUT variables object leaves only that frame setting
  unavailable while preserving independent LWDISPLAY, FILLMODE and model-space
  state. Valid masks share the normalized draw-order buckets used by lines,
  HATCH, primitives and text; an invalid or over-limit mask plan fails closed
  to ordinary geometry plus any enabled WIPEOUT frame;
- IMAGE retains the IMAGEDEF path, insertion/U/V basis, source pixel size,
  brightness/contrast/fade, definition handles and exact rectangular or
  polygonal clipping boundary for lazy JPG/PNG/BMP/DIB/GIF display;
- PDF/DWF/DGN underlays are recognized as logical entities and reported under
  `coverage.deferred_reasons.unsupported_underlays`; their content is not
  claimed as serialized because the current 2D viewer has no qualified
  underlay decoder;
- Scene Cache v1.26 retains ATTMODE, FRAME, IMAGEFRAME, XCLIPFRAME, OLEFRAME,
  PDFFRAME, DWFFRAME, DGNFRAME, ANNOALLVISIBLE, MSLTSCALE, the current model
  CANNOSCALE factor, QTEXTMODE, SPLFRAME, DISPSILH, DISPSILHBLOCKS,
  XREFOVERRIDE, VISRETAIN, raster IMAGEQUALITY and XREF loaded/resolved state.
  Missing optional dictionary values remain explicitly unavailable instead of
  being guessed; invalid saved ranges fail conversion.
- Each model/paper layout also retains its saved ANNOALLVISIBLE value. Paper
  layouts read AutoCAD's `AcadAnnoAV` LAYOUT application data; a duplicate or
  malformed value fails conversion closed instead of guessing visibility. A
  layout with no such application data uses AutoCAD's documented initial value
  1 instead of being interpreted as an explicit off state.
- `SORTENTSTABLE` objects retain their block owner plus entity/sort-handle
  pairs in deterministic, bounded sections that the Webview reads lazily;
- layer and entity colors, lineweights and named linetypes are retained,
  including bounded complex-linetype text/shape metadata; pre-R13 fixed simple
  dash arrays are normalized without interpreting them as modern complex-dash
  records;
- named paper-space layouts retain their paper settings, active viewport and
  bounded VIEWPORT records so every saved layout can be selected independently;
- pre-R13 `TILEMODE=0` files without modern LAYOUT objects remain an explicit
  paper-space presentation boundary; the adapter does not synthesize a layout
  or mislabel model geometry as paper-space content;
- LAYER extension dictionaries retain sparse per-viewport color, transparency,
  linetype and lineweight overrides, capped at 1,048,576 property records;
- XLINE and RAY retain exact point/direction sources and are clipped as
  infinite or half-infinite geometry for each camera, INSERT and XCLIP
  occurrence. MULTILEADER and classic LEADER geometry is displayed with
  bounded approximations, including LEADER arrows and hook lines;
- OLE2FRAME accepts both observed embedded four-corner preamble markers,
  extracts bounded BMP/DIB presentations and reconstructs strictly validated
  chunked EMF presentations from Excel OLE previews; unsupported presentations
  retain their placement as an explicit crossed placeholder;
- after the first line frame, the Webview fills solid/gradient rings and
  clips pattern strokes to the current viewport in one persistent worker;
- a preceding one-shot worker builds instanced POINT markers, SOLID
  fill/outline meshes, 3DFACE edges and enabled WIPEOUT frames under a
  combined 32 MiB GPU limit, then exits;
- every unsupported logical entity is counted under
  `coverage.deferred_entities`, with an exact partition in
  `coverage.deferred_reasons` for unresolved DIMENSION pictures, underlays,
  proxy graphics, unsupported 3D entities, invalid supported entities and
  other unsupported families;
- bounded SHX/BigFont and system-font fallback display is implemented in the
  Webview, including stored MTEXT WCS X-axis, attachment, columns and
  background fill plus bounded inline font/color/scale/slant/decorations and
  stacked horizontal/diagonal fractions and tolerances. The Webview also
  applies bounded paragraph indents, left/center/right tab stops and upright
  top-to-bottom MTEXT flow. Single-line TEXT uses its OCS plane and
  preserves both raw placement points so the Webview can apply measured
  center/right/vertical justification, while endpoint width and direction are
  reserved for Align/Fit. Multiline ATTRIB/ATTDEF records preserve their
  embedded MTEXT insertion point and basis;
  external image baselines for every OCS/justification combination remain
  open in GitHub issues #5 and #7.

This writer is the selected primary engine path. Entities outside the
qualified families remain observable through `coverage.deferred_entities`, so
new corpora cannot silently turn an unsupported object into a successful
conversion claim. Its large-drawing detail batches use group-local midpoint
quantization and a 16-bit XY Morton key, with original source order as the
deterministic tie breaker. The current 36-byte vertex record caps the
first-frame overview at 58,254 segments and 4 MiB. Each detail GPU batch is
capped at 7,281 segments (524,232 bytes), below the Webview's 512 KiB
range-read limit.

## Progressive first frame

When the VS Code host supplies both private preview paths, the same conversion
process emits a Scene Cache v1.26 first-frame sidecar immediately after parsing
and overview planning, before the disk-backed full-detail sort. The sidecar
contains drawing/layer/block/INSERT and layout/viewport metadata, including
viewport layer overrides, plus overview-only GPU line data; remaining required
sections are schema-valid and empty. Header flag bit 0
prevents it from being mistaken for a canonical cache.

The adapter closes the preview before creating its ready marker. It then
continues writing the ordinary full cache and preserves the existing one-JSON
stdout and exit-status contract. Preview creation is best-effort: failure
removes both sidecars and never converts a successful full-cache write into a
failure. Older hosts omit the variables and receive exactly the previous
behavior.

On the 24,680,147-byte reference drawing, the 4,914,376-byte preview and marker
were available at 1,241 ms; the unchanged 177,049,408-byte full cache completed
at 3,312 ms. The full-cache SHA-256 remained
`d3bf4181b9e1ddc936f31a9254d0745990fd4468077498186923f987b7452d77`.
An actual Chromium load rendered the preview in 517.9 ms with a 29.41 MiB peak
JavaScript heap, versus 502.6 ms and 60.16 MiB for the full cache. Combining
the independently measured stages moves the first usable line frame forward
by about 2.1 seconds. Repeating the bounded overview pass adds roughly
0.3–0.4 seconds to full conversion, without another whole-drawing object
graph or a higher parser memory class.

## Portable build and self-diagnosis

The reproducible path downloads checksum-pinned LibreDWG and pkgconf sources,
applies the repository's reviewed ACDS SAT/SAB, R2007 high-compression and
seekable-stdin bulk-read patches, builds a stripped adapter with LibreDWG
linked statically under a new private directory, and writes the adapter to a
new path. It never installs a system package:

```bash
adapters/libredwg/prepare.sh \
  /private/tmp/dwg-viewer-libredwg-build \
  /private/tmp/libredwg-adapter
```

Both paths must not already exist. A C11 compiler, `make`, `strip`, `tar` and
a SHA-256 utility are required. `curl` is needed only when LibreDWG or a
fallback pkgconf must be downloaded. An already downloaded source archive can
be used offline after checksum verification:

```bash
LIBREDWG_SOURCE_ARCHIVE=/path/to/libredwg-0.14.tar.xz \
  adapters/libredwg/prepare.sh \
  /new/private/build-directory \
  /existing/output-parent/libredwg-adapter
```

If the exact LibreDWG 0.14 release already exists in an isolated prefix, only
the adapter needs to be built:

```bash
LIBREDWG_PREFIX=/path/to/libredwg-prefix \
  adapters/libredwg/build.sh /new/path/to/libredwg-adapter
```

The adapter exposes a bounded self-diagnosis that does not open a drawing:

```bash
/path/to/libredwg-adapter doctor
```

It reports the adapter protocol, exact engine and license, Scene Cache
compatibility, static/dynamic linkage and target platform as one bounded JSON
record. The VS Code extension runs this only when the user selects or explicitly
diagnoses an adapter, so it adds no work to the normal drawing-open path.

### Actual DWG viewport override qualification

Use a redistributable synthetic DWG with one `Layout1` paper viewport, one model
viewport and one `TARGET` layer. The model viewport must override the layer with
RGB `#40c4ff`,
40% transparency, `DASHED` linetype and 0.50 mm lineweight, with drawing
lineweight display enabled. The qualification runs the product adapter, opens
its output with the canonical Scene Cache reader and requires all four sparse
records to merge into the same viewport/layer row:

```bash
pnpm run qualify:viewport-layer-overrides -- \
  --adapter /absolute/path/to/libredwg-adapter \
  --fixture /absolute/path/to/viewport-layer-overrides.dwg
```

Alternative fixture names or normalized values can be supplied with `--layout`,
`--layer`, `--linetype`, `--color`, `--transparency` and `--lineweight`. The
fixture must still contain exactly the four properties being qualified. Private
working drawings are not accepted as repository fixtures.

The R2004 round-trip qualification used the repository's
[`generate-viewport-layer-overrides.py`](../../tests/fixtures/generate-viewport-layer-overrides.py)
definition and a separate write-enabled LibreDWG 0.14 build. The read-only
product adapter emitted a valid 51-section Scene Cache v1.26, and the canonical
reader recovered true color `0xc040c4ff`, transparency `0x27000000`, `DASHED`
and lineweight `50` on the original viewport handle. The write-enabled build is
only a fixture producer; it is not part of the product or release package.

## Separate GPL package

The output binary links to LibreDWG and must be distributed in compliance with
GPL-3.0-or-later. Create a new, deterministic GPL package with the exact
LibreDWG source archive:

```bash
node adapters/libredwg/package.mjs \
  --adapter /absolute/path/to/libredwg-adapter \
  --libredwg-source /absolute/path/to/libredwg-0.14.tar.xz \
  --output /absolute/new/path/dwg-viewer-libredwg.tar.gz
```

The packager refuses to overwrite a file, rejects a dynamic LibreDWG
dependency, local build paths, a wrong source checksum or an incompatible
doctor report. The archive includes the executable, unmodified GPL and MPL
license texts, the 2D CAD Viewer project notice, checksums, a machine-readable
manifest, all adapter build sources (including the reviewed source patches)
and the exact LibreDWG 0.14 source archive.
Fixed metadata and sorted entries make repeated packaging from the same target
binary byte-identical. The included repository license, notice and package
metadata also let the packaged `package.mjs` run from the extracted source tree
instead of depending on files outside the archive.

GitHub's release workflow qualifies Linux x64, macOS arm64, macOS Intel x64,
and Windows x64 packages, reproduces the archives, verifies their extracted
contents, and creates keyless GitHub build-provenance attestations. Intel
macOS builds run on GitHub's `macos-15-intel` standard runner. The Windows
writer uses private delete-on-close native temporary files and non-inheritable
handles. Its qualification also exercises cancellation plus drive, UNC,
relative, Unicode, normalization, and case-insensitive paths on the Windows
runner.

The MPL-only VSIX never bundles this executable. The release workflow copies
the verified executable to a viewer-versioned raw converter asset and publishes
the source-complete archive beside it in the same immutable GitHub Release.
The main VSIX records both files' exact names, sizes, and SHA-256 digests, then
downloads and runs the converter as a separate process. The complete reviewed
publication and verification procedure is in
[`docs/distribution.md`](../../docs/distribution.md). This packaging policy is
engineering guidance, not legal advice.

The clean macOS arm64 static-package qualification converted the 24,680,147-byte
reference drawing in 3,564 ms with 524,468,224-byte peak RSS. It produced the
same valid 177,049,408-byte Scene Cache v1.11 with all 378,400 logical entities
preserved, so static distribution remains inside both performance gates.

## Benchmark

Run both phases through the same process-isolated benchmark:

```bash
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /path/to/libredwg-adapter \
  --engine-id libredwg \
  --engine-version 0.14 \
  --engine-license GPL-3.0-or-later \
  --scope all \
  --pretty
```

The conversion destination must not exist. The adapter never overwrites or
removes a pre-existing destination, and it removes a newly created partial
cache if writing fails.

Reports never include the input name, drawing text samples, diagnostic
messages, or a block name. LibreDWG parsing, analysis and cache writing stay in
the adapter process so all transient memory is reclaimed when the process
exits.

The native writer resolves LibreDWG object references before parallel work,
sorts copied spatial records across available cores, and writes seven
independent section groups concurrently. The largest GPU vertex group writes
directly to the final cache; six smaller groups are concatenated
deterministically from bounded private files. The GPU section group fuses
batch-directory and packed-vertex generation into one traversal and buffers
each batch before writing.

The remaining group staging is intentional. A physical-Windows A/B made the
118,534,328-byte entity-geometry body write directly to the final cache. It
removed 118,993,776 process-read bytes and 118,534,328 process-write bytes, but
median wall time increased from 10,423 ms to 11,086 ms (+6.4%) and median
adapter write time increased from 6,163 ms to 6,821 ms. Concurrent writes and
final-file allocation outweighed the avoided copy, so that experiment was
reverted and the six bounded group files remain.
`DWG_VIEWER_CONVERSION_WORKERS=1..8` can override the automatic
online-CPU count for qualification. The conversion report records the selected
worker count, actual sort and section concurrency, coarse stages, spatial-sort
sub-stages, each section-group duration, parse-boundary and final current/peak
working set and private bytes, plus Windows process I/O operations and bytes
under `performance`.

LibreDWG exposes block markers, polyline vertices and attached attributes as
separate raw entities. The adapter keeps raw counts under `drawing.raw_*` and
`embedded_text`, but normalizes the main `drawing.entities`,
`drawing.objects`, `entity_types` and `text` fields to the shared logical
inspection contract.

On the private 24 MB reference drawing, the Scene Cache v1.8 milestone had a
2,986 ms median process wall time and 591,511,552-byte median peak RSS across
three isolated measured runs. The maximums were 3,028 ms and 592,150,528 bytes,
so both target gates pass. The deterministic 176,113,616-byte cache contains
1,659,755 full-detail segments, including 35,550 HATCH boundary segments; no
HATCH reached the boundary or fill-vertex cap and no non-finite display
segment was skipped.

The seven HATCH sections contain 3,553 source records, 6,365 usable closed
loops, 31,511 fill vertices, 6,704 gradient colors, 3,653 seed points, 6,390
pattern-definition lines and 12,020 dash values. Open and invalid paths stay
explicit in the report. Adding 621 POINT and 350 SOLID records raises logical
source coverage to 378,179 of 378,400 entities (99.94%); 221 remain deferred.
The 392 solid and 3,161 pattern HATCH counts are unchanged.

The DIMENSION follow-on resolves all 171 picture-block references while
preserving `coverage.inserts` as the 3,659 source INSERT/MINSERT count.
Coverage rises to 378,350 of 378,400 entities (99.99%), leaving 50 deferred.
The unchanged kind-13 format contains 3,830 records and grows by exactly
23,256 bytes; the complete deterministic cache is 176,136,872 bytes. GPU
batch and vertex sections are byte-identical to the preceding cache. Three
isolated measured conversions completed in 2,921 / 3,215 / 3,860 ms with
590,036,992 / 591,691,776 / 591,708,160 bytes peak RSS (minimum / median /
maximum), passing both gates with deterministic output.

Scene Cache v1.9 adds 34 fixed-size 3DFACE records (4,624 bytes) plus one
40-byte directory entry. The deterministic cache grows by exactly 4,664 bytes
to 176,141,536 bytes. Kinds 2–40 remain byte-identical; only the kind-1
serialized-entity count changes with coverage. Coverage rises to 378,384 of
378,400 entities (99.996%), leaving only 16 WIPEOUT records deferred. Three
clean process-isolated conversions completed in
3,153 / 3,715 / 4,082 ms with 591,446,016 / 591,675,392 / 591,888,384 bytes
peak RSS (minimum / median / maximum). Output was deterministic and both time
and memory gates passed.

Scene Cache v1.10 adds 16 fixed-size WIPEOUT records (2,688 bytes), 627 exact
clip vertices (10,032 bytes) and two 40-byte directory entries. The
deterministic cache grows by exactly 12,800 bytes to 176,154,336 bytes.
Kinds 2–41 remain byte-identical. Source coverage reaches all 378,400 logical
entities with zero converter-deferred records; that figure means lossless
source preservation, not that background masks are already rendered. Three
clean process-isolated conversions completed in 2,880 / 2,886 / 2,890 ms
with 591,691,776 / 591,724,544 / 591,724,544 bytes peak RSS (minimum /
median / maximum). Output was deterministic and both time and memory target
gates passed.

Scene Cache v1.11 adds 508 normalized draw-order table records and 54,667
entity/sort-handle pairs. Two directory entries plus the new bodies grow the
deterministic cache by exactly 895,072 bytes to 177,049,408 bytes; kinds 1–43
remain byte-identical to v1.10. Three isolated conversions completed in
2,983 / 2,999 / 3,009 ms with
591,773,696 / 591,822,848 / 591,822,848 bytes peak RSS (minimum / median /
maximum), passing both gates with deterministic output.

Public LibreDWG fixtures provide a reproducible cross-engine check. Both
writers validated `example_2018.dwg` as one pattern HATCH with two definition
lines and four dash values; the complete kind-37 and kind-38 payloads were
byte-identical. The same fixture also matched at 46 POINT and 15 SOLID records,
with byte-identical kind-39 and kind-40 payloads. Both engines also resolve all
nine DIMENSION picture blocks, producing 19 kind-13 records from ten source
INSERTs and nine dimension references. `2000/entities-3d.dwg` contains one
3DFACE; both engines produce the same invisible-edge flags and four WCS
corners. `example_2018.dwg` also contains two polygonal WIPEOUT records with
16 clip vertices and frame setting 1; kinds 42–43 and the drawing setting are
byte-identical between both engines. `2018/Dynblocks.dwg` matched at one
solid and three pattern
HATCHes, eight loops, 104 fill vertices and four definition lines, again with
byte-identical pattern sections. With the denser HATCH-only chord pass,
`2004/HatchG.dwg` produces two gradient HATCHes, two loops and 1,064 fill
vertices. It reaches neither a cap nor an invalid-source skip.

The browser first-frame path opens the cache with eight range reads totaling
5,001,837 bytes,
including the unchanged 4 MiB overview. A local range-reader qualification
then loaded the seven HATCH sections in seven reads totaling 2,504,181 bytes
in 13.6 ms. A persistent-worker qualification, including block-instance graph
construction, fill triangulation and the fitted-view pattern pass, completed
in about 414 ms with about 137 MB process RSS. It triangulated 379 usable
solid fills into 5,585 triangles and a 536,160-byte GPU buffer. At drawing fit,
the 1.5-pixel density rule correctly omitted all pattern strokes.

With DIMENSION picture references, the first-frame path remains eight reads
and grows by only 23,256 bytes to 5,025,093 bytes. Every one of the 171 source
references is reachable. Repeated owners create 2,668 picture occurrences and
380 nested downstream instances, growing the graph from 94,814 to 97,862
packed matrices (390,144 additional bytes). A local qualification completed
metadata validation, graph construction and overview loading in 345.6 ms at
123,076,608 bytes peak RSS.

With v1.9, the first-frame path still performs eight reads and reads no
3DFACE source data. Only the larger directory is visible, so the total grows
by 40 bytes from 5,025,093 to 5,025,133 bytes while the overview remains
4 MiB. The post-frame primitive path uses seven reads totaling 714,027 bytes.
It validated and displayed all 34 faces as 114 visible edges, omitted ten
source-hidden and twelve degenerate edges, and added 7,296 GPU bytes. The
complete POINT/SOLID/3DFACE payload is 73,920 bytes and no source, owner or GPU
cap was reached.

With v1.10, two directory entries add only 80 bytes to the first frame: eight
reads total 5,025,213 bytes and do not touch either WIPEOUT source section.
The isolated post-frame primitive worker uses nine reads totaling 726,827
bytes, including block/INSERT metadata and kinds 39–43. On the reference
drawing it validates 16 WIPEOUTs and 627 clip vertices. The drawing-wide frame
setting is off, so it adds zero GPU bytes; all 16 background masks remain
explicitly reported as awaiting draw-order rendering. The existing
POINT/SOLID/3DFACE payload remains 73,920 bytes and no source, owner or GPU cap
is reached.

With v1.11, the two additional directory entries add only 80 bytes to the
first-frame path. A direct range qualification opens the cache in two reads
totaling 1,424 bytes and reads neither draw-order body. Requesting draw order
later performs two bounded reads totaling 894,992 bytes for all 508 tables
and 54,667 entries.

An actual v1.10 Chromium qualification produced the first usable line frame
in 502.8 ms. It reported all 16 WIPEOUT sources, zero frames and 16
draw-order-deferred masks, matching the drawing-wide off setting. The
post-frame primitive GPU payload stayed 72.2 KiB, total GPU vertex buffers
were 4.58 MiB at drawing fit, the drawing rendered visibly, and the browser
console contained no warning or error. Loading the public fixture in the same
Webview reported both enabled frames and both deferred masks with no console
error.

An actual v1.9 Chromium qualification produced the first usable line frame in
464.0 ms. It reported all 34 faces and 114 visible face edges, GPU vertex
buffers totaled 4.58 MiB at drawing fit, the drawing rendered visibly, and
the browser console contained no warning or error.

The v1.8 POINT/SOLID qualification used six range reads totaling 686,107 bytes
after the first line frame, including the block and block-instance metadata
needed by its isolated worker. It completed source validation, instance-graph
construction and mesh generation in 289.2 ms at about 111 MB process RSS. All
621 POINT and 350 SOLID records rendered without a cap or invalid-owner skip;
the transferred GPU payload was 66,624 bytes. The worker then exited before
HATCH initialization, so its packed source buffers do not remain resident or
overlap the HATCH source peak.

An actual v1.8 Chromium qualification produced the first usable line frame in
506.2 ms. At drawing fit, all 621 POINT and 350 SOLID records were active,
HATCH fills and patterns completed, GPU vertex buffers totaled 4.57 MiB and
the browser console contained no warnings or errors.

The DIMENSION follow-on Chromium qualification produced the first usable line
frame in 450.0 ms. GPU vertex buffers remained 4.57 MiB because the picture
geometry was already cached, and the console again contained no warnings or
errors.

The earlier v1.7 Chromium qualification produced the first usable line frame in
449.1 ms. At drawing fit, all 6,442 visible definition passes were below the
1.5-pixel density threshold and the pattern buffer remained empty. After eight
zoom-in actions (17.35x), the worker generated 540 clipped segments in
33.8 KiB for 6 HATCHes. The 32 MiB detail cache, fills, patterns and overview
used 36.54 MiB of GPU vertex buffers together. Toggling every layer moved the
visible count from 234 to 0 and back to 234 without rereading pattern source,
and the browser reported no console errors. These are local qualification
figures, not cross-device browser guarantees.
The 2,289 text records still load separately; their 690 Hangul-bearing values and 2,674
Hangul characters match the inspection fingerprint with no corruption
markers. At peak, the two automatically removed sort files use about 312 MB
of temporary disk for this drawing; they do not become resident geometry
arrays. Private reports and generated caches are not committed.
