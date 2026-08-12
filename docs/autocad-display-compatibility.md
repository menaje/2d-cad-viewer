# AutoCAD display compatibility audit

This document audits visible DWG behavior against Autodesk AutoCAD 2026 in
2D Wireframe. It deliberately excludes file-open latency, conversion latency
and time to first frame. The comparison target is the saved model/layout
presentation, not editing or DWG round-trip behavior.

The implementation and this audit use four support states:

- **Preserved** — the relevant source values are retained without replacing
  them with inferred values.
- **Bounded display** — the viewer renders a qualified 2D representation under
  documented record, memory and tessellation limits.
- **Explicitly deferred** — the converter counts the logical entity and a
  specific deferred reason; the viewer does not invent substitute content.
- **Structural** — the record contributes ownership, style or geometry to
  another entity and is not expected to draw independently.

"Bounded display" is not a blanket claim of AutoCAD pixel identity. A feature
is parity-qualified only when its source-state pair and reference pixels are
also present in qualification evidence.

## Saved display state

| AutoCAD state | Viewer behavior | Audit state |
| --- | --- | --- |
| `FILLMODE` | Preserved in the drawing record. It gates HATCH solid/gradient/pattern/background results, SOLID/TRACE and wide-polyline interiors. The boundary remains visible when the corresponding entity has one. | Implemented; the public corpus contains only `1`, so the `0/1` AutoCAD pair remains an external gate. |
| `ATTMODE` / `ATTDISP` | `0` hides ATTRIB and ATTDEF, `1` follows each entity's invisible flag and `2` forces attribute display except structural ATTDEF templates. | Implemented; the public corpus contains only `1`, so `0/1/2` reference pixels remain an external gate. |
| `CANNOSCALE` and `ANNOALLVISIBLE` | Versioned variable-dictionary text is converted before matching `CANNOSCALE`; model and every serialized viewport, including the primary paper viewport, carry an annotation scale. Bounded MTEXT/TEXT/ATTDEF/ATTRIB contexts are selected against that scale, and a missing representation is omitted when all-scales display is off. Scene Cache v1.24 preserves the model value and reads each paper layout's independent value from AutoCAD's `AcadAnnoAV` LAYOUT application data. A layout without that data uses Autodesk's documented initial value 1, not an inferred off state. | Implemented with fail-closed validation for duplicate, malformed or non-boolean layout data. The AutoCAD-generated 2×2 same-DWG matrix remains an external pixel and round-trip gate. Other annotative families remain outside the current representation table. |
| XREF state | Original path plus XREF, overlay, loaded and resolved flags are preserved. Unloaded or unresolved references are not resolved or mounted. Nested INSERT/XREF transforms and XCLIP are applied to qualified child content. | Implemented. A redistributable loaded/unloaded/resolved/unresolved AutoCAD fixture is still required for reference pixels. |
| VIEWPORT group 68 and status group 90 | Nonpositive group 68, invisible entities and group-90 off bit `0x20000` are excluded. Positive group 68 supplies stacking order. The primary paper viewport is not drawn as a model viewport. | Implemented. |
| VIEWPORT perspective, front/back clipping and render mode | Perspective and front/back clipping flags, hidden/shaded render modes and related saved values are preserved. Unsupported model viewports are omitted with named reasons instead of being flattened as 2D Wireframe. Wireframe mode 0/1 remains eligible. | Explicit fail-closed boundary. |
| `FRAME` family | `FRAME`, `IMAGEFRAME`, `XCLIPFRAME`, `OLEFRAME`, `PDFFRAME`, `DWFFRAME` and `DGNFRAME` values are preserved when present. `FRAME` 0/1/2 overrides IMAGE, XCLIP and WIPEOUT settings; its derived mixed value 3 selects each individual setting. `OLEFRAME` remains independent. Unavailable values remain unavailable. Values 0/1/2 retain the visible-versus-plot distinction even though the interactive viewer performs no plot job. | Implemented for supported IMAGE, XCLIP, WIPEOUT and OLE presentation boundaries. Underlay entities themselves remain deferred. |
| `LTSCALE`, entity linetype scale, `MSLTSCALE`, `PSLTSCALE` | Global, per-entity, model-annotation and paper-viewport scale factors are combined for first-frame lines, complex linetype overlays and high-zoom curve/XLINE/RAY refinement. | Implemented with bounded dash/shape/text tables. |
| `LWDISPLAY` | Model-space lineweight visibility is saved. Layout lineweights use paper units, layout/model scale and device pixels; the displayed width is zoom/DPI aware and capped. | Implemented for the 2D renderer. Plot-device end/join styles are not independently reconstructed. |
| `PROXYSHOW` / `PROXYGRAPHICS` | `PROXYSHOW` is not stored in a DWG, so the adapter uses AutoCAD's default value `1`. It renders only an allowlisted proxy-graphics primitive stream and defers a malformed or unsupported stream atomically. | Implemented policy; object-enabler reconstruction is out of scope. |

Autodesk documents `FILLMODE` as affecting hatches, 2D solids, wide
polylines and donuts. The viewer therefore applies it to the wide-polyline
surface path as well as HATCH and SOLID/TRACE; testing only HATCH would be an
incomplete variable-pair gate.

## Color, lineweight and plot styles

| Feature | Viewer behavior | Audit state |
| --- | --- | --- |
| ACI, ByLayer, ByBlock and TrueColor | Entity and viewport-layer resolution is applied through the instance graph. ACI 7 is black on a light display/plot background and white on a dark display background; other ACI entries and TrueColor are unchanged. | Implemented. |
| CTB | The host resolves a stored basename through bounded drawing/project/configured roots, rejects ambiguity, parses bounded compressed CTB content and sends only normalized colors, screening and lineweights to the Webview. A layout can opt into the table without changing model colors. | Implemented. |
| STB / named plot styles | A `.stb` layout assignment is identified and never parsed as CTB. Applying per-entity named styles requires serializing each entity/layer plot-style reference and a normalized named table; that contract does not yet exist. The UI reports this boundary explicitly. | Explicitly deferred; an STB screenshot must prove the diagnostic, not falsely claim styled pixels. |
| Viewport layer overrides | Sparse color, transparency, linetype and lineweight overrides are applied per visibility row and inherited by WebGL lines/fills/points plus Canvas text and IMAGE. Per-viewport group-390 named plot-style overrides are not serialized. | Implemented for the four normalized properties; named STB application is explicitly deferred. |

## Entity-family audit

| Family | Display behavior | Audit state |
| --- | --- | --- |
| LINE | Finite WCS endpoints, common style, handle and owner identity. | Preserved and displayed. |
| ARC, CIRCLE, ELLIPSE | Exact source parameters are retained. A bounded first-frame chord is replaced with camera-dependent high-zoom refinement while preserving identity and linetype phase. | Preserved; bounded display. |
| SPLINE | Degree, knots, weights, control/fit points and tangents are retained. Valid NURBS are sampled per nonempty span; malformed definitions use bounded fit/control chords and remain diagnostic. | Preserved; bounded display. |
| LWPOLYLINE, 2D/3D POLYLINE | Vertices, bulges, closure, widths, elevation/normal and entity linetype scale are retained. Wide segments form joined 2D surfaces; `FILLMODE=0` keeps their boundaries. | Preserved; bounded display. |
| POLYLINE mesh | M/N topology, closed directions and vertices are retained and rendered as bounded wire rows/columns. Polyface and shaded mesh surfaces are not claimed. | Bounded wire display. |
| INSERT, MINSERT | Block ownership, transform, array cells, layer/style inheritance, nested draw order and XCLIP are composed without expanding a whole-drawing graph. | Preserved and displayed under depth/instance caps. |
| DIMENSION families | A resolved anonymous picture block is displayed as one identity-preserving instance. A missing or invalid picture block is counted as `unresolved_dimensions`. | Bounded display or explicit deferral. |
| POINT | WCS point, normal, thickness, angle and PDMODE/PDSIZE snapshot drive screen-space markers. | Preserved; bounded display. |
| SOLID, TRACE | OCS corners use AutoCAD perimeter order. FILLMODE chooses filled triangles or outlines. | Preserved and displayed. |
| 3DFACE | Four WCS corners and invisible-edge flags are retained; only visible nondegenerate edges draw. | Qualified 2D Wireframe boundary; no shaded face claim. |
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
[`autocad-display-parity-2026-08-12.json`](../compatibility/evidence/autocad-display-parity-2026-08-12.json).
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
- deferred partition: 43 unresolved dimensions, 3 underlays, 5 proxy streams,
  18 unsupported 3D entities, 0 invalid supported entities and 39 other
  unsupported entities;
- 51 required Scene Cache v1.24 sections in every output;
- zero omitted referenced linetypes;
- model/layout, presentation-variable, viewport-mode and plot-style state
  distributions plus selected-fixture hashes and section counts;
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
pnpm run qualify:autocad-display-parity \
  --adapter /absolute/path/to/libredwg-adapter \
  --corpus /absolute/path/to/libredwg-0.14/test/test-data \
  --autodesk-samples /absolute/path/to/autodesk-official-samples \
  --source-archive /absolute/path/to/libredwg-0.14.tar.xz \
  --autocad-pair-evidence /absolute/path/to/fillmode-pair.json \
  --autocad-pair-evidence /absolute/path/to/attmode-pair.json \
  --autocad-annotation-evidence /absolute/path/to/annotation-matrix.json \
  --autocad-xref-evidence /absolute/path/to/xref-matrix.json \
  --windows-vscode-evidence /absolute/path/to/windows/report.json \
  --windows-vsix /absolute/path/to/viewer.vsix \
  --windows-companion-vsix /absolute/path/to/companion.vsix \
  --browser-evidence /absolute/path/to/representative-browser.png \
  --output /absolute/new/path/autocad-display-parity.json \
  --observed-at 2026-08-12T08:30:00Z
```

On Windows with AutoCAD installed, generate one same-camera DWG/PNG pair per
saved value before supplying the external pair gate. The output directory must
not already exist. The runner starts AutoCAD with its documented `/b` startup
script switch, performs `ZOOM Extents` once, changes every value in the same
session, uses `PNGOUT` for the displayed reference, saves a DWG for that value,
and reconverts each DWG with the exact adapter under test:

```powershell
pnpm run qualify:autocad-variable-pair `
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

The bounded whitelist is `FILLMODE`, `ATTMODE`, `ANNOALLVISIBLE`, `FRAME`,
`IMAGEFRAME`, `XCLIPFRAME`, `OLEFRAME`, `PDFFRAME`, `DWFFRAME` and
`DGNFRAME`. `FRAME=3` is intentionally not an input: Autodesk documents it as
the derived mixed state, not a manually settable value. Each report records
the source, output DWGs and AutoCAD PNG dimensions and SHA-256 values, the
source/serialized/deferred partition, and the Scene Cache drawing field read
back from the AutoCAD save. The v2 report hashes decoded reference pixels and
fails unless `FILLMODE` and `ANNOALLVISIBLE` 0/1 differ, all three `ATTMODE`
states differ, and every FRAME-family 0 state differs from the identical
on-screen 1/2 states (value 2 changes plotting, not screen display).
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
v1.24 and must independently expose both the model and named-layout values:

```powershell
pnpm run qualify:autocad-annotation-matrix `
  --autocad "C:\Program Files\Autodesk\AutoCAD 2026\acad.exe" `
  --adapter C:\qualification\libredwg-adapter.exe `
  --drawing C:\qualification\public\blank.dwg `
  --supported-scale-name "1:1" --supported-scale-value 1 `
  --active-scale-name "1:2" --active-scale-value 2 `
  --case-id annotation-matrix `
  --output-dir C:\qualification\annotation-matrix `
  --observed-at 2026-08-12T12:00:00Z
```

Pass the ordinary pairs and dedicated reports back to the aggregate
qualification. The aggregate gate remains pending until it
has complete FILLMODE 0/1, ATTMODE 0/1/2, model and layout ANNOALLVISIBLE 0/1,
and FRAME, IMAGEFRAME, XCLIPFRAME and OLEFRAME 0/1/2 reports. Annotation-scale
and XREF state matrices remain independent completion gates.

The three Windows inputs are optional as a group. When supplied, the aggregate
gate verifies the raw packaged-VSIX report, all eight 100/125/150/200% normal
and narrow screenshots, interaction and model/layout reset results, cleanup
enforcement, the exact viewer and companion VSIX bytes and SHA-256 values, and
the pinned Autodesk annotation-scaling/multileader sample used by the Browser
model/layout review.
Supplying only a report or substituting a different package fails closed.

The output never includes local paths, drawing names outside the public corpus,
source text or credentials. It refuses a non-pinned source archive, the wrong
Scene Cache version, evidence not produced by AutoCAD 2026 (`ACADVER=25.1s`)
on Windows, a non-2D-Wireframe capture mode, a missing section, an invalid supported entity, an
unpartitioned omission, an omitted referenced linetype or a mislabeled Browser
image. The Browser gate requires all 11 named model/layout, dark/light,
1×/2×, CTB/STB and object-family images; a partial list remains pending. The
aggregate also records model and paper-layout `ANNOALLVISIBLE`
counts separately, so an independently saved layout value cannot be hidden by
the drawing-level summary.

The top-level status remains `pass-with-explicit-external-gates` until the
complete Browser matrix, AutoCAD variable pairs, annotation matrix, XREF
matrix and exact packaged Windows run are all present. Only then does it become
`pass-with-explicit-boundaries`; documented STB, underlay, proxy and 3D product
boundaries remain explicit rather than being presented as rendered parity.

This corpus does **not** contain `FILLMODE=0`, `ATTMODE=0/2`,
`ANNOALLVISIBLE=0`, FRAME values 1/2 for every family, STB, or a complete XREF
state matrix. The public AutoCAD reference-image gate is closed by the paired
set and representative Browser review, while the AutoCAD-created
system-variable pair gate remains pending. A packaged Windows VS Code run from
the current implementation also remains pending.

## Autodesk and format references

- [Autodesk AutoCAD sample files](https://www.autodesk.com/support/technical/article/caas/tsarticles/ts/6XGQklp3ZcBFqljLPjrnQ9.html)
- [ACADVER release mapping](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-793238B6-F8B8-4D20-BB3A-001700AECD75.htm)
- [Autodesk DXF entities](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-7D07C886-FD1D-4A0C-A7AB-B4D21F18E484.htm)
- [Autodesk common entity group codes](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-3610039E-27D1-4E23-B6D3-7E60B22BB5BD.htm)
- [FILLMODE](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-FC385D70-45AA-4B9A-848A-CA3906C36124.htm)
- [ATTDISP / ATTMODE](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-BCFF32DB-6860-4812-BEF1-3BB658126B26.htm)
- [ANNOALLVISIBLE](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-D8E50F6F-FB71-4A20-A3B9-7701C0518B81.htm)
- [DXF header variables](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-A85E8E67-27CD-4C59-BE61-4DC9FADBE74A.htm)
- [VIEWPORT group codes](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-DXF/files/GUID-2602B0FB-02E4-4B9A-B03C-B1D904753D34.htm)
- [MSLTSCALE](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-023B046C-56EA-463C-A867-DF713666A69E.htm) and [PSLTSCALE](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-23EA4D64-AE7D-41E5-A8D0-20F060313D62.htm)
- [LWDISPLAY](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-51D375D8-AA3D-4AA7-ADC4-1DCCC5BF6D12.htm)
- [ACI 7 background behavior](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-2B089E0A-BDC0-4916-885E-543A85FC8CFD.htm)
- [Color-dependent and named plot styles](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-Core/files/GUID-929FE8EC-EFE3-43BB-A79F-4FF509A91D5A.htm)
- [Object draw order](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-LT-MAC/files/GUID-8203C80A-3D51-49F0-B756-56FDF5D96697.htm)
- [FRAME](https://help.autodesk.com/cloudhelp/2015/ENU/AutoCAD-Core/files/GUID-29BD70BB-07BF-41A2-8C2F-AD41C9402486.htm), [PDFFRAME](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-9FC48ACE-3962-4977-B2BB-CD90984E91D6.htm), [DWFFRAME](https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-Core/files/GUID-67366D5F-0B39-4159-B762-D369EC765486.htm) and [DGNFRAME](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-A311139A-E89C-4F44-B6E9-C41A25E54CB5.htm)
- [PROXYSHOW](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-E0F980FF-53A5-4094-B259-B1143F8C9B89.htm), [PROXYGRAPHICS](https://help.autodesk.com/cloudhelp/2020/ENG/AutoCAD-Core/files/GUID-4205F367-F234-4BE3-86D5-81234684385F.htm) and [ObjectARX WorldDraw primitives](https://help.autodesk.com/view/OARX/2024/ENU/?guid=GUID-E569419D-8F10-4B2D-B473-7D7B538EE661)
- [HATCH DXF](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-C6C71CED-CE0F-4184-82A5-07AD6241F15B.htm), [MULTILEADER DXF](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-DXF/files/GUID-69B9139A-48B4-48A5-B3CF-A3233ABFBE49.htm) and [MLINE DXF](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-590E8AE3-C6D9-4641-8485-D7B3693E432C.htm)
- [PDF underlays](https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-LT/files/GUID-09D63C05-6647-4086-B7E3-86A019E4F93D.htm) and [underlay clipping/display](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-7D42F81C-1007-4D3C-83CE-88D2AF49918E.htm)

Other public implementation references are used only where Autodesk does not
document a file detail, notably ezdxf's HATCH background and MLINE structure
documentation. Those references do not override Autodesk's visible behavior.
