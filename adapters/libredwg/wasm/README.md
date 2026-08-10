# LibreDWG WASM qualification

Status: rejected for product use on 2026-08-01.

This directory reproduces issue
[#17](https://github.com/menaje/dwg-viewer/issues/17)'s real LibreDWG 0.14
WASM probe. It compiles the same C Scene Cache v1.21 writer used by the Native
adapter. It does not add a selectable backend, automatic fallback or VSIX
asset.

## Build

The build uses the checksum-pinned LibreDWG 0.14 and pkgconf 3.0.4 sources
inside the exact Emscripten 4.0.15 amd64 container image. Docker Desktop may
emulate that image on arm64 hosts. Neither Emscripten nor LibreDWG is installed
on the host:

```bash
adapters/libredwg/wasm/build.sh \
  /private/tmp/dwg-viewer-wasm-build \
  /private/tmp/dwg-viewer-wasm-output
```

Both destinations must be new. Existing source archives may be supplied
offline and are still checksum-verified:

```bash
LIBREDWG_SOURCE_ARCHIVE=/path/to/libredwg-0.14.tar.xz \
PKGCONF_SOURCE_ARCHIVE=/path/to/pkgconf-3.0.4.tar.xz \
  adapters/libredwg/wasm/build.sh \
  /new/private/build-directory \
  /new/private/output-directory
```

The output is `libredwg-wasm.js` plus `libredwg-wasm.wasm`. The WASM module
statically incorporates GPL-3.0-or-later LibreDWG code. It is a qualification
artifact, must not be committed or bundled in the MPL-only VSIX, and would
require the same source-complete GPL distribution review as the Native
adapter before publication.

## Node Worker probe

Run one isolated conversion:

```bash
node adapters/libredwg/wasm/probe.mjs \
  --module /private/tmp/dwg-viewer-wasm-output/libredwg-wasm.js \
  --input /path/to/drawing.dwg
```

For a small fixture, compare the WASM output hash with a cache made by the
current Native v1.21 adapter:

```bash
node adapters/libredwg/wasm/probe.mjs \
  --module /private/tmp/dwg-viewer-wasm-output/libredwg-wasm.js \
  --input /path/to/drawing.dwg \
  --expected-cache /path/to/native.dwg.cache
```

Worker termination is measured independently:

```bash
node adapters/libredwg/wasm/probe.mjs \
  --module /private/tmp/dwg-viewer-wasm-output/libredwg-wasm.js \
  --input /path/to/large.dwg \
  --cancel-after-ms 0
```

Probe JSON never includes an input or module path. The memory gate is
800,000,000 bytes of concurrent peak RSS. Passing that one field would not by
itself admit the backend; the browser, Korean text, geometry, packaging and
user-visible benefit gates still apply.

## Qualification evidence

The probe used Node.js 24.11.1 on a macOS arm64 host and the exact amd64
container above.

| Check | Result |
| --- | --- |
| Generated module | 5.2 MiB WASM plus 67 KiB JavaScript |
| 37,961-byte public LINE fixture | 45.8 ms conversion |
| Native/WASM Scene Cache | byte-identical 2,376-byte v1.11 output |
| 24,680,147-byte reference drawing | 3,736–3,856 ms conversion |
| Large output | same 177,049,408-byte size and record counts; overall hash differs |
| Byte-identical large sections | header/directory plus 29 of 34 section bodies |
| Different large sections | text entities (22), GPU lines (30–31), HATCH loops/vertices (33–34) |
| Source string tables | all byte-identical, including Korean text |
| Final WASM linear memory | 506,658,816 bytes |
| Direct-process RSS after explicit GC | 2,221,260,800 bytes |
| Node Worker RSS before termination | 2,723,463,168 bytes |
| Maximum RSS before full output comparison | 2,723,479,552 bytes |
| Maximum RSS with full output fingerprint | 2,983,854,080 bytes |
| Node Worker termination | 2.12 ms |
| Chromium Worker, public fixture | module and input ready in 33.7 ms; conversion did not finish within 30 seconds |

Small-fixture byte identity does not extend to the large drawing. Its cache
header/directory and 29 section bodies match Native. Every string-table
payload also matches, so the probe found no Korean or other source-string
loss. The five differing numeric/derived sections still require a
platform-tolerance analysis before geometry or exact text placement could be
qualified.

The default MEMFS path keeps the input, 177 MB output and spatial-sort
temporary files in memory alongside the LibreDWG object graph. Emscripten
memory growth also leaves overlapping resident buffers during the conversion.
The result is similar conversion time to Native but over three times the
800 MB hard limit, rising to almost 3 GB when the complete output is read for
comparison. Fixed 512 MiB and 768 MiB heaps, and a single 512 MiB linear growth
step, reduced resident memory but failed to complete within 39–77 seconds and
were stopped.

## Decision

The current WASM candidate fails large-output equality, memory and actual
browser-execution gates. LibreDWG Native remains the only product backend.

A new WASM attempt is justified only after replacing MEMFS output and
temporary storage with direct disk-backed Worker storage, avoiding a complete
output copy, and proving that LibreDWG parsing completes in the target browser.
Likely research paths are read-only `WORKERFS` input and WasmFS/OPFS output,
but those require an asynchronous or pthread-aware filesystem design rather
than a compiler-flag change. Any such rewrite must repeat byte identity,
Korean SHX/BigFont, cancellation, total-memory and user-visible loading tests.
