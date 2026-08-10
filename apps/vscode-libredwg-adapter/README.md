# DWG Viewer — Legacy Engine Test Package

This workspace is retained for offline and extension-host qualification of the
historical two-extension installation model. It is not a current Marketplace
product and the main DWG Viewer does not declare it as a dependency.

Current releases publish only **DWG Viewer for VS Code** to Marketplace. The
viewer prepares its exact version-matched converter from the corresponding
GitHub Release, verifies its byte length and SHA-256 digest, runs `doctor`, and
stores it outside the MPL VSIX.

## License and corresponding source

When this legacy package is built for qualification, the linked LibreDWG
adapter executable is conveyed under GPL-3.0-or-later. The platform-specific
test VSIX includes:

- the complete, unmodified GPLv3 license text in `LICENSE.txt`;
- the exact checksum-pinned GNU LibreDWG 0.14 source archive;
- the DWG Viewer adapter source and build scripts used for the executable;
- the applicable MPL 2.0 text and project notice; and
- a package manifest and SHA-256 checksums.

The executable is at
`native/<platform>-<architecture>/libredwg-adapter` (with `.exe` on Windows),
and the complete corresponding source is under `source/`. Rebuild instructions
are in `source/dwg-viewer/adapters/libredwg/README.md`.

The qualification package remains separate from the MPL-2.0 DWG Viewer VSIX.
The viewer communicates with its converter through a versioned process and
file protocol; LibreDWG is not loaded into the VS Code extension host.
