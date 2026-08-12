# `@menaje/viewer-webgl`

Host-neutral Viewer Core presentation mount와 DWG Scene Cache WebGL2
renderer입니다. 공개 entrypoint는 DOM을 자동 탐색하거나
`acquireVsCodeApi()`를 호출하지 않습니다. `mountWebGlPresentation()`은
제품이 주입한 scene loader를, `mountDwgWebGlPresentation()`은
`@menaje/dwg-scene-source` range layer를 사용합니다.

`src/main.mjs`, `index.html`과 `styles.css`는 독립 DWG Viewer 제품 shell과
개발·검증 harness입니다. 이 bootstrap과 `dwg-*` Host message는 공개
embedding 계약이 아니며 package export map에 노출되지 않습니다.

```js
import {
  mountDwgWebGlPresentation,
} from "@menaje/viewer-webgl";

const runtime = await openViewerRuntime(source, {
  host,
  mount: (context) =>
    mountDwgWebGlPresentation(context, { canvas }),
});
```

## DWG Viewer product shell

Scene Cache v1.26 range reader, WebGL2 line/fill/point renderer, bounded CAD
text overlay and lazy raster IMAGE overlay for the VS Code Webview.

Standalone Browser의 `File`과 VS Code의 cache channel은 모두
`DwgSceneCacheSource -> Viewer Core runtime -> render-layer range source`를
거쳐 같은 renderer를 mount합니다. Viewer Core가 source/snapshot,
presentation과 Host disposal을 소유하고, 기존 worker transport는
DWG 제품 내부 구현으로 유지됩니다. 2D camera의 canonical 구현은
`viewer-core`에 있으며 source-neutral GPU batch cache와 함께 과거 Webview
import path는 re-export입니다. Viewport interaction lifecycle도 Core
구현을 상속합니다. Core의 renderer controller가 root/XREF detail target을
조정하고 generic detail streaming controller가 cache·concurrency·폐기를
소유합니다. Webview wrapper는 Scene Cache batch 가시성 계산과 vertex
reader/WebGL mapping만 주입합니다. 객체 선택은 DWG candidate decoder에
남지만 선택 상태는 active snapshot에 묶인 Core controller를 통해
`selection.changed` Host event로 전달됩니다.
Review toolbar의 활성 상태, `aria-pressed`, generic result row/action
composition과 DOM listener disposal은 `@menaje/viewer-ui`가 소유합니다.
이 package는 CAD candidate를 알지 않으며 Webview의 `ReviewTools`가 DWG
속성과 측정 결과를 bounded view model로 투영합니다.

`DwgRenderDeltaAdapter`는 Core의 source-neutral atomic delta hook과 이
package의 private line/triangle-fill/POINT/Canvas-text/instance-transform/
instance-style packet을 연결합니다.
payload resolver가
descriptor의 digest와 byte bound를 검증한 decoded packet을 동기적으로
제공하면 adapter는 모든 WebGL/Canvas/instance resource를 먼저 stage한 뒤 한 번에
활성화합니다. base Scene Cache buffer는 수정하지 않고 line vertex의 DWG
handle과 fill·pattern·POINT·surface·WIPEOUT의 압축 identity-range sidecar로
draw range만 제외합니다. Canvas text도 같은 source/handle suppression을
적용하므로 preview rollback은 base를 다시 읽거나 GPU buffer를 복원하지
않습니다. 같은 state가 native identity별 upsert/tombstone pick 상태도
제공합니다. adapter는 renderer가 반환한 staged resource의 소유권을
명시적으로 추적하고 commit/promotion/rollback cleanup이 실패하면 직전
committed/preview renderer state를 다시 활성화하므로 같은 전이를 안전하게
재시도할 수 있습니다. source switch와 idempotent disposal은 active 여부와
무관하게 소유한 GPU/Canvas/instance resource를 정확히 한 번 회수합니다.

## Full-scene revision comparison

`mountWebGlRevisionComparison()`은 이미 mount된 public presentation,
`DwgRenderDeltaAdapter`, Core의 revision-bound diff controller와 제품이
제공한 container를 결합합니다. base와 candidate에 별도 WebGL context와
전체 Scene Cache를 복제하지 않습니다. 하나의 `WebGlLineRenderer`가 exact
base/target revision을 직렬로 활성화해 같은 logical camera로 그린 뒤,
current/candidate 결과를 두 개의 bounded 2D surface에 보존합니다. 따라서
두 화면을 동시에 비교하면서도 기존 단일 surface 제품 경로는 이 API를
호출하지 않는 한 바뀌지 않습니다.

```js
import {
  mountWebGlRevisionComparison,
} from "@menaje/viewer-webgl/comparison";

const comparison = mountWebGlRevisionComparison({
  presentation,
  renderDeltaAdapter,
  renderDiffController,
  container: comparisonElement,
  camera: { origin: [0, 0, 0], worldHeight: 100 },
});

comparison.setCamera({ origin: [20, 10, 0], worldHeight: 50 });
comparison.select("before", {
  revisionId: baseRevisionId,
  layerId,
  renderId,
});
comparison.setSideVisibility({ before: true, after: false });
comparison.dispose();
```

Mount 전에 presentation snapshot, diff의 session/source/base snapshot,
base/committed/target revision과 preview ID가 모두 일치해야 합니다. 하나라도
다르면 첫 surface를 그리기 전에 fail-closed합니다. `setCamera()`,
`setCameraFrom()`, selection/highlight, diff policy와 resize는 원자적
transition이며 candidate capture가 실패하면 last-good current/candidate
pixel과 logical camera를 복원합니다. added와 removed는 실제 존재하는 쪽에만,
modified는 exact layer/Render ID가 일치하는 양쪽에만 강조됩니다. pick의
revision이 해당 surface와 다르면 stale pick으로 거부합니다.

두 최종 RGBA surface의 기본 합계 한도는 16,777,216 pixels(64 MiB)이며,
transition rollback용 임시 surface는 각 transition 뒤 즉시 해제됩니다.
`dispose()`는 생성한 Canvas와 listener를 한 번만 회수하고 원래 render
canvas의 DOM/접근성 상태를 복원합니다. 호출자가 주입한 비교 Canvas는
제거하지 않고 원래 DOM 위치·크기와 이 컨트롤러가 바꾼 inline style/속성을
복원합니다. presentation과 delta adapter의
소유권은 호출자에게 남으므로 source switch나 host 종료 때는 comparison을
먼저 닫은 뒤 adapter와 presentation을 각각 dispose해야 합니다.

2026-08-10 qualification은 640×360 current/candidate RGBA surface 두 개에
1,843,200 bytes를 유지했고, 독립 Browser의 actual WebGL2 첫 비교 frame은
24 ms, 패키징된 VS Code 1.132.0 Webview는 40 ms였습니다. 패키징 검증은
동반 엔진 확장 없이 main VSIX만 설치해 수행했습니다. actual pixel,
camera rollback, stale selection, corresponding highlight, visibility와 8회
반복 mount/close 후 Canvas/GPU delta 기준선 회귀를 모두 확인했습니다.
경로 없는 결과는
[`compatibility/evidence/viewer-webgl-comparison-2026-08-10.json`](../../compatibility/evidence/viewer-webgl-comparison-2026-08-10.json)에
기록됩니다.

The current decoded v6 packet is private to this package:

```text
{
  payloadId, sha256, byteLength,
  operations: [{
    operationId,
    lines: [{ renderId, sceneId, batch, vertices, instanceIndices }],
    fills: [{ renderId, sceneId, batch, vertices, instanceIndices }],
    points: [{ renderId, sceneId, batch, vertices, instanceIndices }],
    texts: [{ renderId, sceneId, buffer }],
    transforms: [{ renderId, sceneId, buffer }],
    styles: [{ renderId, sceneId, buffer }]
  }]
}
```

`byteLength` is the exact sum of the non-shared 36-byte line, 32-byte
triangle-fill, 32-byte POINT, UTF-8 JSON text and fixed 272-byte instance
transform and 40-byte instance-style buffers. Every line vertex, text record,
transform occurrence or style occurrence handle must match its operation's
`dwg:<sceneId>:<handle>` Render ID. Each fill, POINT, text, transform or style
entry belongs to exactly one Render ID, and every visual upsert Render ID must
be covered across the six streams. A
transform record binds one existing block/index occurrence to separate
display and measurement affine matrices. It replaces only that packed matrix,
so the shared block geometry is neither copied nor re-uploaded. A style record
binds `blockIndex`, `instanceIndex` and handle, then uses canonical flag-gated
fields to partially override resolved color, layer, opacity, line weight,
linetype and visibility in the same packed occurrence metadata used by WebGL,
Canvas text and raster IMAGE. Inactive fields and the three reserved tail
bytes must be zero. Nested root/XREF changes replay the compact instance
topology and materialize only affected descendant occurrence matrices or
resolved style records, without cloning block geometry. Direct clipped
transforms and parent transforms with an affected XCLIP descendant remain
fail-closed until clip recomputation is available; style-only updates remain
valid for clipped occurrences. Derived transforms and styles each have an
8 MiB bound. Repeated/MINSERT cells for one native handle require complete
atomic coverage.
One text record is capped at 256 KiB; staged Canvas text, transforms and styles
each use separate 8 MiB CPU bounds. Packet
lookup and digest verification happen before the synchronous Core apply
boundary; the adapter rechecks descriptor binding, operation coverage, byte
bounds and native identity before allocating renderer resources. The v1
line-only, v2 line/fill, v3 line/fill/POINT, v4 Canvas-text and v5
instance-transform media types remain readable while producers move to v6.

The standalone page is the development and qualification shell: it keeps the
framed canvas, diagnostics and full memory/performance dashboard. When hosted
by VS Code, the same renderer switches to an immersive shell that fills the
editor with the drawing, hides metrics and reveals its edge tool shelf and
layout tabs on hover, focus or an explicit click.

## Localization

The Webview shell resolves its locale before binding controls. VS Code passes
`vscode.env.language` through the generated `<html data-locale>` attribute;
the standalone browser uses `navigator.languages`. Exact locales fall back to
their base language (`ko-KR` → `ko`), and unsupported or invalid values fall
back to English.

English and Korean catalogs live in `src/locales/en.mjs` and
`src/locales/ko.mjs`. To add a language, create a catalog with the same keys
and register it in `src/locales/index.mjs`. Static text and accessibility
attributes use `data-i18n`, `data-i18n-title`,
`data-i18n-aria-label`, and `data-i18n-placeholder`; runtime labels use the
same catalog through `createI18n().t()`. The catalog-alignment tests fail when
built-in languages, template keys, or runtime shell keys diverge.

## Implemented

- Reads the cache header and section directory without loading the full file.
- Accepts local `Blob`/`File` sources and strict HTTP byte-range sources.
- Validates section bounds, record sizes, string tables and GPU batch ranges.
- Limits the overview to 8 MiB on read; current converters emit at most 4 MiB.
- Limits each detail read to 512 KiB.
- Resolves nested INSERT, MINSERT and DIMENSION picture-block references while
  keeping block geometry shared.
- Reads current original XREF paths, composes each child model/block instance
  under its parent INSERT and preserves shared geometry across repeated inserts.
  Saved unloaded or unresolved XREF blocks are retained for diagnostics but are
  not requested or mounted for display.
- Reads current INSERT/XREF spatial clips, propagates nested clip chains through
  shared instances and applies one boundary to WebGL geometry and Canvas text.
- Reads the v1.26 linetype, saved-view, layout, VIEWPORT and raster IMAGE
  sections and
  allows every paper-space tab to be selected without duplicating model data.
- Applies VIEWPORT group-68 activity/stacking and the group-90 off bit before
  building model roots, including inactive-layout fallback without reviving an
  explicitly off-screen viewport.
- Applies each viewport's layer color, transparency, linetype and lineweight
  overrides consistently to WebGL geometry, Canvas text/complex linetypes and
  raster images while preserving shared block geometry.
- Opens each tab at its saved CAD view while the `전체 보기` action fits the
  complete stored layout extents, including multi-sheet paper-space layouts
  without letting stray off-paper geometry distort the fit.
- Requests only visible JPG/PNG IMAGE references, applies IMAGE and nested
  XREF clipping plus brightness/contrast/fade, deduplicates compressed content
  and bounds decoded bitmap memory with an LRU. Raster footprints participate
  in fitted bounds even for image-only drawings, while decoding follows the
  current on-screen size and upgrades only after a meaningful zoom. IMAGE clip
  pixels are converted from their saved top-origin Y convention before
  placement so cropped rasters stay aligned with CAD geometry. IMAGEFRAME and
  XCLIPFRAME values 1/2 draw their clipped screen boundary; value 0 omits it.
  Saved IMAGEQUALITY selects high-quality interpolation or uninterpolated
  Draft pixels without reducing embedded OLE presentation quality.
- Range-reads bounded embedded OLE BMP/EMF previews only when visible. Excel
  EMF presentations are replayed in a 4,096-pixel, 200,000-record local Canvas
  sandbox and enter the same deduplicated raster cache; unavailable previews
  remain explicit crossed placeholders.
- Remaps child layers and linetypes to root XREF-dependent definitions and
  renders external overview/detail lines, HATCH fills and patterns,
  POINT/SOLID/3DFACE primitives, stable-view curve refinement and source text
  without expanding a full scene graph. At VISRETAIN=0, exact nested-prefix
  child layer visibility, color/transparency, linetype and lineweight replace
  only the corresponding display rows; VISRETAIN=1 keeps the saved host rows.
- Serializes external first-frame loads and caps aggregate external overview
  source, overview GPU and detail GPU data at 32 MiB each. Deferred external
  fill, primitive and refined-curve GPU data has a separate 64 MiB cap.
- Stores instance transforms in packed `Float64Array` collections.
- Rebases world coordinates around the camera before WebGL2 `f32` upload.
- Renders overview lines with batched, instanced draw calls.
- Stages bounded DWG Render Delta
  line/triangle-fill/POINT/Canvas-text/instance-transform/instance-style
  packets
  before one
  atomic state swap under one 64 MiB GPU budget,
  suppresses replaced/tombstoned base lines, HATCH fills/patterns, POINTs,
  SOLID/3DFACE/WIPEOUT primitives and Canvas text without rewriting immutable
  Scene Cache buffers, sparsely replaces root/XREF block occurrence matrices
  and resolved style/visibility metadata across WebGL, Canvas text and raster
  images, propagates bounded transform and inherited-style changes through
  nested shared-block occurrences, resolves root/XREF review candidates
  through the same
  revision-bound native identity/dependency map, and restores draw and pick
  state on preview rollback. Tombstoned, replaced, dependency-invalidated,
  transformed-stale and hidden-style base candidates fail closed while native
  Canvas text delta hits resolve as upserts.
- Applies diff presentation to direct INSERT transform/style identities by
  partitioning only the packed root/XREF occurrence indices for a shared block
  draw. Unchanged occurrences retain the global unchanged style, a changed
  child resource or removed base range takes precedence over its containing
  INSERT style, and source-hidden occurrences remain hidden. WebGL geometry and
  Canvas block text use the same native-handle rule without cloning block
  vertices.
- Supports anchored mouse-wheel/button zoom, independently configurable mouse
  and trackpad-pinch sensitivity, accelerated trackpad pinch zoom, click-drag
  pan, two-finger scroll pan and fitted-view reset. Pixel, line and page deltas
  are normalized, while one smooth-scroll sequence stays locked to pan so
  inertial tail events cannot turn into zoom.
- Keeps byte-budgeted detail streaming active while zooming out so switching
  to the sampled overview cannot abruptly remove visible objects.
- Selects LOD 1 model and transformed block batches against the viewport.
- Streams at most two detail reads concurrently and coalesces redraws.
- Caps one visible detail set and cached GPU detail at 256 MiB. This keeps
  dense plan views complete while retaining a hard upper bound for unusually
  large drawings.
- Cancels stale queued work and safely releases in-flight results on disposal.
- Reuses one geometrically growing instance-upload scratch buffer instead of
  allocating a new typed-array backing store per batched draw call.
- Displays current/peak Chromium JavaScript heap when available and current/
  peak tracked WebGL vertex, instance and layer-texture allocations. It labels
  unsupported heap telemetry and does not count driver-owned framebuffer or
  shader memory as tracked GPU bytes.
- Searches Hangul layer names and toggles individual or all layers without
  rereading geometry or rebuilding GPU buffers.
- Derives root and XREF layer groups at runtime from each drawing's layer
  records and DWG-dependent `reference|layer` names. It does not assume a
  sample reference name and accepts arbitrary Unicode and nested references.
- Fits a dragged rectangular region, records wheel and pan gestures as bounded
  previous/next view-history steps, and stores named camera bookmarks
  independently for model space and each layout.
- Isolates one layer, inverts all layer visibility, and restores the previous
  visibility state with one renderer update.
- Keeps completed measurement guides visible for object/cumulative distance,
  polygon area/perimeter, three-point angle, and exact arc/circle/ellipse
  radius/diameter review tools.
- Selects HATCH, SOLID and 3DFACE objects from the current drawing and resolved
  nested XREFs through one bounded, on-demand index. External candidates keep
  their composed transforms, root layer mapping and visibility, Layer 0
  inheritance and XCLIP chains without assuming any reference filename.
- Converts every measured length, area, radius and coordinate from the DWG
  insertion unit to a selectable display unit with automatic or fixed
  precision. Unitless drawings require an explicit two-point calibration
  before physical units such as mm, m or in can be selected.
- Exports the current screen, the complete current tab or every paper-space
  layout as PNG/PDF without viewer chrome. It reads each layout's arbitrary
  paper dimensions and rotation at runtime, falls back to a user-selected
  preset only when needed, derives 1:N scale from the DWG insertion unit or
  explicit measurement calibration, and can apply the layout CTB to output
  without changing the saved viewer state.
- Packages multi-layout PNG output with portable ASCII entry names and a UTF-8
  `layout-names.txt` map so native ZIP tools retain arbitrary Unicode layout
  labels across macOS, Windows and Linux.
- Displays bounded first-pass chords for arcs, circles, ellipses, polyline
  bulges, NURBS splines and HATCH boundaries emitted by the converter. HATCH
  curves use their own denser 64-segment circular and eight-per-span spline
  limits without increasing ordinary first-frame curve density; fit-point-only
  HATCH splines are interpolated through their points with saved endpoint
  tangents and periodic closure instead of displaying their control polygon.
- Starts a persistent worker after the first line frame and range-reads the
  v1.6/v1.7 HATCH source sections independently of the first frame.
- Triangulates solid and gradient HATCH rings with pinned Earcut 3.2.3, keeps
  holes and source HATCH styles, and draws fills before boundary lines. Named
  LINEAR, CYLINDER, SPHERICAL, HEMISPHERICAL and CURVED gradients plus their
  inverse variants are evaluated per fragment from the saved angle and shift;
  unknown names fall back to LINEAR and remain visible in diagnostics.
- Retains shared block instances and layer visibility for fill geometry
  without expanding a whole-drawing scene graph.
- Caps HATCH fill GPU vertices at 32 MiB, triangles at 65,536 per entity,
  loops at 2,048 per entity and local-origin batches at 24,576 vertices.
- Preserves v1.7 pattern definition lines and dash/space arrays, clips their
  strokes against normal/outer/ignore rings and draws fill, pattern and
  boundary geometry in that order.
- Regenerates pattern strokes only after a 160 ms viewport debounce, omits
  definitions below 1.5 screen pixels and keeps shared blocks restricted to
  visible instance indices instead of expanding their geometry.
- Caps one pattern result at 250,000 segments (16 MiB of line vertices),
  65,536 segments per HATCH and eight million boundary intersection tests.
- Terminates the previous HATCH worker when another cache is selected.
- Range-reads the current v1.26 POINT/SOLID/3DFACE/WIPEOUT source sections only
  after the first line frame, preserving shared block instances without
  expanding geometry per INSERT.
- Range-reads the current v1.26 normalized `SORTENTSTABLE` tables and entries on
  demand. The first frame reads neither draw-order section.
- Collapses the preserved sort keys to WIPEOUT-only order events, recursively
  includes nested/DIMENSION/MINSERT mask spans and attaches one compact order
  base to each existing block instance without copying its matrix.
- Draws `PDMODE` point markers in screen space and converts SOLID OCS corners
  to bounded fill triangles or `FILLMODE`-off outlines.
- Draws only the visible, non-degenerate WCS edges of 3DFACE records while
  retaining all four corners and invisible-edge flags for a future shaded
  mode.
- Triangulates visible WIPEOUT clip/full-image boundaries and records them
  first in a 24-bit WebGL depth buffer. Batched lines, HATCH, SOLID, 3DFACE
  and POINT geometry then use the same compressed order, so only objects
  below each mask are hidden.
- Applies the same expanded order to Canvas text by clipping an occurrence
  only against later WIPEOUT polygons. Layer-hidden masks are omitted from
  both GPU and text composition.
- Caps expanded masks at 10,000 and mask GPU vertices at 8 MiB. Invalid
  boundaries, inverted clipping, sort collisions, block cycles and
  depth/instance/order-limit failures disable every mask while preserving
  ordinary geometry and configured WIPEOUT frames.
- Caps POINT, SOLID-fill and shared SOLID/3DFACE/WIPEOUT-outline GPU vertices
  at 8, 16 and 8 MiB, plus 8 MiB for WIPEOUT triangles. It runs their
  one-shot worker before HATCH work and releases its source buffers when the
  final GPU payload is transferred.
- Loads source text after the first geometry frame and renders selected local
  SHX/BigFont glyphs through byte-bounded caches, with a Korean system-font
  fallback when a CAD font is unavailable.
- Wraps MTEXT paragraphs to their stored drawing or column width, flows at
  most 64 stored columns, and paints bounded background fills. Stored WCS
  X-axis direction, attachment, column width, gutter and height are preserved
  while explicit `\P` paragraph breaks remain bounded.
- Applies nested MTEXT font, ACI color, height, width, tracking, oblique,
  vertical-run alignment, underline, overline and strike-through controls
  within 4,096 code points and 32 formatting levels. Visible inline font
  families are requested lazily from the host instead of scanning off-screen
  strings. `\S` horizontal fractions, diagonal fractions and tolerances retain
  their upper/lower glyph layout and remain indivisible during word wrapping.
- Preserves `\p` first-line, left and right paragraph indents plus left,
  center and right custom tab stops. Stored drawing-unit distances are
  normalized by the initial character height, `tz` clears custom stops, and
  `^I` advances to the same bounded stop during wrapping, measurement and
  final placement.
- Renders explicit top-to-bottom MTEXT and by-style vertical flow as upright
  glyphs descending within right-to-left logical columns. A by-style record
  remains horizontal unless its referenced text style is actually vertical.
- Maps single-line TEXT, ATTRIB and ATTDEF from their stored OCS plane. Plain
  left/baseline text uses the insertion point; center, right, middle and
  vertical justification use the alignment point plus resolved SHX or
  fallback-font glyph metrics. Align/Fit retain their two-point span and
  direction, while multiline attributes use their embedded MTEXT basis.
- Applies ATTMODE 0/1/2 to attributes, preserves the current model annotation
  scale, and hides an annotative MTEXT representation that has no current-scale
  context when ANNOALLVISIBLE is disabled.
- Applies drawing FILLMODE to solid, gradient and patterned HATCH results as
  well as the existing SOLID and wide-polyline paths. OLEFRAME=0 suppresses
  generated OLE boundaries while preserving the bounded presentation image.
- Separates strict EUC-KR from CP949/UHC, encodes all 11,172 modern Hangul
  syllables plus the KS X 1001 symbol and Hanja rows as Johab/CP1361, and
  probes actual glyph presence instead of guessing from BigFont filenames.
  A per-font override resolves ambiguous fonts without duplicating compiled
  glyph geometry.

The current page is an engine verification harness, not the final VS Code
extension UI. At a stable 4× or higher zoom, a dedicated worker now refines
ARC, CIRCLE, ELLIPSE, polyline-bulge, control-point NURBS and fit-point-only
SPLINE geometry to a 0.5 px screen-error contract without changing the bounded
first frame. Fit-point interpolation distinguishes chord, centripetal and
uniform knot spacing, honors stored endpoint tangents and closes periodic
curves smoothly. External image baselines for every TEXT OCS/justification
combination, lossless analytic HATCH boundary topology and further real-world
Korean SHX corpus expansion remain follow-up work.

## Run

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter dwg-viewer-vscode run build:webview
python3 -m http.server 4173 --bind 127.0.0.1 --directory .
```

Open `http://127.0.0.1:4173/apps/vscode-extension/media/webview/` and select a
generated `.cache` file. This serves the same bundled main module and workers
that ship in the extension. The repository root remains the static root so a
same-origin qualification cache can be served without uploading it. The file
stays local to the browser.

Automated local UI qualification can open a same-origin synthetic cache
without a native file picker. A server that advertises `Accept-Ranges: bytes`
is read through bounded HTTP ranges (up to the 8 GiB qualification ceiling)
without downloading the complete cache; a server without byte ranges falls
back to a complete `Blob` only for files of at most 64 MiB:

```text
http://127.0.0.1:4173/apps/vscode-extension/media/webview/?qualification-cache=/tmp/fixture.cache
```

This query is ignored by the VS Code host and rejects cross-origin or non-cache
paths. It is a development-shell input, not a product DWG loading path.

The public actual-WebGL comparison fixture is available at:

```text
http://127.0.0.1:4173/packages/webview/qualification/revision-comparison.html
```

It uses the same public comparison mount as the packaged VS Code qualification;
the fixture does not call VS Code APIs when opened in a standalone browser.

Append `qualification-shell=vscode` to exercise the immersive extension shell.
The optional `qualification-top-toolbar-labels` and
`qualification-left-toolbar-labels` parameters accept `hover` or `icons`, and
`qualification-locale` accepts a BCP 47 language tag. These parameters are also
ignored by the VS Code host. `qualification-theme=dark|light` fixes the drawing
surface to the corresponding VS Code editor background for reproducible ACI 7
and plot-preview qualification; it does not emulate an entire VS Code theme.

## Test

```bash
pnpm --filter @menaje/viewer-webgl check
```

Tests cover bounded range reads, cache validation, nested/DIMENSION block
transforms, invalid targets, cycles and instance/depth caps, large-coordinate
camera rebasing, camera controls, Core renderer/detail lifecycle adapters,
viewport detail selection, GPU resource ranges, selection publication,
layer visibility, arbitrary Unicode/nested XREF layer grouping,
rectangle camera fitting, bounded branching view history, bookmark-state
validation, XREF instance/layer/text composition, aggregate XREF GPU budgets,
bounded root/XREF filled-object selection with layer and clip filtering, and
LRU eviction/request coalescing.
They also cover delayed Korean text reads, strict EUC-KR, CP949 and Johab
mapping, per-BigFont overrides, SHX/BigFont cache limits and the
current v1.26 HATCH range, triangulation, dashed-pattern, block-clipping,
large-coordinate and render-order contracts, plus POINT/SOLID/3DFACE/WIPEOUT
range, WCS/OCS, clip-boundary, frame-setting, instance-sharing and GPU-budget
behavior, plus draw-order normalization,
contiguous ranges, lazy reads, nested/array mask buckets, depth composition,
HATCH/primitive bucket packing and Canvas text clipping.
Render Delta coverage additionally includes bounded nested root/XREF transform
and inherited-style propagation, direct-child precedence, repeated occurrence
isolation, XCLIP fail-closed behavior and shared WebGL/Canvas text/raster IMAGE
results.
Revision-comparison coverage additionally checks exact source/snapshot/revision
binding, one-renderer current/candidate pixels, synchronized camera rollback,
revision-exact selection, corresponding highlights, side/status visibility,
surface pixel budgets and idempotent repeated cleanup. The packaged VS Code
scenario runs the same actual WebGL fixture from the built VSIX without mixing
its memory with the drawing first-frame measurement.
