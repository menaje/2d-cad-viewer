# DWG Viewer for VS Code

Open, inspect, search, measure, and export DWG drawings without leaving
VS Code.

DWG Viewer is an open-source, local-first, read-only viewer built for large
drawings, Korean SHX/BigFont text, external references, and paper-space
layouts. Your drawings and fonts stay on your computer.

> This is an early public release. Editing and DWG saving are not available,
> and the viewer currently supports Linux x64, macOS arm64, macOS Intel x64,
> and Windows x64.

## Why we built DWG Viewer

Opening a DWG just to check one detail should not interrupt the work around it.
A conventional viewer or CAD workflow often means leaving the current
workspace, launching another application, waiting for it to become ready, and
then repeating part of that wait for each drawing. A few seconds at a time can
become a real loss of focus when many files need to be reviewed.

DWG Viewer was built around VS Code's existing file workflow. Select a drawing
in the Explorer and open it directly in an editor tab, next to the files and
code you are already using. Local conversion and a private reusable cache are
designed to minimize the time to a useful view and make repeat opens faster.

This extension does not try to replace a full CAD editor. It aims to remove as
much friction as possible from quick inspection, search, measurement, and
export, so checking a drawing feels like opening another project file instead
of starting a separate task.

## Highlights

### Private and read-only

- Drawing conversion, font handling, XREF discovery, and rendering happen
  locally.
- The original DWG is never modified or uploaded.
- A private local cache makes repeat opens faster.

### Korean CAD text support

- Displays `TEXT`, `MTEXT`, `ATTRIB`, and `ATTDEF` content.
- Resolves SHX and BigFont files requested by the drawing.
- Detects legacy EUC-KR, CP949/UHC, and Johab/CP1361 BigFont encodings.
- Lets you connect missing or renamed fonts and falls back to an installed
  Korean font when possible.

### Comfortable navigation on mouse and trackpad

- Click-drag or two-finger scroll to pan.
- Use the mouse wheel or a trackpad pinch to zoom around the pointer.
- Drag a window to zoom, return to the fitted view, move through previous and
  next views, and save named view bookmarks.
- The top-right and left tool shelves can independently remain icon-only or
  reveal every tool name together on hover or keyboard focus.
- High-DPI interaction defaults to a hybrid strategy: it moves the completed
  frame immediately, refreshes low-resolution geometry about every 80 ms to
  cover newly exposed areas, and restores bounded detail after interaction.
- In-viewer controls follow the VS Code environment language for English and
  Korean.

### Layers, XREFs, and images

- Search layers, toggle visibility, isolate a layer group, invert visibility,
  and restore the previous state.
- Layers are grouped from the current drawing and its actual XREF records.
- Resolves DWG XREFs and JPG/PNG image references across Windows, macOS, and
  Linux path formats.
- Ambiguous or missing references can be selected manually and remembered at
  the source, filename, or folder-mapping level.

### Inspection and measurement

- Select drawing objects to inspect their type, layer, color, and relevant CAD
  properties.
- Measure distance, cumulative distance, area and perimeter, three-point
  angles, radius, and diameter.
- Calibrate a unitless drawing from two known points, then choose display units
  and precision.
- Search `TEXT`, `MTEXT`, `ATTRIB`, and `ATTDEF` across workspace DWGs from the
  Explorer **DWG 문자 검색** view. Selecting a result opens, centers, and
  highlights it.

### Layouts and export

- Switch between model space and paper-space layouts.
- Preserve layout paper size, rotation, viewports, frozen layers, and each
  viewport's layer colors, transparency, linetypes, and lineweights.
- Export the current screen, current tab, or all layouts to PNG or PDF.
- Optionally apply a referenced CTB to a layout for plot colors and
  lineweights.
- All-layout PNG export produces a portable ZIP with the original Unicode
  layout-name mapping.

## Get started

### Requirements

- VS Code 1.125 or newer
- Linux x64, macOS arm64, macOS Intel x64, or Windows x64
- The GPL LibreDWG Engine companion, installed automatically with DWG Viewer

### Installation

Install **DWG Viewer** from the VS Code Marketplace. VS Code also installs the
matching **DWG Viewer — LibreDWG Engine** companion for the current platform.
Open a `.dwg` file from the Explorer; no converter path needs to be selected.

For a manual or offline installation, download
`dwg-viewer-vscode-<version>.vsix` and the matching
`dwg-viewer-libredwg-<version>-<platform>.vsix` from
[GitHub Releases](https://github.com/menaje/dwg-viewer/releases), then install
both with **Extensions: Install from VSIX...**. Install the GPL companion first
when the Marketplace is unavailable.

The extension checks the companion executable before using it. You can repeat
that check at any time with **DWG Viewer: LibreDWG 변환기 진단**. The manual
converter-selection command remains available for controlled or offline
deployments that maintain an external adapter path.

For checksums, provenance verification, macOS security approval, and
platform-specific commands, see the
[distribution and installation guide](https://github.com/menaje/dwg-viewer/blob/main/docs/distribution.md).

## Everyday use

- **Pan:** click-drag or use a two-finger trackpad scroll.
- **Zoom:** use the mouse wheel, trackpad pinch, or window-zoom tool.
- **Find a tool:** hover or focus a shelf to expand all of its tool names.
- **Choose compact menus:** set **Top Toolbar Labels** and **Left Toolbar
  Labels** under the DWG Viewer settings to `icons` or `hover` independently.
- **Tune high-DPI rendering:** keep **Render Resolution** on `auto` to reuse a
  bounded pixel budget with MSAA disabled, choose `performance` for the lowest
  pixel budget, or `quality` for full redraw quality and MSAA.
- **Choose interaction behavior:** keep **Interaction Rendering** on `hybrid`
  for an immediate retained-frame response plus periodic live refreshes, use
  `continuous` to redraw newly exposed areas on every movement frame, or use
  `maximumPerformance` to defer live redraws until interaction stops.
- **Manage layers:** open the left layer panel and search or change visibility.
- **Inspect or measure:** choose a tool, then select points or objects in the
  drawing.
- **Switch layouts:** use the tabs along the bottom edge of the viewer.
- **Search drawing text:** use the Explorer **DWG 문자 검색** view.
- **Export:** open **PNG/PDF**, choose a scope, and select output options.

The tool shelves and layout tabs remain compact until hovered,
keyboard-focused, or explicitly opened so the drawing can use most of the
editor. Expanding a shelf reveals all names at once without moving individual
tool targets.

## What the viewer displays

- Lines, polylines, arcs, circles, ellipses, and splines
- Blocks, repeated block instances, dimension picture blocks, and nested XREFs
- Solid, gradient, and patterned HATCH content
- POINT, SOLID, 3DFACE, and WIPEOUT content
- CAD text, attributes, Korean SHX/BigFont glyphs, and common MTEXT formatting
- Model space, multiple layouts, viewports, and per-viewport layer display
  overrides
- JPG/PNG IMAGE references and XCLIP boundaries
- Linetypes, colors, transparency, lineweights, and optional layout CTB styles

The viewer loads drawing detail and referenced images as they become useful on
screen, which keeps large drawings responsive without eagerly decoding every
resource.

## Fonts and missing references

After the first drawing frame, the viewer looks only for fonts requested by
the drawing. It checks stored paths, the drawing folder, bounded project
locations, and folders you add through **글꼴 → 글꼴 폴더 추가** or
**DWG Viewer: SHX 글꼴 폴더 추가**.

The font panel distinguishes connected, substituted, ambiguous, missing,
unreadable, and malformed files. You can choose a replacement without exposing
its absolute path to the drawing Webview.

XREFs and images follow a similar local-first flow. The viewer tries portable
path alternatives and a bounded project search, then asks you when it cannot
choose safely. It never searches the whole disk or silently chooses between
equally ranked files.

## Current limitations

- Viewing is read-only; editing, overwriting, and Save As are not available.
- Native companions are currently published for Linux x64, macOS arm64,
  macOS Intel x64, and Windows x64.
- Embedded OLE content such as an Excel sheet is not rendered; its placement
  frame may still be shown.
- External raster images currently support JPG/JPEG and PNG.
- Missing fonts, XREFs, and images must be connected to the correct local
  files by the user.

## Privacy, license, and source

The VSIX is licensed under MPL-2.0. Its complete source form is available in
the [menaje/dwg-viewer repository](https://github.com/menaje/dwg-viewer),
along with build scripts and third-party notices. The packaged `LICENSE.txt`
contains Mozilla's unmodified MPL 2.0 text, while `NOTICE` contains the project
copyright notice.

The GPL-3.0-or-later LibreDWG adapter is never included in the MPL VSIX. VS
Code installs it as a separately published, platform-specific GPL companion
extension. Every companion VSIX contains its executable's complete
corresponding source, unmodified GPLv3 and MPL 2.0 texts, build scripts,
manifest, and checksums. The main extension starts that executable as a
separate process; it does not load LibreDWG into the extension host.

Release artifacts are reproducibly built and include SHA-256 checksums and
GitHub build-provenance attestations. Details are in the
[distribution guide](https://github.com/menaje/dwg-viewer/blob/main/docs/distribution.md).
The component-level license map and review rules are in the
[licensing guide](https://github.com/menaje/dwg-viewer/blob/main/docs/licensing.md).

## For contributors and integrations

User documentation stays separate from implementation contracts:

- [Architecture](https://github.com/menaje/dwg-viewer/blob/main/docs/architecture.md)
- [Engine decision](https://github.com/menaje/dwg-viewer/blob/main/docs/engine-decision.md)
- [Licensing policy](https://github.com/menaje/dwg-viewer/blob/main/docs/licensing.md)
- [LibreDWG Engine companion](https://github.com/menaje/dwg-viewer/tree/main/apps/vscode-libredwg-adapter)
- [Viewer Core](https://github.com/menaje/dwg-viewer/tree/main/packages/viewer-core)
- [Render protocol](https://github.com/menaje/dwg-viewer/tree/main/packages/render-protocol)
- [Viewer UI](https://github.com/menaje/dwg-viewer/tree/main/packages/viewer-ui)

Run the full repository verification with:

```bash
pnpm install --frozen-lockfile
pnpm check
```
