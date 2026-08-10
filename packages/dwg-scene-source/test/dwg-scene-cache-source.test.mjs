import assert from "node:assert/strict";
import test from "node:test";

import {
  createRenderLayerRangeSource,
  openViewerRuntime,
} from "@menaje/viewer-core";
import {
  RenderProtocolDiagnosticCode,
  RenderProtocolVersion,
  ViewerLayerKind,
} from "@menaje/viewer-render-protocol";
import { runRenderSourceConformance } from "@menaje/viewer-core/conformance";

import { makeFixtureCache } from "../../webview/test/cache-fixture.mjs";
import {
  CACHE_VERSION_MINOR,
  DwgSceneCacheSource,
  MemoryRangeSource,
  SceneCacheReader,
  SectionKind,
  TrackedRangeSource,
  createSceneCacheRevisionId,
} from "../src/index.mjs";

const cacheSha256 = "c".repeat(64);

function createSource({
  buffer = makeFixtureCache(),
  maximumRangeRequestBytes = Math.min(256, buffer.byteLength),
} = {}) {
  const rangeSource = new TrackedRangeSource(
    new MemoryRangeSource(buffer),
  );
  const source = new DwgSceneCacheSource({
    rangeSource,
    sessionId: "session:dwg-fixture",
    sourceId: "source:dwg-fixture",
    revisionId: createSceneCacheRevisionId(cacheSha256),
    cacheSha256,
    resourceBudgetBytes: buffer.byteLength,
    maximumRangeRequestBytes,
    readBudgetBytes: buffer.byteLength,
  });
  return { buffer, rangeSource, source };
}

test("opens only the Scene Cache header and directory before snapshot use", async () => {
  const { buffer, rangeSource, source } = createSource();
  const session = await source.open({
    protocolVersion: RenderProtocolVersion,
  });
  const snapshot = await session.getSnapshot();

  assert.equal(snapshot.layers.length, 1);
  assert.equal(snapshot.layers[0].kind, ViewerLayerKind.BASE);
  assert.equal(
    snapshot.layers[0].rangeHandle.byteLength,
    buffer.byteLength,
  );
  assert.deepEqual(rangeSource.requests, [
    { offset: 0, length: 64 },
    { offset: 64, length: Object.keys(SectionKind).length * 40 },
  ]);

  const magic = await session.readRange(
    snapshot.layers[0].rangeHandle,
    0,
    8,
  );
  assert.deepEqual(
    [...new Uint8Array(magic)],
    [68, 87, 71, 83, 67, 78, 49, 0],
  );
  await source.dispose();
  await assert.rejects(
    session.getSnapshot(),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
  );
});

test("keeps the legacy Webview import as a canonical reader re-export", async () => {
  const legacy = await import("../../webview/src/scene-cache.mjs");
  assert.equal(legacy.SceneCacheReader, SceneCacheReader);
});

test("passes the reusable RenderSource conformance fixture", async () => {
  const report = await runRenderSourceConformance(
    () => createSource().source,
  );
  assert.equal(report.protocolVersion, RenderProtocolVersion);
  assert.equal(report.layers, 1);
  assert.equal(report.rangeBytes, 4);
  assert.equal(report.disposed, true);
});

test("mounts the canonical reader through the Viewer Core runtime", async () => {
  const buffer = makeFixtureCache();
  const { rangeSource, source } = createSource({
    buffer,
    maximumRangeRequestBytes: buffer.byteLength,
  });
  let hostDisposals = 0;
  const runtime = await openViewerRuntime(source, {
    host: {
      handleEvent() {},
      dispose() {
        hostDisposals += 1;
      },
    },
    async mount({ sourceSession, snapshot }) {
      const projectedSource = createRenderLayerRangeSource(
        sourceSession,
        snapshot,
      );
      const reader = await SceneCacheReader.open(projectedSource);
      return {
        reader,
        dispose() {
          reader.cache.clear();
        },
      };
    },
  });

  assert.equal(runtime.presentation.reader.header.major, 1);
  assert.equal(
    runtime.presentation.reader.header.minor,
    CACHE_VERSION_MINOR,
  );
  await runtime.dispose();
  assert.equal(hostDisposals, 1);
  assert.equal(rangeSource.disposed, true);
});

test("rejects an unsupported Scene Cache before publishing a snapshot", async () => {
  const buffer = makeFixtureCache({ minorVersion: 17 });
  const { source } = createSource({ buffer });
  await assert.rejects(
    source.open({ protocolVersion: RenderProtocolVersion }),
    /unsupported scene-cache version 1\.17/u,
  );
  await source.dispose();
});
