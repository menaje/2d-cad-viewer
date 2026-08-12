# Scene Engine protocol v1

Issue [#17](https://github.com/menaje/2d-cad-viewer/issues/17) validates optional
execution backends without replacing the accepted LibreDWG Native path or
forking the renderer. The extension-side contract is
`dwg-scene-engine/1`.

## Boundary

```text
DWG
  -> SceneCacheManager
       -> LibreDWG Native process (product default)
            -> first-frame preview sidecar
            -> validated full cache
       -> WASM Worker candidate (qualification only)
  -> Scene Cache v1.26
  -> one range reader and one WebGL renderer
```

A `SceneEngine` supplies:

- an immutable engine and backend descriptor;
- a revision snapshot used to detect implementation changes;
- one cancellable conversion method that writes the requested packed cache;
- bounded progress events tied to the descriptor.

The parser and execution backend are separate identities. LibreDWG Native and
a future LibreDWG WASM build therefore share `engineId=libredwg` and the exact
engine version, but use different backend IDs and kinds. Their caches do not
overlap unless a later qualification proves byte-identical output and changes
this policy explicitly.

## Capabilities

Every descriptor declares:

- local-only execution;
- packed Scene Cache output;
- whether a usable preview can be published before the full cache;
- cancellation support;
- supported geometry/text feature families;
- accepted conversion option names.

The current product descriptor is `libredwg` 0.14 on backend `native` with
kind `native-process`. It declares linework, blocks, HATCH, WIPEOUT, text and
SHX/BigFont support. It declares `progressivePreview=true`: the same Native
process may publish an independently readable, first-frame Scene Cache before
it performs the disk-backed detail sort and writes the complete cache. A WASM
candidate may declare true only when its Worker provides the same guarantee
without creating a whole-drawing JavaScript object graph.

## Native progressive publication

The preview is optional and best-effort. When the caller supplies an
`onPreview` callback, the cache manager first checks a deterministic overview
path derived from the full-cache identity. If no compatible overview exists,
it gives the Native engine a new private temporary preview path. The adapter:

1. parses the DWG once and builds the capped overview plan;
2. writes and closes an independent Scene Cache v1.26 preview;
3. creates a separate ready marker;
4. continues the existing disk-backed detail sort and atomic full-cache write.

The preview contains drawing, layer, block and INSERT metadata plus only the
LOD-0 GPU line prefix. Its geometry is capped by the existing 4 MiB overview
limit; source, text, HATCH, primitive and draw-order sections remain present
but empty. Header flag bit 0 identifies this display-only artifact. It is
never accepted as the final conversion result or committed under the
canonical full-cache filename.

The extension observes the marker without blocking the converter, verifies
the preview path, size, schema and preview flag, and rechecks both source and
engine snapshots. It then atomically commits the overview as
`<full-cache-id>.dwg.preview` and opens a separate range channel. A later
forced or interrupted full conversion publishes that overview before starting
the converter, gives its first frame a bounded opportunity to complete, and
omits a duplicate preview request. The Webview replaces it with the ordinary
full cache when that cache is validated. Retry, cancellation, editor close and
preview-render failure release the range channel; the validated overview
remains reusable.

Preview creation, publication or rendering failure does not weaken the final
cache contract: conversion continues through the existing validated,
atomically committed path. Older compatible adapters simply ignore the
preview environment variables and retain the previous loading behavior.

## Progress

Events use `dwg-scene-engine-progress/1` and always include engine ID, engine
version, backend ID and backend kind.

| Phase | Meaning |
| --- | --- |
| `checking` | The cache manager is checking an existing cache and identities. |
| `parsing` | The backend is parsing or converting the DWG. |
| `preview-ready` | A progressive backend has published a bounded usable preview. |
| `validating` | The backend is validating packed output. |
| `cache-ready` | The cache has been validated and committed, or safely reused. |
| `failed` | Preparation ended with an error. |
| `cancelled` | Preparation ended after explicit cancellation. |

`cache-ready`, `failed` and `cancelled` are terminal for one preparation
attempt. Native process termination, temporary-file cleanup and retry
serialization remain unchanged behind the common contract.

## Cache identity

The private cache filename is a SHA-256 digest over length-prefixed fields:

```text
SceneEngine contract
+ Scene Cache version
+ resolved source path, size and modification time
+ engine ID and version
+ backend ID and kind
+ implementation revision
+ canonical sorted conversion options
```

Only the digest becomes the filename. Option order cannot change the identity,
while changing an option value, engine/backend version or implementation
revision must change it. Source and engine snapshots are checked again after
conversion before the temporary output is committed.

## WASM admission

The common TypeScript path can already exercise a progressive
`wasm-worker`-shaped test engine. This is contract scaffolding, not a shipped
WASM parser. A real candidate remains excluded from settings, automatic
selection, fallback and the VSIX until it:

1. writes the same supported Scene Cache contract without a full JavaScript
   drawing graph;
2. passes geometry, Korean text and SHX/BigFont comparison;
3. stays below 300 MB stable Webview memory and 800 MB concurrent total memory;
4. proves cancellation and Worker cleanup;
5. demonstrates a measured installation, isolation or user-perceived
   performance benefit over LibreDWG Native;
6. completes its license and package review.

LibreDWG Native remains the only product backend while those gates are open.

The 2026-08-01 real LibreDWG 0.14 qualification closed the current candidate
as rejected, rather than admitting it. Its small public-fixture cache was
byte-identical to Native and Worker termination took 2.12 ms. On the large
drawing all source string tables remained identical, but kinds 22, 30–31 and
33–34 did not; full-cache comparison peaked at 2,983,854,080 bytes RSS. The
same small fixture did not complete within 30 seconds in an actual Chromium
Worker. Compiler memory settings alone did not satisfy both time and memory
gates. A future candidate must first replace in-memory output and temporary
files with direct disk-backed Worker storage, then repeat all six admission
checks. Reproduction instructions and measurements are in
[`adapters/libredwg/wasm`](../adapters/libredwg/wasm/README.md).
