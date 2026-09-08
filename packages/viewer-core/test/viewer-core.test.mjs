import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolId,
  RenderProtocolVersion,
  ViewerLayerKind,
  ViewerRepresentation,
} from "@menaje/viewer-render-protocol";

import {
  ViewerCoreApi,
  ViewerCoreVersion,
  assertViewerHost,
  createRenderLayerRangeSource,
  openRenderSource,
  openViewerRuntime,
} from "../src/index.mjs";
import { runRenderSourceConformance } from "../src/conformance.mjs";
import { MockRenderSource } from "../src/mock-render-source.mjs";

const revisionOne =
  "revision:sha256:1111111111111111111111111111111111111111111111111111111111111111";

function createMockSource({
  capabilities = [
    RenderCapability.LAYER_MANIFEST,
    RenderCapability.RENDER_SNAPSHOT,
    RenderCapability.RANGE_READ,
  ],
  sequences = [0],
  includeRangeMethod = true,
  remainingReadBytes = 8,
  expiresAt = null,
  rangeRead,
} = {}) {
  const state = {
    negotiatedVersion: null,
    sourceDisposals: 0,
    sessionDisposals: 0,
    reads: [],
  };
  let snapshotIndex = 0;
  const handle = {
    protocolVersion: RenderProtocolVersion,
    handleId: "range:base",
    sessionId: "session:mock",
    sourceId: "source:base",
    revisionId: revisionOne,
    layerId: "layer:base",
    mediaType: "application/vnd.dwg-viewer.scene-cache",
    byteLength: 8,
    maximumRequestBytes: 4,
    remainingReadBytes,
    sha256: "b".repeat(64),
    expiresAt,
    disposeWithSession: true,
  };
  const source = {
    supportedProtocolVersions: [RenderProtocolVersion],
    async open({ protocolVersion }) {
      state.negotiatedVersion = protocolVersion;
      const session = {
        descriptor: {
          protocolVersion,
          sessionId: "session:mock",
          sourceId: "source:mock",
          currentRevisionId: revisionOne,
          lastSuccessfulRevisionId: revisionOne,
          capabilities,
          resourceBudgetBytes: 1024,
        },
        async getSnapshot() {
          const sequence =
            sequences[Math.min(snapshotIndex, sequences.length - 1)];
          snapshotIndex += 1;
          return {
            protocolVersion,
            sessionId: "session:mock",
            sourceId: "source:mock",
            revisionId: revisionOne,
            snapshotId: `snapshot:${sequence}`,
            sequence,
            layers: [
              {
                layerId: "layer:base",
                sourceId: "source:base",
                revisionId: revisionOne,
                kind: ViewerLayerKind.BASE,
                representation: ViewerRepresentation.TWO_DIMENSIONAL,
                order: 0,
                visible: true,
                rangeHandle: handle,
              },
            ],
          };
        },
        async dispose() {
          state.sessionDisposals += 1;
        },
      };
      if (includeRangeMethod) {
        session.readRange = async (_handle, offset, length) => {
          state.reads.push({ offset, length });
          if (rangeRead) {
            return rangeRead({ offset, length });
          }
          return Uint8Array.from(
            { length },
            (_, index) => offset + index,
          );
        };
      }
      return session;
    },
    async dispose() {
      state.sourceDisposals += 1;
    },
  };
  return { source, state, handle };
}

test("opens a negotiated RenderSource and validates its snapshot", async () => {
  const { source, state } = createMockSource();
  const session = await openRenderSource(source);
  const snapshot = await session.getSnapshot();

  assert.equal(state.negotiatedVersion, RenderProtocolVersion);
  assert.equal(snapshot.snapshotId, "snapshot:0");
  assert.equal(snapshot.layers[0].kind, ViewerLayerKind.BASE);

  await session.dispose();
  await session.dispose();
  assert.equal(state.sessionDisposals, 1);
  assert.equal(state.sourceDisposals, 1);
});

test("enforces active range scope, request size, and cumulative budget", async () => {
  const { source, state, handle } = createMockSource();
  const session = await openRenderSource(source);
  await session.getSnapshot();

  assert.deepEqual(
    [...new Uint8Array(await session.readRange(handle, 0, 4))],
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    [...new Uint8Array(await session.readRange(handle, 4, 4))],
    [4, 5, 6, 7],
  );
  await assert.rejects(
    session.readRange(handle, 0, 1),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.RANGE_INVALID,
  );
  await session.getSnapshot();
  await assert.rejects(
    session.readRange(handle, 0, 1),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.RANGE_INVALID,
  );
  assert.deepEqual(state.reads, [
    { offset: 0, length: 4 },
    { offset: 4, length: 4 },
  ]);
  await session.dispose();
});

test("rejects an out-of-order snapshot before exposing it", async () => {
  const { source } = createMockSource({ sequences: [2, 1] });
  const session = await openRenderSource(source);
  await session.getSnapshot();
  await assert.rejects(
    session.getSnapshot(),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.OUT_OF_ORDER,
  );
  await session.dispose();
});

test("reserves range budget before concurrent reads", async () => {
  const { source, handle } = createMockSource({
    remainingReadBytes: 4,
  });
  const session = await openRenderSource(source);
  await session.getSnapshot();

  const firstRead = session.readRange(handle, 0, 4);
  await assert.rejects(
    session.readRange(handle, 4, 4),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.RANGE_INVALID,
  );
  assert.equal((await firstRead).byteLength, 4);
  await session.dispose();
});

test("does not expose range bytes after the active snapshot changes", async () => {
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const { source, handle } = createMockSource({
    sequences: [0, 1],
    async rangeRead({ offset, length }) {
      markReadStarted();
      await readGate;
      return Uint8Array.from(
        { length },
        (_, index) => offset + index,
      );
    },
  });
  const session = await openRenderSource(source);
  await session.getSnapshot();

  const pendingRead = session.readRange(handle, 0, 4);
  await readStarted;
  await session.getSnapshot();
  releaseRead();
  await assert.rejects(
    pendingRead,
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  await session.dispose();
});

test("rejects an expired range handle before calling its source", async () => {
  const { source, state, handle } = createMockSource({
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const session = await openRenderSource(source);
  await session.getSnapshot();

  await assert.rejects(
    session.readRange(handle, 0, 4),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.RANGE_INVALID,
  );
  assert.deepEqual(state.reads, []);
  await session.dispose();
});

test("fails opening when a declared capability has no implementation", async () => {
  const { source, state } = createMockSource({
    includeRangeMethod: false,
  });
  await assert.rejects(
    openRenderSource(source),
    (error) =>
      error.code ===
      RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
  );
  assert.equal(state.sessionDisposals, 1);
  assert.equal(state.sourceDisposals, 1);
});

test("disposes a source when protocol negotiation fails", async () => {
  const { source, state } = createMockSource();
  await assert.rejects(
    openRenderSource(source, {
      supportedProtocolVersions: ["2.0.0"],
    }),
    (error) =>
      error.code ===
      RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
  );
  assert.equal(state.sourceDisposals, 1);
  assert.equal(state.sessionDisposals, 0);
});

test("runs the reusable conformance fixture against a Browser mock source", async () => {
  const report = await runRenderSourceConformance(
    () =>
      new MockRenderSource({
        bytes: Uint8Array.of(1, 2, 3, 4, 5, 6),
      }),
  );

  assert.equal(report.protocolVersion, RenderProtocolVersion);
  assert.equal(report.layers, 1);
  assert.equal(report.rangeBytes, 4);
  assert.equal(report.disposed, true);
});

test("adapts one snapshot layer to the bounded reader interface", async () => {
  const { source, state } = createMockSource();
  const session = await openRenderSource(source);
  const snapshot = await session.getSnapshot();
  const rangeSource = createRenderLayerRangeSource(
    session,
    snapshot,
    { layerId: "layer:base" },
  );

  assert.equal(rangeSource.size, 8);
  assert.equal(rangeSource.maximumRequestBytes, 4);
  assert.deepEqual(
    [...new Uint8Array(await rangeSource.read(2, 3))],
    [2, 3, 4],
  );
  assert.deepEqual(state.reads, [{ offset: 2, length: 3 }]);
  assert.throws(
    () =>
      createRenderLayerRangeSource(session, snapshot, {
        layerId: "layer:missing",
      }),
    (error) =>
      error.code ===
      RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
  );
  await session.dispose();
});

test("owns source, presentation, and host disposal in one runtime", async () => {
  const { source, state } = createMockSource();
  const lifecycle = {
    hostDisposals: 0,
    presentationDisposals: 0,
    events: [],
  };
  const host = {
    handleEvent(event) {
      lifecycle.events.push(event);
    },
    async dispose() {
      lifecycle.hostDisposals += 1;
    },
  };
  const runtime = await openViewerRuntime(source, {
    host,
    async mount({ sourceSession, snapshot }) {
      const rangeSource = createRenderLayerRangeSource(
        sourceSession,
        snapshot,
      );
      assert.equal((await rangeSource.read(0, 1)).byteLength, 1);
      return {
        async dispose() {
          lifecycle.presentationDisposals += 1;
        },
      };
    },
  });

  const event = { type: "viewport.changed" };
  runtime.handleEvent(event);
  assert.deepEqual(lifecycle.events, [event]);
  await runtime.dispose();
  await runtime.dispose();

  assert.equal(runtime.disposed, true);
  assert.equal(lifecycle.presentationDisposals, 1);
  assert.equal(lifecycle.hostDisposals, 1);
  assert.equal(state.sessionDisposals, 1);
  assert.equal(state.sourceDisposals, 1);
});

test("cleans up source and host when runtime mounting fails", async () => {
  const { source, state } = createMockSource();
  let hostDisposals = 0;
  const host = {
    handleEvent() {},
    async dispose() {
      hostDisposals += 1;
    },
  };

  await assert.rejects(
    openViewerRuntime(source, {
      host,
      async mount() {
        throw new Error("mount failed");
      },
    }),
    /mount failed/,
  );
  assert.equal(hostDisposals, 1);
  assert.equal(state.sessionDisposals, 1);
  assert.equal(state.sourceDisposals, 1);
});

test("requires ViewerHost lifecycle methods without importing a host API", () => {
  const host = {
    handleEvent() {},
    dispose() {},
  };
  assert.equal(assertViewerHost(host), host);
  assert.throws(
    () => assertViewerHost({ handleEvent() {} }),
    /dispose/,
  );
});

test("keeps Viewer Core free of product bootstrap and DWG readers", async () => {
  const sourceDirectory = new URL("../src/", import.meta.url);
  const sourceNames = (await readdir(sourceDirectory)).filter((name) =>
    name.endsWith(".mjs"),
  );
  const sources = await Promise.all(
    sourceNames.map((name) =>
      readFile(new URL(name, sourceDirectory), "utf8"),
    ),
  );
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /from\s+["']vscode["']/u);
  assert.doesNotMatch(combined, /acquireVsCodeApi/u);
  assert.doesNotMatch(combined, /SceneCacheReader/u);
  assert.doesNotMatch(combined, /@dwg-viewer\/dwg-scene-source/u);
  assert.doesNotMatch(combined, /detail-streamer\.mjs/u);
  assert.doesNotMatch(combined, /VERTEX_STRIDE/u);
  assert.doesNotMatch(combined, /GpuLineBatchKind/u);
});

test("keeps package versions and producer compatibility manifest aligned", async () => {
  const root = new URL("../../../", import.meta.url);
  const [manifest, viewerPackage, protocolPackage] = await Promise.all([
    readFile(new URL("compatibility/viewer-core.json", root), "utf8"),
    readFile(new URL("packages/viewer-core/package.json", root), "utf8"),
    readFile(
      new URL("packages/render-protocol/package.json", root),
      "utf8",
    ),
  ]).then((documents) => documents.map(JSON.parse));

  assert.equal(manifest.status, "public-preview");
  assert.equal(
    manifest.distribution.kind,
    "github-release-and-packages",
  );
  assert.equal(manifest.distribution.published, true);
  assert.equal(manifest.distribution.releaseStage, "prerelease");
  assert.equal(
    typeof manifest.distribution.tagPublicationApproved,
    "boolean",
  );
  assert.equal(
    manifest.distribution.automaticStablePromotion,
    false,
  );
  assert.equal(
    manifest.distribution.tag,
    `viewer-core-v${manifest.distribution.packageVersions.viewerCore}`,
  );
  assert.deepEqual(manifest.distribution.packageVersions, {
    viewerCore: "0.1.3",
    renderProtocol: "0.1.3",
    viewerUi: "0.1.3",
  });
  for (const artifact of Object.values(
    manifest.distribution.artifacts,
  )) {
    assert.match(artifact.file, /^menaje-viewer-.+\.tgz$/u);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.match(artifact.contentSha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(artifact.bytes));
    assert.ok(artifact.bytes > 0);
  }
  assert.deepEqual(manifest.compatibilityWindow.renderProtocol, [
    RenderProtocolVersion,
  ]);
  assert.deepEqual(manifest.qualification, {
    viewerOwnedBoundary: "passed",
    artifactOnlyStaged3dConsumer: "passed",
    command: "pnpm run qualify:viewer-boundary",
    evidence:
      "compatibility/evidence/viewer-boundary-0.1.3-2026-08-15.json",
    externalConsumers: "consumer-owned",
  });
  if (manifest.developmentQualification !== undefined) {
    const { validateSourceBinding, validateQualificationReport } = await import(
      "../../../scripts/development-package-evidence.mjs"
    );
    validateSourceBinding(manifest.developmentQualification);
    validateQualificationReport(manifest.developmentQualification);
  }
  assert.equal(
    manifest.sources.mockRenderDelta,
    "delta-conformance",
  );
  assert.equal(
    manifest.components.renderDelta,
    "backward-compatible-sync-apply-plus-async-prepare-atomic-geometry-pick-commit-with-bounded-rollback-disposal",
  );
  assert.equal(
    manifest.components.renderDiff,
    "changed-id-only-added-removed-modified-unchanged-net-summary",
  );
  assert.equal(
    manifest.components.diffOverlay,
    "bounded-revision-bound-status-style-policy-with-dwg-line-fill-point-canvas-text-and-shared-insert-occurrence-presentation-source-intersected-visibility-child-precedence-and-retryable-application",
  );
  assert.equal(
    manifest.components.splitViewCamera,
    "before-after-logical-camera-sync-with-retryable-rollback-and-independent-renderer-lifecycles",
  );
  assert.equal(
    manifest.components.diffSemantic,
    "revision-bound-diff-open-host-hook-with-bounded-identity-and-dependency-projection",
  );
  assert.equal(
    manifest.components.splitViewDiff,
    "shared-changed-id-mapping-and-corresponding-entity-highlight-with-atomic-two-surface-rollback",
  );
  assert.equal(
    manifest.components.serviceEvents,
    "ordered-revision-and-diagnostic-streams-with-last-successful-snapshot-preservation-and-intent-only-host-events",
  );
  assert.equal(
    manifest.components.layerComposition,
    "source-neutral-2d-3d-semantic-base-live-diff-diagnostic-ordering-with-atomic-rollback",
  );
  assert.equal(
    manifest.conformance.viewerRenderDelta,
    "packages/viewer-core/test/render-delta-controller.test.mjs",
  );
  assert.equal(
    manifest.conformance.viewerRenderDeltaLargeQualification,
    "packages/viewer-core/test/render-delta-large-qualification.test.mjs",
  );
  assert.equal(
    manifest.conformance.viewerDiffOverlay,
    "packages/viewer-core/test/diff-overlay-controller.test.mjs",
  );
  assert.equal(
    manifest.conformance.viewerServiceEvents,
    "packages/viewer-core/test/service-event-controller.test.mjs",
  );
  assert.equal(
    manifest.conformance.viewerLayerComposition,
    "packages/viewer-core/test/layer-composition-controller.test.mjs",
  );
  assert.equal(
    manifest.conformance.viewerSplitView,
    "packages/viewer-core/test/split-view-camera-controller.test.mjs",
  );
  assert.equal(
    manifest.conformance.viewerSplitViewDiff,
    "packages/viewer-core/test/split-view-diff-controller.test.mjs",
  );
  assert.equal(
    manifest.conformance.dwgRenderDelta,
    "packages/webview/test/render-delta-adapter.test.mjs",
  );
  assert.equal(
    manifest.conformance.dwgDiffOverlay,
    "packages/webview/test/renderer.test.mjs",
  );
  assert.equal(
    manifest.conformance.dwgTextDiffOverlay,
    "packages/webview/test/text-overlay.test.mjs",
  );
  assert.equal(manifest.viewerCore.package, viewerPackage.name);
  assert.equal(manifest.viewerCore.version, viewerPackage.version);
  assert.equal(manifest.viewerCore.version, ViewerCoreVersion);
  assert.equal(manifest.viewerCore.api, ViewerCoreApi);
  assert.equal(
    manifest.renderProtocol.package,
    protocolPackage.name,
  );
  assert.equal(
    manifest.renderProtocol.version,
    protocolPackage.version,
  );
  assert.equal(
    manifest.renderProtocol.protocol,
    RenderProtocolId,
  );
});
