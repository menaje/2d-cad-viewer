# Test fixtures

Only synthetic drawings or drawings with explicit redistribution permission
may be committed here. Private working drawings belong outside this directory
and are ignored by the repository-level `test files/` rule.

## Viewport layer overrides

`generate-viewport-layer-overrides.py` creates the source definition for the
four-property viewport override qualification. It requires the pinned optional
fixture dependency `ezdxf==1.4.2` and refuses to overwrite an output file:

```bash
PYTHONPATH=/absolute/path/to/ezdxf-1.4.2 \
  python3 tests/fixtures/generate-viewport-layer-overrides.py \
  /absolute/new/path/viewport-layer-overrides-r2004.dxf
```

Encode that DXF as an R2004 DWG with a separate trusted fixture converter, then
pass the DWG to `pnpm run qualify:viewport-layer-overrides`. Neither the
write-enabled converter nor its output is part of the product package. The
source definition contains only generated geometry and has no private drawing
content. `Layout1` contains a paper viewport and one model viewport so the
qualification exercises the final layout composition path, not only sparse
override metadata.

## Generated large-DWG qualification source

`generate-large-line-dxf.mjs` streams a deterministic R2000 ASCII DXF with a
bounded number of synthetic `LINE` entities. The default 250,000-entity source
exercises the native parser's large object-graph class without committing a
large binary or using a private drawing:

```bash
node tests/fixtures/generate-large-line-dxf.mjs \
  --output /absolute/new/path/generated-large.dxf \
  --entities 250000
```

`build-libredwg-dxf2dwg.sh` builds a fixture-only writer from the same
checksum-pinned LibreDWG 0.14 source archive used by the product adapter. The
write-enabled executable and generated DWG are test inputs only: neither is
included in the adapter package or VSIX. Their GPL boundary therefore remains
separate from the MPL viewer and synthetic DXF generator.

The integrated qualification uses 100,000 lines and requires the generated
R2000 DWG to be at least 5,000,000 bytes. It converts the drawing twice,
requires 100% serialized coverage with no deferred entity or diagnostic, and
requires byte-identical Scene Caches plus identical normalized reports:

```bash
tests/fixtures/build-libredwg-dxf2dwg.sh \
  /absolute/path/to/libredwg-0.14.tar.xz \
  /absolute/new/dxf2dwg-build \
  /absolute/new/dxf2dwg
node scripts/qualify-generated-large-dwg.mjs \
  --adapter /absolute/path/to/libredwg-adapter \
  --dxf2dwg /absolute/new/dxf2dwg \
  --work-root /absolute/new/generated-large-work \
  --report /absolute/new/generated-large-report.json \
  --entities 100000 \
  --minimum-dwg-bytes 5000000
```

The Linux x64 adapter workflow runs this gate from the same pinned source. A
local macOS arm64 run produced a 5,738,218-byte DWG, serialized all 100,000
lines with zero deferred entities into two byte-identical 19,400,096-byte
caches, and observed about 94 MB process peak RSS. These figures qualify that
synthetic target only; they are not Windows or customer-drawing performance
claims.

## macOS object-graph allocation probe

`libredwg-object-graph-probe.c` is a GPL-3.0-or-later diagnostic linked only to
the checksum-pinned static LibreDWG development build. It is not shipped in the
adapter package or VSIX. Build it with the exact install prefix left by
`adapters/libredwg/prepare.sh`, then attach the macOS `heap` tool during its
bounded hold interval:

```bash
LIBREDWG_PREFIX=/absolute/new/adapter-build/install \
  tests/fixtures/build-libredwg-object-graph-probe.sh \
  /absolute/new/libredwg-object-graph-probe
MallocStackLogging=1 /absolute/new/libredwg-object-graph-probe \
  /absolute/path/to/generated-large.dwg 60 \
  > /absolute/new/object-graph-summary.json &
probe_pid=$!
/usr/bin/heap -sortBySize "$probe_pid" > /absolute/new/heap-summary.txt
wait "$probe_pid"
```

The normalized JSON reports object-vector capacity and slack, logical bytes for
entity wrappers, `LINE` bodies, reference records and reference pointers, plus
ACIS decoded/duplicate payload totals. It also records the audited post-parse
invariant that the source file chain and generic decompressed-section chains
are no longer retained. It never emits an object handle, drawing bound, text or
input identity.

Use only the generated fixture for publishable evidence. Raw allocator output
from an arbitrary drawing can contain source-derived bytes and must remain
private. The normalized findings and target status are recorded in
[`docs/libredwg-parser-memory.md`](../../docs/libredwg-parser-memory.md).

## macOS LibreDWG sanitizer qualification

`build-libredwg-sanitized-adapter.sh` builds the exact pinned LibreDWG source,
reviewed product patches and current adapter with macOS AddressSanitizer and
UndefinedBehaviorSanitizer. The binary is local test evidence and is never
packaged. Run it against a public or synthetic fixture, then execute the
deterministic bounded mutation sweep:

```bash
tests/fixtures/build-libredwg-sanitized-adapter.sh \
  /absolute/path/to/libredwg-0.14.tar.xz \
  /absolute/new/sanitizer-build \
  /absolute/new/libredwg-sanitized-adapter
node scripts/qualify-libredwg-sanitizers.mjs \
  --adapter /absolute/new/libredwg-sanitized-adapter \
  --fixture /absolute/path/to/public-or-generated.dwg \
  --work-root /absolute/new/sanitizer-work \
  --report /absolute/new/sanitizer-work/report.json \
  --mutations 24
```

The gate requires a validated cache for the unmodified fixture. Each malformed
case must either fail normally or produce another validated cache; a sanitizer
diagnostic, signal or timeout fails the run. All mutated inputs and caches are
removed before the path-free report is written. A suspended converter is also
terminated and its possible partial output is removed to cover cancellation
cleanup. This macOS profile is not evidence for Linux or Windows sanitizer
behavior.
