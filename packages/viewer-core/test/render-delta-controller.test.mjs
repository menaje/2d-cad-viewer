import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderCapability,
  RenderDeltaAspect,
  RenderDeltaOperationKind,
  RenderProtocolDiagnosticCode,
  RenderProtocolVersion,
  ViewerLayerKind,
  ViewerRepresentation,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
} from "@menaje/viewer-render-protocol";

import {
  runRenderDeltaConformance,
  runStagedRenderDeltaConformance,
} from "@menaje/viewer-core/conformance";
import {
  MockRenderDeltaSource,
  MockStagedRenderDeltaAdapter,
} from "@menaje/viewer-core/testing";
import {
  ViewerRenderDeltaController,
} from "@menaje/viewer-core/render-delta";
import {
  ViewerDiffStatus,
  ViewerRenderDiffController,
} from "@menaje/viewer-core/render-diff";
import {
  openRenderSource,
} from "@menaje/viewer-core";

const revisionOne = "revision:delta:1";
const revisionTwo = "revision:delta:2";
const revisionThree = "revision:delta:3";

function sessionDescriptor() {
  return parseRenderSessionDescriptor({
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:delta",
    sourceId: "source:delta",
    currentRevisionId: revisionOne,
    lastSuccessfulRevisionId: revisionOne,
    capabilities: [
      RenderCapability.LAYER_MANIFEST,
      RenderCapability.RENDER_DELTA,
      RenderCapability.RENDER_SNAPSHOT,
    ],
    resourceBudgetBytes: 1024 * 1024,
  });
}

function baseSnapshot(descriptor = sessionDescriptor()) {
  return parseRenderSnapshotDescriptor(
    {
      protocolVersion: RenderProtocolVersion,
      sessionId: descriptor.sessionId,
      sourceId: descriptor.sourceId,
      revisionId: revisionOne,
      snapshotId: "snapshot:delta:base",
      sequence: 0,
      layers: [
        {
          layerId: "layer:base",
          sourceId: "source:base",
          revisionId: revisionOne,
          kind: ViewerLayerKind.BASE,
          representation: ViewerRepresentation.TWO_DIMENSIONAL,
          order: 0,
          visible: true,
        },
        {
          layerId: "layer:live",
          sourceId: "source:live",
          revisionId: revisionOne,
          kind: ViewerLayerKind.LIVE,
          representation: ViewerRepresentation.TWO_DIMENSIONAL,
          order: 1,
          visible: true,
        },
      ],
    },
    { session: descriptor },
  );
}

function bounds(offset = 0) {
  return {
    min: [offset, offset, 0],
    max: [offset + 2, offset + 2, 1],
  };
}

function operation(
  renderId,
  {
    operationId = `operation:${renderId}`,
    kind = RenderDeltaOperationKind.UPSERT,
    aspect = RenderDeltaAspect.GEOMETRY,
    layerId = "layer:live",
    sourceId = "source:live",
    affectedWorldBounds = bounds(),
    dependencyIds = [],
    externalIdentityToken = `external:${renderId}`,
  } = {},
) {
  return {
    operationId,
    kind,
    aspect,
    layerId,
    sourceId,
    renderIds: [renderId],
    affectedWorldBounds,
    dependencyIds,
    externalIdentityToken,
  };
}

function payload(fromRevisionId, toRevisionId, sequence) {
  return {
    protocolVersion: RenderProtocolVersion,
    payloadId: `payload:delta:${sequence}`,
    sessionId: "session:delta",
    sourceId: "source:delta",
    fromRevisionId,
    toRevisionId,
    mediaType: "application/vnd.menaje.viewer.render-delta",
    byteLength: 128,
    sha256: `${sequence}`.repeat(64),
    expiresAt: null,
    disposeWithSession: true,
  };
}

function delta({
  deltaId = "delta:1",
  fromRevisionId = revisionOne,
  toRevisionId = revisionTwo,
  sequence = 1,
  operations = [operation("render:new")],
  affectedWorldBounds = bounds(),
  includePayload = true,
} = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    deltaId,
    sessionId: "session:delta",
    sourceId: "source:delta",
    baseSnapshotId: "snapshot:delta:base",
    fromRevisionId,
    toRevisionId,
    sequence,
    operations,
    affectedWorldBounds,
    payload: includePayload
      ? payload(fromRevisionId, toRevisionId, sequence)
      : null,
  };
}

test("applies bounded tombstone and aspect upserts atomically", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
  });
  const operations = [
    operation("render:removed", {
      operationId: "operation:tombstone",
      kind: RenderDeltaOperationKind.TOMBSTONE,
      aspect: RenderDeltaAspect.ENTITY,
      externalIdentityToken: null,
    }),
    operation("render:geometry"),
    operation("render:text", {
      aspect: RenderDeltaAspect.TEXT,
    }),
    operation("render:transform", {
      aspect: RenderDeltaAspect.TRANSFORM,
    }),
    operation("render:style", {
      aspect: RenderDeltaAspect.STYLE,
    }),
    operation("render:identity", {
      aspect: RenderDeltaAspect.IDENTITY,
    }),
    operation("render:dependency", {
      aspect: RenderDeltaAspect.DEPENDENCY,
      dependencyIds: ["block:shared-door", "type:wall"],
    }),
  ];

  const state = controller.applyCommitted(
    delta({ operations }),
  );

  assert.equal(state.revisionId, revisionTwo);
  assert.equal(state.sequence, 1);
  assert.equal(state.tombstones.length, 1);
  assert.equal(state.upserts.length, 6);
  assert.deepEqual(state.invalidatedDependencyIds, [
    "block:shared-door",
    "type:wall",
  ]);
  assert.equal(state.invalidatedDependencyCount, 2);
  assert.equal(
    controller.lookup("layer:live", "render:removed").status,
    "tombstone",
  );
  assert.equal(
    controller.lookup("layer:live", "render:geometry").status,
    "upsert",
  );
  assert.equal(
    controller.externalIdentity("layer:live", "render:geometry"),
    "external:render:geometry",
  );
});

test("classifies bounded net diff state without enumerating unchanged entities", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
  });
  const baseRenderIds = new Set([
    "render:removed",
    "render:geometry",
    "render:style",
    "render:unchanged",
  ]);
  const diffController = new ViewerRenderDiffController({
    renderDeltaController: controller,
    baseRenderIdCount: baseRenderIds.size,
    hasBaseRenderId(layerId, renderId) {
      return (
        layerId === "layer:live" &&
        baseRenderIds.has(renderId)
      );
    },
  });

  assert.deepEqual(diffController.snapshot().counts, {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 4,
  });
  controller.applyCommitted(
    delta({
      operations: [
        operation("render:removed", {
          operationId: "operation:remove",
          kind: RenderDeltaOperationKind.TOMBSTONE,
          aspect: RenderDeltaAspect.ENTITY,
          externalIdentityToken: null,
        }),
        operation("render:geometry"),
        operation("render:style", {
          aspect: RenderDeltaAspect.STYLE,
        }),
        operation("render:added", {
          operationId: "operation:add",
        }),
      ],
    }),
  );

  const diff = diffController.snapshot();
  assert.equal(diff.baseRevisionId, revisionOne);
  assert.equal(diff.revisionId, revisionTwo);
  assert.deepEqual(diff.counts, {
    added: 1,
    removed: 1,
    modified: 2,
    unchanged: 1,
  });
  assert.deepEqual(
    diff.changedEntries.map(({ renderId, status }) => ({
      renderId,
      status,
    })),
    [
      {
        renderId: "render:added",
        status: ViewerDiffStatus.ADDED,
      },
      {
        renderId: "render:geometry",
        status: ViewerDiffStatus.MODIFIED,
      },
      {
        renderId: "render:removed",
        status: ViewerDiffStatus.REMOVED,
      },
      {
        renderId: "render:style",
        status: ViewerDiffStatus.MODIFIED,
      },
    ],
  );
  assert.equal(
    diffController.classify("layer:live", "render:unchanged"),
    ViewerDiffStatus.UNCHANGED,
  );
  assert.equal(
    diffController.classify("layer:live", "render:missing"),
    null,
  );
});

test("collapses an added-then-removed Render ID to an unchanged net diff", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
  });
  const diffController = new ViewerRenderDiffController({
    renderDeltaController: controller,
    baseRenderIdCount: 1,
    hasBaseRenderId(_layerId, renderId) {
      return renderId === "render:unchanged";
    },
  });
  controller.applyCommitted(delta());
  controller.applyCommitted(
    delta({
      deltaId: "delta:remove-added",
      fromRevisionId: revisionTwo,
      toRevisionId: revisionThree,
      sequence: 2,
      operations: [
        operation("render:new", {
          operationId: "operation:remove-added",
          kind: RenderDeltaOperationKind.TOMBSTONE,
          aspect: RenderDeltaAspect.ENTITY,
          externalIdentityToken: null,
        }),
      ],
      includePayload: false,
    }),
  );

  assert.deepEqual(diffController.snapshot().counts, {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 1,
  });
  assert.deepEqual(diffController.snapshot().changedEntries, []);
  assert.equal(
    diffController.classify("layer:live", "render:new"),
    null,
  );
});

test("tracks preview diff state and restores the base summary on rollback", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
  });
  const diffController = new ViewerRenderDiffController({
    renderDeltaController: controller,
    baseRenderIdCount: 2,
    hasBaseRenderId(_layerId, renderId) {
      return ["render:existing", "render:unchanged"].includes(
        renderId,
      );
    },
  });
  const preview = delta({
    deltaId: "delta:diff-preview",
    operations: [
      operation("render:existing"),
      operation("render:added"),
    ],
  });

  controller.applyPreview(preview);
  assert.equal(
    diffController.snapshot().previewId,
    "delta:diff-preview",
  );
  assert.deepEqual(diffController.snapshot().counts, {
    added: 1,
    removed: 0,
    modified: 1,
    unchanged: 1,
  });

  controller.rollbackPreview(preview.deltaId);
  assert.equal(diffController.snapshot().previewId, null);
  assert.deepEqual(diffController.snapshot().counts, {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 2,
  });
});

test("leaves committed state untouched after stale or out-of-order input", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
  });
  controller.applyCommitted(delta());
  const before = controller.snapshot();

  assert.throws(
    () =>
      controller.applyCommitted(
        delta({
          deltaId: "delta:stale",
          sequence: 2,
          toRevisionId: revisionThree,
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  assert.deepEqual(controller.snapshot(), before);

  assert.throws(
    () =>
      controller.applyCommitted(
        delta({
          deltaId: "delta:out-of-order",
          fromRevisionId: revisionTwo,
          toRevisionId: revisionThree,
          sequence: 3,
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.OUT_OF_ORDER,
  );
  assert.deepEqual(controller.snapshot(), before);
});

test("rolls a preview back without rebuilding the immutable base", () => {
  const descriptor = sessionDescriptor();
  const snapshot = baseSnapshot(descriptor);
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot,
  });
  const baseline = controller.snapshot();
  const preview = delta({ deltaId: "delta:preview" });

  const previewState = controller.applyPreview(preview);
  assert.equal(previewState.previewId, "delta:preview");
  assert.equal(previewState.revisionId, revisionTwo);
  assert.equal(
    controller.lookup("layer:live", "render:new").status,
    "upsert",
  );

  assert.deepEqual(
    controller.rollbackPreview("delta:preview"),
    baseline,
  );
  assert.equal(
    controller.lookup("layer:live", "render:new").status,
    "base",
  );

  controller.applyPreview(preview);
  const promoted = controller.promotePreview("delta:preview");
  assert.equal(promoted.previewId, null);
  assert.equal(promoted.committedRevisionId, revisionTwo);

  const removed = controller.applyCommitted(
    delta({
      deltaId: "delta:2",
      fromRevisionId: revisionTwo,
      toRevisionId: revisionThree,
      sequence: 2,
      operations: [
        operation("render:new", {
          operationId: "operation:remove-new",
          kind: RenderDeltaOperationKind.TOMBSTONE,
          aspect: RenderDeltaAspect.ENTITY,
          externalIdentityToken: null,
        }),
      ],
      includePayload: false,
    }),
  );
  assert.equal(removed.revisionId, revisionThree);
  assert.equal(
    controller.lookup("layer:live", "render:new").status,
    "tombstone",
  );
});

test("recommends a checkpoint before bounded overlay limits are exhausted", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    checkpointDeltaCount: 1,
    checkpointPayloadBytes: 128,
    checkpointOverlayEntries: 1,
    checkpointDependencyIds: 1,
    maximumDeltaCount: 2,
    maximumPayloadBytes: 256,
    maximumOverlayEntries: 2,
    maximumDependencyIds: 2,
  });

  const state = controller.applyCommitted(delta());
  assert.equal(state.checkpointRecommended, true);

  assert.throws(
    () =>
      controller.applyCommitted(
        delta({
          deltaId: "delta:too-large",
          fromRevisionId: revisionTwo,
          toRevisionId: revisionThree,
          sequence: 2,
          operations: [
            operation("render:second"),
            operation("render:third", {
              affectedWorldBounds: bounds(1),
            }),
          ],
          affectedWorldBounds: {
            min: [0, 0, 0],
            max: [3, 3, 1],
          },
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.equal(controller.revisionId, revisionTwo);

  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  assert.throws(() => controller.snapshot(), /disposed/u);
});

test("bounds retained dependency invalidations and preserves the last good revision", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    checkpointDependencyIds: 1,
    maximumDependencyIds: 2,
  });
  const first = controller.applyCommitted(
    delta({
      operations: [
        operation("render:dependency-one", {
          aspect: RenderDeltaAspect.DEPENDENCY,
          dependencyIds: ["block:one", "block:two"],
        }),
      ],
    }),
  );
  assert.equal(first.checkpointRecommended, true);
  assert.equal(first.invalidatedDependencyCount, 2);

  assert.throws(
    () =>
      controller.applyCommitted(
        delta({
          deltaId: "delta:dependency-overflow",
          fromRevisionId: revisionTwo,
          toRevisionId: revisionThree,
          sequence: 2,
          operations: [
            operation("render:dependency-three", {
              aspect: RenderDeltaAspect.DEPENDENCY,
              dependencyIds: ["block:three"],
            }),
          ],
          includePayload: false,
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.equal(controller.revisionId, revisionTwo);
  assert.deepEqual(controller.snapshot(), first);
});

test("streams ordered deltas and rejects a replay without advancing state", async () => {
  const source = new MockRenderDeltaSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const controller = new ViewerRenderDeltaController({
    sourceSession,
    snapshot,
  });
  const errors = [];
  const subscription = await sourceSession.subscribeRenderDeltas(
    (nextDelta) => controller.applyCommitted(nextDelta),
    {
      onError(error) {
        errors.push(error);
      },
    },
  );

  const first = await source.emitNext();
  await subscription.whenIdle();
  assert.equal(first.deltaId, "delta:mock:1");
  assert.equal(sourceSession.revisionId, "revision:delta-mock:2");
  assert.equal(controller.revisionId, "revision:delta-mock:2");
  const pickRequest = {
    protocolVersion: RenderProtocolVersion,
    sessionId: snapshot.sessionId,
    sourceId: "source:delta-live",
    revisionId: sourceSession.revisionId,
    snapshotId: snapshot.snapshotId,
    layerId: "layer:delta-live",
    renderId: "render:delta:42",
    pickId: "pick:delta:42",
    worldPosition: [10, 20, 0],
    worldBounds: bounds(),
  };
  const identity = await sourceSession.resolvePick(pickRequest);
  assert.equal(identity.revisionId, "revision:delta-mock:2");
  assert.equal(
    identity.externalIdentityToken,
    "external:delta-mock:42",
  );

  assert.equal(await source.emit(first), null);
  await subscription.whenIdle();
  assert.equal(
    errors.at(-1).code,
    RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  assert.equal(sourceSession.revisionId, "revision:delta-mock:2");
  assert.equal(controller.revisionId, "revision:delta-mock:2");

  const second = await source.emitNext();
  await subscription.whenIdle();
  assert.equal(second.deltaId, "delta:mock:2");
  assert.equal(sourceSession.revisionId, "revision:delta-mock:3");
  assert.equal(controller.revisionId, "revision:delta-mock:3");
  await assert.rejects(
    sourceSession.resolvePick({
      ...pickRequest,
      revisionId: "revision:delta-mock:3",
    }),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
  );

  await subscription.dispose();
  controller.dispose();
  await sourceSession.dispose();
});

test("passes the reusable Render Delta conformance fixture", async () => {
  const report = await runRenderDeltaConformance(() => {
    const source = new MockRenderDeltaSource();
    return {
      source,
      emitNext: (options) => source.emitNext(options),
      emit: (nextDelta, options) =>
        source.emit(nextDelta, options),
    };
  });

  assert.equal(report.deltaCount, 2);
  assert.equal(report.staleRejected, true);
  assert.equal(report.revisionId, "revision:delta-mock:3");
  assert.equal(report.disposed, true);
});

test("passes the reusable staged Render Delta conformance fixture", async () => {
  const report = await runStagedRenderDeltaConformance(() => {
    const source = new MockRenderDeltaSource({
      representation: ViewerRepresentation.THREE_DIMENSIONAL,
    });
    return {
      source,
      emitNext: (options) => source.emitNext(options),
      emit: (nextDelta, options) =>
        source.emit(nextDelta, options),
    };
  });

  assert.equal(report.deltaCount, 2);
  assert.equal(report.representation, ViewerRepresentation.THREE_DIMENSIONAL);
  assert.equal(report.revisionId, "revision:delta-mock:3");
  assert.equal(report.asynchronousPreparePreservedCurrentScene, true);
  assert.equal(report.atomicGeometryPickCommit, true);
  assert.equal(report.staleRejectedBeforePrepare, true);
  assert.equal(report.prepareFailureReleasedResources, true);
  assert.equal(report.commitFailureRolledBack, true);
  assert.equal(report.digestMismatchRejected, true);
  assert.equal(report.cancellationReleasedResources, true);
  assert.equal(report.disposed, true);
});

test("coordinates a source-neutral renderer adapter with preview lifecycle", () => {
  const descriptor = sessionDescriptor();
  const calls = [];
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter: {
      applyDelta(nextDelta, { preview }) {
        calls.push(["apply", nextDelta.deltaId, preview]);
      },
      rollbackPreview(nextDelta) {
        calls.push(["rollback", nextDelta.deltaId]);
      },
      promotePreview(nextDelta) {
        calls.push(["promote", nextDelta.deltaId]);
      },
      dispose() {
        calls.push(["dispose"]);
      },
    },
  });
  const preview = delta({ deltaId: "delta:adapter-preview" });

  controller.applyPreview(preview);
  controller.rollbackPreview(preview.deltaId);
  controller.applyPreview(preview);
  controller.promotePreview(preview.deltaId);
  controller.dispose();

  assert.deepEqual(calls, [
    ["apply", "delta:adapter-preview", true],
    ["rollback", "delta:adapter-preview"],
    ["apply", "delta:adapter-preview", true],
    ["promote", "delta:adapter-preview"],
    ["dispose"],
  ]);
});

test("does not publish state when a renderer adapter rejects an atomic delta", () => {
  const descriptor = sessionDescriptor();
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter: {
      applyDelta() {
        throw new Error("cannot stage payload");
      },
      rollbackPreview() {},
      promotePreview() {},
      dispose() {},
    },
  });
  const baseline = controller.snapshot();

  assert.throws(
    () => controller.applyCommitted(delta()),
    /cannot stage payload/u,
  );
  assert.deepEqual(controller.snapshot(), baseline);
  controller.dispose();
});

test("keeps geometry, pick identity, and revision unchanged during asynchronous prepare", async () => {
  const descriptor = sessionDescriptor();
  const adapter = new MockStagedRenderDeltaAdapter({
    revisionId: revisionOne,
    holdPrepare: true,
    expectedPayloadSha256: "1".repeat(64),
  });
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter,
  });
  const baseline = controller.snapshot();
  const applying = controller.applyCommittedAsync(delta());

  await adapter.prepareStarted;
  assert.equal(controller.preparing, true);
  assert.deepEqual(controller.snapshot(), baseline);
  assert.equal(adapter.snapshot().revisionId, revisionOne);
  assert.equal(adapter.snapshot().geometryRevisionId, revisionOne);
  assert.equal(adapter.snapshot().pickRevisionId, revisionOne);
  assert.equal(adapter.snapshot().resources.stagedRanges, 1);
  assert.equal(adapter.snapshot().resources.stagedWorkers, 1);

  adapter.releasePrepare();
  const applied = await applying;
  assert.equal(await controller.whenIdle(), true);
  assert.equal(applied.revisionId, revisionTwo);
  assert.equal(adapter.snapshot().revisionId, revisionTwo);
  assert.equal(adapter.snapshot().geometryRevisionId, revisionTwo);
  assert.equal(adapter.snapshot().pickRevisionId, revisionTwo);
  assert.deepEqual(adapter.snapshot().identities, [
    {
      renderId: "render:new",
      externalIdentityToken: "external:render:new",
    },
  ]);
  assert.deepEqual(
    adapter.snapshot().resources,
    {
      stagedRanges: 0,
      stagedWorkers: 0,
      stagedCpuBytes: 0,
      stagedGpuBytes: 0,
      activeGpuBytes: 128,
    },
  );

  assert.equal(await controller.disposeAsync(), true);
  assert.equal(adapter.snapshot().resources.activeGpuBytes, 0);
});

test("rolls back and disposes a staged transaction after atomic commit failure", async () => {
  const descriptor = sessionDescriptor();
  const adapter = new MockStagedRenderDeltaAdapter({
    revisionId: revisionOne,
    expectedPayloadSha256: "1".repeat(64),
    failCommit: true,
  });
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter,
  });
  const baseline = controller.snapshot();

  await assert.rejects(
    controller.applyCommittedAsync(delta()),
    /atomic commit failed/u,
  );
  assert.deepEqual(controller.snapshot(), baseline);
  assert.equal(adapter.snapshot().revisionId, revisionOne);
  assert.deepEqual(adapter.snapshot().resources, {
    stagedRanges: 0,
    stagedWorkers: 0,
    stagedCpuBytes: 0,
    stagedGpuBytes: 0,
    activeGpuBytes: 0,
  });
  assert.equal(adapter.snapshot().metrics.rollbacks, 1);
  assert.equal(adapter.snapshot().metrics.transactionDisposals, 1);
  await controller.disposeAsync();
});

test("fails a staged payload digest mismatch without changing the current scene", async () => {
  const descriptor = sessionDescriptor();
  const adapter = new MockStagedRenderDeltaAdapter({
    revisionId: revisionOne,
    expectedPayloadSha256: "f".repeat(64),
  });
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter,
  });
  const baseline = controller.snapshot();

  await assert.rejects(
    controller.applyCommittedAsync(delta()),
    /digest mismatch/u,
  );
  assert.deepEqual(controller.snapshot(), baseline);
  assert.equal(adapter.snapshot().revisionId, revisionOne);
  assert.equal(adapter.snapshot().resources.stagedCpuBytes, 0);
  assert.equal(adapter.snapshot().resources.stagedGpuBytes, 0);
  await controller.disposeAsync();
});

test("cancels a completed prepare before commit and reclaims every staged resource", async () => {
  const descriptor = sessionDescriptor();
  const adapter = new MockStagedRenderDeltaAdapter({
    revisionId: revisionOne,
    holdPrepare: true,
    ignoreAbortDuringPrepare: true,
  });
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter,
  });
  const baseline = controller.snapshot();
  const abortController = new AbortController();
  const applying = controller.applyCommittedAsync(delta(), {
    signal: abortController.signal,
  });

  await adapter.prepareStarted;
  abortController.abort(new DOMException("cancel test", "AbortError"));
  adapter.releasePrepare();
  await assert.rejects(
    applying,
    (error) => error.name === "AbortError",
  );
  assert.deepEqual(controller.snapshot(), baseline);
  assert.equal(adapter.snapshot().metrics.commits, 0);
  assert.equal(adapter.snapshot().metrics.rollbacks, 1);
  assert.equal(adapter.snapshot().metrics.transactionDisposals, 1);
  assert.equal(adapter.snapshot().resources.stagedRanges, 0);
  assert.equal(adapter.snapshot().resources.stagedWorkers, 0);
  await controller.disposeAsync();
});

test("disposeAsync aborts in-flight preparation and terminally releases the adapter", async () => {
  const descriptor = sessionDescriptor();
  const adapter = new MockStagedRenderDeltaAdapter({
    revisionId: revisionOne,
    holdPrepare: true,
  });
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter,
  });
  const applying = controller.applyCommittedAsync(delta());

  await adapter.prepareStarted;
  const rejected = assert.rejects(
    applying,
    (error) => error.name === "AbortError",
  );
  assert.throws(
    () => controller.dispose(),
    /disposeAsync/u,
  );
  assert.equal(await controller.disposeAsync(), true);
  await rejected;
  assert.equal(controller.disposed, true);
  assert.equal(adapter.snapshot().disposed, true);
  assert.deepEqual(adapter.snapshot().resources, {
    stagedRanges: 0,
    stagedWorkers: 0,
    stagedCpuBytes: 0,
    stagedGpuBytes: 0,
    activeGpuBytes: 0,
  });
});

test("rejects stale, out-of-order, and over-budget staged deltas before prepare", async () => {
  const descriptor = sessionDescriptor();
  const adapter = new MockStagedRenderDeltaAdapter({
    revisionId: revisionOne,
  });
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter,
  });

  for (const invalid of [
    delta({ fromRevisionId: revisionTwo }),
    delta({ sequence: 2 }),
    {
      ...delta(),
      payload: {
        ...delta().payload,
        byteLength: 2 * 1024 * 1024,
      },
    },
  ]) {
    assert.throws(
      () => controller.applyCommittedAsync(invalid),
      (error) => error instanceof Error,
    );
  }
  assert.equal(adapter.snapshot().metrics.prepares, 0);
  assert.equal(controller.revisionId, revisionOne);
  await controller.disposeAsync();
});

test("does not advance the source revision when consumer application fails", async () => {
  const source = new MockRenderDeltaSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const rejected = new ViewerRenderDeltaController({
    sourceSession,
    snapshot,
    adapter: {
      applyDelta() {
        throw new Error("GPU transaction failed");
      },
      rollbackPreview() {},
      promotePreview() {},
      dispose() {},
    },
  });
  const errors = [];
  const failedSubscription =
    await sourceSession.subscribeRenderDeltas(
      (nextDelta) => rejected.applyCommitted(nextDelta),
      {
        onError(error) {
          errors.push(error);
        },
      },
    );

  assert.equal(await source.emitNext(), null);
  await failedSubscription.whenIdle();
  assert.match(errors.at(-1).message, /GPU transaction failed/u);
  assert.equal(sourceSession.revisionId, "revision:delta-mock:1");
  assert.equal(rejected.revisionId, "revision:delta-mock:1");
  await failedSubscription.dispose();
  rejected.dispose();

  const recovered = new ViewerRenderDeltaController({
    sourceSession,
    snapshot,
  });
  const recoveredSubscription =
    await sourceSession.subscribeRenderDeltas(
      (nextDelta) => recovered.applyCommitted(nextDelta),
    );
  assert.equal(
    (await source.emitNext()).toRevisionId,
    "revision:delta-mock:2",
  );
  await recoveredSubscription.whenIdle();
  assert.equal(sourceSession.revisionId, "revision:delta-mock:2");
  assert.equal(recovered.revisionId, "revision:delta-mock:2");

  await recoveredSubscription.dispose();
  recovered.dispose();
  await sourceSession.dispose();
});
