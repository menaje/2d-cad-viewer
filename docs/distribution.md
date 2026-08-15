# Distribution and installation

Status: qualified release procedure for Linux x64, macOS arm64, macOS Intel
x64, and Windows x64.

## Release artifacts

| Artifact | License | Purpose |
| --- | --- | --- |
| `dwg-viewer-vscode-<version>.vsix` | MPL-2.0, plus bundled MIT, ISC and Apache-2.0 components | The only VS Code Marketplace product. It contains the Webview, notices, and a version-bound engine catalog, but no LibreDWG executable. |
| `dwg-viewer-native-converter-<version>-linux-x64` | GPL-3.0-or-later | Exact converter selected by the same viewer version on Linux x64. |
| `dwg-viewer-native-converter-<version>-darwin-arm64` | GPL-3.0-or-later | Exact converter selected by the same viewer version on Apple Silicon. |
| `dwg-viewer-native-converter-<version>-darwin-x64` | GPL-3.0-or-later | Exact converter selected by the same viewer version on Intel macOS. |
| `dwg-viewer-native-converter-<version>-win32-x64.exe` | GPL-3.0-or-later | Exact converter selected by the same viewer version on Windows x64. |
| `dwg-viewer-libredwg-0.14-<target>.tar.gz` | GPL-3.0-or-later; adapter source retains MPL-2.0 notices | Complete corresponding source package for the converter of that target. It includes the binary, exact LibreDWG source, reviewed ACDS SAT/SAB and R2007 high-compression patches, adapter source, build scripts, unmodified license texts, manifest, and checksums. |
| `SHA256SUMS` | Not executable | Digests for the main VSIX, four converters, and four source-complete archives. |

The release pipeline builds each converter from checksum-pinned official GNU
LibreDWG 0.14 source on its target operating system. It runs the bounded
`doctor` command and verifies a deterministic source-complete archive before
publishing the raw executable.

The MPL VSIX excludes `native/**` and has no extension dependency on a second
Marketplace product. Its generated `dist/engine-assets.json` records the exact
viewer version, release tag, platform filename, byte length, SHA-256 digest,
adapter protocol, Scene Cache version, and corresponding source asset. Package
tests reject a GPL executable in the VSIX or a missing catalog.

This is an engineering compliance review, not legal advice. The policy follows
the [MPL 2.0 executable-form source requirement](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
the [GNU GPL distribution guidance](https://www.gnu.org/licenses/gpl-faq.html),
and GitHub's
[artifact attestation procedure](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Automatic installation model

Installing **2D CAD Viewer for VS Code** activates the extension after VS Code
startup. The extension then:

1. selects `linux-x64`, `darwin-arm64`, `darwin-x64`, or `win32-x64` from the
   extension-host environment;
2. reads only the catalog packaged with that exact extension version;
3. downloads the catalog's converter from the matching `v<version>` GitHub
   Release over HTTPS;
4. rejects an unexpected redirect host, byte length, or SHA-256 digest;
5. writes the executable under the extension's private global storage, keyed by
   viewer version, platform, and digest;
6. runs `doctor` and requires the expected platform, architecture, adapter
   protocol, and Scene Cache `dwg-scene-cache/1.26`; and
7. reuses the verified local executable on later starts.

The converter runs as a separate operating-system process. Updating the viewer
selects a new version-bound catalog and storage directory, so an independently
updated or older converter cannot silently produce an incompatible cache. If a
previous `1.18` cache is found, the cache header check removes and rebuilds it
with the current `1.26` writer.

A configured adapter path, environment override, or historical engine
extension is considered only when automatic installation is unavailable. Every
fallback must pass the same `doctor` compatibility check and cannot override a
healthy version-managed converter.

## Release branches and channels

The product release path is `dev` → `prerelease` → `main`. Direct pushes to
`prerelease` and `main` are blocked; the required `release-route` check accepts
only a same-repository `dev` → `prerelease` pull request or a `prerelease` →
`main` pull request. Closing a pull request without merging it, creating a
branch, pushing a tag, or manually running a dry run cannot publish a release.

VS Code Marketplace versions use `major.minor.patch` without a SemVer suffix.
This repository uses the following channel convention:

- odd minor versions, such as `0.1.5` or `0.3.0`, are prereleases;
- even minor versions, such as `0.2.0` or `0.4.0`, are stable releases;
- the root repository and main extension versions must match; and
- each release version must be greater than every existing `v<version>` product
  tag.

Merging `dev` into `prerelease` with a new odd-minor version publishes a
prerelease. Merging a new even-minor version into `prerelease` is the stable
preparation step: it runs the complete qualification and artifact build without
publishing. After that succeeds, merging `prerelease` into `main` publishes the
stable version.

The `Release packages` workflow also has two non-publishing manual modes:
`dry-run` builds and verifies every artifact, while `verify-auth` checks that
the configured `VSCE_PAT` can publish under `menaje`.

For a publishing merge, the workflow:

1. validates the branch route, channel, tag history, and aligned root/viewer
   versions;
2. builds checksum-pinned static converters on all four supported targets;
3. runs `doctor`, creates each source-complete archive twice, and requires
   byte-identical output and valid internal checksums;
4. generates a catalog from the exact converter and source-archive files;
5. builds the MPL VSIX twice with that catalog, normalizes bounded ZIP metadata,
   and requires byte-identical output;
6. inspects the VSIX license, notices, source link, GPL exclusion, and embedded
   catalog;
7. produces build-provenance attestations and `SHA256SUMS` for the complete
   release set;
8. creates the immutable `v<version>` GitHub release, which makes the converter
   URLs usable; and
9. only after the GitHub release succeeds, publishes the single MPL viewer to
   Marketplace with `--pre-release` for the prerelease channel.

This order prevents Marketplace from offering a viewer before its exact engine
assets are available. A release retry may add a missing asset, but it must never
replace an existing asset whose digest differs.

The `darwin-x64` job uses GitHub's `macos-15-intel` runner. Hosted Intel macOS
support must move to a maintained external Intel builder or be retired before
that image is retired.

Marketplace publishing requires the repository Actions secret `VSCE_PAT` with
permission to manage the `menaje` publisher. The token is never stored in a
manifest or artifact. The separately listed historical
`menaje.dwg-viewer-libredwg` package is no longer a product dependency and is
not published by this workflow; it remains in the repository only for legacy
offline and extension-host qualification.

## Reproduce the packages

The release build needs a directory containing all four raw converters and all
four source-complete archives. Generate the version-bound catalog first:

```bash
node scripts/create-engine-catalog.mjs \
  --directory /absolute/path/release-assets \
  --version 0.1.8 \
  --output /absolute/path/engine-assets.json
```

Then build the main package with that exact catalog:

```bash
pnpm install --frozen-lockfile
DWG_VIEWER_ENGINE_CATALOG=/absolute/path/engine-assets.json \
  pnpm --dir apps/vscode-extension run build
pnpm --dir apps/vscode-extension exec vsce package \
  --pre-release \
  --no-dependencies \
  --out /absolute/new/path/dwg-viewer-vscode-0.1.8.vsix
```

Use the checksum-pinned preparation and deterministic packager in
[`adapters/libredwg/README.md`](../adapters/libredwg/README.md) to reproduce a
platform converter and its source-complete archive.

## Verify a downloaded release

Place the main VSIX, four converters, four source-complete archives, and
`SHA256SUMS` in one directory. On Linux:

```bash
sha256sum -c SHA256SUMS
```

On macOS:

```bash
shasum -a 256 -c SHA256SUMS
```

With GitHub CLI, verify provenance for the files you intend to use:

```bash
gh attestation verify dwg-viewer-vscode-0.1.8.vsix \
  --repo menaje/2d-cad-viewer
gh attestation verify dwg-viewer-native-converter-0.1.8-darwin-arm64 \
  --repo menaje/2d-cad-viewer
gh attestation verify dwg-viewer-libredwg-0.14-darwin-arm64.tar.gz \
  --repo menaje/2d-cad-viewer
```

## Install

From Marketplace, install only **2D CAD Viewer for VS Code**. The automatic flow
above prepares the correct converter; there is no engine extension to select or
install.

For a manual VSIX installation:

```bash
code --install-extension dwg-viewer-vscode-0.1.8.vsix
```

If the target computer cannot reach GitHub Releases, copy the matching raw
converter from another verified computer. On Linux or macOS, make only that
file executable and run its self-test:

```bash
chmod 700 dwg-viewer-native-converter-0.1.8-darwin-arm64
./dwg-viewer-native-converter-0.1.8-darwin-arm64 doctor
```

On Windows, run:

```powershell
.\dwg-viewer-native-converter-0.1.8-win32-x64.exe doctor
```

Then run **2D CAD Viewer: LibreDWG 변환기 선택** and choose that verified file.
The command is an offline fallback; it does not replace a healthy automatically
managed converter.

The macOS converter is not notarized with an Apple Developer ID. If macOS
blocks a verified download, use the operating system's Privacy & Security
approval flow for that specific file. Do not disable Gatekeeper globally.

## Publication checklist

- The pull request follows `dev` → `prerelease` or `prerelease` → `main`, and
  required route and CI checks pass.
- Root and main extension versions are identical and follow the channel rule.
- A manual `Release packages` dry run succeeds before the release merge.
- The workflow-created tag is exactly `v<version>` and points to the merged
  commit.
- The main VSIX embeds the catalog generated from the exact release files.
- Main VSIX, all four converters, and all four source-complete archives have
  valid GitHub attestations and match `SHA256SUMS`.
- Existing release assets are never overwritten with different bytes.
- GitHub Release creation succeeds before Marketplace publication.
- Marketplace publication targets only `menaje.dwg-viewer-vscode`.
- The packaged MPL text matches the official canonical text and project
  copyright remains in `NOTICE`.
- The Webview production dependency audit matches the copyright and permission
  notices in `THIRD_PARTY_NOTICES.md`.
- Windows native-path and VS Code display-scale qualification passes on the
  intended commit.

## Independent Viewer package trains

`@menaje/viewer-core`, `@menaje/viewer-render-protocol`, and
`@menaje/viewer-ui` use the separate `viewer-core-v<version>` release train.
`@menaje/viewer-webgl` and `@menaje/dwg-scene-source` use
`viewer-webgl-v<version>`. Their compatibility manifests, normalized archives,
and release workflows remain independent of the VS Code product version.
