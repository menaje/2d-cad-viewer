# Scene Cache v1.26

Status: current writer. Product writers emit major 1, minor 26. Product
readers accept the explicit backward window 1.21–1.26; older and newer minor
versions fail closed. References to lower minor versions below otherwise
describe additive format history and do not define supported runtime inputs.
The current implementation includes source geometry/text writing, resolved
DIMENSION picture-block instances, bounded HATCH rings and asynchronous
solid/gradient fill,
viewport-clipped pattern, POINT marker, SOLID fill/outline and 3DFACE
wireframe paths, plus lossless WIPEOUT source, frame display and normalized
draw-order tables, original XREF paths, INSERT/XREF spatial clips and
external line/text composition, CAD linetypes, paper/model layout tabs,
viewport layer/clip/annotation-scale state and the saved model-space view
plus source IMAGE/IMAGEDEF paths, image bases and clip boundaries, bounded
OLE bitmap/EMF previews, bounded MTEXT/TEXT/ATTDEF/ATTRIB
annotation-context representations and entity linetype scales for exact-curve
refinement;
expansion tracked by GitHub issues #3 and #9.

The cache is a little-endian, versioned binary container designed for range
reads and browser `ArrayBuffer`/`DataView` access. Geometry is never encoded as
JSON.

## File layout

```text
64-byte header
40-byte section directory entries
8-byte alignment padding
section payloads
```

### Header

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[8]` | magic: `DWGSCN1\0` |
| 8 | `u16` | major version |
| 10 | `u16` | minor version |
| 12 | `u32` | header size |
| 16 | `u32` | section count |
| 20 | `u32` | directory-entry size |
| 24 | `u32` | flags |
| 28 | `u32` | reserved |
| 32 | `u64` | directory offset |
| 40 | `u64` | cache file size |
| 48 | `u64` | source DWG size |
| 56 | `u32` | source DWG version code |
| 60 | `u32` | maintenance version |

Header flag bit 0 (`0x00000001`) marks a display-only progressive preview.
All other bits are reserved and must be zero; the Webview rejects a cache with
an unknown header flag. A canonical full cache always writes flags as zero.

A flagged preview is still an independently readable v1.26 container with the
complete section directory. It carries drawing, layer, block and INSERT
metadata, layout/viewport state including viewport layer overrides, INSERT
clip boundaries, plus only the LOD-0 GPU line batches and vertices needed for
the first frame. Remaining required sections are encoded as valid empty
sections.
Preview geometry retains the 4 MiB overview cap and existing metadata section
limits. The artifact is ephemeral: it is not a valid replacement for the
canonical full conversion result, is not committed under the cache identity
and must be deleted after the full cache replaces it.

### Directory entry

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | section kind |
| 4 | `u32` | record size |
| 8 | `u64` | payload offset |
| 16 | `u64` | payload byte length |
| 24 | `u64` | record count |
| 32 | `u32` | flags |
| 36 | `u32` | reserved |

Section kinds currently written:

Directory order defines section identity but does not require payloads to be
stored in kind order. Every payload must be 8-byte aligned, contained within
the declared file size and non-overlapping. This permits the native writer to
place the large kind-31 vertex body before the small kind-30 batch directory
while writing the vertex body directly to its final range.

| Kind | Payload |
| ---: | --- |
| 1 | drawing metadata and bounds |
| 2 | layer table and UTF-8 strings |
| 3 | shared block-definition table and UTF-8 strings |
| 4 | text-style table and UTF-8 strings |
| 10 | LINE records |
| 11 | ARC records |
| 12 | CIRCLE records |
| 13 | block-instance records (INSERT/MINSERT and resolved DIMENSION pictures) |
| 14 | normalized polyline headers |
| 15 | normalized polyline vertex pool |
| 16 | ELLIPSE records |
| 17 | SPLINE headers |
| 18 | SPLINE knot pool |
| 19 | SPLINE weight pool |
| 20 | SPLINE control-point pool |
| 21 | SPLINE fit-point pool |
| 22 | TEXT/MTEXT/ATTDEF/ATTRIB records and UTF-8 strings |
| 23 | MTEXT column-height pool |
| 30 | viewport/LOD GPU line batches |
| 31 | interleaved GPU line vertices |
| 32 | HATCH records and UTF-8 pattern/gradient names |
| 33 | bounded closed HATCH loop records |
| 34 | HATCH loop `f64[3]` vertex pool |
| 35 | HATCH gradient-color pool |
| 36 | HATCH seed-point pool |
| 37 | HATCH pattern-definition-line records |
| 38 | HATCH pattern dash/gap/dot value pool |
| 39 | POINT source records |
| 40 | SOLID source records |
| 41 | 3DFACE source records |
| 42 | WIPEOUT source records |
| 43 | WIPEOUT clip-boundary `f64[2]` vertex pool |
| 44 | normalized block-local draw-order table records |
| 45 | draw-order entity/sort-handle entry pool |
| 46 | INSERT/XREF spatial-clip records |
| 47 | INSERT/XREF clip-boundary `f64[2]` vertex pool |
| 48 | linetype definitions and UTF-8 names/descriptions |
| 49 | linetype dash/shape/text records |
| 50 | model/paper layout records and UTF-8 plot settings |
| 51 | paper-space viewport records |
| 52 | viewport-frozen layer indices |
| 53 | non-rectangular viewport clip vertices |
| 54 | IMAGE records and IMAGEDEF UTF-8 paths |
| 55 | IMAGE clip-boundary `f64[2]` vertex pool |
| 56 | MTEXT/TEXT/ATTDEF/ATTRIB annotation-context representation records |
| 57 | MTEXT annotation-context column-height pool |
| 58 | sparse viewport-specific layer property overrides |
| 59 | embedded OLE preview metadata |
| 60 | embedded OLE preview byte pool |
| 61 | exact-curve entity linetype-scale records |
| 62 | exact XLINE/RAY point-and-direction records |

Version 1.0 contains kinds 1–3 and 10–13. Version 1.1 adds kinds 14–21.
Version 1.2 adds kinds 30–31 for straight and polyline GPU lines. Version 1.3
extends those GPU sections with bounded curve chords without changing their
binary record sizes. Version 1.4 adds kinds 4 and 22–23 for source text and
font-style metadata. Version 1.5 adds bounded HATCH boundary chords and expands
the packed GPU source-kind field without changing a record size. Version 1.6
adds kinds 32–36 for bounded source-backed HATCH fills. Version 1.7 adds kinds
37–38 for resolved pattern-definition lines and dash values. Version 1.8 adds
kinds 39–40 for POINT and SOLID source records. Resolved DIMENSION picture
blocks reuse the unchanged kind-13 record and therefore require no version
bump or new section. Version 1.9 adds kind 41 for WCS 3DFACE corners and
invisible-edge flags. Version 1.10 adds kinds 42–43 for WIPEOUT image bases,
display metadata and exact clip vertices; drawing metadata offset 12 stores
the drawing-wide frame setting. Version 1.11 adds kinds 44–45 for normalized
`SORTENTSTABLE` ownership and entity/sort-handle pairs. Version 1.12 uses the
last eight bytes of the unchanged 64-byte block record for the original XREF
path. At that milestone, the v1.12 writer retained the path unchanged.
Version 1.13 adds kinds 46–47 for bounded
`SPATIAL_FILTER`/XCLIP boundaries associated with INSERT records. A v1.13
writer emits 36 sections. Version 1.14 expands the drawing display settings
without adding a section. Version 1.15 adds kinds 48–49, extends drawing
metadata with linetype scales and expands GPU vertices with a pattern-distance
field. Version 1.16 adds kinds 50–53 for layouts and paper-space viewports.
Version 1.17 extends drawing metadata with the saved model-space view.
Version 1.18 adds kinds 54–55 for raster IMAGE placement, display metadata,
IMAGEDEF paths and exact clip coordinates. Version 1.19 adds kinds 56–57 for
MTEXT annotation-context representations and their column heights, and uses
the final eight bytes of the unchanged kind-51 viewport record for its exact
annotation scale. Version 1.20 adds kind 58 for viewport-specific layer color,
transparency, linetype and lineweight overrides. Version 1.21 adds kinds 59–60
for bounded OLE bitmap and reconstructed EMF previews. Version 1.22 uses the
drawing presentation word and two block flags to preserve ATTMODE, FRAME-family
settings, ANNOALLVISIBLE, MSLTSCALE and XREF loaded/resolved state without
changing any record size or section count. A v1.22 writer always emits all 49
sections, including empty pools.
Version 1.23 extends kind 56 with a discriminated representation for annotative
TEXT, ATTDEF and ATTRIB, adds kind 61 so finite and construction-line curve
sources retain their entity linetype scale during high-zoom refinement, and
adds kind 62 for exact XLINE/RAY point-and-direction sources. It also uses
presentation bits 15–20 for saved PDF/DWF/DGN underlay-frame settings. A v1.23 writer
always emits all 51 sections, including empty pools.
Version 1.24 uses the previously reserved layout-record word at offset 54 to
preserve the effective per-layout ANNOALLVISIBLE boolean. It does not add a
section or change a record size; a v1.24 writer still emits all 51 sections.
Version 1.25 assigns drawing-presentation bits 21–24 to the saved QTEXTMODE,
SPLFRAME, DISPSILH and XREFOVERRIDE booleans. It does not add a section or
change a record size; a v1.25 writer still emits all 51 sections.
Version 1.26 assigns drawing-presentation bits 25–27 to VISRETAIN,
RASTERVARIABLES image quality and DISPSILHBLOCKS. It does not add a section or
change a record size; a v1.26 writer still emits all 51 sections.

## Shared primitive prefix

Every primitive record begins with the same 32 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | entity handle |
| 8 | `u64` | owner/block-record handle |
| 16 | `u32` | layer index, or `0xffffffff` |
| 20 | `u32` | encoded source color |
| 24 | `i16` | source line weight |
| 26 | `u16` | flags; bit 0 means invisible |
| 28 | `u32` | reserved |

Color uses the upper two bits as its kind: `00` ByLayer, `01` ByBlock, `10`
ACI index and `11` 24-bit RGB.

Source coordinates are stored as `f64` in v1 to avoid losing precision in large
civil drawings. The v1.2+ GPU sections contain derived, batch-local `f32`
coordinates without replacing these source-precision records.

## Drawing record

In v1.20–v1.26, kind 1 contains one 160-byte record:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | source DWG version code |
| 4 | `u32` | source maintenance version |
| 8 | `i32` | insertion units |
| 12 | `u32` | display bits: WIPEOUT frame 0–1 (`3` unavailable), LWDISPLAY 2, FILLMODE 3, model space active 4; legacy `0xffffffff` means all unavailable |
| 16 | `u64` | total logical entity count |
| 24 | `u64` | serialized logical entity count |
| 32 | `f64[3]` | drawing minimum bounds |
| 56 | `f64[3]` | drawing maximum bounds |
| 80 | `f64` | global linetype scale |
| 88 | `f64` | current-entity linetype scale |
| 96 | `u32` | linetype display flags; bit 0 is paper-space linetype scaling |
| 100 | `u32` | v1.22+ presentation settings; zero and reserved in v1.20–v1.21 |
| 104 | `f64[3]` | saved model-view center |
| 128 | `f64` | saved model-view height |
| 136 | `f64` | saved model-view width |
| 144 | `f64` | saved model-view twist |
| 152 | `u32` | saved-view flags; bit 0 means present |
| 156 | `f32` | v1.22 current model-space annotation scale; zero when unavailable; reserved zero in v1.20–v1.21 |

Before v1.10, offset 12 is reserved and must be zero. Versions 1.10–1.13 use
only its WIPEOUT value; v1.14 adds the three display bits. Versions before
v1.15 end at byte 80, v1.15–v1.16 end at byte 104, and v1.17 adds the saved
view suffix. Those shorter historical records are not accepted by the current
reader, which requires the complete 160-byte current record.

The v1.22 presentation word packs two-bit settings at bits 0–1 ATTMODE, 2–3
IMAGEFRAME, 4–5 XCLIPFRAME, 6–7 OLEFRAME, 8–9 ANNOALLVISIBLE and 10–11
MSLTSCALE. For the first four fields, values 0–2 are the saved setting and 3
means unavailable. ANNOALLVISIBLE and MSLTSCALE accept 0 or 1, use 3 for
unavailable and reject 2. Bits 12–13 carry FRAME and bit 14 marks FRAME as
available. In a v1.22 cache, bits 15–31 are reserved and must be zero. A v1.21
reader path requires the old zero word and exposes conservative display
defaults.

Scene Cache v1.23 assigns bits 15–16 to PDFFRAME, 17–18 to DWFFRAME and
19–20 to DGNFRAME. Values 0–2 preserve the saved setting and 3 means
unavailable. Bits 21–31 remain reserved and must be zero. A v1.22 reader path
requires bits 15–31 to remain zero.

Scene Cache v1.25 assigns bit 21 to QTEXTMODE, bit 22 to SPLFRAME, bit 23 to
DISPSILH and bit 24 to XREFOVERRIDE. A set bit means the saved drawing value
is 1 and a clear bit means 0. Bits 25–31 remain reserved and must be zero.
Readers of v1.21–v1.24 expose the documented initial value 0 for all four
fields.

Scene Cache v1.26 assigns bit 25 to VISRETAIN, bit 26 to high raster IMAGE
quality and bit 27 to DISPSILHBLOCKS. A clear raster-quality bit means draft
display. Bits 28–31 remain reserved and must be zero. Readers of v1.21–v1.25
expose Autodesk's documented initial values: VISRETAIN 1, high IMAGE quality
and DISPSILHBLOCKS 1.

## String-table sections

Layer, block, text-style, text-entity and IMAGE sections begin with:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | record count |
| 4 | `u32` | record size |
| 8 | `u64` | UTF-8 blob offset relative to the section |

Individual records contain offsets and lengths into the trailing UTF-8 blob.
Layer and block data is stored once; primitive and block-instance records
reference it by index or owner handle.

### Block record

Kind 3 stores one 64-byte record per shared block definition:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | block handle |
| 8 | `u32[2]` | block-name UTF-8 offset and length |
| 16 | `u32` | owned entity count |
| 20 | `u32` | INSERT reference count |
| 24 | `u32` | block flags |
| 28 | `i32` | insertion units |
| 32 | `f64[3]` | block base point |
| 56 | `u32[2]` | v1.12 original XREF-path UTF-8 offset and length |

Block flag bits are 0 anonymous, 1 has attributes, 2 XREF, 3 XREF overlay,
4 external path present, 5 explodable and 6 uniformly scaled. Version 1.22
adds bit 7 XREF loaded and bit 8 XREF resolved. Those state bits are valid only
for XREF blocks; the v1.21 compatibility path treats XREFs as loaded and
resolved to preserve its historical behavior. Before v1.12,
offsets 56–63 are reserved and readers expose an empty XREF path. A v1.12
writer retains the path stored by the DWG—relative, Windows drive, UNC or
POSIX—without converting it to the current machine's path syntax. The host
resolves that portable source string and never rewrites the original drawing.
Writers set bit 2 whenever LibreDWG identifies the block as an XREF or retains
an explicit path containing a separator or `.dwg` suffix. The bounded path
check recovers LibreDWG revisions that omit `blkisxref` without promoting bare
ordinary-block metadata such as a name or application marker. The v1.21
compatibility path also normalizes a record that has bit 4 and a non-empty path
but lacks bit 2. Version 1.22+ readers preserve the explicit XREF, loaded and
resolved state without that legacy inference.
The LibreDWG writer converts the raw BLOCK_HEADER Loaded Bit before writing
these semantic flags because DWG stores zero for a loaded reference. A loaded
reference always sets both bits 7 and 8. When the raw loaded bit is set, the
common table resolved value selects unloaded (`loaded=false`, `resolved=true`)
or unresolved (`loaded=false`, `resolved=false`). Consumers test resolved
before loaded so the latter combination remains unresolved rather than being
misreported as an intentional unload.

## Shared block-instance records

Kind 13 is a 136-byte stream consumed by the same recursive instance graph for
ordinary INSERT/MINSERT entities and resolved DIMENSION picture blocks:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u32` | target block-table index, or `0xffffffff` |
| 36 | `u16` | column count |
| 38 | `u16` | row count |
| 40 | `f64[3]` | insertion point |
| 64 | `f64[3]` | XYZ scale |
| 88 | `f64` | rotation in radians |
| 96 | `f64[3]` | OCS normal |
| 120 | `f64` | column spacing |
| 128 | `f64` | row spacing |

An ordinary INSERT/MINSERT retains its source transform and contributes to
`coverage.inserts`. A DIMENSION whose group-code-2 picture block resolves to
the block table contributes to `coverage.dimensions` and writes a one-by-one
identity reference: insertion point equals the target block base point, scale
is `[1,1,1]`, rotation and spacing are zero, and normal is `[0,0,1]`. Because
the instance transform subtracts the target base point, this record applies
the DIMENSION owner's world transform without copying or moving the picture
geometry. Its shared prefix retains the DIMENSION handle, owner, layer, color
and visibility. A missing or non-finite target is not serialized and remains
explicit in `coverage.deferred_entities`.

DIMENSION picture blocks may themselves contain nested block references. The
existing cycle, depth and global-instance limits therefore apply unchanged,
as do the packed `Float64Array` matrices and shared GPU geometry.

### INSERT/XREF spatial clips

Kind 46 stores one 32-byte record for each clipped INSERT or MINSERT:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | INSERT handle |
| 8 | `u64` | first kind-47 vertex |
| 16 | `u32` | vertex count |
| 20 | `u32` | flags: bit 0 rectangular, bit 1 inverted |
| 24 | `u64` | reserved |

Kind 47 stores target-block-local `f64[2]` clip vertices. Rectangular
boundaries contain two opposing corners; polygonal boundaries contain 3–256
ordered vertices. The native writer applies LibreDWG's spatial-filter inverse
transform before serialization. The instance graph expands a rectangle to
four corners, transforms each boundary into world coordinates and propagates
the resulting clip chain through every nested block occurrence.

The renderer stores clip-chain headers and camera-relative vertices in one
bounded floating-point texture. The line, fill and point shaders discard
fragments outside every inherited boundary. The Canvas text overlay applies
the same chain with Canvas2D clipping, and fitted/detail bounds intersect the
non-inverted clip envelopes so hidden block geometry cannot dominate the
initial view or detail streaming.

## Text styles and source text

Scene Cache v1.4 preserves the source strings before attempting display. The
Webview reads the text sections only after the first geometry frame and decodes
an entity's value only after cheap pixel-size and viewport culling.

### Text-style record

Each kind-4 record is 96 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | style handle |
| 8 | `u32[2]` | style-name UTF-8 offset and length |
| 16 | `u32[2]` | primary font-file UTF-8 offset and length |
| 24 | `u32[2]` | BigFont-file UTF-8 offset and length |
| 32 | `u32[2]` | TrueType-name UTF-8 offset and length |
| 40 | `u32` | style flags |
| 44 | `u32` | reserved |
| 48 | `f64` | fixed height |
| 56 | `f64` | width factor |
| 64 | `f64` | oblique angle |
| 72 | `f64` | last height |
| 80 | `u8[16]` | reserved |

Style flag bits are 0 backward, 1 upside down, 2 xref-dependent, 3
annotative, 4 vertical and 5 shape.

### Text-entity record

Each kind-22 record is 336 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u16` | kind: 0 TEXT, 1 MTEXT, 2 ATTDEF, 3 ATTRIB |
| 34 | `u16` | text flags |
| 36 | `u32` | style index, or `0xffffffff` |
| 40 | `u32[2]` | value UTF-8 offset and length |
| 48 | `u32[2]` | attribute tag UTF-8 offset and length |
| 56 | `u32[2]` | attribute prompt UTF-8 offset and length |
| 64 | `u64` | linked handle, or zero |
| 72 | `f64[3]` | insertion point |
| 96 | `f64[3]` | alignment point |
| 120 | `f64[3]` | OCS normal |
| 144 | `f64[3]` | source X-axis direction |
| 168 | `f64` | height |
| 176 | `f64` | width factor |
| 184 | `f64` | rotation |
| 192 | `f64` | oblique angle |
| 200 | `f64` | thickness |
| 208 | `f64` | rectangle width |
| 216 | `f64` | rectangle height |
| 224 | `f64` | extents width |
| 232 | `f64` | extents height |
| 240 | `f64` | line-spacing factor |
| 248 | `f64` | background scale |
| 256 | `u32` | encoded background color |
| 260 | `i32` | background transparency |
| 264 | `i32` | background flags |
| 268 | `i32` | source attribute flags |
| 272 | `i16` | horizontal alignment |
| 274 | `i16` | vertical alignment |
| 276 | `i16` | MTEXT attachment |
| 278 | `i16` | MTEXT flow direction |
| 280 | `i16` | line-spacing style |
| 282 | `i16` | generation flags |
| 284 | `i16` | attribute field length |
| 286 | `i16` | attribute text type: 0 legacy, 1 single-line, 2 multiline ATTRIB, 4 multiline ATTDEF |
| 288 | `i32` | line count |
| 292 | `i32` | column type |
| 296 | `i32` | column count |
| 300 | `u32` | column flags |
| 304 | `f64` | column width |
| 312 | `f64` | column gutter |
| 320 | `u64` | first kind-23 column height |
| 328 | `u64` | column-height count |

Text flag bits are 0 alignment point present, 1 rectangle height present, 2
annotative, 3 multiline (attribute type 2 or 4), 4 position locked and 5 really locked. Column flag
bits are 0 automatic height and 1 reversed flow. Kind 23 is a packed `f64`
pool; every offset/count pair is range-checked.

Source attribute flag bits follow the DWG/DXF ATTDEF and ATTRIB flags: 0
invisible, 1 constant, 2 verification required and 3 preset. A nonconstant
ATTDEF inside a block is a value template and is replaced by the inserted
block's ATTRIB record; it is not itself a visible text occurrence.

### Text annotation contexts

Scene Cache v1.19+ preserves bounded `MTEXTOBJECTCONTEXTDATA` records attached
to MTEXT entities. Version 1.23 also preserves bounded
`TEXTOBJECTCONTEXTDATA` and `MTEXTATTRIBUTEOBJECTCONTEXTDATA` records attached
to TEXT, ATTDEF and ATTRIB entities. Each kind-56 record is 160 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | owning kind-22 text entity handle |
| 8 | `f64` | annotation scale, drawing units per paper unit |
| 16 | `u32` | flags: bit 0 default, bit 1 automatic height, bit 2 reversed flow, bit 3 single-line text representation |
| 20 | `i32` | MTEXT attachment 1–9, or TEXT horizontal alignment 0–5 |
| 24 | `f64[3]` | representation insertion point |
| 48 | `f64[3]` | MTEXT X-axis direction, or TEXT alignment point |
| 72 | `f64` | MTEXT rectangle height, or TEXT rotation |
| 80 | `f64` | rectangle width |
| 88 | `f64` | extents width |
| 96 | `f64` | extents height |
| 104 | `i32` | column type: 0 none, 1 static, 2 dynamic |
| 108 | `u32` | reserved; zero |
| 112 | `f64` | column width |
| 120 | `f64` | column gutter |
| 128 | `u64` | first kind-57 column height |
| 136 | `u64` | column-height count |
| 144 | `u64[2]` | reserved; zero |

Kind 57 is a packed `f64` pool. A context contains at most 64 column heights;
the full cache is capped at 262,144 contexts and 1,048,576 context column
heights. The reader requires finite coordinates and dimensions, positive
annotation scales, a matching MTEXT or single-line-text owner, contiguous pool
ranges and at most one default context per entity. TEXT-family records require
zero column and extent fields and cannot reference the kind-57 pool.

The unchanged 272-byte kind-51 viewport record stores its exact annotation
scale as an `f64` at offset 264. Zero means the source scale was unavailable;
the layout planner then falls back to the finite geometric paper-to-model
ratio. Paper/model roots without a selected layout viewport use annotation
scale zero. For a model viewport, the renderer selects only a context whose
scale matches the viewport annotation scale. The raw kind-22 values represent
the default context and are left unchanged for that context. A non-default
MTEXT match overrides its placement, direction, attachment, extents and column
metadata. A single-line-text match overrides insertion/alignment points,
rotation and horizontal alignment. In both cases text height is the raw height
multiplied by the target/default annotation-scale ratio. If no context matches,
the renderer keeps the default representation only when ANNOALLVISIBLE is
enabled; otherwise it hides the annotative occurrence without inventing
geometry.

### Exact-curve linetype scales

Scene Cache v1.23 kind 61 contains one 16-byte record for every ARC, CIRCLE,
ELLIPSE, SPLINE, normalized polyline header, XLINE and RAY. Offset 0 is the
nonzero `u64` entity handle and offset 8 is its finite positive `f64` entity
linetype scale. The section must cover the exact curve and construction-line
sources one-to-one with unique handles.
The high-zoom refinement path divides saved cumulative pattern distances by
this scale before combining them with global, model/layout and viewport
linetype scaling. Version 1.21–1.22 caches use the historical implicit value 1
because they did not preserve this field.

### Construction lines

Scene Cache v1.23 kind 62 contains one 80-byte record for every XLINE and RAY:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `f64[3]` | finite source WCS point |
| 56 | `f64[3]` | finite nonzero projected WCS direction |

Shared-prefix flag bit 1 discriminates RAY from XLINE; all other bits retain
their shared meaning. The canonical reader rejects unknown common flags,
duplicate or zero handles and non-finite/projected-zero direction vectors. The
coarse GPU line is only a bounded first-frame placeholder. High-zoom refinement
clips the exact infinite line or half-line to the current camera and each
transformed INSERT and XCLIP occurrence, then replaces the placeholder using
the same handle and draw-order identity. This avoids baking an arbitrary
drawing-extents segment that disappears after a pan or at high zoom.

### Viewport layer overrides

Scene Cache v1.20 preserves AutoCAD viewport layer overrides from each LAYER
extension dictionary. Kind 58 contains one 24-byte sparse property record for
every valid XRECORD viewport/value pair:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | owning paper-space VIEWPORT handle |
| 8 | `u32` | layer-table index |
| 12 | `u16` | property: 1 color, 2 transparency, 3 linetype, 4 lineweight |
| 14 | `u16` | reserved; zero |
| 16 | `u32` | normalized property value |
| 20 | `u32` | reserved; zero |

Color uses the cache's encoded ACI/true-color representation with no opacity
bits. Transparency uses only the explicit cache opacity bits. Linetype stores
the normalized kind-48 code and lineweight stores hundredths of a millimetre.
The writer accepts only actual VIEWPORT handles, known layer/linetype entries,
ACI or true-color values, explicit transparency and lineweights from 0 through
211. The reader rejects unknown properties, duplicate viewport/layer/property
tuples, non-zero reserved fields and orphan viewport handles. The pool is
capped at 1,048,576 records.

The layout planner merges the sparse values with the base layer table into the
same bounded rows used for viewport freeze state. WebGL color/opacity,
lineweight, plot-style and linetype textures use the instance row; Canvas text,
complex-linetype and raster-image overlays resolve the same row. Paper space
keeps the base row, and each model viewport can therefore display its own
layer styling without changing shared block geometry.

## Polyline normalization

LWPOLYLINE, 2D POLYLINE and 3D POLYLINE share a 112-byte header and a
64-byte vertex pool. Each header stores:

- the shared 32-byte primitive prefix;
- first vertex index and vertex count;
- source kind and flags;
- elevation, thickness and OCS normal;
- default and constant widths.

Each pooled vertex preserves its `f64` position, bulge, start/end widths,
curve-fit tangent, source flags and vertex ID. Header ranges are validated
against the vertex-pool count.

## Spline normalization

A 208-byte SPLINE header retains degree, flags, knot parameterization, OCS
normal, tolerances and begin/end tangents. It references four typed pools:

- `f64` knots;
- `f64` rational weights;
- `f64[3]` control points;
- `f64[3]` fit points.

All offset/count pairs are checked against their corresponding pool before the
cache is accepted.

## Bounded HATCH source, fill rings and patterns

Scene Cache v1.7 preserves every HATCH as a kind-32 source record, including
its shared primitive prefix, pattern and gradient names, style, flags,
elevation, normal, pattern transform, gradient parameters, seed-point range
and pattern-definition-line count. Closed usable boundary paths become
bounded `f64` rings in kinds 33–34. The duplicated closing endpoint is omitted;
the loop is implicitly closed from its last vertex to its first.

Analytic and bulge edges use the same bounded chord rules as the line display
path. Consequently, kind 34 is a source-backed fill ring rather than a
lossless replacement for the original analytic edge topology. Open,
degenerate and non-finite paths are skipped and reported separately. One
HATCH contributes at most 65,536 ring vertices, the global vertex pool is
capped at 1,048,576 records, and each gradient-color and seed-point pool is
also capped at 1,048,576 records. A truncated entity sets its source flag and
increments `hatch_fills.truncated_fill_hatches`.

### HATCH entity record

Kind 32 uses the standard 16-byte string-table header followed by 192-byte
records:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u32[2]` | pattern-name UTF-8 offset and length |
| 40 | `u32[2]` | gradient-name UTF-8 offset and length |
| 48 | `u32` | HATCH flags |
| 52 | `u16` | style: 0 normal, 1 outer, 2 ignore |
| 54 | `u16` | source pattern-type enum |
| 56 | `u64` | first kind-33 loop |
| 64 | `u64` | loop count |
| 72 | `u64` | first kind-35 gradient color |
| 80 | `u64` | gradient-color count |
| 88 | `f64` | elevation |
| 96 | `f64[3]` | finite OCS normal; `[0,0,1]` fallback |
| 120 | `f64` | pattern angle |
| 128 | `f64` | pattern scale |
| 136 | `f64` | pixel size |
| 144 | `f64` | gradient angle |
| 152 | `f64` | gradient shift |
| 160 | `f64` | gradient tint |
| 168 | `u64` | first kind-36 seed point |
| 176 | `u64` | seed-point count |
| 184 | `u32` | encoded per-HATCH background color, or zero |
| 188 | `u32` | source pattern-definition-line count |

HATCH flag bits are 0 solid, 1 associative, 2 double, 3 gradient, 4
single-color gradient, 5 truncated and 6 per-HATCH background color present.
The background color is recovered from the de facto
`HATCHBACKGROUNDCOLOR` application-data record (DXF group 1071), encoded as
the standard Scene Cache TrueColor value with the HATCH transparency. Pattern
backgrounds use the same bounded rings as the foreground pattern and are
drawn first. A missing, malformed or differently named application-data
record never invents a background.

### HATCH loop and value pools

Each kind-33 record is 48 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | owning kind-32 HATCH index |
| 8 | `u32` | source boundary-path flags |
| 12 | `u32` | source path index within the HATCH |
| 16 | `u64` | first kind-34 vertex |
| 24 | `u64` | vertex count |
| 32 | `u32` | source edge count |
| 36 | `u32` | loop flags; bit 0 means a curve was approximated |
| 40 | `f64` | signed area in the dominant-axis projection |

Kind 34 stores one `f64[3]` vertex per 24-byte record. Kind 35 stores a
gradient stop as `f64 value`, encoded `u32 color` and reserved `u32` in 16
bytes. Kind 36 stores one `f64[2]` seed point in 16 bytes. Entity ranges are
contiguous and monotonic; loop-to-entity, loop-to-vertex, gradient-color and
seed-point ranges are all validated before the cache is accepted.

### HATCH pattern-definition and dash pools

Kind 37 stores each parser-resolved pattern-definition line in a 72-byte
record:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | owning kind-32 HATCH index |
| 8 | `u32` | source definition-line index within the HATCH |
| 12 | `u32` | flags; currently zero |
| 16 | `f64` | resolved line angle in radians |
| 24 | `f64[2]` | resolved base point in HATCH OCS |
| 40 | `f64[2]` | resolved offset vector in HATCH OCS |
| 56 | `u64` | first kind-38 dash value |
| 64 | `u32` | dash-value count |
| 68 | `u32` | reserved; zero |

Kind 38 is a packed `f64` pool. A positive value is a drawn dash length, a
negative value is a gap length, and zero is a dot. The two native writers
preserve the values exposed by their parser after the DWG pattern angle and
scale have been resolved; the Webview therefore does not apply the entity
transform a second time. A user-defined pattern with the HATCH double flag
adds one perpendicular display pass. Predefined pattern definitions already
contain their complete resolved line families.

Definition records are grouped by HATCH and ordered by source definition-line
index. Their dash ranges are contiguous, monotonic and cover the complete
kind-38 pool. The validator checks owner indices, source order, flags,
reserved values, finite angle/base/offset/dash values and all range
arithmetic. One HATCH contributes at most 4,096 definition lines and 65,536
dash values; global pools are capped at 262,144 lines and 1,048,576 dash
values. Truncation sets the HATCH source flag and is reported separately from
invalid skipped definitions.

The Webview starts this work only after the first line frame. A dedicated
worker range-reads the seven HATCH sections, applies normal/outer/ignore ring
nesting, triangulates solid and gradient fills plus qualified pattern
backgrounds, and retains the packed source and block-instance graph for
viewport pattern requests. Pattern definitions
are clipped first to nested HATCH rings and then to the union of visible
model/block-instance viewport intervals. The worker transfers only final
local-origin GPU buffers. Pattern regeneration is debounced by 160 ms and
never rereads the cache. A new file cancels and terminates the previous
worker.

Fill runtime limits are 2,048 loops and 65,536 triangles per entity, 32 MiB of
GPU vertices overall and 24,576 vertices per local-origin batch. Pattern
runtime limits are 2,048 loops and 65,536 segments per HATCH, 250,000 segments
(16 MiB) globally, eight million boundary intersection tests and 32 MiB of
GPU bytes. Definitions closer than 1.5 screen pixels are omitted before
geometry generation. Shared block pattern vertices are stored once, and draw
calls submit only the visible instance indices selected for that viewport.

## POINT, SOLID, 3DFACE and WIPEOUT source/display

Scene Cache v1.8 preserves POINT and SOLID independently of the first line
frame, and v1.9 adds 3DFACE to the same deferred path. All three fixed-size
sections use the shared primitive prefix and retain owner handles, so a block
definition is converted once and displayed through the existing
INSERT/MINSERT instance graph.

### POINT record

Each kind-39 record is 112 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `f64[3]` | source WCS location |
| 56 | `f64[3]` | finite normal |
| 80 | `f64` | thickness |
| 88 | `f64` | source X-axis angle in radians |
| 96 | `f64` | drawing `PDSIZE` snapshot |
| 104 | `i16` | drawing `PDMODE` snapshot |
| 106 | `u16` | reserved; zero |
| 108 | `u32` | reserved; zero |

The Webview emits one local-origin 32-byte vertex per visible marker. Its
payload stores relative `f32[3]` position, layer, color, normalized marker
angle, bounded `PDSIZE` and `PDMODE` plus invisibility. A dedicated point
shader draws the base dot/plus/X/tick and optional circle/square bits in
screen space. Positive `PDSIZE` is converted from drawing units, negative
values are viewport percentages and zero uses five percent of viewport
height; non-dot markers are clamped to 5–64 pixels and the plain dot uses
three pixels. `PDMODE=1` emits no marker.

### SOLID record

Each kind-40 record is 168 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u32` | flags; bit 0 is the drawing `FILLMODE` snapshot |
| 36 | `u32` | reserved; zero |
| 40 | `f64[3]` | first OCS corner |
| 64 | `f64[3]` | second OCS corner |
| 88 | `f64[3]` | third OCS corner |
| 112 | `f64[3]` | fourth OCS corner |
| 136 | `f64[3]` | finite OCS normal |
| 160 | `f64` | thickness |

The fourth corner equals the third for a triangle. The worker converts OCS
corners to WCS once, triangulates a filled quadrilateral as `(1,2,3)` and
`(1,3,4)`, and omits a degenerate second triangle. With `FILLMODE` off it
emits three or four boundary edges instead. Fill vertices use the same
layer-aware 32-byte layout as HATCH fills; outlines use the existing 32-byte
line layout.

### 3DFACE record

Each kind-41 record is 136 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u32` | invisible-edge flags; bits 0–3 correspond to edges 1–4 |
| 36 | `u32` | reserved; zero |
| 40 | `f64[3]` | first WCS corner |
| 64 | `f64[3]` | second WCS corner |
| 88 | `f64[3]` | third WCS corner |
| 112 | `f64[3]` | fourth WCS corner |

The fourth corner equals the third for a triangle. Unlike SOLID, 3DFACE
corners are already WCS coordinates and the edge flags are source semantics,
not a drawing-wide fill switch. The current viewer is a wireframe view, so
the worker emits only non-hidden, non-degenerate edges. It preserves all four
corners and flags so a future explicit shaded mode can triangulate the face
without reparsing the DWG. Face edges append to the existing surface-outline
buffer rather than allocating a fourth primitive GPU buffer.

The source reader caps POINT at 262,144 records and both SOLID and 3DFACE at
131,072 records in addition to the 64 MiB per-section guard. After the first
line frame, a one-shot worker reads kinds 39–41 plus block/INSERT metadata,
builds the shared-instance meshes, transfers the final buffers and exits.
POINT GPU data is capped at 8 MiB, SOLID fills at 16 MiB and the shared
SOLID/3DFACE outline buffer at 8 MiB, for the unchanged 32 MiB combined hard
limit. The primitive worker completes before the HATCH worker starts,
avoiding simultaneous source-geometry peaks.
Per-owner scratch batches start at one primitive instead of reserving a fixed
block and grow only as needed up to 24,576 vertices, so many tiny block
definitions cannot multiply a large initial allocation. Opening another file
terminates either outstanding worker.

### WIPEOUT source and frame display

Scene Cache v1.10 preserves WIPEOUT without adding it to the first line frame.
Each kind-42 record is 168 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `i32` | source class version |
| 36 | `u16` | display properties; only bits 0–3 are valid |
| 38 | `u8` | clip-boundary type: 1 rectangular, 2 polygonal |
| 39 | `u8` | clipping enabled: 0 or 1 |
| 40 | `u8` | brightness, 0–100 |
| 41 | `u8` | contrast, 0–100 |
| 42 | `u8` | fade, 0–100 |
| 43 | `u8` | clip mode: 0 outside, 1 inside/inverted |
| 44 | `u32` | reserved; zero |
| 48 | `u64` | first kind-43 clip vertex |
| 56 | `u32` | clip-vertex count |
| 60 | `u32` | reserved; zero |
| 64 | `u64` | image-definition handle, or zero |
| 72 | `u64` | image-definition-reactor handle, or zero |
| 80 | `f64[3]` | insertion point |
| 104 | `f64[3]` | image U vector |
| 128 | `f64[3]` | image V vector |
| 152 | `f64[2]` | positive image size |

Kind 43 stores one little-endian `f64[2]` local image coordinate per
16-byte record. Entity ranges must be contiguous and cover the complete pool.
A rectangular boundary contains exactly two opposite corners; a polygonal
boundary contains at least three points. The image basis must be finite and
non-degenerate. Readers cap source at 65,536 entities and 1,048,576 clip
vertices, with the existing 64 MiB per-section guard.

The worker displays a frame only when the drawing-wide setting is 1 or 2.
When clipping is enabled and display-property bit 2 (`4`) requests clipping,
the frame follows the clip boundary; otherwise it follows the full image
rectangle from `[-0.5,-0.5]` to `[size.x-0.5,size.y-0.5]`. Rectangular
two-corner clips are expanded to four edges. Each local point `[x,y]` becomes
`insertion + U*x + V*y`, and the result retains the source owner, layer,
color, handle and block-instance sharing. Frames append to the shared 8 MiB
surface-outline buffer used by SOLID and 3DFACE. Degenerate edges and budget
exhaustion are reported explicitly.

The background mask itself is deliberately not synthesized yet. Correct
WIPEOUT masking depends on entity draw order, including block-local
`SORTENTSTABLE` order and nested INSERT ordering. Drawing a mask after the
current type-grouped geometry would erase valid foreground text and lines.
The Webview therefore reports visible source masks as
`deferredWipeoutMasks` while preserving every source field needed by the
draw-order-aware renderer tracked in issue #4.

## Raster IMAGE references

Scene Cache v1.18 preserves each raster `IMAGE` entity independently of the
first line frame. Kind 54 is a string-table section with one 176-byte record
per entity:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u32[2]` | IMAGEDEF path UTF-8 offset and byte length |
| 40 | `i32` | source class version |
| 44 | `u16` | display properties; only bits 0–3 are valid |
| 46 | `u8` | clip-boundary type: 1 rectangular, 2 polygonal |
| 47 | `u8` | clipping enabled: 0 or 1 |
| 48 | `u8` | brightness, 0–100; 50 is neutral |
| 49 | `u8` | contrast, 0–100; 50 is neutral |
| 50 | `u8` | fade, 0–100 |
| 51 | `u8` | clip mode: 0 outside, 1 inside/inverted |
| 52 | `u32` | reserved; zero |
| 56 | `u64` | first kind-55 clip vertex |
| 64 | `u32` | clip-vertex count |
| 68 | `u32` | reserved; zero |
| 72 | `u64` | IMAGEDEF handle, or zero |
| 80 | `u64` | IMAGEDEF reactor handle, or zero |
| 88 | `f64[3]` | insertion point |
| 112 | `f64[3]` | image U vector per source pixel |
| 136 | `f64[3]` | image V vector per source pixel |
| 160 | `f64[2]` | positive source-pixel width and height |

Kind 55 stores the contiguous 16-byte `f64[2]` local image-coordinate pool.
Rectangular clips contain exactly two opposite corners and polygonal clips
contain at least three vertices. The validator requires finite,
non-degenerate U/V bases, bounded display values, valid UTF-8 paths and full
pool coverage. Source is capped at 65,536 IMAGE records and 1,048,576 clip
vertices. Serialized clip vertices retain the source IMAGE pixel convention.
Before applying placement, the Webview converts each top-origin clip Y to its
bottom-origin image basis with `height - 1 - y`; this leaves the default
half-pixel boundary invariant while aligning cropped image content with its
CAD geometry.

The path is retained exactly as stored in IMAGEDEF. The VS Code host resolves
saved manual mappings, current-platform absolute paths, drawing-relative
paths and bounded filename/parent-folder search in that order. It currently
accepts JPG/JPEG and PNG only. A file is limited to 32 MiB, one source image
to 100 million pixels, one drawing session to 256 references and unique
compressed transfer to 64 MiB. Missing or ambiguous paths remain available
for explicit user selection.

The Webview requests content only after the transformed image rectangle
intersects the current viewport and is at least 0.75 screen pixel in each
dimension. Its first decode is sized to 1.5 times the current screen footprint
and upgrades only when the requested size grows by more than 1.5 times.
Decoding is capped at 4,096 pixels on either axis and 8,388,608 pixels per
bitmap. A least-recently-used cache retains at most 16,777,216 decoded pixels
(64 MiB RGBA) while compressed content remains deduplicated by SHA-256. Each
image reuses the existing block/XREF instance graph, layer visibility and
nested XCLIP chain. Its transformed normal clip boundary contributes to fitted
bounds, including image-only root and external drawings. Canvas placement maps
the bitmap to `insertion + U*x + V*y`, applies rectangular or polygonal IMAGE
clipping, brightness, contrast, fade and instance opacity, and keeps WebGL
line/fill geometry above the raster plane.

### Embedded OLE previews

Scene Cache v1.21 appends one synthetic kind-54 IMAGE placement for each
OLE2FRAME whose finite four-corner drawing-space preamble can be recovered.
The placement uses the actual WCS quadrilateral rather than LibreDWG's
natural-size fallback. Its internal path is `@embedded/ole-<handle>.bmp` or
`.emf`; it is never passed to the host filesystem resolver. OLE preambles with
either observed `0x5580` or `0x5581` marker are accepted after all twelve
little-endian `f64` corner coordinates and the resulting area are validated.

Kind 59 contains one 40-byte record for each available preview:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | corresponding kind-54 IMAGE index |
| 4 | `u32` | MIME kind: 1 BMP, 2 EMF |
| 8 | `u64` | byte offset in kind 60 |
| 16 | `u64` | byte length in kind 60 |
| 24 | `u32` | validated source width |
| 28 | `u32` | validated source height |
| 32 | `u32` | flags: bit 0 direct BMP, bit 1 reconstructed EMF |
| 36 | `u32` | reserved; zero |

Kind 60 is the contiguous byte pool with record size 1. Payload ranges are
ordered, non-overlapping and cover the pool exactly. The complete pool is
capped at 512 MiB, each preview at 64 MiB, the bounded source scan at 128 MiB
and each validated image at 100 million pixels. A BMP file or DIB extracted
from `EMR_STRETCHDIBITS` is normalized to BMP. Excel previews split across
WMF `WMFC` comments are reassembled only when chunk count, total length,
remaining length, fixed record spacing and every EMF record agree. The EMF
must begin with a valid header/signature, end with `EMR_EOF`, contain no more
than 200,000 aligned records and match its declared byte and record counts.

The Webview range-reads a payload only when its placement becomes visible.
BMP content follows the normal raster path. EMF content is replayed locally
into a Canvas by the pinned Apache-2.0 `emf-converter` dependency, with a
4,096-pixel dimension cap and the same 200,000-record cap, then validated as a
PNG before entering the SHA-256-deduplicated raster cache. No source content is
uploaded or interpreted as HTML. If an OLE frame has no supported preview, its
placement remains visible as a crossed placeholder instead of disappearing.

## Layout, viewport and LOD GPU lines

Scene Cache v1.24+ kind 50 retains the fixed 256-byte layout record introduced
in v1.16. Offset 54 is a `u16` per-layout ANNOALLVISIBLE value: 0 is off and 1
is on. Values above 1 are invalid and readers fail closed. The Model record
mirrors the saved model-space value; each paper-layout record is decoded from
AutoCAD's `AcadAnnoAV` LAYOUT application data. Versions 1.21–1.23 require
offset 54 to be zero and expose no per-layout override, so the Viewer falls
back to the drawing-wide value only for those legacy caches. A v1.24+
writer uses AutoCAD's documented initial value 1 when a paper layout has no
`AcadAnnoAV` data; absence is not serialized as an explicit off state.

The remaining kind-50 fields and every kind-51 viewport field retain their
v1.23 layout, including viewport annotation scale, frozen-layer ranges and
clip-boundary references.

The kind-51 group-68 status/order field is transient for an inactive paper
layout: AutoCAD reports every viewport in that layout as not on until the
layout becomes current. The Viewer therefore uses positive values only for
stack ordering. Persistent display suppression comes from viewport status bit
`0x20000`; a zero group-68 value without that bit does not hide a viewport when
the user selects its layout.

LINE and normalized polyline segments are emitted as interleaved, GPU-ready
line vertices. Scene Cache v1.3 also emits bounded first-pass chords for ARC,
CIRCLE, ELLIPSE, polyline bulges and NURBS SPLINE entities. Model-space
geometry and each block definition remain separate. A block's vertices are
stored once regardless of how many INSERT entities reference it.

Scene Cache v1.5+ also emits HATCH boundary paths. Straight edges remain exact
within the derived `f32` display buffer; circular, elliptic, bulge and spline
edges use the same bounded chord rules as the corresponding standalone
entities. One HATCH contributes at most 65,536 boundary segments. The
conversion report exposes both `hatch_boundary_segments` and
`truncated_hatch_entities`, so the safety cap cannot silently hide a
pathological boundary. In v1.6, the separate bounded ring pools support
source-backed solid and gradient fills without changing this first-frame line
path.

Circular and bulge curves use no more than 16 segments per revolution. Valid
splines use two segments per non-empty knot span and no more than 256 segments
per entity. Invalid spline definitions fall back to their fit-point or
control-point chords instead of being silently dropped. These limits bound
conversion work and cache growth; source-precision curve records remain the
authority for future view-adaptive refinement.

The v1.15+ converter creates at most 58,254 overview segments across model
space and all non-empty blocks, keeping its 36-byte vertex stream below
4 MiB. Versions with 32-byte vertices used a 65,536-segment budget. When the
number of non-empty groups fits the current budget, each group receives one
segment before the remainder is distributed by segment count; in the
pathological case of more groups than slots, the largest groups are selected
first. If the full drawing is already below the limit, the full data is also
LOD 0 and no duplicate overview is written.

Overview batches are written before all LOD 1 detail batches. Consequently,
the first-frame vertex data is one contiguous prefix of at most 4 MiB. Current
detail batches contain no more than 7,281 line segments (524,232 bytes of
vertex data); versions with 32-byte vertices used 8,192 segments. Every
current batch therefore remains below the 512 KiB range-read limit. Batches
are ordered spatially by a 16-bit XY Morton key. A client can scan the small
batch directory, intersect batch bounds with the viewport and range-read only
the matching vertex spans.

### GPU line batch record

Each kind-30 record is 128 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | sequential batch ID |
| 4 | `u16` | kind: 0 model overview, 1 model detail, 2 block definition |
| 6 | `u16` | LOD: 0 overview/primary, 1 detail |
| 8 | `u32` | flags; bit 0 means at least one curve chord is approximate |
| 12 | `u32` | block-table index, or `0xffffffff` for model space |
| 16 | `u64` | first vertex |
| 24 | `u64` | vertex count |
| 32 | `u32` | line-segment count |
| 36 | `u32` | reserved |
| 40 | `f64[3]` | batch-local origin in source coordinates |
| 64 | `f64[3]` | source-coordinate minimum bounds |
| 88 | `f64[3]` | source-coordinate maximum bounds |
| 112 | `f32` | conservative maximum component error after local `f32` quantization |
| 116 | `u8[12]` | reserved |

Batch vertex ranges are contiguous, non-overlapping and cover the complete
kind-31 vertex pool. The validator checks batch IDs, kinds, LOD ordering,
block references, bounds, vertex/segment counts and pool coverage.

### GPU line vertex record

Each v1.15+ kind-31 record is 36 bytes and can be bound directly as an
interleaved GPU vertex buffer:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `f32[3]` | position relative to the batch origin |
| 12 | `u32` | layer index |
| 16 | `u32` | encoded source color |
| 20 | `u32` | entity handle low 32 bits |
| 24 | `u32` | entity handle high 32 bits |
| 28 | `u32` | packed line-weight index, linetype, visibility, source kind and approximation flag |
| 32 | `f32` | cumulative linetype-pattern distance |

For v1.15+, bits 0–4 select a normalized line weight, bits 5–15 carry the
linetype code, bit 16 is invisibility, bits 17–20 are source kind and bit 21
marks a curved or bounded fallback approximation. Source kinds are 0 LINE,
1 LWPOLYLINE, 2 2D POLYLINE, 3 3D POLYLINE, 4 ARC, 5 CIRCLE, 6 ELLIPSE,
7 SPLINE, 8 HATCH boundary, 9 XLINE, 10 MULTILEADER, 11 VIEWPORT frame,
12 LEADER and 13 OLE2FRAME boundary. The OLE kind preserves the actual four
WCS corners from AutoCAD's embedded preamble; kinds 54 and 59–60 independently
carry a bounded presentation preview when available. Versions before v1.15 use 32-byte vertices
without the pattern-distance field. Precise standalone curve parameters,
bulges and OCS metadata remain available in the source sections for later
high-zoom refinement.

## Deferred v1 work

- complete MTEXT formatting and exact OCS/alignment display fidelity beyond
  the bounded source, column and annotation-context pass;
- exact CAD draw-order parity beyond the bounded block-local/nested INSERT
  mask composition and safe fallback;
- view-adaptive high-zoom refinement beyond the bounded v1.3 curve chords;
- lossless HATCH analytic-edge topology beyond the bounded fill rings;
- entity-selection index and source fingerprint.

Cache files can contain project names and drawing text. They are local,
generated artifacts and must not be committed.

## LibreDWG qualification writer

The selected LibreDWG adapter writes a valid v1.26 cache
to measure the direct object-to-cache boundary. It preserves layer/block UTF-8
names and source records for LINE, ARC, CIRCLE, INSERT/MINSERT,
LWPOLYLINE/2D/3D POLYLINE, ELLIPSE and SPLINE, including the four SPLINE value
pools. Resolved DIMENSION picture blocks use the same kind-13 instance stream.
It also preserves text styles and UTF-8 TEXT, MTEXT, ATTDEF and attached ATTRIB
source records. Its GPU sections render LINE and normalized polyline segments
plus bounded ARC/CIRCLE/ELLIPSE, bulge, SPLINE and HATCH-boundary chords.
Circular curves use the same 16-segments-per-revolution limit; SPLINE
evaluation and malformed-input fallback use the 256-segments-per-entity limit.
It also writes the seven bounded HATCH source/fill/pattern sections and the
POINT/SOLID/3DFACE/WIPEOUT source sections, including `PDMODE`, `PDSIZE`,
`FILLMODE`, invisible face edges, exact WIPEOUT clip vertices and saved
ATTMODE/FRAME-family, QTEXTMODE/SPLFRAME/DISPSILH/XREFOVERRIDE and
VISRETAIN/IMAGEQUALITY/DISPSILHBLOCKS
presentation settings, normalized draw-order tables and
entries, bounded INSERT/XREF
`SPATIAL_FILTER` boundaries, and IMAGE/IMAGEDEF paths, placement bases and
clip vertices, MTEXT annotation contexts and exact viewport annotation scales.
It also preserves sparse viewport layer color, transparency, linetype and
lineweight overrides from LAYER extension dictionaries. Bounded OLE2FRAME
bitmap previews and chunked WMF-carried EMF previews are stored in kinds
59–60 and displayed at their recovered four-corner WCS placement.
The Webview
range-reads those sections after the first line
frame, builds POINT markers, SOLID geometry, 3DFACE wireframe edges and safe
WIPEOUT frames in a one-shot worker, triangulates solid and gradient HATCH
rings, and regenerates clipped HATCH pattern strokes in the persistent worker.
Bounded draw-order composition expands and renders safe WIPEOUT masks, with an
explicit frame/source fallback when its caps or validity checks fail. All
omitted logical entities, unresolved DIMENSION blocks, unsupported
underlay/proxy/3D families, invalid supported sources, skipped paths and safety
caps are exposed in the conversion report rather than silently treated as
supported. The six `coverage.deferred_reasons` counters exactly partition
`coverage.deferred_entities`.

It also emits bounded classic LEADER polylines/arrows, MULTILEADER geometry,
XLINE display chords, layout viewport frames and OLE2FRAME boundaries. An OLE
object without a validated bitmap or EMF presentation remains an explicit
crossed placeholder rather than a silent omission.

This qualification writer keeps the 4 MiB overview and 512 KiB detail
limits and uses disk-backed group-local XY Morton ordering for detail batches.
When the extension requests progressive publication, the writer emits the
flagged overview-only sidecar before that detail sort, then continues to the
full v1.26 cache.
LibreDWG is the selected primary engine path. The remaining unsupported source
families and exact CAD text-layout fidelity must be closed before that path is
release-ready.
