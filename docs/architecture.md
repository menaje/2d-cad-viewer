# Architecture

## Decision

The accepted product pipeline is:

```text
DWG
  -> dwg-scene-engine/1
       -> process-isolated LibreDWG Native converter (default)
       -> rejected LibreDWG WASM Worker probe (qualification only)
  -> versioned chunked binary scene cache
  -> VS Code Webview
  -> batched and instanced GPU renderer
```

## Viewer product and package boundary

The raw DWG Viewer remains an independently installed product. The independent
`bim-explorer` is the second, 3D consumer, while Coni Spatial owns
revision/change authority and embeds only compatible packages. Renderer reuse
is through versioned Viewer Core packages rather than an installed extension,
its process, or its private `dwg-*` Host–Webview messages. The accepted
three-product boundary and extraction order are recorded in
[`ADR-0001`](adr/ADR-0001-viewer-core-boundary.md).

The first executable package boundary is:

```text
RenderSource
  -> @menaje/viewer-render-protocol
  -> @menaje/viewer-core
       -> ViewerHost
       -> @menaje/viewer-ui -> product DOM
```

These packages are `0.1.2` public previews distributed as checksum-pinned
artifacts in the `viewer-core-v0.1.2` GitHub release and through GitHub
Packages. Their producer compatibility record, exact artifact digests, protocol
window, and consumer manifests are recorded in
[`compatibility/viewer-core.json`](../compatibility/viewer-core.json).
The canonical Scene Cache reader and bounded range sources now live in
`packages/dwg-scene-source`; the legacy Webview paths are compatibility
re-exports. The public `@menaje/dwg-scene-source` package exposes that
host-neutral source, while `@menaje/viewer-webgl` exposes generic and DWG
presentation mounts plus the WebGL renderer adapters. It does not export the
standalone product's HTML/bootstrap or its private `dwg-*` Host messages.
`DwgSceneCacheSource` and the Browser mock source pass the common source
lifecycle fixture. Both the standalone Browser file path and VS Code cache
channel now open `DwgSceneCacheSource` through the same Viewer Core runtime
and mount the renderer through the public snapshot-bound presentation
contract. The source-neutral 2D camera is now canonical in Viewer Core with
a legacy Webview re-export, as is the byte-budgeted GPU batch cache. Viewport
interaction lifecycle is also canonical in Core; the Webview wrapper injects
the current DWG detail-selection policy so Core does not import Scene Cache
batch kinds. `ViewerRendererController` validates redraw/camera/detail-target
capabilities and coordinates root/XREF detail disposal.
`DetailStreamingController` owns concurrency, byte-budgeted GPU caching,
stale-work rejection, review geometry publication and redraw coalescing.
`ViewerSelectionController` binds projected picks to the active
session/revision/snapshot and publishes monotonic `selection.changed` Host
events. Service-backed sources can additionally use revision-bound
`pick.resolve`, external identity, Context Reference and source-reveal
descriptors. `ViewerIdentityController` rejects stale in-flight responses and
publishes only opaque `context.request` and `source.reveal` details to the Host.
`MockServiceRenderSource` and the reusable service conformance exercise
base/live/diff/diagnostic layer composition and those hooks without importing
Spatial code. Ordered `revision.changed` and `diagnostics.changed` streams
preserve the last successful snapshot on build failure and reject replayed
sequence numbers. `ViewerLayerCompositionController` orders 2D, 3D, and
semantic layers with atomic visibility rollback. `ViewerServiceEventController`
forwards revision, diagnostics, viewport, and intent-only human action events
without granting a capability or owning Host/source lifecycle.
Render Delta is normalized as an atomic base-snapshot/from-to-revision
envelope with ordered tombstone/upsert operations, affected bounds and a
bounded opaque binary payload. `ViewerRenderDeltaController` retains only
changed Render IDs, dependency invalidations and identity updates, supports
preview rollback/promotion without rereading the immutable base, and exposes a
source-neutral renderer adapter hook. `MockRenderDeltaSource` verifies that a
stale replay cannot advance either source or overlay revision and that picking
tracks the applied revision. The existing DWG WebGL vertex layouts remain
renderer-adapter details rather than render-protocol fields.
`DwgRenderDeltaAdapter` now consumes a
digest/byte-bound decoded v6 packet containing 36-byte lines, 32-byte triangle
fills, 32-byte POINT records, bounded UTF-8 JSON native-text records, 272-byte
direct block-occurrence transforms and 40-byte partial instance styles. It
stages every WebGL, Canvas or instance resource before an atomic renderer state
swap and keeps the committed resources alive while a preview is active. The v1
line-only, v2 line/fill, v3 line/fill/POINT, v4 Canvas-text and v5
instance-transform media types remain accepted during the private producer
transition.
The renderer suppresses replaced or tombstoned base line
handles from vertex identity and HATCH fill/pattern, POINT,
SOLID/3DFACE/WIPEOUT handles from compact vertex-range sidecars. Canvas text
uses the same source-scoped handle filter. Cached visible draw ranges avoid
rewriting immutable Scene Cache buffers, so rollback restores the complete
base presentation and native-handle pick status without rereading the
snapshot. Promotion and disposal release superseded resources under a
dedicated shared 64 MiB GPU bound. The adapter explicitly owns every staged
resource, publishes transition state only after superseded resources are
released, and restores the prior committed or preview renderer state when
cleanup fails so rollback, promotion and disposal remain retryable. Successful
source-switch disposal drains active and inactive owned resources exactly
once. Native Canvas text shares the same
source-scoped handle suppression, font/layout/XCLIP and hit-test path, with a
separate 8 MiB staged text bound. These DWG record kinds remain private adapter
details rather than public protocol fields. Instance transforms and styles
have separate 8 MiB CPU bounds. Transforms sparsely replace only the addressed
packed display and measurement matrices; styles sparsely replace resolved
color, layer, opacity, line weight, linetype and visibility metadata. Root and
XREF WebGL batches, Canvas text and raster images therefore retain one shared
block definition. A compact, bounded DFS replay derives affected descendant
matrices and inherited styles for nested root/XREF occurrences; a descendant's
direct sparse record takes precedence over its ancestor-derived state. The
renderer rejects a direct transform for an XCLIP-bound occurrence and rejects a
parent transform when any moved descendant carries XCLIP, while style-only
changes remain valid. It requires complete coverage of every repeated/MINSERT
occurrence that shares the native handle and caps derived transform and style
records at 8 MiB each.
DWG dependency IDs use a canonical scene plus native-handle scope while
remaining opaque to Viewer Core. A block invalidation excludes only that
root/XREF block's immutable base WebGL, Canvas text and raster-image cache; a
type invalidation conservatively excludes the source scene's base cache. Delta
overlays remain drawable. The resources are retained under their existing
bounds instead of being destructively rewritten, so preview rollback restores
them in the same atomic state swap. Unknown non-DWG dependency IDs remain
observable without being guessed or parsed by the adapter.
The same renderer activation swaps a bounded native pick map and its revision.
Root/XREF overview, streamed detail, exact-curve and filled-object review
indexes resolve each base candidate against that live state, so a tombstoned,
replaced or dependency-invalidated candidate cannot win while a nearby
unchanged candidate remains selectable. Stale CPU candidates for a sparsely
transformed occurrence and hidden styled occurrences fail closed. Canvas text
marks dynamic hits as delta-origin picks, allowing the upsert identity while
the suppressed base hit remains unavailable. Rollback restores the committed
pick revision without rebuilding the immutable indexes. Only the winning
candidate is projected to its current revision, Render ID and external
identity; the selection controller advances to that revision before publishing
the Host event.
`ViewerRenderDiffController` classifies only the bounded changed-ID overlay
against a product-supplied compact base-membership index. Base upserts become
modified, non-base upserts become added, base tombstones become removed, and
an added-then-removed ID disappears from the net diff. Unchanged is derived
from the base count instead of enumerating the immutable entity graph. The
same snapshot follows preview apply and rollback. Viewer UI projects those
four counts and the bound base/target revisions through its existing
text-only result model. `ViewerDiffOverlayController` combines that bounded
summary with immutable per-status visibility, canonical hex color and opacity
styles. The default palette is green for added, red for removed, amber for
modified, and native color at reduced opacity for unchanged. It still sends
only changed IDs; unchanged remains a count plus one global style. Status
visibility is always intersected with source, layer and clip visibility, so a
diff policy cannot reveal source-hidden geometry. Adapter application is
synchronous and retryable: failures restore the last stable presentation and
an incomplete rollback remains observable. The DWG product adapter binds each
changed logical Render ID to its active split GPU resources and native handle.
WebGL lines, fills and points apply status tint and opacity only after the
existing layer, viewport and clip tests; removed entities redraw only their
suppressed base ranges. Canvas text uses the same presentation, including
removed-base recovery, while preserving source-layer visibility. A revision
change clears stale product styling before a new presentation is accepted.
Direct transform/style identities additionally partition a shared root/XREF
block draw by packed INSERT occurrence handle. Unchanged occurrences keep the
global style; an explicitly changed child resource or removed base range
overrides the containing occurrence style. Canvas block text resolves the same
precedence inside its occurrence loop, and source-hidden sparse styles are
filtered before either renderer applies diff visibility.
`ViewerSplitViewCameraController` now coordinates the before and after surfaces
through two distinct synchronous adapters. It sends only a frozen logical 2D
camera (`origin` and `worldHeight`), leaving each renderer to derive its own
canvas-dependent width and retain its own revision, scene, GPU and detail
state. A source-side interaction updates only its peer, while a programmatic
change updates both. Failed transitions restore the last stable camera on both
surfaces; an incomplete rollback is observable and can be retried with an
explicit synchronization. The controller never disposes either surface.
`ViewerSplitViewDiffController` sends both surfaces the same frozen changed-ID
mapping and corresponding-entity highlight while binding each side to its own
base or target revision. A failed update restores the last stable mapping on
both surfaces. `ViewerSplitViewUiController` owns the actual accessible
two-surface DOM composition, bounded keyboard/pointer divider and restoration
of the injected surfaces to their original DOM positions; renderer resources
remain product-owned.
`ViewerDiffSemanticController` projects only identity/dependency changes and
bounded invalidation IDs into the revision-bound `diff.open` Host event, so an
external semantic panel does not require the visual geometry list or an
expanded base graph.
The WebGL CAD renderer, viewport batch selection and DWG candidate decoder
remain Webview adapters and move incrementally without changing raw DWG
qualification. `ViewerReviewUiController` now owns review toolbar state,
accessibility attributes, bounded text-only result composition and DOM listener
disposal. The Webview adapter still owns Korean/CAD labels, DWG property
projection, picking and measurement calculations.

The public large-delta qualification models the current 378,400-entity base
without allocating its entity graph and retains only 768 changed IDs across
eight deltas. It checks checkpoint recommendation, exact preview rollback,
last-good state after a staging failure, and identical overlay/split mappings.
The 24,680,147-byte private reference drawing was requalified on 2026-08-04:
the packaged product reported `status: ok`, 5,220 ms to first usable frame,
564,907,536 bytes of incremental physical memory, and complete converter/editor
cleanup. The frame missed the 5-second target by 220 ms but remained below the
8-second hard limit; memory remained below its 800 MB hard limit. The private
drawing and raw report are not committed.

The engine decision is now accepted: LibreDWG 0.14 is the primary parser and
converter for continued product development. The former acadrust comparison
engine was retired and removed after failing the reference drawing's memory
hard gate.
ACadSharp 3.6.51 is excluded because its parser-only preflight peaks around
1.45 GB, above the 800 MB hard limit. The complete evidence and GPL
distribution boundary are recorded in
[`engine-decision.md`](engine-decision.md).
The engine/backend capability, progress and cache-isolation boundary is
recorded in
[`scene-engine.md`](../specs/scene-engine.md).

Raw DWG query and mutation admission is a second, narrower boundary:
[`dwg-native-document-adapter/0.1.0`](../specs/native-document-adapter.md).
It accepts only registered opaque input/output capabilities and exact
source/entity fingerprints. The current implementation builds a compact
parallel-typed-array handle index by reading Scene Cache source records in
bounded ranges; it never exports LibreDWG pointers or a whole JavaScript
drawing graph. Native read/entity/region query is available as a
`query-preview`. The actual LibreDWG writer, every mutation, preservation and
reopen capability remain pre-write `blocked`, while the reference writer
exercises intended-versus-reopened-observed receipt validation. The rejected
WASM MEMFS candidate remains outside settings and the VSIX.

The product writer, preview writer, benchmark validator and Webview reader now
accept only Scene Cache v1.19. Lower version numbers in the milestone evidence
below are historical development records, not supported runtime formats.

LibreDWG passes the conversion time and memory targets and matches the
normalized geometry and Korean text fingerprint. It renders LINE and
LWPOLYLINE/2D/3D POLYLINE
geometry plus bounded ARC/CIRCLE/ELLIPSE and bulge chords, while preserving
source records for a partial entity set. Bounded SPLINE evaluation and
fit/control-point fallback now use the same cache contract. Scene Cache v1.4
also proves UTF-8 TEXT, MTEXT, ATTDEF and attached ATTRIB preservation plus a
bounded SHX/BigFont display path. Scene Cache v1.5 adds a bounded preview of
HATCH line, circular, elliptic, bulge and spline boundaries without adding a
whole-drawing fill mesh. Scene Cache v1.6 adds bounded HATCH source rings and
worker-side solid/gradient fills. Scene Cache v1.7 adds resolved
pattern-definition and dash pools plus viewport-clipped pattern rendering in
the persistent HATCH worker. Scene Cache v1.8 adds lossless POINT and SOLID
source records plus a bounded one-shot display worker. Resolved DIMENSION
picture blocks reuse the existing kind-13 instance stream, so their nested
block geometry reaches every renderer without a cache-version change or a
second geometry copy. Scene Cache v1.9 adds lossless 3DFACE WCS corners and
invisible-edge flags to the same deferred worker. Scene Cache v1.10 adds
lossless WIPEOUT image bases, clip boundaries and drawing-wide frame metadata;
the worker displays enabled frames while keeping background masks deferred
until block-local and nested-INSERT draw order is available. Scene Cache v1.11
preserves bounded, normalized `SORTENTSTABLE` tables and entries in two lazy
sections without adding them to the first-frame read path. Scene Cache v1.12
retains the original XREF path in each block record, and v1.13 retains bounded
INSERT/XREF spatial-clip boundaries. The VS Code host resolves
relative, drive, UNC and POSIX forms through bounded project-local search,
persists explicit manual mappings, converts child caches serially and the
Webview composes their shared line/text instances under the parent INSERT.
The same composed instance graph now drives child HATCH, primitive and
stable-view exact-curve workers, with child layer and linetype indices remapped
before upload. Aggregate XREF overview source, overview GPU and detail GPU data
are each capped at 32 MiB; external deferred geometry has a separate 64 MiB GPU
cap. Versions 1.14–1.17 add drawing display settings, named
linetypes, saved model view and paper/model layout viewport state. Scene Cache
v1.18 adds IMAGE/IMAGEDEF paths, placement bases and clip vertices without
adding raster bytes to the cache or first-frame read. The host resolves only
visible JPG/PNG references and transfers deduplicated, bounded content; the
Webview applies image/XREF clipping and keeps decoded bitmaps in a 64 MiB RGBA
LRU below the transparent WebGL drawing plane. Scene Cache v1.19 adds bounded
MTEXT annotation contexts and exact viewport annotation scales, so layout
viewports select stored representations instead of multiplying text by a
geometric viewport ratio. Remaining exact
CAD text layout and draw-order work are product-completeness gates on this
selected engine, not an open parser choice.

The complete mlightcad/LibreDWG WASM object-model pipeline is intentionally not
used for large drawings because the full JavaScript model, structured cloning,
render-cache cloning and geometry merging amplify memory. Issue #17 also
compiled the project's own bounded Scene Cache writer with exact LibreDWG 0.14
and Emscripten 4.0.15, so the WASM decision no longer rests only on that
third-party architecture.

The direct WASM probe produced a byte-identical v1.11 cache for a 37,961-byte
public fixture and terminated its Node Worker in 2.12 ms. On the
24,680,147-byte reference drawing it wrote a 177,049,408-byte cache with the
same directory and record counts in 3,567–3,856 ms. All string tables,
including Korean source text, were byte-identical. However, text entity
placement (kind 22), GPU line batches/vertices (30–31) and HATCH
loops/vertices (33–34) differed; the other 29 section bodies were identical.
The large run ended with a 506,658,816-byte WASM heap,
2,221,260,800-byte direct-process RSS after explicit garbage collection, and
2,723,463,168-byte RSS with a 2,723,479,552-byte peak in the reproducible Node
Worker probe before copying the complete output. Full-cache fingerprinting
raised the maximum observed RSS to 2,983,854,080 bytes. The default MEMFS path
retains input, output and spatial-sort temporary files beside the parser
graph. Fixed 512/768 MiB heaps and one large linear growth step did not
complete in 39–77 seconds. In an actual Chromium Worker the module and public
input were ready in 33.7 ms, but conversion of that small fixture did not
finish within 30 seconds. Therefore the current WASM backend fails the
large-output-equality, concurrent-memory and browser-execution gates and is
not a product fallback.

The extension now places LibreDWG Native behind the common `SceneEngine`
interface without adding work to the drawing-open path. Cache identity includes
the source fingerprint, Scene Cache version, engine ID/version, backend
ID/kind, converter revision and canonical conversion options. Native and a
future redesigned WASM backend therefore cannot silently reuse each other's
cache.
Progress events are bound to the same engine/backend identity, while terminal
failure and cancellation remain explicit. The WASM-shaped test implementation
only qualifies this boundary; the rejected real probe is reproducible under
[`adapters/libredwg/wasm`](../adapters/libredwg/wasm/README.md) and is not
exposed as a product backend.

## Native first-frame modes

The default uncached path is memory-balanced: it starts conversion before
initializing Webview content, waits for the Native process to exit, and only
then publishes the canonical cache to the Webview. A second Webview renderer
still belongs to VS Code's Custom Editor architecture, but deferring its
content and full renderer workload keeps the stable-host incremental physical
peak within the product target.

The optional `dwgViewer.progressivePreview` path separates “usable line frame”
from “canonical cache complete” without changing parsers or adding another
converter process:

```text
one LibreDWG parse
  -> capped overview plan
       -> independent preview cache -> Webview first line frame
       -> disk-backed detail sort -> full cache -> validation/commit
                                           -> replace preview
```

The adapter publishes the preview only after closing it and creating a ready
marker. The extension rechecks source and engine snapshots, opens a dedicated
range channel and keeps the sidecar outside the reusable-cache namespace. The
full cache retains its original atomic write, validation and cache identity.
Preview failures are non-terminal, and editor close, retry, cancellation,
render failure or the full first frame releases its channel and private file.

The preview repeats the bounded overview traversal but does not copy the
LibreDWG object graph or build full-detail geometry in memory. It contains the
metadata required for block expansion plus no more than 4 MiB of overview GPU
vertices. Empty schema-valid source sections prevent post-frame workers from
requesting data that is not part of the preview.

On the 24,680,147-byte reference drawing, one instrumented Native run
published a 4,914,376-byte preview at 1,241 ms and completed the unchanged
177,049,408-byte full cache at 3,312 ms. The full SHA-256 remained
`d3bf4181b9e1ddc936f31a9254d0745990fd4468077498186923f987b7452d77`.
Actual Chromium loads produced first line frames in 517.9 ms for the preview
and 502.6 ms for the full cache. Combining the independently measured stages
puts usable geometry at about 1.76 seconds instead of 3.81 seconds, a roughly
2.1-second perceived-loading gain. Peak JavaScript heap was 29.41 MiB for the
preview and 60.16 MiB for the full cache. The repeated overview work adds
roughly 0.3–0.4 seconds to total conversion.

Product-level qualification changed the default trade-off. In a stabilized VS
Code 1.131 host, four isolated balanced runs reached the first frame in
3,736–3,795 ms and added 530,435,720–595,660,352 bytes of de-duplicated
physical memory above the host baseline. The progressive path reached a frame
in 1,824 ms but added 664,686,480 bytes. During an immediate host-startup
overlap it added 919,359,496 bytes and failed the 800 MB hard limit.
Progressive preview therefore remains an explicit speed-first option rather
than the default.

## Process boundary

DWG parsing runs outside the VS Code extension host and Webview. The converter
writes a compact cache and exits, releasing transient parser memory. The
Webview receives only visible chunks and display metadata.

The `dwg-engine-adapter/1` benchmark boundary invokes `inspect` and `convert`
in a new process for every run. It records process wall time, adapter-reported
time, peak RSS and privacy-filtered compatibility fingerprints. Warmups are
excluded from aggregates, temporary caches are deleted per run, target gates
use the median and hard gates use the maximum. External engine wrappers must
produce the same inspection report and Scene Cache contract; documentation
feature tables alone do not select the primary parser.

If an inspect-only candidate already exceeds the 800,000,000-byte memory hard
limit, the runner rejects it before a cache writer exists. Parsing is a
mandatory subset of conversion. A candidate below that limit still remains
incomplete until the full conversion phase is measured.

The packaged-extension qualification is a separate process-tree measurement.
It launches an isolated VS Code instance, waits four seconds for the renderer
and extension-host baseline to stabilize, then opens the private reference
drawing through a temporary local driver. It samples RSS every 100 ms, but
uses de-duplicated macOS `footprint` or Linux proportional set size for the
product memory gate. Aggregate Electron RSS is diagnostic only because shared
code and mappings are counted once per process. Baseline-inclusive physical
memory is also diagnostic because VS Code's pre-existing host cost is outside
the extension. Reports contain numeric metrics and source size, never drawing
paths or text.

The runner performs both a full first-open and a close-during-conversion run.
The final macOS arm64 sample reached a full first frame in 3,745 ms, added
595,660,352 bytes above a 416,779,576-byte stable host baseline, and observed
the converter gone 286 ms after disposal. Three prior stable full runs added
530,435,720, 534,679,032 and 568,118,824 bytes; all passed the 600 MB target.

On the macOS arm64 reference environment, the current process-isolated
LibreDWG 0.14 inspection measured 810 ms median wall time and 591,380,480 bytes
median peak RSS. The retired acadrust candidate had measured 878 ms and
935,641,088 bytes.
After normalizing
LibreDWG's separate block markers, owned vertices, table records and attached
attributes, the drawing summary, entity-type counts, Hangul counts and
corruption markers match exactly.

The Scene Cache v1.4 LibreDWG milestone measured 4,069 ms median conversion
wall time and 592,101,376 bytes median peak RSS; measured maximums were
4,246 ms and 592,150,528 bytes. It wrote a deterministic 171,202,960-byte
valid cache with the same 4,194,304-byte overview, 512 KiB maximum detail
batch and 863 detail batches as the preceding Morton milestone. Adding source
text raised logical source coverage from 371,396 to 373,655 of 378,400
entities (98.75%). The remaining 4,745 logical entities are reported rather
than silently dropped.

The Scene Cache v1.5 HATCH-boundary milestone measured 3,526 ms median
conversion wall time and 592,216,064 bytes median peak RSS; measured maximums
were 3,601 ms and 592,232,448 bytes. It added 35,550 bounded HATCH boundary
segments with zero capped HATCH entities and zero non-finite skips. Full-detail
segments rose from 1,624,205 to 1,659,755. The deterministic cache grew by
2,277,760 bytes to 173,480,720 bytes, while the 4 MiB overview and 512 KiB
detail-batch caps stayed unchanged. HATCH source/fill records are deliberately
still deferred, so logical source coverage remains 373,655 of 378,400.

The Scene Cache v1.6 source-backed fill milestone measured 4,120 ms median
conversion wall time and 592,150,528 bytes median peak RSS; measured maximums
were 4,134 ms and 592,265,216 bytes. The extra bounded source passes increase
conversion time but still pass the 5-second target, while peak memory remains
at the parser-dominated v1.5 level. The deterministic cache is 175,428,864
bytes and contains 3,553 HATCH records, 6,365 usable closed loops, 31,511
`f64` fill vertices, 6,704 gradient colors and 3,653 seed points. Logical
source coverage rises to 377,208 of 378,400 entities (99.68%); the remaining
1,192 entities and skipped open/invalid HATCH paths stay explicit in the
report.

The Scene Cache v1.7 pattern milestone on LibreDWG 0.14 measured 2,941 ms
median conversion wall time and 591,659,008 bytes median peak RSS; measured
maximums were 2,957 ms and 591,740,928 bytes. The deterministic
175,985,184-byte cache adds
6,390 resolved pattern-definition records and 12,020 dash values. Those two
sections add 556,320 bytes over v1.6 while the line overview and detail
batches remain unchanged. The retired acadrust candidate measured 7,642 ms
median and 969,310,208 bytes median peak RSS, confirming the reason it was
removed while LibreDWG passes both conversion gates.

The Scene Cache v1.8 POINT/SOLID milestone measured 2,986 ms median conversion
wall time and 591,511,552 bytes median peak RSS; measured maximums were
3,028 ms and 592,150,528 bytes. It adds 621 POINT records (69,552 bytes), 350
SOLID records (58,800 bytes) and two 40-byte directory entries. The
deterministic cache is 176,113,616 bytes, exactly 128,432 bytes larger than
v1.7. Logical source coverage rises from 377,208 to 378,179 of 378,400
entities (99.94%), leaving 221 deferred. Both conversion gates still pass.

The DIMENSION picture-block follow-on keeps the v1.8 format and all 29
sections. It resolves all 171 DIMENSION references in the reference drawing
as one-by-one identity block instances, while `coverage.inserts` remains the
3,659 source INSERT/MINSERT count. Coverage rises to 378,350 of 378,400
entities (99.99%), leaving 50 deferred. Kind 13 grows from 497,624 to 520,880
bytes and the deterministic cache grows by exactly the same 23,256 bytes to
176,136,872 bytes. Kinds 30–31 are byte-identical before and after the change.
Three isolated measured processes completed in 2,921 / 3,215 / 3,860 ms with
590,036,992 / 591,691,776 / 591,708,160 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both conversion gates passed.

The Scene Cache v1.9 3DFACE milestone adds one 40-byte directory entry and 34
fixed 136-byte records. The deterministic cache grows by exactly 4,664 bytes
to 176,141,536 bytes. Kinds 2–40 remain byte-identical; only the kind-1
serialized-entity count changes with coverage. Coverage rises to 378,384 of
378,400 entities (99.996%), leaving only 16 WIPEOUT records deferred. Three
clean process-isolated conversions completed in 3,153 / 3,715 / 4,082 ms with
591,446,016 / 591,675,392 / 591,888,384 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both conversion gates passed.

The Scene Cache v1.10 WIPEOUT milestone adds two 40-byte directory entries,
16 fixed 168-byte entity records and 627 16-byte clip vertices. The
deterministic cache grows by exactly 12,800 bytes to 176,154,336 bytes.
Kinds 2–41 remain byte-identical. Logical source coverage reaches all 378,400
entities with zero converter-deferred records, while all 16 background masks
remain explicitly deferred at the Webview layer until draw-order rendering is
implemented. Three clean process-isolated conversions completed in
2,880 / 2,886 / 2,890 ms with
591,691,776 / 591,724,544 / 591,724,544 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both conversion target gates passed.

Scene Cache v1.11 adds two more directory entries plus 508 fixed 40-byte
draw-order table records and 54,667 fixed 16-byte entity/sort-handle pairs.
The deterministic cache grows by exactly 895,072 bytes to 177,049,408 bytes
while kinds 1–43 remain byte-identical to v1.10. Tables are normalized by
block owner/table handle and entries by entity/sort handle because source
entry enumeration order has no draw-order meaning. The archived cross-engine
qualification produced byte-identical kind-44 and kind-45 payloads.

Three isolated conversions completed in 2,983 / 2,999 / 3,009 ms with
591,773,696 / 591,822,848 / 591,822,848 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both conversion target gates passed.

The 0.14 cache and normalized conversion report are byte-identical to the
0.13.4 result on the reference drawing, while median conversion time improves
from 4,140 ms to 2,941 ms. Nightly `0.14.xxxx` prereleases are not used as the
reproducible engine pin.

The latest ACadSharp 3.6.51 parser preflight measured 4,014 ms median wall time
and 1,452,392,448 bytes median peak RSS; measured maximums were 4,098 ms and
1,452,474,368 bytes. It preserved the logical entity, block and Korean text
fingerprints, but parser memory alone exceeds the hard limit by more than
650 MB. No ACadSharp cache writer is planned.

The archived cross-engine qualification of public LibreDWG fixtures covered
every HATCH mode.
`example_2018.dwg` produces one pattern HATCH, two definition lines and four
dash values; kinds 37–38 were byte-identical between the compared engines. Its
46 POINT and 15 SOLID records also produce byte-identical kind-39 and kind-40
payloads. The fixture's nine DIMENSION picture blocks resolve in both engines
and produce 19 total kind-13 records: ten source INSERTs plus nine dimension
references.
`2000/entities-3d.dwg` adds a reproducible 3DFACE check: both engines preserve
the same invisible-edge flags and four WCS corners.
`example_2018.dwg` also provides two polygonal WIPEOUTs and 16 clip vertices;
both engines produce byte-identical kind-42/kind-43 payloads and drawing-wide
frame setting 1. The Webview emits 16 frame edges in 1,024 GPU bytes while
reporting both masks as draw-order deferred.
`2018/Dynblocks.dwg` matches at one solid plus three pattern HATCHes, eight
loops, 104 fill vertices and four definition lines, with identical pattern
sections. `2004/HatchG.dwg` matches at two gradient HATCHes, two loops and 269
fill vertices. Both generated caches validate in every case, with no
truncation or invalid-record skip.

The new text-style and text-source payload is 793,407 bytes on the reference
drawing. Its 2,289 records include 2,259 logical TEXT/MTEXT/ATTDEF records and
30 attached ATTRIB records. The cache reproduces the inspection fingerprint
exactly: 690 Hangul-bearing records, 2,674 Hangul characters and zero null,
replacement or question-mark corruption markers.

The first-frame range path remains eight reads and grows by only the three
new 40-byte directory entries, from 4,998,797 to 4,998,917 bytes. After that
frame, source text requires three additional reads totaling 793,407 bytes.
A Node-based range-reader measurement completed header, metadata, 94,814 block
instances and overview in about 324 ms with about 124 MB process RSS; text
validation and loading took about 5 ms more. This is a qualification
measurement rather than a browser-memory guarantee, but it confirms that the
cache is not read wholesale.

With v1.5 boundary batches, the same first-frame path remains eight reads and
5,001,477 bytes. The 2,560-byte increase is only the larger GPU batch
directory; overview vertices remain exactly 4,194,304 bytes.

With v1.6, the five new directory entries add only 200 bytes to that path:
eight first-frame reads total 5,001,677 bytes. A Node range-reader
qualification loaded the five post-frame HATCH sections in five reads totaling
1,947,941 bytes in 11.8 ms, then triangulated the supported fills in 14.9 ms.
It rendered 379 solid HATCHes as 5,585 triangles in a 536,160-byte GPU buffer;
3,161 pattern HATCHes were retained but skipped, the 32 MiB GPU cap was not
reached, and process peak RSS was about 122 MB. These are local qualification
figures rather than a cross-device browser guarantee.

With v1.7, two directory entries add 80 bytes to the same path: eight
first-frame reads total 5,001,757 bytes, and the unchanged overview remains
4 MiB. Loading the seven HATCH source sections took seven reads totaling
2,504,181 bytes and 13.6 ms. An end-to-end persistent-worker qualification
including its own block-instance graph, fill mesh and fitted-view pattern pass
completed in about 414 ms at about 137 MB process RSS.

With v1.8, two more directory entries add 80 bytes: the first-frame path is
still eight reads and now totals 5,001,837 bytes. POINT and SOLID data are not
part of those reads. Their one-shot post-frame qualification used six reads
totaling 686,107 bytes, including block and INSERT metadata, and completed
validation, instance-graph construction and mesh generation in 289.2 ms at
about 111 MB process RSS. It rendered all 621 POINT and 350 SOLID records into
a 66,624-byte GPU payload without reaching a cap or skipping an owner.
An actual Chromium run produced the first usable line frame in 506.2 ms,
reported all 621 POINT and 350 SOLID records, used 4.57 MiB of GPU vertex
buffers at drawing fit and emitted no console warning or error.

The DIMENSION follow-on does not add a read. The same eight-read path grows
from 5,001,837 to 5,025,093 bytes, exactly matching the 23,256-byte kind-13
increase while the overview remains 4 MiB. Every one of the 171 source
references is reachable. Repeated block ownership expands them into 2,668
direct picture occurrences plus 380 nested downstream instances, moving the
graph from 94,814 to 97,862 packed matrices. The exact matrix payload increase
is 390,144 bytes. A local Node qualification completed metadata validation,
graph construction and overview loading in 345.6 ms at 123,076,608 bytes peak
RSS. An actual Chromium run produced the first usable line frame in 450.0 ms,
kept GPU vertex buffers at 4.57 MiB and emitted no warning or error.

With v1.9, one directory entry adds only 40 bytes to the first frame: eight
reads total 5,025,133 bytes and do not touch the 3DFACE section. The post-frame
primitive path uses seven reads totaling 714,027 bytes. It renders all 34
faces as 114 visible edges, omitting ten source-hidden and twelve degenerate
edges. The face portion adds 7,296 GPU bytes; the complete POINT/SOLID/3DFACE
payload is 73,920 bytes and reaches no cap.
An actual v1.9 Chromium run produced the first usable line frame in 464.0 ms,
reported all 34 faces and 114 visible edges, used 4.58 MiB of GPU vertex
buffers at drawing fit and emitted no console warning or error.

With v1.10, the two new directory entries add 80 bytes to the first-frame
path: eight reads total 5,025,213 bytes and do not touch kinds 42–43. The
isolated primitive worker uses nine reads totaling 726,827 bytes for
block/INSERT metadata and kinds 39–43. It validates all 16 WIPEOUTs and 627
clip vertices. The reference drawing's global frame setting is off, so
WIPEOUT adds zero GPU bytes; the complete primitive payload remains 73,920
bytes, and 16 masks are reported as awaiting draw-order rendering.

An actual v1.10 Chromium run produced the first usable line frame in 502.8 ms,
reported all 16 WIPEOUT sources, zero frames and 16 deferred masks, used
4.58 MiB of total GPU vertex buffers at drawing fit and emitted no console
warning or error. The public fixture reported both enabled WIPEOUT frames and
both deferred masks without a console error.

With v1.11, the first-frame path grows only by the two 40-byte directory
entries and still does not touch draw-order bodies. A direct range
qualification opened the 177 MB cache in two reads totaling 1,424 bytes, then
loaded all 508 tables and 54,667 entries in two independent reads totaling
894,992 bytes. The sections remain outside the primitive worker and first
usable line-frame path.

An actual Chromium qualification produced the first usable line frame in
449.1 ms. At drawing fit, the 1.5-pixel rule omitted all 6,442 visible
definition passes and emitted no pattern buffer. After eight zoom-in actions
(17.35x), the worker emitted 540 clipped segments (33.8 KiB) for 6 HATCHes.
With the 32 MiB detail cache full, overview, detail, fill and pattern vertex
buffers totaled 36.54 MiB. Layer all-off/all-on changed the visible count from
234 to 0 and back to 234 without a source reread; no browser console error was
reported. The largest measured sequential Node qualification RSS was about
147 MB. These figures validate bounded behavior on the reference drawing, not
a cross-device frame-rate guarantee.

The external sort keeps either one 8,192-record run or its small merge windows
resident, while two private unnamed files consume about 312 MB of temporary
disk at peak for the reference drawing and disappear on close.

At the measured v1.11 milestone, the parser itself accounted for almost all
RSS: the conversion maximum was only 8,177,152 bytes below the
600,000,000-byte target.
Therefore future LibreDWG coverage must retain streaming or disk-backed
bounded passes; a whole-drawing geometry vector would erase the margin.

The implemented Webview first-frame path opens the cache with `Blob.slice`
or HTTP byte ranges. It validates the 64-byte header and section directory
before reading metadata, resolves nested INSERT/MINSERT and DIMENSION-picture
transforms into packed matrix arrays and uploads one bounded overview vertex
prefix to WebGL2.
World-space transforms remain `f64` on the CPU; the renderer rebases each
batch around the camera before converting matrices to `f32`.

## Data rules

- No entity-per-JavaScript-object scene model.
- No entity-per-Three.js-object renderer.
- Coordinate data is stored in packed typed-array-compatible buffers.
- Block definitions are stored once and referenced by transform instances.
- Chunks can be loaded and released independently.
- Unsupported entities are reported; they are never silently dropped.
- Cache identity includes the source fingerprint and converter format version.

## Implemented cache slice

Scene Cache v1.10 writes the drawing/layer/block/text-style tables and
source-precision LINE, ARC, CIRCLE, INSERT, LWPOLYLINE/POLYLINE, ELLIPSE,
SPLINE, TEXT, MTEXT, ATTDEF, ATTRIB, POINT, SOLID, 3DFACE and WIPEOUT
records. Resolved DIMENSION picture blocks share the kind-13 block-instance
stream. The records retain owner handles so block definitions remain shared
instead of being expanded per insertion. Text values, tags, prompts, font
filenames and BigFont filenames remain UTF-8, while MTEXT column heights and
WIPEOUT clip points use separate packed `f64` pools. The Webview reads MTEXT
WCS X-axis, attachment, background, column count, width, gutter and the shared
height pool only after the first geometry frame. It limits a record to 64
columns and paints its background inside the existing XCLIP/WIPEOUT Canvas
clip before drawing glyphs. The same delayed pass parses at most 4,096 code
points and 32 nested inline-format levels. Font, ACI color, height, width,
tracking, oblique and text-decoration changes stay as compact runs instead of
per-character objects. A previously unseen visible `\f` family triggers one
deduplicated host request; off-screen strings remain undecoded and cannot
start font scans.
HATCH adds source records plus bounded closed `f64` ring, gradient-color and
seed-point pools. Pattern-definition lines preserve parser-resolved angles,
bases, offsets and dash/gap/dot sequences in separate typed pools. Original
analytic HATCH edge topology is not yet a lossless source record.

The v1.2 display slice added local-origin `f32` line buffers. It keeps model
space and block definitions separate, assigns every non-empty block a bounded
overview allocation within the then-current global 65,536-segment budget,
writes the complete first-frame vertex set as one contiguous prefix of at most
4 MiB and caps each spatial detail batch at 512 KiB. The current 36-byte
vertex format uses 58,254 overview segments and 7,281 detail segments to keep
those same byte limits.

The v1.3 display slice adds bounded first-pass chords for ARC, CIRCLE, ELLIPSE,
polyline bulges and NURBS SPLINE entities. Circular curves use at most 16
segments per revolution. Valid splines use two segments per non-empty knot span
with a 256-segment entity cap; malformed splines fall back to bounded fit-point
or control-point chords. Approximation bits stay attached to the GPU vertices,
and the source-precision records remain available for later view-adaptive
high-zoom refinement. That refinement evaluates valid NURBS data first and,
when a drawing stores only fit data, constructs a bounded cubic interpolant
using chord, square-root chord or uniform spacing, stored endpoint tangents and
periodic closure. Batch-local position error is recorded as a conservative
`f32` upper bound without a second geometry traversal.

The v1.5 display slice extends the same path to HATCH boundaries. Each HATCH
is traversed directly from the parser object and contributes at most 65,536
segments; straight edges, circular/elliptic arcs, bulges and rational spline
edges all stay in the existing overview, Morton detail and byte-bounded cache
pipeline. Reports count rendered boundary segments and capped HATCH entities.
Solid, gradient and clipped pattern fills are intentionally left for a
separate source-backed renderer.

The current converter applies a denser bounded rule only to those HATCH
boundaries: circular, elliptic and bulge curves use at most 64 chords per
revolution, while curved spline knot spans use eight and remain capped at
1,024 spline segments. A HATCH spline that contains fit points but lacks a
valid control-point/knot definition uses a chord-parameterized cubic Hermite
path, including stored endpoint tangents and periodic closure, rather than
straight fit-point links. Ordinary first-frame curves keep the original
16/two limits because their analytic source is refined after zoom settles.
The public `2004/HatchG.dwg` fixture consequently retains 1,064 rather than
269 HATCH ring vertices without reaching a per-entity or global cap.

The v1.6 fill slice implements that separate path without changing the line
first frame. After the overview is visible, a dedicated worker reopens the
local cache, range-reads only the five HATCH sections, triangulates solid and
gradient rings with the pinned ISC-licensed Earcut implementation and
transfers only the final packed GPU buffer. Fills use the same shared block
ownership and layer texture as line geometry, are split into local-origin
batches and draw before boundary lines. Source planning is capped at 65,536
vertices per HATCH and 1,048,576 globally; browser work is capped at 2,048
loops and 65,536 triangles per entity and 32 MiB of GPU vertices overall.
Opening another file terminates the previous worker.

Gradient batches retain the named AutoCAD profile as a compact descriptor.
The fill fragment shader evaluates LINEAR, CYLINDER, SPHERICAL,
HEMISPHERICAL, CURVED and all inverse forms from HATCH-local coordinates,
angle and shift, avoiding a profile-dependent tessellation increase. Unknown
names use LINEAR while incrementing an explicit diagnostic counter.

The v1.7 pattern slice retains the same worker and source buffers after fill
initialization. Camera changes are debounced by 160 ms and regenerate pattern
strokes without cache reads. Infinite pattern lines are intersected with
normal/outer/ignore ring groups, dashed in source units and clipped to the
current viewport. Definitions below 1.5 screen pixels are omitted before
intersection work. For shared block definitions, only the union of visible
instance intervals is generated and the GPU draw uses an explicit visible
instance-index set, so a heavily reused block does not expand into one mesh
per block instance.

Pattern work is capped at 2,048 loops, 65,536 segments per HATCH, 250,000
segments globally and eight million edge intersection tests; the packed
vertices have both a 16 MiB effective segment cap and a 32 MiB byte guard.
Local origins retain display precision at large coordinates. Positive dash
values draw, negative values skip and zero values become one-pixel dots.
User-defined double patterns add the perpendicular pass; predefined
definition lines are already resolved by the native parser.

The v1.8 POINT/SOLID slice also stays outside the line first frame. A
one-shot worker range-reads the two source sections plus block-table and
block-instance metadata, reuses the instance graph including DIMENSION picture
references,
transfers only the packed display buffers and exits. POINT keeps WCS location
and drawing `PDMODE`/`PDSIZE`;
its shader draws bounded screen-space glyphs. SOLID keeps four OCS corners in
1-2-4-3 perimeter order and drawing `FILLMODE`; the worker applies the arbitrary-axis transform and
emits either fill triangles or three/four outline edges.

The v1.9 3DFACE slice adds WCS corners and four source invisible-edge bits to
that worker. The wireframe view emits only visible, non-degenerate edges and
appends them to the existing surface-outline packed buffer. It does not fill
faces implicitly; retaining the complete source record leaves that decision
for a future explicit shaded mode without reparsing the DWG.

The v1.10 WIPEOUT slice adds its insertion/U/V image basis, size, display and
clipping metadata, definition handles, exact rectangular or polygonal clip
vertices, and the drawing-wide frame setting. The first-frame reader touches
only the enlarged directory and existing drawing record. The one-shot worker
reads WIPEOUT source later and appends enabled frames to the shared surface
outline buffer.

The v1.11 draw-order slice preserves each `SORTENTSTABLE` handle, associated
block owner and normalized entity/sort-handle pairs under fixed record caps.
The Webview validates contiguous table ranges and deterministic ordering only
when the post-first-frame renderer requests them. It keeps only WIPEOUT and
INSERT order events, recursively folds child/MINSERT mask spans into their
owners, and attaches an order base to each existing instance collection
without copying its transform matrices. Line diagnostic/source-kind style
bits, which are not consumed by the shader, become a 15-bit block-local mask
bucket after the first frame.

WIPEOUT boundaries are triangulated once and drawn to the background color
before all other geometry. A 24-bit depth buffer with `GEQUAL` then rejects
fragments below a later mask while allowing equal-order geometry after that
mask to redraw. HATCH fill/pattern, POINT, SOLID, 3DFACE and streamed line
detail use the same bucket contract. Canvas text independently subtracts
only higher-order mask polygons. Expanded masks are capped at 10,000 and their
GPU triangles at 8 MiB; invalid/inverted boundaries, duplicate critical sort
keys, cycles and depth/instance/order limits disable all masks.

POINT source is capped at 262,144 records and 8 MiB of GPU vertices. SOLID
and 3DFACE source are each capped at 131,072 records. WIPEOUT is capped at
65,536 records and 1,048,576 clip vertices. SOLID fill vertices are capped at
16 MiB, while SOLID, 3DFACE and WIPEOUT share the existing 8 MiB outline
buffer. WIPEOUT mask triangles have a separate 8 MiB cap, making the combined
primitive GPU hard limit 40 MiB. This worker runs before
HATCH initialization so the two source-buffer peaks do not overlap, and
opening another file cancels unfinished work.

Large-drawing detail records are ordered by group and a 32-bit interleaved XY
Morton key computed from each segment midpoint within that group's finite
bounds. Original traversal order resolves key ties deterministically. The
LibreDWG writer creates sorted 8,192-record runs in a private temporary file
and performs one bounded k-way merge into a second file, so it never retains
the complete spatial index or geometry set in memory.

Detail ranges are independently capped at 512 KiB. The Webview includes a
byte-budgeted least-recently-used cache so viewport refinement can release
inactive chunks instead of retaining the complete drawing. After the fitted
overview, detail selection starts only at 4x zoom, intersects model and
transformed block bounds with the viewport and limits one visible working set
to 32 MiB. GPU detail resources use a 96 MiB LRU budget. Camera revisions stop
stale queued work, while at most two in-flight local reads are allowed to
finish and become reusable cache entries.

The per-draw instance upload uses one geometrically growing `Float32Array`
scratch buffer capped at 16,384 matrices (1,114,112 bytes with the mask-base
value). Every matrix value is overwritten before upload, so subsequent batched
draws reuse the same backing store instead of allocating a new array for every
draw call. Renderer metrics report the current scratch size, the current and
peak instance-buffer allocation, layer-texture bytes, vertex-buffer bytes and
their tracked WebGL total. A per-drawing telemetry object samples Chromium's
current and peak JavaScript heap when `performance.memory` is available. It
reports the API as unavailable elsewhere rather than inventing a process-memory
estimate. Driver allocations, shader programs and the browser-owned default
framebuffer are explicitly outside the tracked WebGL total.

Text is deliberately outside the first geometry frame. The Webview then reads
the three v1.4 text ranges and keeps the 336-byte records in their packed
buffer. Numeric display fields are read into one reused scratch record;
UTF-8 values are decoded only for text that survives pixel-size and viewport
culling. One redraw is capped at 50,000 source records, 10,000 visible
occurrences, 250,000 SHX line segments and 50,000 system-font fallback
glyphs.

The MIT-licensed `@mlightcad/shx-parser` is used only after the first geometry
frame. The standalone browser harness accepts user-selected SHX files. In the
VS Code Custom Editor, the extension host extracts only referenced SHX,
BigFont, TTF and OTF names from the loaded style table. It tries an existing
stored relative or native absolute path, the drawing directory, bounded
project/package roots, then up to 31 explicitly configured non-recursive
fallback directories. Same-rank normalized matches are ambiguous rather than
chosen by traversal order. User mappings or the font-panel picker can bind a
requested name to an explicit local file for the current drawing. Files are
transferred one at a time, and the Webview receives no resolved host filesystem
path beyond any original reference already embedded in the DWG style table.

Layout CTB discovery uses the same stored, drawing, bounded project and
configured fallback order. Its manual picker installs a session mapping after
an ambiguous or missing result. Parsed color and lineweight tables cross the
host boundary instead of the CTB bytes or path, and only the referencing layout
can enable that plot style.

Host font reads are isolated by cache ID and capped at 128 requests, 32 MiB per
file and 64 MiB transferred per drawing. Primary SHX and paired BigFont names
are normalized by basename, extension and case. Legacy Korean codes are not
inferred from filenames. Automatic mode probes the actual font in strict
EUC-KR, CP949/UHC and Johab/CP1361 order, de-duplicating identical code
candidates. A window-scoped map can force one of those encodings for up to 128
requested BigFont names; only normalized names and encoding labels cross into
the Webview.

Strict EUC-KR is limited to the KS X 1001 `A1A1-FEFE` two-byte region
documented by [Unicode](https://www.unicode.org/iuc/iuc15/tb1/slides.pdf).
The CP949 path adds the ordered UHC Hangul extension and was checked against
all 11,172 modern syllables in Unicode's
[CP949 mapping](https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP949.TXT).
Johab uses its initial/medial/final five-bit composition and matches the
11,172-row [Unicode Technical Note #60 data](https://www.unicode.org/notes/tn60/tn60-2.html).
The KS X 1001 row transform is checked against Unicode's authoritative
[Windows CP1361 best-fit mapping](https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WindowsBestFit/bestfit1361.txt)
and adds 892 symbols, 4,888 Hanja, `®` and `€`. Compatibility and archaic
Jamo without an explicit CP1361 slot fall through to a direct Unicode SHX
glyph or the local system-font fallback.

Glyphs are parsed lazily into compact `Float32Array` line pairs and retained
in a byte-bounded LRU. Switching an encoding map clears compiled glyph
lookups but retains the registered font bytes. Webview limits are
32 MiB per font file, 64 MiB registered font bytes, 48 MiB concurrently parsed
font bytes, 4,096 compiled glyphs, 64 MiB compiled glyph bytes and 8,192
segments per glyph. One malformed glyph is negatively cached without disabling
the rest of its font. A malformed font is isolated and reported separately.
Missing fonts or glyphs use an upright local system-font fallback so Korean
text remains readable.

Layer visibility is stored in a compact one-dimensional GPU texture indexed by
the existing layer index on every vertex. Hiding a layer therefore updates only
that texture and redraws the current camera; it does not reread cache ranges,
rebuild geometry or upload vertex buffers. The visibility test runs before
color resolution in the fragment shader, so by-layer and explicit-color
entities follow the same hidden-layer state. The Webview layer panel searches
Unicode names locally and supports individual, all-on and all-off changes.

## Performance gates

| Metric | Target | Hard limit |
| --- | ---: | ---: |
| Native conversion | <= 5 s | <= 8 s |
| First usable frame | <= 5 s | <= 8 s |
| Full refinement | <= 10 s | <= 15 s |
| Native converter peak RSS | <= 600 MB | <= 800 MB |
| Product incremental physical memory | <= 600 MB | <= 800 MB |
| Stable Webview memory | <= 200 MB | <= 300 MB |
| Dropped blocks | 0 | 0 |
| Hangul replacement/loss | 0 | 0 |

These gates apply to the current 24MB/approximately 378k-entity reference
drawing. Product memory is measured above a stabilized VS Code baseline;
baseline-inclusive physical memory and aggregate RSS remain diagnostics.
Results from private drawings must not be committed.

## Privacy

Real drawings and generated reports may contain project names, addresses,
handles and text. They are ignored by default. Only synthetic or explicitly
redistributable fixtures belong in the public repository.
