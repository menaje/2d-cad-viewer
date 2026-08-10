# Licensing and distribution policy

Status: project licensing review updated on 2026-08-10.

This document records the repository's engineering policy. It is not legal
advice, does not replace the applicable license texts, and does not determine
whether two programs form one combined work under copyright law. When this
document conflicts with an upstream license or copyright notice, the upstream
terms control.

## Governing principles

1. Reproduce authoritative license texts, copyright notices, permission
   notices, warranty disclaimers, and liability limitations without editing
   their substance.
2. Keep project copyright and engineering explanations in `NOTICE`,
   `THIRD_PARTY_NOTICES.md`, or this policy instead of inserting them into an
   upstream license text.
3. Include notices according to what an artifact actually contains. The MPL
   VSIX contains only version-bound engine metadata, not the GPL adapter. Each
   separately published GPL converter is paired in the same release with its
   applicable license texts and complete corresponding source.
4. Tell executable-form recipients where they can obtain the matching
   preferred source form.
5. Treat a published artifact and its checksum as immutable. A licensing-file
   change requires a new versioned artifact; an old artifact or recorded hash
   is never silently replaced.

## Component and artifact map

| Component or artifact | License | Distribution policy |
| --- | --- | --- |
| Repository source and documentation, unless a file states otherwise | MPL-2.0 | `LICENSE` is the complete, unmodified official MPL 2.0 text; project copyright is in `NOTICE` |
| `dwg-viewer-vscode-<version>.vsix` | MPL-2.0, plus bundled MIT, ISC, and Apache-2.0 components | Includes `LICENSE.txt`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, a source link, and the filenames, sizes, and SHA-256 digests of separately released converters and source archives; contains no GPL executable and declares no engine-extension dependency |
| `dwg-viewer-native-converter-<version>-<target>[.exe]` | GPL-3.0-or-later | Platform executable built from the verified source-complete package and published separately in the matching `v<version>` GitHub Release |
| `dwg-viewer-libredwg-0.14-<target>.tar.gz` | GPL-3.0-or-later executable and LibreDWG source; adapter source retains MPL-2.0 notices | Complete corresponding source distribution containing the exact converter, LibreDWG source, adapter source, build scripts, unmodified GPLv3 and MPL 2.0 texts, manifest, and checksums |
| `@menaje/viewer-core`, `@menaje/viewer-render-protocol`, `@menaje/viewer-ui` | MPL-2.0 | Current packages include the unmodified official MPL text, project `NOTICE`, README, and source modules |
| `@menaje/viewer-webgl`, `@menaje/dwg-scene-source` | MPL-2.0, with MIT, ISC, and Apache-2.0 runtime dependencies used by WebGL | Public package archives include the unmodified official MPL text, project `NOTICE`, README, and source modules; dependency packages retain their own upstream licenses and notices |
| `@mlightcad/shx-parser` 1.4.5 | MIT | Bundled into the Webview; its copyright and full MIT permission notice are included in `THIRD_PARTY_NOTICES.md` |
| Earcut 3.2.3 | ISC | Bundled into the Webview; its copyright and full ISC permission notice are included in `THIRD_PARTY_NOTICES.md` |
| emf-converter 2.0.2 | Apache-2.0 | Bundled into the Webview for local, bounded OLE EMF preview rendering; its complete unmodified Apache license text and attribution notice are included in `THIRD_PARTY_NOTICES.md` |
| DWG Viewer LibreDWG adapter source | MPL-2.0 | Included as corresponding adapter source in the separate engine archive |
| Linked LibreDWG adapter executable and GNU LibreDWG 0.14 | GPL-3.0-or-later | Published only in separate platform artifacts with the GPL text, exact LibreDWG source, adapter source, build scripts, manifest, and checksums |
| ACadSharp benchmark adapter source | MPL-2.0 | Development and qualification only; not part of the selected viewer runtime |
| ACadSharp 3.6.51 | MIT | Optional process-isolated benchmark dependency; not bundled in the VSIX |
| `dwg-converter` Rust tool | MPL-2.0 | Development and qualification tool; not included in the current VSIX or LibreDWG adapter release artifacts |

The Rust tool links registry crates under their recorded permissive licenses.
If that binary becomes a release artifact, its transitive dependency licenses
and required notices must be generated and reviewed before publication.

## MPL source availability

The VSIX contains compiled JavaScript and therefore distributes MPL-covered
code in executable form. The project satisfies its source-notice policy by:

1. identifying the VSIX as MPL-2.0 in its manifest and packaged README;
2. including the unmodified official MPL 2.0 text, project `NOTICE`, and
   third-party notices in the VSIX;
3. linking recipients to the complete repository source;
4. building a versioned release from a matching `v<version>` Git tag; and
5. retaining the source and build scripts needed to reproduce that version.

The historical `viewer-core-v0.1.0` packages use the same license identifier
and include the official Exhibit A notice, README, and preferred source form.
Mozilla permits that notice to be placed in a `LICENSE` file in a relevant
directory. The historical `viewer-core-v0.1.1` packages add the complete
official MPL text and separate project `NOTICE`. Both releases remain
immutable. The superseding `viewer-core-v0.1.2` packages preserve that license
payload and use platform-normalized archives whose actual hashes are verified
by `pnpm run qualify:viewer-boundary`.

The `viewer-webgl-v0.1.1` package train follows the same rule. Both package
archives carry byte-identical copies of the repository's unmodified official
MPL text and keep project-specific copyright in `NOTICE`.

## GPL adapter boundary

The LibreDWG adapter executable statically links GNU LibreDWG and is conveyed
under GPL-3.0-or-later. It is not present in the MPL VSIX, and the main
extension declares no dependency on a separately listed engine extension.

The release workflow creates a separately named, source-complete GPL archive
for every platform and verifies its internal manifest, checksums, licenses, and
`doctor` result. The raw converter published for automatic installation is the
same verified executable. Its complete corresponding source is offered through
the target-matched archive in the same GitHub Release, using the same download
mechanism. That archive contains the exact checksum-pinned LibreDWG source,
the reviewed ACDS SAT/SAB and R2007 high-compression source patches, adapter
source and build scripts,
license texts, notice, manifest, and
checksums. `GPL-3.0-or-later.txt` is byte-identical to the GPLv3 `COPYING` file
conveyed in the pinned LibreDWG 0.14 source.

The MPL VSIX carries a generated catalog containing the exact converter and
source-archive names, byte lengths, and SHA-256 digests for all supported
targets. At startup, it downloads only its version-matched converter from the
same immutable release, verifies that catalog entry, installs it in VS Code's
private global storage, and runs `doctor`. A viewer update therefore cannot
silently select an independently versioned writer. The catalog metadata does
not copy or incorporate GPL program code into the VSIX.

At runtime, the extension starts the adapter as a separate operating-system
process. It does not load LibreDWG into the extension host or Webview. The
current boundary exchanges command options, bounded progress records, and
versioned Scene Cache files through `dwg-engine-adapter/1`.

The separate release files and process boundary are project controls, not a
categorical legal conclusion. The GNU GPL FAQ explains that the substance and
intimacy of communication between programs can affect whether they are treated
as a single combined program. Any change that places the adapter in the MPL
VSIX, links or loads LibreDWG into the extension host, shares in-process data
structures, stops offering equivalent access to complete corresponding source,
or materially expands the private protocol requires a new licensing review
before release.

## Third-party notice policy

The Webview production dependency audit is:

```bash
pnpm --filter @menaje/viewer-webgl licenses list --prod --json
```

The result must contain only reviewed versions. Because esbuild places the
Webview dependencies inside generated JavaScript rather than shipping their
original package folders, the VSIX must preserve their required copyright and
permission notices in `THIRD_PARTY_NOTICES.md`.

Development tools and rejected benchmark candidates remain listed separately
so their presence is not confused with bundled runtime code.

## Contributor and release checklist

- Treat new repository source as MPL-2.0 unless an approved file-level notice
  states otherwise.
- Preserve existing SPDX identifiers, copyright notices, license texts, and
  warranty disclaimers.
- Keep the root and packaged VSIX `LICENSE` byte-identical to Mozilla's
  official MPL 2.0 plain text. Keep project-specific notices outside it.
- Review every new runtime dependency before merging it and add its exact
  required notice before bundling.
- Do not copy GPL-covered LibreDWG code into the MPL VSIX or public Viewer
  packages.
- Build every linked LibreDWG artifact from the verified source-complete GPL
  package created by `adapters/libredwg/package.mjs`; never stage a raw
  converter from an unverified binary alone.
- Publish every platform converter and its source-complete archive in the
  immutable GitHub Release before publishing the MPL Marketplace extension
  whose catalog selects them.
- Re-run the Webview production-license audit and inspect the packaged VSIX.
- Require `pnpm run check` and the release gates in
  [`distribution.md`](distribution.md) before publication.

## Primary license references

- [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/)
- [Mozilla MPL 2.0 official plain text](https://www.mozilla.org/media/MPL/2.0/index.txt)
- [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)
- [GNU LibreDWG licensing statement](https://www.gnu.org/software/libredwg/)
- [VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [VS Code extension global storage](https://code.visualstudio.com/api/references/vscode-api#ExtensionContext)
