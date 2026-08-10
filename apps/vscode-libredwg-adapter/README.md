# DWG Viewer — LibreDWG Engine

This companion extension supplies the local LibreDWG conversion process used
by [DWG Viewer](https://marketplace.visualstudio.com/items?itemName=menaje.dwg-viewer-vscode).
Install DWG Viewer and VS Code installs the matching engine automatically for
Linux x64, macOS arm64, or Windows x64.

The engine runs as a separate local process. Drawings are not uploaded, and
the original DWG file is not modified. This extension has no commands or user
interface of its own.

## License and corresponding source

The linked LibreDWG adapter executable is conveyed under
GPL-3.0-or-later. Every platform-specific VSIX includes:

- the complete, unmodified GPLv3 license text in `LICENSE.txt`;
- the exact checksum-pinned GNU LibreDWG 0.14 source archive;
- the DWG Viewer adapter source and build scripts used for the executable;
- the applicable MPL 2.0 text and project notice; and
- a package manifest and SHA-256 checksums.

The executable is located at
`native/<platform>-<architecture>/libredwg-adapter` (with `.exe` on Windows).
The complete corresponding source is under `source/` in the installed
extension and in the downloadable platform package attached to the matching
[DWG Viewer release](https://github.com/menaje/dwg-viewer/releases).

The source, license texts, and notices are included in the VSIX itself, so
their availability does not depend on a later network download. Rebuild
instructions are in `source/dwg-viewer/adapters/libredwg/README.md`.

This companion is distributed separately from the MPL-2.0 DWG Viewer VSIX.
DWG Viewer communicates with it through a versioned process and file
protocol; LibreDWG is not loaded into the VS Code extension host.
