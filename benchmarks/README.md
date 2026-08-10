# Benchmarks

Benchmark results from private drawings must remain under `benchmarks/results/`,
which is ignored by Git.

Build the runner once so measured child processes do not include compilation:

```bash
cargo build --release -p dwg-converter
mkdir -p benchmarks/results
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /absolute/path/to/libredwg-adapter \
  --engine-id libredwg \
  --engine-version 0.14 \
  --engine-license GPL-3.0-or-later \
  --runs 3 \
  --warmup-runs 1 \
  --scope all \
  --pretty \
  --output benchmarks/results/libredwg.json
```

Every warmup and measured phase runs in a new process. Conversion caches are
created in a private temporary directory and deleted immediately after each
run. The report contains raw and aggregate timing, peak RSS where supported,
privacy-filtered compatibility fingerprints and automatic target/hard-limit
decisions.

The implemented LibreDWG adapter can be prepared without a global install and
measured in both inspection and partial conversion mode:

```bash
adapters/libredwg/prepare.sh \
  /private/tmp/dwg-viewer-libredwg-build \
  /private/tmp/libredwg-adapter

target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /private/tmp/libredwg-adapter \
  --engine-id libredwg \
  --engine-version 0.14 \
  --engine-license GPL-3.0-or-later \
  --scope all \
  --output benchmarks/results/libredwg.json
```

The current direct LibreDWG writer is a qualification milestone, not a complete
engine replacement. Its report explicitly identifies deferred entities.
Benchmark gate success proves that this bounded conversion architecture meets
the time/RSS limits; it does not waive geometry, Korean text or spatial-detail
coverage requirements.

External adapters must implement
[`specs/engine-adapter.md`](../specs/engine-adapter.md).

The retired acadrust adapter is no longer built or accepted as an implicit
benchmark target. Every run must identify an explicit external adapter.

## Korean encoding regression

The public Webview suite fixes the legacy Korean mapping contract without
committing private drawings or proprietary SHX files:

```bash
pnpm --filter @menaje/viewer-webgl test
```

It distinguishes the 2,350 modern Hangul syllables available through strict
EUC-KR from the complete 11,172-syllable CP949/UHC and Johab sets. CP949 and
Johab boundary/sample codes, automatic glyph probing and per-BigFont overrides
are deterministic regression cases.

The repository also pins three official Data Portal archives made available
by the Cultural Heritage Administration under KOGL Type 1. Before every
download, the fetcher verifies that the current official catalog page still
declares KOGL Type 1. It then verifies the exact byte count and SHA-256 before
a bounded ZIP reader extracts only DWG magic entries to deterministic ASCII
names. It never trusts or publishes the archive's legacy-encoded entry names:

```bash
corpus_root=/absolute/new/public-korean-corpus
node benchmarks/public-korean-corpus.mjs \
  --manifest "$(pwd)/benchmarks/public-korean-corpus-assets.json" \
  --output "$corpus_root"

node benchmarks/korean-corpus-inventory.mjs \
  --root "$corpus_root" \
  --adapter /absolute/path/to/libredwg-adapter \
  --output "$corpus_root/manifest.json" \
  --discipline architecture \
  --limit 30 \
  --redistributable
```

`PUBLIC-CORPUS-PROVENANCE.json` retains the publisher, catalog, KOGL terms,
live catalog verification, archive checksums and the fact that DWG bytes were
not modified. The public asset pool currently supplies 63 architectural
drawings spanning AC1018, AC1021 and AC1032; the balanced inventory selects 30
actual drawings for the runner. The current GitHub Actions evidence records
30 pass, 0 target miss and 0 failure. It does not claim the still-missing
AC1015/AC1024/AC1027, civil/MEP, strict EUC-KR/Johab, Extended BigFont or
image-baseline cells. The path-free fixed report is
[`compatibility/evidence/public-korean-corpus-2026-08-04.json`](../compatibility/evidence/public-korean-corpus-2026-08-04.json).

The corpus runner turns a private manifest into one path-free automatic result
table. It executes cases sequentially so converter memory never overlaps:

```bash
pnpm corpus:korean -- \
  --manifest /absolute/private/korean-corpus.json \
  --runner /absolute/path/to/target/release/dwg-converter \
  --adapter /absolute/path/to/libredwg-adapter \
  --output /absolute/path/to/benchmarks/results/korean-corpus.json
```

Build a conservative private manifest directly from a drawing directory when
the pinned adapter includes anonymous text-environment inspection:

```bash
node benchmarks/korean-corpus-inventory.mjs \
  --root /absolute/private/drawings \
  --adapter /absolute/path/to/libredwg-adapter \
  --output /absolute/private/korean-corpus.json \
  --discipline architecture \
  --limit 30
```

The inventory reads candidates sequentially, excludes directories named
`xref` by default and interleaves observed DWG-version/size groups. It selects
only drawings with Hangul text plus an automatically observed Unicode or
Korean legacy codepage. A drawing may legitimately have no font-table
reference; font coverage remains a corpus-wide requirement instead of a
per-case requirement. The adapter converts legacy TV strings with the declared
DWG codepage before those anonymous counts are made; current text counts then
become the loss baseline. It never infers
EUC-KR, Extended BigFont or a drawing discipline from a filename, so those
coverage cells remain incomplete until independently verified assets are
provided. The exclusive manifest is owner-only and contains private paths;
only its path-free summary may be shared. `--redistributable` is an explicit
license assertion, requires the manifest to be inside the corpus root and
writes only relative paths; do not use it for private or unverified drawings.

The manifest has this shape:

```json
{
  "schema": "dwg-korean-corpus-manifest/1",
  "cases": [
    {
      "id": "arch-r2000-001",
      "path": "/absolute/private/drawing.dwg",
      "redistributable": false,
      "discipline": "architecture",
      "sizeClass": "medium",
      "dwgVersion": "AC1015",
      "encodings": ["cp949"],
      "fontKinds": ["shx", "bigfont"],
      "expectedText": {
        "minimumHangulCharacters": 1,
        "maximumReplacementCharacters": 0,
        "maximumNullCharacters": 0
      }
    }
  ]
}
```

Case IDs must be non-sensitive slugs. Paths, text samples, absolute bounds and
adapter diagnostics are never copied into the corpus report. The exclusive
output file is owner-only and is not overwritten. The gate requires at least
20 cases plus all declared DWG versions, architecture/civil/MEP, three size
classes, Unicode/EUC-KR/CP949/Johab and SHX/BigFont/Extended BigFont coverage.
Per-case version, Hangul-loss, deterministic-output, conversion time and RSS
decisions are automatic. `--allow-incomplete` writes an incremental report
without returning a failing exit code while the matrix is still being filled.

## VS Code product qualification

The product runner measures the packaged extension in an isolated, stabilized
VS Code instance rather than adding process RSS values from an existing user
session:

```bash
pnpm --filter dwg-viewer-vscode package:vsix
pnpm --filter dwg-viewer-vscode qualify:host -- \
  --code /absolute/path/to/code-cli \
  --runtime /absolute/path/to/code-runtime \
  --adapter /absolute/path/to/libredwg-adapter \
  --drawing /absolute/path/to/reference.dwg \
  --vsix apps/vscode-extension/dwg-viewer-vscode-0.1.3.vsix \
  --companion-vsix /absolute/path/to/dwg-viewer-libredwg-0.1.3-platform.vsix \
  --output benchmarks/results/vscode-product.json
```

It runs a cold full-cache open, a close-during-conversion scenario and an
isolated packaged-Webview revision-comparison scenario. The comparison scenario
activates the installed VSIX without opening the drawing, exercises actual
WebGL2 current/candidate pixels, synchronized camera rollback, revision-exact
selection, corresponding highlights and repeated Canvas/GPU cleanup, and does
not contribute to the drawing timing or memory Gate. Run only that path with
`--scenario comparison`.

The companion VSIX is installed first so the isolated host matches the real
two-extension product installation. The adapter path remains explicit for
process classification and to keep the measured engine binary exact. The
memory gate uses the extension's incremental physical memory above the stable
VS Code renderer/extension-host baseline. macOS uses `footprint`, which
de-duplicates shared mappings; Linux uses summed proportional set size from
`smaps_rollup`. Aggregate RSS and baseline-inclusive physical memory remain in
the report as diagnostics because aggregate Electron RSS double-counts shared
pages and the host baseline is outside the extension.

Use `--progressive-preview` to measure the optional speed-first path. Reports
are created exclusively with owner-only permissions and never overwrite an
existing file.
