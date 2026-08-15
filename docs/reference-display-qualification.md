# DWG reference display qualification

This document audits saved 2D DWG model/layout presentation from public format
and product documentation plus reproducible public or synthetic fixtures. It
deliberately excludes file-open latency, conversion latency, editing and DWG
round-trip behavior.

## Evidence hierarchy and completion rules

Required completion evidence is source-neutral and reproducible in this
repository: bounded conversion, an exact source/serialized/deferred partition,
valid and invalid contract fixtures, deterministic display-state matrices and
explicit unsupported boundaries. Public vendor documentation is used to
interpret saved DWG fields and display semantics.

Screenshots or reports from proprietary desktop or web viewers can be supplied
as supplemental observations. They are recorded separately with product,
version, profile and screen-versus-publish context, but are not required to
complete this qualification and do not override the source-neutral contract
fixtures. Packaged Windows UI execution remains a separate platform gate.

The implementation and this audit use four support states:

- **Preserved** — the relevant source values are retained without replacing
  them with inferred values.
- **Bounded display** — the viewer renders a qualified 2D representation under
  documented record, memory and tessellation limits.
- **Explicitly deferred** — the converter counts the logical entity and a
  specific deferred reason; the viewer does not invent substitute content.
- **Structural** — the record contributes ownership, style or geometry to
  another entity and is not expected to draw independently.

"Bounded display" is not a blanket claim of pixel identity with another
renderer. A feature is qualified when its documented source state and the
repository's deterministic display result are both covered; optional external
pixels may add observational evidence without becoming a completion condition.

## Saved display state

| AutoCAD state | Viewer behavior | Audit state |
| --- | --- | --- |
| `TILEMODE`, `CTAB` and `CLAYOUT` | The drawing's saved model/paper state chooses the initial tab. When paper space is active, the viewer resolves the layout whose associated block is exactly `*PAPER_SPACE`; it does not assume the first paper tab is current. AutoCAD retains that block name for the most recently active paper layout even while Model is active. The adapter reads the canonical BLOCK entity name rather than a possibly duplicated LibreDWG BLOCK_HEADER name. | Implemented for LAYOUT-bearing drawings. Annotation-matrix schema v3 rejects a converted save unless its named paper layout is the current `*PAPER_SPACE` layout. A missing or ambiguous marker fails closed to Model and is observable in first-frame metrics. Pre-R13 paper space without LAYOUT objects remains an explicit legacy boundary; proprietary-viewer capture is optional supplemental evidence. |
| `FILLMODE` | Preserved in the drawing record. It gates HATCH solid/gradient/pattern/background results, SOLID/TRACE and wide-polyline interiors. The boundary remains visible when the corresponding entity has one. | Implemented and covered by the repository-generated `0/1` matrix; proprietary reference pixels are optional. |
| `ATTMODE` / `ATTDISP` | `0` hides ATTRIB and ATTDEF, `1` follows each entity's invisible flag and `2` forces attribute display except structural ATTDEF templates. | Implemented and covered by the repository-generated `0/1/2` matrix; proprietary reference pixels are optional. |
| Entity visibility and layer state | Common entity visibility (DXF group 60) is preserved across native geometry, Canvas overlays, XREFs and draw-order masking. Layer off/frozen suppresses screen display; locked and no-plot do not suppress an ordinary screen view. Enabling the layout CTB preview with **Plot style on** (`출력 켬`) excludes no-plot layers from WebGL, Canvas overlays, picking and measurement; turning it off restores ordinary screen visibility without changing the layer-panel state. INSERT-layer visibility still gates every occurrence. | Implemented. `OBJECTISOLATIONMODE=1` fixture authoring must persist the resulting entity visibility in the DWG; the viewer does not infer the author's user setting. |
| `CANNOSCALE` and `ANNOALLVISIBLE` | Versioned variable-dictionary text is converted before matching `CANNOSCALE`; model and every serialized viewport, including the primary paper viewport, carry an annotation scale. Bounded MTEXT/TEXT/ATTDEF/ATTRIB contexts are selected against that scale, and a missing representation is omitted when all-scales display is off. Scene Cache v1.25 preserves the model value and reads each paper layout's independent value from AutoCAD's `AcadAnnoAV` LAYOUT application data. A layout without that data uses Autodesk's documented initial value 1, not an inferred off state. | Implemented with fail-closed validation for duplicate, malformed or non-boolean layout data and a repository-generated model/layout `2×2` matrix. Other annotative families remain outside the current representation table. |
| `QTEXTMODE` | Scene Cache v1.25 preserves the saved boolean. When enabled, the Canvas text path omits glyphs, backgrounds and frames and draws the bounded text-entity box while preserving owner, layer, draw order and clipping. | Implemented for TEXT, MTEXT, ATTDEF and ATTRIB; external pixels are optional supplemental evidence. |
| `SPLFRAME` | Scene Cache v1.25 preserves the saved boolean. When enabled, invisible 3DFACE edges are restored. Autodesk's current definition also exposes HELIX control polygons, unsmoothed mesh objects and polyface edges. | Implemented for qualified 3DFACE records. HELIX, smoothed mesh reconstruction and polyface topology remain explicit 3D/mesh boundaries; a spline-fit 2D POLYLINE frame is not invented from this variable. |
| `DISPSILH` | Scene Cache v1.25 preserves the saved boolean controlling 3D-solid silhouette display in 2D Wireframe. | Preserved, but silhouette extraction remains inside the explicit 3D boundary. External observations cannot promote the existing bounded SAT edge representation to silhouette support. |
| `XREFOVERRIDE` | Scene Cache v1.25 preserves the saved boolean. For objects inside a mounted DWG xref, value 1 resolves explicit color, linetype, lineweight and transparency as ByLayer through the host xref-layer mapping, including nested instances and Canvas/raster paths. The rule is not applied merely because an IMAGE, OLE or underlay file is itself an external resource. | Implemented for the four normalized properties. Per-object named plot-style override remains deferred with STB; a host/child observation is optional supplemental evidence. |
| `VISRETAIN` | Scene Cache v1.26 preserves the saved boolean. Value 1 keeps the host's xref-dependent layer table. At value 0, mounting or reloading a child copies its matching on/off, freeze, lock, plot, color/transparency, linetype and lineweight state into immutable display rows for the exact nested XREF prefix. Root source metadata is not mutated and an explicit viewport override remains authoritative. | Implemented for mounted 2D XREF content, including prefix-qualified linetypes and nested contexts. Missing child rows retain the host value; packaged viewer capture remains a separate platform observation. |
| `IMAGEQUALITY` | Scene Cache v1.26 reads the drawing's `RASTERVARIABLES` object. High enables high-quality Canvas sampling; Draft disables interpolation so source pixels remain visibly coarse. Embedded OLE presentations stay high quality because Autodesk scopes this command to raster IMAGE display. | Implemented for decoded IMAGE content. Autodesk states that plotting always uses high quality, so the native pair uses `PNGOUT`, which Autodesk documents as reflecting screen display, and must contain a loaded color/grayscale raster whose decoded pixels differ. |
| `DISPSILHBLOCKS` | Scene Cache v1.26 preserves this drawing-saved boolean separately from `DISPSILH`. | Preserved, but generation and caching of 3D-solid silhouettes inside block instances remains inside the explicit 3D boundary. A native 0/1 block-solid pair must not be used to claim viewer silhouette support. |
| XREF state | Original path plus XREF, overlay, loaded and resolved flags are preserved. The adapter normalizes DWG's inverted Loaded Bit (`0` means loaded), and consumers classify `resolved=false` before `loaded=false` so the saved false/false pair remains unresolved. Unloaded or unresolved references are not resolved or mounted. Nested INSERT/XREF transforms and XCLIP are applied to qualified child content. | Implemented. A redistributable loaded/unloaded/resolved/unresolved AutoCAD fixture is still required for reference pixels. |
| VIEWPORT group 68 and status group 90 | Nonpositive group 68, invisible entities and group-90 off bit `0x20000` are excluded. Positive group 68 supplies stacking order. The primary paper viewport is not drawn as a model viewport. | Implemented. |
| VIEWPORT perspective, front/back clipping and render mode | Perspective and front/back clipping flags, hidden/shaded render modes and related saved values are preserved. Unsupported model viewports are omitted with named reasons instead of being flattened as 2D Wireframe. Wireframe mode 0/1 remains eligible. | Explicit fail-closed boundary. |
| `FRAME` family | `FRAME`, `IMAGEFRAME`, `XCLIPFRAME`, `OLEFRAME`, `PDFFRAME`, `DWFFRAME` and `DGNFRAME` values are preserved when present. `FRAME` 0/1/2 overrides IMAGE, XCLIP and WIPEOUT settings; its derived mixed value 3 selects each individual setting. `OLEFRAME` remains independent. Unavailable values remain unavailable. Values 0/1/2 retain the visible-versus-plot distinction even though the interactive viewer performs no plot job. | Implemented for supported IMAGE, XCLIP, WIPEOUT and OLE presentation boundaries. Underlay entities themselves remain deferred. |
| `LTSCALE`, entity linetype scale, `MSLTSCALE`, `PSLTSCALE` | Global, per-entity and model-annotation factors are combined for first-frame lines, complex linetype overlays and high-zoom curve/XLINE/RAY refinement. Each paper layout independently reads its own `PSLTSCALE` from LAYOUT group-70 bit 1 before scaling model-space objects through that layout's viewports; a drawing-wide header value is not reused for every tab. | Implemented with bounded dash/shape/text tables; a same-DWG external capture is optional supplemental evidence. |
| Simple-linetype `A` alignment | A finite standalone LINE shorter than one complete scaled pattern is displayed continuously instead of letting the repeating shader place the whole segment inside a gap. The renderer carries a conservative segment extent only in its transient GPU upload and leaves the source cache and CPU layer index unchanged. | Implemented for the short standalone-LINE rule, including ByLayer resolution, draw-order repacking and streamed detail updates. Polyline-wide `PLINEGEN` endpoint adjustment and longer-segment terminal-dash stretching remain explicit follow-up behavior. |
| `LWDISPLAY` | Drawing-wide lineweight visibility is saved. Layout lineweights use paper units, layout/model scale and device pixels; the displayed width is zoom/DPI aware and capped. | Implemented for the 2D renderer. Plot-device end/join styles are not independently reconstructed. |
| `VIEWRES` / curve display resolution | Autodesk saves VIEWRES in the drawing and, with hardware acceleration disabled, can deliberately show circles, arcs, splines and arced polylines as coarse vectors. The viewer instead retains analytic curve sources and refines them to a bounded half-pixel screen tolerance. | Known fidelity-policy difference, not an object-presence loss. Scene Cache does not yet preserve the per-viewport VIEWRES value, so an exact low-VIEWRES polygonal screen is a remaining contract change. Native evidence must record hardware acceleration and `WHIPARC`; ordinary parity captures use a smooth-curve profile. |
| `SORTENTS` | Current AutoCAD releases always sort REGEN display order; the former bit 16 is obsolete. The viewer therefore uses each owner record's `SORTENTSTABLE` rather than treating the current `SORTENTS` bit mask as a screen-display switch. | No modification required for current AutoCAD. Selection, object-snap and plot-only sorting choices are outside the ordinary screen renderer. |
| `PROXYSHOW` / `PROXYGRAPHICS` | `PROXYSHOW` is not stored in a DWG, so the adapter uses AutoCAD's default value `1`. It renders only an allowlisted proxy-graphics primitive stream and defers a malformed or unsupported stream atomically. | Implemented policy; object-enabler reconstruction is out of scope. |

Autodesk documents `FILLMODE` as affecting hatches, 2D solids, wide
polylines and donuts. The viewer therefore applies it to the wide-polyline
surface path as well as HATCH and SOLID/TRACE; testing only HATCH would be an
incomplete variable-pair gate.

## Profile and session display state

The following controls affect native Autodesk pixels but are saved in the
Windows registry rather than the DWG. They must not be inferred from drawing
bytes. Native comparisons pin them in the evidence manifest; a viewer-facing
preference is required where the product intentionally exposes the same
choice.

| AutoCAD profile state | Normalized qualification value | Current viewer boundary |
| --- | ---: | --- |
| `TRANSPARENCYDISPLAY` | `1` | Transparency is displayed. A future explicit preference may suppress it, but the converter must not serialize a guessed DWG value. |
| `VPLAYEROVERRIDESMODE` | `1` | The viewer applies the serialized viewport color, transparency, linetype and lineweight overrides. A `0` TrueView capture is a different registry profile, not evidence of a DWG decode defect. |
| `OLEHIDE` | `0` | Qualified OLE previews/placeholders remain visible in model and paper space. Values 1–3 are profile-specific suppression and are recorded, not inferred from the file. |
| `OBJECTISOLATIONMODE` | `1` while authoring a persistent hidden-object fixture | The resulting entity visibility is read from the DWG. Session-only hidden selections at value 0 are deliberately not treated as file content. |
| `XDWGFADECTL` | `0` | Native xref fading is disabled for color comparison. AutoCAD's nonzero fade is a profile effect and must not be confused with missing or unresolved xref content. |
| `LAYLOCKFADECTL` | `0` | Locked-layer fading is disabled for pixel comparison; lock still affects editing, not drawing visibility. |
| `VISRETAINMODE` | `0` | Xref reload property synchronization is disabled while qualifying `VISRETAIN=1`; nonzero synchronization masks are separate reload-profile cases. |
| `PROXYSHOW` | `1` | Qualified proxy graphics are displayed. Values 0 and 2 are distinct registry-profile cases (hidden and bounding-box-only), not drawing decode results. |
| `TEXTFILL` | `1` | Qualified TrueType glyphs are displayed filled. AutoCAD's outline value `0` is a registry-profile effect and is not inferred from drawing bytes; exact native font contours remain outside the bounded Canvas text renderer. |
| `WHIPARC` / hardware acceleration | smooth-curve profile recorded | `WHIPARC` is obsolete but can still override VIEWRES under some graphics profiles. It is recorded with hardware acceleration so coarse VIEWRES evidence cannot be mislabeled. |
| `LINESMOOTHING` | `1` | AutoCAD applies registry-backed 2D antialiasing. Pixel evidence records this separately from object geometry because WebGL/Canvas rasterization is not expected to be byte-identical. |
| `LINEFADING` | `0` | Density-triggered hardware line fading is disabled so a missing-looking line cannot be accepted as source visibility behavior. |
| `RTDISPLAY` | `0` | Static first-frame evidence is captured after pan/zoom has ended. Temporary raster/OLE suppression during real-time navigation is outside this loading-excluded audit. |

Viewer background color, reduced-quality/progressive-display modes, font and
support-file availability, active layout/viewport, and 2D Wireframe visual
style are also evidence inputs. A reference capture without those values is
informative only and cannot close a pixel gate.

`FASTSHADEDMODE` is also registry-backed, but Autodesk lists Wireframe and
shaded visual styles rather than 2D Wireframe among the affected modes. It is
recorded for any supplemental 3D/Wireframe capture and is not treated as a DWG
visibility value or as a variable in the primary 2D Wireframe oracle.

## Color, lineweight and plot styles

| Feature | Viewer behavior | Audit state |
| --- | --- | --- |
| ACI, ByLayer, ByBlock and TrueColor | Entity and viewport-layer resolution is applied through the instance graph. ACI 7 is black on a light display/plot background and white on a dark display background; other ACI entries and TrueColor are unchanged. | Implemented. |
| CTB | The host resolves a stored basename through bounded drawing/project/configured roots, rejects ambiguity, parses bounded compressed CTB content and sends only normalized colors, screening and lineweights to the Webview. A layout can opt into the table without changing model colors. | Implemented. |
| Layout `ShowPlotStyles` | The saved per-layout flag is the initial screen behavior. An explicit viewer preference can override it for the current session without altering the DWG. | Implemented; previously the viewer incorrectly defaulted every layout to off. |
| STB / named plot styles | A `.stb` layout assignment is identified and never parsed as CTB. Applying per-entity named styles requires serializing each entity/layer plot-style reference and a normalized named table; that contract does not yet exist. The UI reports this boundary explicitly. | Explicitly deferred; an STB screenshot must prove the diagnostic, not falsely claim styled pixels. |
| Viewport layer overrides | Sparse color, transparency, linetype and lineweight overrides are applied per visibility row and inherited by WebGL lines/fills/points plus Canvas text and IMAGE. Per-viewport group-390 named plot-style overrides are not serialized. | Implemented for the four normalized properties; named STB application is explicitly deferred. |

## Entity-family audit

| Family | Display behavior | Audit state |
| --- | --- | --- |
| LINE | Finite WCS endpoints, common style, handle and owner identity. Serialized `A` alignment applies the continuous short-segment fallback after global, entity and viewport linetype scaling. | Preserved and displayed. |
| ARC, CIRCLE, ELLIPSE | Exact source parameters are retained. A bounded first-frame chord is replaced with camera-dependent high-zoom refinement while preserving identity and linetype phase. | Preserved; bounded display. |
| SPLINE | Degree, knots, weights, control/fit points and tangents are retained. Valid NURBS are sampled per nonempty span; malformed definitions use bounded fit/control chords and remain diagnostic. | Preserved; bounded display. |
| LWPOLYLINE, 2D/3D POLYLINE | Vertices, bulges, closure, widths, elevation/normal and entity linetype scale are retained. Wide segments form joined 2D surfaces; `FILLMODE=0` keeps their boundaries. | Preserved; bounded display. |
| POLYLINE mesh | M/N topology, closed directions and vertices are retained and rendered as bounded wire rows/columns. Polyface and shaded mesh surfaces are not claimed. | Bounded wire display. |
| INSERT, MINSERT | Block ownership, transform, array cells, layer/style inheritance, nested draw order and XCLIP are composed without expanding a whole-drawing graph. | Preserved and displayed under depth/instance caps. |
| DIMENSION families | A resolved anonymous picture block is displayed as one identity-preserving instance. A missing or invalid picture block is counted as `unresolved_dimensions`. | Bounded display or explicit deferral. |
| POINT | WCS point, normal, thickness, angle and PDMODE/PDSIZE snapshot drive screen-space markers. | Preserved; bounded display. |
| SOLID, TRACE | OCS corners use AutoCAD perimeter order. FILLMODE chooses filled triangles or outlines. | Preserved and displayed. |
| 3DFACE | Four WCS corners and invisible-edge flags are retained. Invisible edges are omitted at `SPLFRAME=0` and restored at `SPLFRAME=1`; degenerate edges never draw. | Qualified 2D Wireframe boundary; no shaded face claim. |
| HATCH | Closed rings, holes, island style, gradients, pattern definitions, seed points and named background color are retained. Fills/backgrounds precede patterns and boundaries; all work is capped and viewport-clipped. | Preserved; bounded display. Invalid/open/capped paths remain diagnostic. |
| WIPEOUT | Image basis, clip boundary and frame setting are retained. Valid masks participate in the same bounded draw-order depth plan as lines, fills, points, text and images. Unsafe plans disable masking without hiding ordinary geometry. | Preserved; bounded display with fail-closed fallback. |
| TEXT | OCS placement, both alignment points, style, generation flags and annotative contexts are retained. Align/Fit endpoint width and exact font metrics remain bounded approximations. | Preserved; bounded display. |
| MTEXT | WCS basis, attachment, columns, background/frame, paragraphs, tabs, inline style runs, fractions/tolerances and annotative contexts are bounded. Field source syntax is not evaluated; a field with no usable cached display becomes `####` rather than leaked expression text. | Bounded display; exact AutoCAD font layout is not claimed. |
| ATTDEF, ATTRIB | Attribute flags, attached values, embedded MTEXT and annotation contexts are retained; ATTMODE and entity invisibility are applied after structural template suppression. | Preserved; bounded display. |
| LEADER | Vertices, hook and arrow are emitted with common style. | Bounded display. |
| MLEADER / MULTILEADER | Straight and spline leader lines, arrows, text frame/content and block content are normalized under per-entity caps. | Bounded display. Style edge cases beyond the serialized context are not claimed. |
| MLINE | Styled parallel elements, joins/caps and qualified uncut style fills are rendered. Area-fill cut parameters fail closed instead of producing guessed fills. | Bounded display with explicit unsupported subcase. |
| XLINE, RAY | Exact base point and direction are retained. Each camera, INSERT and XCLIP occurrence clips an infinite or forward half-infinite line; arbitrary drawing extents are not baked into the cache. | Preserved and displayed. |
| IMAGE | Placement basis, pixel size, brightness/contrast/fade and clip are retained. The host accepts bounded JPG, PNG, BMP, DIB and GIF bytes; unsupported or malformed resources show the existing missing-resource state. | Bounded display; TIFF and codec-dependent formats are not claimed. |
| OLE2FRAME | Placement is retained. Qualified embedded BMP/DIB and validated EMF presentations render; other presentations retain a crossed placeholder, subject to OLEFRAME. | Bounded display. |
| PDF/DWF/DGN UNDERLAY | Logical entities and drawing-wide frame settings are recognized. No qualified decoder or per-entity placement contract exists. | Explicitly deferred as `unsupported_underlays`. |
| REGION, 3DSOLID, BODY | Bounded SAT/SAB topology can emit straight, elliptic and rational NURBS edge chords. | Bounded 2D edge display only; materials, hidden-line and shaded pixels are not claimed. |
| HELIX, MESH, SURFACE families, LIGHT, SUN, SECTION, point cloud and Navisworks model | These require a 3D/view-style renderer or a separately qualified 2D projection. | Explicitly deferred as `unsupported_3d_entities` or `unsupported_other_entities`. |
| ACAD_PROXY_ENTITY and unknown custom entities | Default proxy display supports opcodes 6, 7, 14, 18, 22, 23, 29–32 and 38 for bounded lines/polygons, style state, transforms and Unicode text. | Bounded display when the entire stream is valid; otherwise `unsupported_proxy_graphics`. |
| TABLE, TOLERANCE, SHAPE, OLEFRAME and other unsupported native families | A valid proxy stream may still display. Without one, no native renderer is inferred. | Explicitly deferred under `unsupported_other_entities`. |
| MLEADERSTYLE, SEQEND, VERTEX, block/table records | Supply styles, ownership or pooled geometry to another entity. | Structural, not independent display objects. |

## Draw-order identity audit

Scene Cache retains each `SORTENTSTABLE` owner and entity/sort-handle pair.
The reader builds one bounded shared identity index from all display-bearing
source sections, rather than treating section enumeration as display order.

| Render path | Identity/order behavior |
| --- | --- |
| GPU straight lines and first-frame curve chords | Entity handle is carried in every vertex; the style word receives the normalized local bucket. |
| High-zoom ARC/CIRCLE/ELLIPSE/SPLINE and XLINE/RAY | Replacement vertices keep the same handle, owner, linetype phase and bucket as the coarse source. |
| HATCH fill, background, pattern and boundary | Packed identity ranges survive worker transfer, regeneration, INSERT expansion and viewport clipping. |
| POINT, SOLID/TRACE, 3DFACE and WIPEOUT | Packed identity ranges cover worker-built points, fills, outlines and masks. |
| Canvas TEXT/MTEXT/attributes and complex linetype glyphs | Occurrences compute the same owner/handle bucket and write a lossless 24-bit order surface before visible compositing. |
| Raster IMAGE and OLE presentation | Root, repeated block and XREF occurrences use the same order surface and absolute bucket. |
| INSERT/MINSERT/DIMENSION and XREF | Nested/array spans reserve deterministic subranges without copying matrices; XREF child buckets are scaled into the parent range. |

If identity count/byte limits, sort-key collisions, cycles, inverted WIPEOUT
clips or depth limits are violated, the mask/order plan fails closed. Ordinary
geometry remains visible and diagnostics name the reason; a partial order is
not silently applied.

## Qualification evidence

The current reproducible public-corpus run is
[`reference-display-qualification-2026-08-12.json`](../compatibility/evidence/reference-display-qualification-2026-08-12.json).
It pins the LibreDWG 0.14 source archive and scans its complete 141-DWG
`test/test-data` tree. Ninety-one companion text records identify AutoCAD as
their producer. All 75 companion AutoCAD JPEG references are paired to their
public DWG and pinned by media type, dimensions, byte count and SHA-256.
The same run also pins and converts the 18 DWGs linked from Autodesk Support's
official **AutoCAD Sample Files** page; those inputs cover annotation scaling,
multileaders, blocks/tables, colors, lineweights, plot screening/fills, title
blocks, TrueType text and explicit 3D visualization boundaries.

The current run records:

- 141 converted drawings and zero conversion failures;
- 18/18 Autodesk official sample drawings converted with zero invalid
  supported entities;
- 59,627 logical source entities = 59,519 serialized + 108 deferred;
- all 390 serialized layout records retain an effective `ANNOALLVISIBLE`
  value: 129/129 model records and 261/261 paper records use the saved value
  or Autodesk's documented initial value `1`, with no missing application data
  misclassified as an explicit off state;
- saved-tab inventory: 138 drawings reopen Model and 3 request paper space;
  both LAYOUT-bearing paper drawings resolve exactly one canonical
  `*PAPER_SPACE` layout, with zero missing or ambiguous modern markers. The
  remaining R11 drawing has no LAYOUT objects and is recorded as an explicit
  pre-R13 paper-space boundary instead of selecting a guessed tab;
- per-layout `PSLTSCALE`: 258 paper layouts use `1` and 3 use `0`; each value is
  now applied from that layout's group-70 bit rather than one drawing-wide
  snapshot;
- deferred partition: 43 unresolved dimensions, 3 underlays, 5 proxy streams,
  18 unsupported 3D entities, 0 invalid supported entities and 39 other
  unsupported entities;
- 51 required Scene Cache v1.26 sections in every output;
- zero omitted referenced linetypes;
- model/layout, presentation-variable, viewport-mode and plot-style state
  distributions plus selected-fixture hashes and section counts;
- all 141 public-corpus drawings use the saved/default-off state for
  `QTEXTMODE`, `SPLFRAME`, `DISPSILH` and `XREFOVERRIDE`; this proves v1.26
  decoding, while repository fixtures separately cover implemented decisions;
- Scene Cache v1.26 additionally observes `VISRETAIN=1` in 137 drawings and
  `0` in 4, high `IMAGEQUALITY` in all 141 and `DISPSILHBLOCKS=1` in all 141;
  the non-default VISRETAIN values prove both cache states are exercised, while
  raster-quality pixels are optional observations and block-silhouette
  extraction remains an explicit 3D boundary;
- AutoCAD ActiveX `BasePoint` and `DirectionVector` values for the public
  XLINE/RAY fixtures compared numerically with the decoded Scene Cache values;
- Browser pixel evidence for HATCH, XLINE, RAY, MLINE, text-only MTEXT,
  model/layout switching, a CTB-assigned layout, an explicit STB diagnostic,
  1×/2× zoom and dark/light drawing backgrounds with actual media type,
  dimensions, bytes and SHA-256;
- paired manual object-content/placement review for XLINE, RAY, MLINE and TEXT
  against the public AutoCAD JPEGs. AutoCAD grid, UCS and cursor pixels are
  deliberately excluded from that review and no false byte-identical claim is
  made.

Run the same gate with a newly built adapter and the checksum-pinned source:

```bash
pnpm run qualify:reference-display \
  --adapter /absolute/path/to/libredwg-adapter \
  --corpus /absolute/path/to/libredwg-0.14/test/test-data \
  --autodesk-samples /absolute/path/to/autodesk-official-samples \
  --source-archive /absolute/path/to/libredwg-0.14.tar.xz \
  --output /absolute/new/path/reference-display-report.json \
  --observed-at 2026-08-12T08:30:00Z
```

Optional proprietary-viewer reports can be added with the existing repeated
evidence options. Raster captures must remain outside Git unless their
redistribution rights are documented. The aggregate report records only a
capture basename, dimensions and SHA-256; it never copies the image into the
repository. Raster files under `compatibility/evidence` are ignored as a
second line of defense.

### Optional proprietary-viewer observations

On Windows with AutoCAD installed, the supplemental runner can generate one
same-camera DWG/PNG pair per saved value. The output directory must not already
exist. It changes every value in the same session, saves a DWG for that value
and reconverts each DWG with the exact adapter under test:

```powershell
pnpm run qualify:reference-variable-pair `
  --autocad "C:\Program Files\Autodesk\AutoCAD 2026\acad.exe" `
  --adapter C:\qualification\libredwg-adapter.exe `
  --drawing C:\qualification\public\HatchG.dwg `
  --variable FILLMODE `
  --values 0,1 `
  --case-id fillmode-pair `
  --space current `
  --output-dir C:\qualification\fillmode-pair `
  --observed-at 2026-08-12T12:00:00Z
```

The bounded whitelist is `FILLMODE`, `ATTMODE`, `ANNOALLVISIBLE`, `QTEXTMODE`,
`SPLFRAME`, `DISPSILH`, `DISPSILHBLOCKS`, `IMAGEQUALITY`, `VISRETAIN`,
`XREFOVERRIDE`, `FRAME`, `IMAGEFRAME`, `XCLIPFRAME`, `OLEFRAME`, `PDFFRAME`,
`DWFFRAME` and `DGNFRAME`. `IMAGEQUALITY` uses the drawing-backed command and
reads DXF group 71 from `ACAD_IMAGE_VARS`; `VISRETAIN` reloads every XREF after
each value. `FRAME=3` is intentionally
not an input: Autodesk documents it as the derived mixed state, not a manually
settable value. Each report records
the source, output DWGs and AutoCAD PNG dimensions and SHA-256 values, the
source/serialized/deferred partition, and the Scene Cache drawing field read
back from the AutoCAD save. The v2 report hashes decoded reference pixels and
fails unless `FILLMODE`, `ANNOALLVISIBLE`, `QTEXTMODE`, `SPLFRAME`, `DISPSILH`,
`DISPSILHBLOCKS`, `IMAGEQUALITY`, `VISRETAIN` and `XREFOVERRIDE` 0/1 differ,
all three `ATTMODE` states differ, and every
FRAME-family 0 state differs from the identical on-screen 1/2 states (value 2
changes plotting, not screen display).
Every AutoCAD report also records the Windows adapter filename, byte count and
SHA-256; the aggregate rejects a matrix assembled from different adapter
artifacts.
Independent model/layout `ANNOALLVISIBLE` and XREF
loaded/unloaded/unresolved matrices require the dedicated runners. The XREF
v2 report hashes decoded pixels and requires the loaded view to differ from
the matching unloaded view while unloaded and unresolved views match; the
single-current-space runner does not close those two gates by itself.

The annotation runner creates one unsupported-scale annotative TEXT, one paper
layout and one viewport, then captures all four model/layout 0/1 combinations
without changing either camera. Each saved DWG is reconverted as Scene Cache
v1.26 and must independently expose both the model and named-layout values.
Schema v3 additionally requires the generated named layout to resolve through
the canonical current-paper `*PAPER_SPACE` block in every saved state:

```powershell
pnpm run qualify:reference-annotation-matrix `
  --autocad "C:\Program Files\Autodesk\AutoCAD 2026\acad.exe" `
  --adapter C:\qualification\libredwg-adapter.exe `
  --drawing C:\qualification\public\blank.dwg `
  --supported-scale-name "1:1" --supported-scale-value 1 `
  --active-scale-name "1:2" --active-scale-value 2 `
  --case-id annotation-matrix `
  --output-dir C:\qualification\annotation-matrix `
  --observed-at 2026-08-12T12:00:00Z
```

When supplied, ordinary pairs and dedicated reports are summarized as
supplemental evidence. Missing or partial proprietary reports remain visibly
`not-run` or incomplete, but do not change the source-neutral top-level
qualification status. Annotation-scale and XREF matrices are validated
independently when they are present.

The three Windows inputs are optional as a group. When supplied, the aggregate
verifies the raw packaged-VSIX report, all eight 100/125/150/200% normal
and narrow screenshots, interaction and model/layout reset results, cleanup
enforcement, the exact viewer and companion VSIX bytes and SHA-256 values, and
the pinned Autodesk annotation-scaling/multileader sample used by the Browser
model/layout review.
Supplying only a report or substituting a different package fails closed.

### Repository-generated saved-state matrix

The platform-neutral gate constructs 20 deterministic Scene Cache v1.26 cases
without a private DWG or write-enabled product dependency. It covers
`FILLMODE` 0/1, `ATTMODE` 0/1/2, the model/layout `ANNOALLVISIBLE` 2x2 matrix,
six `FRAME`/`IMAGEFRAME` fallback combinations, saved Model/Paper layout
restoration and loaded/unloaded/unresolved XREF states. Every case records its
repository-generated source identity, source entity count, serialized count,
deferred-reason partition and normalized display decision:

```bash
pnpm run check:display-state-matrix
node scripts/qualify-display-state-matrix.mjs \
  --output /absolute/new/path/display-state-matrix.json
```

The report refuses an existing destination and hashes the ordered normalized
cases, so repeated execution can detect a state or inventory change without
committing a drawing or raster. This closes the local fixture and deterministic
inventory/display-result gates. Browser captures are supplemental; exact
packaged Windows VS Code execution remains a separate platform gate.

On Windows x64, `scripts/qualify-windows-vscode-ui.mjs` supplies that platform
gate. It installs the exact viewer and GPL companion VSIX files into an
isolated latest-stable VS Code instance, then loads the same 20 generated
caches through the packaged Webview. A token-scoped, read-only observation
surface is enabled only for this qualification mode. The runner rejects any
inventory or normalized display decision that differs from the local matrix
and records the ordered matrix fingerprint together with both VSIX SHA-256
values. The same run retains the 100%, 125%, 150% and 200% display-scale,
normal/narrow layout and review-interaction checks. Paths, drawing names,
source text and raster bytes are excluded from the report.

This repository does not define product-to-product screenshot comparison as a
completion workflow. If maintainers supply optional external observations,
their reports pin product/version or observation time, source digest,
screenshot digest and dimensions, selected space/view, background and
font/resource availability. Login state, private drawings, local paths,
credentials and raster bytes are never committed.

The output never includes local paths, drawing names outside the public corpus,
source text, raster bytes or credentials. It refuses a non-pinned source
archive, the wrong Scene Cache version, a missing section, an invalid supported
entity, an unpartitioned omission or an omitted referenced linetype. Optional
external reports additionally fail closed on an unrecognized product/version,
platform, capture mode or mislabeled image. The aggregate records model and
paper-layout `ANNOALLVISIBLE` counts, saved current tabs, exact current-paper
resolution and per-layout `PSLTSCALE` counts separately, so an independently
saved layout value cannot be hidden by a drawing-level summary.

After the required local checks pass, the top-level report status is
`pass-with-explicit-boundaries`. Supplemental Browser or proprietary reports
are listed as observed, incomplete or `not-run`; they do not promote or demote
that status. Documented STB, underlay, proxy and 3D product boundaries remain
explicit rather than being presented as rendered parity.

This corpus does **not** contain `FILLMODE=0`, `ATTMODE=0/2`,
`ANNOALLVISIBLE=0`, `QTEXTMODE=1`, `SPLFRAME=1`, `DISPSILH=1`,
`DISPSILHBLOCKS=0`, `IMAGEQUALITY=0`, `VISRETAIN=0`, `XREFOVERRIDE=1`,
FRAME values 1/2 for every family, STB, or a complete XREF
state matrix. Repository-generated state fixtures cover the listed local
completion matrix where applicable; unsupported families remain explicit
boundaries. Packaged Windows completion requires a fresh `status: "pass"`
report from the current VSIX bytes; a local matrix report or an older package
cannot substitute for it.

## Autodesk and format references

- [Autodesk Viewer getting started and conversion](https://help.autodesk.com/cloudhelp/ENU/ADSKVIEWER-Help/files/ADSKVIEWER_Help_GettingStarted_html.html), [supported file types](https://help.autodesk.com/cloudhelp/ENU/ADSKVIEWER-Help/files/ADSKVIEWER_Help_SupportedFileTypes_html.html) and [viewer tools/settings](https://help.autodesk.com/cloudhelp/ENU/ADSKVIEWER-Help/files/ADSKVIEWER_Help_AutodeskViewerTools_html.html)
- [APS 2D DWG SmartPDF/SVF translation](https://aps.autodesk.com/blog/model-derivative-dwg-translation-optimizations) and [Model Derivative conversion](https://aps.autodesk.com/model-derivative-api-2d-3d-conversions)
- [DWG TrueView capabilities](https://help.autodesk.com/view/TRUEVIEW/2023/ENU/?guid=GUID-3B781BF9-BE26-4E33-854E-BE5C6BCF8243), [saved system-variable limitation](https://help.autodesk.com/cloudhelp/2025/ENU/DWGTrueView/files/GUID-8C40931E-E3EF-47CF-86D5-E379BBB1385F.htm) and [Autodesk viewer-engine FAQ](https://download.autodesk.com/us/support/files/design_review_documentation/2018/design_review_2018_faq_en.pdf)
- [Autodesk AutoCAD sample files](https://www.autodesk.com/support/technical/article/caas/tsarticles/ts/6XGQklp3ZcBFqljLPjrnQ9.html)
- [ACADVER release mapping](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-793238B6-F8B8-4D20-BB3A-001700AECD75.htm)
- [Autodesk DXF entities](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-7D07C886-FD1D-4A0C-A7AB-B4D21F18E484.htm)
- [Autodesk common entity group codes](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-3610039E-27D1-4E23-B6D3-7E60B22BB5BD.htm)
- [TILEMODE](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-LT/files/GUID-02F55DD8-1EB1-493C-929D-A7CFDE55C348.htm), [CTAB](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-20529853-0C88-4417-8D8C-9783E9789BBC.htm), [CLAYOUT](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-0C492884-3B3F-4C35-8BAE-8233342A9203.htm) and [current layout block resolution](https://help.autodesk.com/cloudhelp/2019/ENU/OARX-RefGuide/files/OREF-__MEMBERTYPE_Methods_AcDbLayoutManager.html)
- [FILLMODE](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-FC385D70-45AA-4B9A-848A-CA3906C36124.htm)
- [ATTDISP / ATTMODE](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-BCFF32DB-6860-4812-BEF1-3BB658126B26.htm)
- [ANNOALLVISIBLE](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-D8E50F6F-FB71-4A20-A3B9-7701C0518B81.htm)
- [QTEXTMODE](https://help.autodesk.com/cloudhelp/2022/ENG/AutoCAD-Core/files/GUID-95370B7F-B389-4026-94B7-7E869BF2AAB6.htm), [SPLFRAME](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-9F9CC9C6-023C-44BC-A0BF-3C25F36C4259.htm) and [DISPSILH](https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-Core/files/GUID-AFD89831-0DE8-4398-8774-0C3F8DB0D228.htm)
- [IMAGEQUALITY](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-19368CF1-3845-4E62-B408-B5036853C261.htm), [raster display versus plot quality](https://help.autodesk.com/cloudhelp/2020/ENU/OARX-ManagedRefGuide/files/OARX-ManagedRefGuide-Autodesk_AutoCAD_DatabaseServices_RasterVariables_ImageQuality.html) and [PNGOUT screen-display behavior](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-DC273B67-42AC-4A2A-9001-4825FF268E5D.htm)
- [XREFOVERRIDE](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Core/files/GUID-131E3BBB-A28A-40BC-BDC5-A4486C1E2DBE.htm), [VISRETAIN](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-897B1672-4E09-42E0-B857-A9D1F96ED671.htm), [VISRETAINMODE](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-46480687-6DFF-499E-B7C0-E741AEA11D00.htm) and [xref layer/fade behavior](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-A987D2FF-45BD-474E-99C1-E6316A42F667.htm)
- [TRANSPARENCYDISPLAY](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-0908F1AC-D122-4B3D-A17C-8705D03A0D0C.htm), [VPLAYEROVERRIDESMODE](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-MAC-Core/files/GUID-C70C14C3-7BF1-4199-BFD4-7AF172E344CB.htm), [OLEHIDE](https://help.autodesk.com/cloudhelp/2026/PTB/AutoCAD-Core/files/GUID-5C49940E-532B-4FDF-8EC4-D75C9779A8B8.htm), [LAYLOCKFADECTL](https://help.autodesk.com/cloudhelp/2016/ENU/AutoCAD-Core/files/GUID-753F2A76-E248-483F-9F55-CCF613B12C31.htm) and [RTDISPLAY](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-BA3CD3F0-A5A3-421A-92EC-C02317F9BE4A.htm)
- [OBJECTISOLATIONMODE](https://help.autodesk.com/cloudhelp/2019/ENU/AutoCAD-Core/files/GUID-B4ED98BE-62D0-4982-82A2-87B744C56F99.htm), [common entity visibility](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-3610039E-27D1-4E23-B6D3-7E60B22BB5BD.htm) and [DISPSILHBLOCKS](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-9E293ED4-1C00-4EF1-BD1D-338D2FEEC01B.htm)
- [DXF header variables](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-A85E8E67-27CD-4C59-BE61-4DC9FADBE74A.htm) and [LAYOUT group codes](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-DXF/files/GUID-433D25BF-655D-4697-834E-C666EDFD956D.htm)
- [VIEWPORT group codes](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-DXF/files/GUID-2602B0FB-02E4-4B9A-B03C-B1D904753D34.htm)
- [MSLTSCALE](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-023B046C-56EA-463C-A867-DF713666A69E.htm) and [PSLTSCALE](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-23EA4D64-AE7D-41E5-A8D0-20F060313D62.htm)
- [Simple custom linetype `A` alignment and short-segment behavior](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-LT-Customization/files/GUID-EF1DF0A9-2088-487C-8085-16FEE6425405.htm) and [polyline linetype generation](https://help.autodesk.com/view/ACD/2026/ENU/?guid=GUID-20B4D4B3-1220-426A-847B-5BBE36EC6FDF)
- [LWDISPLAY](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-51D375D8-AA3D-4AA7-ADC4-1DCCC5BF6D12.htm)
- [TEXTFILL](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-8E1786B0-D31D-4A61-8A84-78E7BE34867B.htm) and [FASTSHADEDMODE](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-81A94EE2-017F-406C-90BB-8E004157DA33.htm)
- [VIEWRES](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-77B1C617-E4BB-4D1E-823A-8E2B055B258E.htm), [WHIPARC](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-DFB5E247-3ADF-4F73-9DE3-E6EA4D2F4AAA.htm), [LINESMOOTHING](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-A3F27607-8A69-401B-9247-61E00584B7F4.htm) and [LINEFADING](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-7AA085DB-2F0C-43B6-933A-DB8170E20F58.htm)
- [SORTENTS](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-56B7D915-515B-4A9C-BCB5-EF2D43C05FE5.htm) and [current REGEN sorting behavior](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-4FEBA606-95E0-4DC4-A116-257ED86DCD58.htm)
- [ACI 7 background behavior](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-2B089E0A-BDC0-4916-885E-543A85FC8CFD.htm)
- [Color-dependent and named plot styles](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Core/files/GUID-929FE8EC-EFE3-43BB-A79F-4FF509A91D5A.htm)
- [Layout ShowPlotStyles](https://help.autodesk.com/cloudhelp/2024/PTB/AutoCAD-ActiveX-Reference/files/GUID-31B8B6DE-C9F1-4BB2-916C-EF7B9AE723B5.htm)
- [Object draw order](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-LT-MAC/files/GUID-8203C80A-3D51-49F0-B756-56FDF5D96697.htm)
- [FRAME](https://help.autodesk.com/cloudhelp/2015/ENU/AutoCAD-Core/files/GUID-29BD70BB-07BF-41A2-8C2F-AD41C9402486.htm), [PDFFRAME](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-9FC48ACE-3962-4977-B2BB-CD90984E91D6.htm), [DWFFRAME](https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-Core/files/GUID-67366D5F-0B39-4159-B762-D369EC765486.htm) and [DGNFRAME](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-A311139A-E89C-4F44-B6E9-C41A25E54CB5.htm)
- [PROXYSHOW](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-E0F980FF-53A5-4094-B259-B1143F8C9B89.htm), [PROXYGRAPHICS](https://help.autodesk.com/cloudhelp/2020/ENG/AutoCAD-Core/files/GUID-4205F367-F234-4BE3-86D5-81234684385F.htm) and [ObjectARX WorldDraw primitives](https://help.autodesk.com/view/OARX/2024/ENU/?guid=GUID-E569419D-8F10-4B2D-B473-7D7B538EE661)
- [HATCH DXF](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-C6C71CED-CE0F-4184-82A5-07AD6241F15B.htm), [MULTILEADER DXF](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-DXF/files/GUID-69B9139A-48B4-48A5-B3CF-A3233ABFBE49.htm) and [MLINE DXF](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-590E8AE3-C6D9-4641-8485-D7B3693E432C.htm)
- [PDF underlays](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-LT/files/GUID-09D63C05-6647-4086-B7E3-86A019E4F93D.htm) and [underlay clipping/display](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-7D42F81C-1007-4D3C-83CE-88D2AF49918E.htm)

Other public implementation references are used only where Autodesk does not
document a file detail, notably ezdxf's HATCH background and MLINE structure
documentation. Those references do not override Autodesk's visible behavior.
