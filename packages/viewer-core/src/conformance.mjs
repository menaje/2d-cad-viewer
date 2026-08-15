import {
  RenderCapability,
  RenderDeltaOperationKind,
  RenderProtocolDiagnosticCode,
} from "@menaje/viewer-render-protocol";

import { openRenderSource } from "./render-source-session.mjs";
import {
  ViewerRenderDeltaController,
} from "./render-delta-controller.mjs";
import {
  MockStagedRenderDeltaAdapter,
} from "./mock-staged-render-delta-adapter.mjs";

async function expectProtocolError(promise, code, label) {
  try {
    await promise;
  } catch (error) {
    if (error?.code === code) {
      return;
    }
    throw new Error(
      `${label} returned ${error?.code ?? error?.name ?? "unknown error"}`,
      { cause: error },
    );
  }
  throw new Error(`${label} did not fail closed`);
}

export async function runRenderSourceConformance(createSource) {
  if (typeof createSource !== "function") {
    throw new TypeError(
      "render source conformance requires a source factory",
    );
  }

  const incompatibleSource = await createSource();
  await expectProtocolError(
    openRenderSource(incompatibleSource, {
      supportedProtocolVersions: ["9999.0.0"],
    }),
    RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
    "incompatible version negotiation",
  );
  await incompatibleSource.dispose();

  const source = await createSource();
  let session;
  try {
    session = await openRenderSource(source);
    const snapshot = await session.getSnapshot();
    let rangeBytes = 0;
    if (
      session.descriptor.capabilities.includes(
        RenderCapability.RANGE_READ,
      )
    ) {
      const layer = snapshot.layers.find(
        (candidate) => candidate.rangeHandle,
      );
      if (!layer) {
        throw new Error(
          "range-read capability has no range handle in the snapshot",
        );
      }
      const length = Math.min(
        4,
        layer.rangeHandle.byteLength,
        layer.rangeHandle.maximumRequestBytes,
        layer.rangeHandle.remainingReadBytes,
      );
      const bytes = await session.readRange(
        layer.rangeHandle,
        0,
        length,
      );
      if (
        !(bytes instanceof ArrayBuffer) ||
        bytes.byteLength !== length
      ) {
        throw new Error("conformance range read returned invalid bytes");
      }
      rangeBytes = bytes.byteLength;
    }
    await session.dispose();
    await session.dispose();
    await source.dispose();
    await expectProtocolError(
      session.getSnapshot(),
      RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
      "disposed session snapshot",
    );

    return Object.freeze({
      protocolVersion: session.descriptor.protocolVersion,
      sessionId: session.descriptor.sessionId,
      sourceId: session.descriptor.sourceId,
      revisionId: snapshot.revisionId,
      snapshotId: snapshot.snapshotId,
      layers: snapshot.layers.length,
      rangeBytes,
      disposed: session.disposed,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source.dispose()),
    ]);
  }
}

export async function runServiceRenderSourceConformance(
  createSource,
  fixture,
) {
  if (typeof createSource !== "function") {
    throw new TypeError(
      "service RenderSource conformance requires a source factory",
    );
  }
  if (
    fixture === null ||
    typeof fixture !== "object" ||
    Array.isArray(fixture)
  ) {
    throw new TypeError(
      "service RenderSource conformance requires a pick fixture",
    );
  }

  const lifecycle = await runRenderSourceConformance(createSource);
  const source = await createSource();
  let session;
  try {
    session = await openRenderSource(source);
    const requiredCapabilities = [
      RenderCapability.PICK_RESOLVE,
      RenderCapability.CONTEXT_CREATE,
      RenderCapability.SOURCE_REVEAL,
    ];
    for (const capability of requiredCapabilities) {
      if (!session.descriptor.capabilities.includes(capability)) {
        throw new Error(
          `service RenderSource does not declare ${capability}`,
        );
      }
    }

    const snapshot = await session.getSnapshot();
    const layer = snapshot.layers.find(
      (candidate) => candidate.layerId === fixture.layerId,
    );
    if (!layer) {
      throw new Error(
        "service pick fixture layer is not in the render snapshot",
      );
    }
    const request = Object.freeze({
      protocolVersion: session.descriptor.protocolVersion,
      sessionId: session.descriptor.sessionId,
      sourceId: layer.sourceId,
      revisionId: snapshot.revisionId,
      snapshotId: snapshot.snapshotId,
      layerId: layer.layerId,
      renderId: fixture.renderId,
      pickId: fixture.pickId,
      worldPosition: fixture.worldPosition,
      worldBounds: fixture.worldBounds,
    });
    const identity = await session.resolvePick(request);
    const context = await session.createContext(identity);
    const reveal = await session.resolveSourceReveal(identity);

    await expectProtocolError(
      session.resolvePick({
        ...request,
        revisionId: "revision:stale-conformance",
      }),
      RenderProtocolDiagnosticCode.STALE_REVISION,
      "stale service pick",
    );

    await session.dispose();
    await session.dispose();
    await source.dispose();

    return Object.freeze({
      ...lifecycle,
      snapshotId: snapshot.snapshotId,
      layers: snapshot.layers.length,
      layerKinds: Object.freeze(
        snapshot.layers.map((candidate) => candidate.kind),
      ),
      renderId: identity.renderId,
      pickId: identity.pickId,
      hasExternalIdentity:
        identity.externalIdentityToken !== null,
      contextId: context.contextId,
      revealId: reveal.revealId,
      revealLabel: reveal.label,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source.dispose()),
    ]);
  }
}

export async function runServiceEventConformance(createHarness) {
  if (typeof createHarness !== "function") {
    throw new TypeError(
      "service event conformance requires a harness factory",
    );
  }
  const lifecycle = await runRenderSourceConformance(async () => {
    const harness = await createHarness();
    return harness?.source;
  });
  const harness = await createHarness();
  for (const method of [
    "publishRevision",
    "replayRevision",
    "publishDiagnostics",
  ]) {
    if (typeof harness?.[method] !== "function") {
      throw new TypeError(
        `service event harness must implement ${method}()`,
      );
    }
  }
  const source = harness.source;
  let session;
  let revisionSubscription;
  let diagnosticSubscription;
  try {
    session = await openRenderSource(source);
    for (const capability of [
      RenderCapability.REVISION_EVENTS,
      RenderCapability.DIAGNOSTICS,
    ]) {
      if (!session.descriptor.capabilities.includes(capability)) {
        throw new Error(
          `service event source does not declare ${capability}`,
        );
      }
    }
    const snapshot = await session.getSnapshot();
    const revisions = [];
    const diagnostics = [];
    const errors = [];
    revisionSubscription = await session.subscribeRevisionEvents(
      (event) => {
        revisions.push(event);
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );
    diagnosticSubscription = await session.subscribeDiagnostics(
      (batch) => {
        diagnostics.push(batch);
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );

    await harness.publishRevision({ sourceSession: session, snapshot });
    await harness.publishDiagnostics({
      sourceSession: session,
      snapshot,
    });
    await Promise.all([
      revisionSubscription.whenIdle(),
      diagnosticSubscription.whenIdle(),
    ]);
    if (revisions.length !== 1 || diagnostics.length !== 1) {
      throw new Error(
        "service event source did not publish one ordered revision and diagnostic batch",
      );
    }

    await harness.replayRevision({
      sourceSession: session,
      snapshot,
    });
    await revisionSubscription.whenIdle();
    if (
      revisions.length !== 1 ||
      errors.at(-1)?.code !==
        RenderProtocolDiagnosticCode.OUT_OF_ORDER
    ) {
      throw new Error(
        "service event source did not fail closed on a revision replay",
      );
    }

    return Object.freeze({
      ...lifecycle,
      revisionEvents: revisions.length,
      diagnosticBatches: diagnostics.length,
      diagnostics: diagnostics[0].diagnostics.length,
      replayRejected: true,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => revisionSubscription?.dispose()),
      Promise.resolve().then(() => diagnosticSubscription?.dispose()),
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source?.dispose()),
    ]);
  }
}

export async function runRenderDeltaConformance(createHarness) {
  if (typeof createHarness !== "function") {
    throw new TypeError(
      "render delta conformance requires a harness factory",
    );
  }
  const lifecycle = await runRenderSourceConformance(async () => {
    const harness = await createHarness();
    return harness?.source;
  });
  const harness = await createHarness();
  if (
    !harness ||
    !harness.source ||
    typeof harness.emitNext !== "function" ||
    typeof harness.emit !== "function"
  ) {
    throw new TypeError(
      "render delta harness requires source, emitNext(), and emit()",
    );
  }

  const source = harness.source;
  let session;
  let subscription;
  let controller;
  try {
    session = await openRenderSource(source);
    if (
      !session.descriptor.capabilities.includes(
        RenderCapability.RENDER_DELTA,
      )
    ) {
      throw new Error(
        "delta RenderSource does not declare render-delta",
      );
    }
    const snapshot = await session.getSnapshot();
    controller = new ViewerRenderDeltaController({
      sourceSession: session,
      snapshot,
    });
    const received = [];
    const errors = [];
    subscription = await session.subscribeRenderDeltas(
      (delta) => {
        const state = controller.applyCommitted(delta);
        received.push(delta);
        return state;
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );

    await harness.emitNext();
    await subscription.whenIdle();
    if (received.length !== 1 || errors.length !== 0) {
      throw new Error(
        "first render delta was not applied atomically",
      );
    }
    const first = received[0];
    if (
      !first.operations.some(
        (operation) =>
          operation.kind === RenderDeltaOperationKind.UPSERT,
      )
    ) {
      throw new Error(
        "first render delta fixture must include an upsert",
      );
    }
    const firstState = controller.snapshot();
    if (
      session.revisionId !== first.toRevisionId ||
      firstState.revisionId !== first.toRevisionId
    ) {
      throw new Error(
        "render delta did not advance source and overlay together",
      );
    }

    await harness.emit(first);
    await subscription.whenIdle();
    if (
      errors.at(-1)?.code !==
        RenderProtocolDiagnosticCode.STALE_REVISION ||
      session.revisionId !== first.toRevisionId ||
      controller.revisionId !== first.toRevisionId
    ) {
      throw new Error(
        "replayed render delta did not fail closed",
      );
    }

    await harness.emitNext();
    await subscription.whenIdle();
    if (received.length !== 2) {
      throw new Error(
        "ordered render delta did not recover after stale input",
      );
    }
    const second = received[1];
    if (
      !second.operations.some(
        (operation) =>
          operation.kind === RenderDeltaOperationKind.TOMBSTONE,
      )
    ) {
      throw new Error(
        "second render delta fixture must include a tombstone",
      );
    }
    if (
      session.revisionId !== second.toRevisionId ||
      controller.revisionId !== second.toRevisionId
    ) {
      throw new Error(
        "second render delta did not advance atomically",
      );
    }

    await subscription.dispose();
    controller.dispose();
    await session.dispose();
    await source.dispose();

    return Object.freeze({
      ...lifecycle,
      baseSnapshotId: snapshot.snapshotId,
      revisionId: second.toRevisionId,
      deltaCount: received.length,
      staleRejected: true,
      operations: received.reduce(
        (total, delta) => total + delta.operations.length,
        0,
      ),
      disposed: session.disposed,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => subscription?.dispose()),
      Promise.resolve().then(() => controller?.dispose()),
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source.dispose()),
    ]);
  }
}

function assertNoStagedResources(adapter, label) {
  const resources = adapter.snapshot().resources;
  if (
    resources.stagedRanges !== 0 ||
    resources.stagedWorkers !== 0 ||
    resources.stagedCpuBytes !== 0 ||
    resources.stagedGpuBytes !== 0
  ) {
    throw new Error(`${label} retained staged resources`);
  }
}

function assertNoRetainedResources(adapter, label) {
  assertNoStagedResources(adapter, label);
  if (adapter.snapshot().resources.activeGpuBytes !== 0) {
    throw new Error(`${label} retained active GPU resources`);
  }
}

export async function runStagedRenderDeltaConformance(createHarness) {
  if (typeof createHarness !== "function") {
    throw new TypeError(
      "staged render delta conformance requires a harness factory",
    );
  }
  const lifecycle = await runRenderSourceConformance(async () => {
    const harness = await createHarness();
    return harness?.source;
  });
  const harness = await createHarness();
  if (
    !harness ||
    !harness.source ||
    typeof harness.emitNext !== "function" ||
    typeof harness.emit !== "function"
  ) {
    throw new TypeError(
      "staged render delta harness requires source, emitNext(), and emit()",
    );
  }

  const source = harness.source;
  let session;
  let subscription;
  let controller;
  const auxiliaryControllers = [];
  try {
    session = await openRenderSource(source);
    const snapshot = await session.getSnapshot();
    const adapter = new MockStagedRenderDeltaAdapter({
      revisionId: snapshot.revisionId,
      holdPrepare: true,
    });
    controller = new ViewerRenderDeltaController({
      sourceSession: session,
      snapshot,
      adapter,
    });
    const received = [];
    const errors = [];
    subscription = await session.subscribeRenderDeltas(
      async (delta) => {
        const state = await controller.applyCommittedAsync(delta);
        received.push(delta);
        return state;
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );

    const firstDelivery = harness.emitNext();
    await adapter.prepareStarted;
    if (
      controller.revisionId !== snapshot.revisionId ||
      session.revisionId !== snapshot.revisionId ||
      adapter.snapshot().revisionId !== snapshot.revisionId ||
      adapter.snapshot().geometryRevisionId !== snapshot.revisionId ||
      adapter.snapshot().pickRevisionId !== snapshot.revisionId
    ) {
      throw new Error(
        "asynchronous prepare changed the current scene before commit",
      );
    }
    if (
      adapter.snapshot().resources.stagedWorkers !== 1 ||
      adapter.snapshot().resources.stagedCpuBytes <= 0 ||
      adapter.snapshot().resources.stagedGpuBytes <= 0
    ) {
      throw new Error(
        "staged conformance did not allocate bounded mock resources",
      );
    }
    adapter.releasePrepare();
    const first = await firstDelivery;
    await subscription.whenIdle();
    const committed = adapter.snapshot();
    if (
      !first ||
      received.length !== 1 ||
      errors.length !== 0 ||
      controller.revisionId !== first.toRevisionId ||
      session.revisionId !== first.toRevisionId ||
      committed.revisionId !== first.toRevisionId ||
      committed.geometryRevisionId !== first.toRevisionId ||
      committed.pickRevisionId !== first.toRevisionId ||
      committed.identities.length === 0
    ) {
      throw new Error(
        "staged geometry and pick identity did not commit atomically",
      );
    }
    assertNoStagedResources(adapter, "successful commit");

    const prepareCount = committed.metrics.prepares;
    await harness.emit(first);
    await subscription.whenIdle();
    if (
      errors.at(-1)?.code !==
        RenderProtocolDiagnosticCode.STALE_REVISION ||
      adapter.snapshot().metrics.prepares !== prepareCount ||
      controller.revisionId !== first.toRevisionId
    ) {
      throw new Error(
        "stale staged delta reached prepare or changed the current scene",
      );
    }

    const second = await harness.emitNext();
    await subscription.whenIdle();
    if (
      !second ||
      received.length !== 2 ||
      controller.revisionId !== second.toRevisionId ||
      adapter.snapshot().pickRevisionId !== second.toRevisionId
    ) {
      throw new Error("ordered staged delta did not recover after stale input");
    }

    const commitFailureAdapter = new MockStagedRenderDeltaAdapter({
      revisionId: snapshot.revisionId,
      expectedPayloadSha256: first.payload?.sha256 ?? null,
      failCommit: true,
    });
    const commitFailureController = new ViewerRenderDeltaController({
      sourceSession: { descriptor: session.descriptor },
      snapshot,
      adapter: commitFailureAdapter,
    });
    auxiliaryControllers.push(commitFailureController);
    try {
      await commitFailureController.applyCommittedAsync(first);
      throw new Error("staged commit failure did not reject");
    } catch (error) {
      if (!/atomic commit failed/u.test(error.message)) {
        throw error;
      }
    }
    if (
      commitFailureController.revisionId !== snapshot.revisionId ||
      commitFailureAdapter.snapshot().metrics.rollbacks !== 1 ||
      commitFailureAdapter.snapshot().metrics.transactionDisposals !== 1
    ) {
      throw new Error("staged commit failure did not roll back atomically");
    }
    assertNoStagedResources(commitFailureAdapter, "commit failure");

    const prepareFailureAdapter = new MockStagedRenderDeltaAdapter({
      revisionId: snapshot.revisionId,
      failPrepare: true,
    });
    const prepareFailureController = new ViewerRenderDeltaController({
      sourceSession: { descriptor: session.descriptor },
      snapshot,
      adapter: prepareFailureAdapter,
    });
    auxiliaryControllers.push(prepareFailureController);
    try {
      await prepareFailureController.applyCommittedAsync(first);
      throw new Error("staged prepare failure did not reject");
    } catch (error) {
      if (!/geometry preparation failed/u.test(error.message)) {
        throw error;
      }
    }
    if (
      prepareFailureController.revisionId !== snapshot.revisionId ||
      prepareFailureAdapter.snapshot().metrics.prepares !== 1 ||
      prepareFailureAdapter.snapshot().metrics.commits !== 0
    ) {
      throw new Error("staged prepare failure changed the current scene");
    }
    assertNoStagedResources(prepareFailureAdapter, "prepare failure");

    const digest = first.payload?.sha256;
    if (!digest) {
      throw new Error(
        "first staged conformance delta requires an opaque payload",
      );
    }
    const mismatchAdapter = new MockStagedRenderDeltaAdapter({
      revisionId: snapshot.revisionId,
      expectedPayloadSha256:
        `${digest[0] === "f" ? "e" : "f"}${digest.slice(1)}`,
    });
    const mismatchController = new ViewerRenderDeltaController({
      sourceSession: { descriptor: session.descriptor },
      snapshot,
      adapter: mismatchAdapter,
    });
    auxiliaryControllers.push(mismatchController);
    try {
      await mismatchController.applyCommittedAsync(first);
      throw new Error("staged payload digest mismatch did not reject");
    } catch (error) {
      if (!/digest mismatch/u.test(error.message)) {
        throw error;
      }
    }
    if (mismatchController.revisionId !== snapshot.revisionId) {
      throw new Error("digest mismatch changed the current revision");
    }
    assertNoStagedResources(mismatchAdapter, "digest mismatch");

    const cancellationAdapter = new MockStagedRenderDeltaAdapter({
      revisionId: snapshot.revisionId,
      holdPrepare: true,
      ignoreAbortDuringPrepare: true,
    });
    const cancellationController = new ViewerRenderDeltaController({
      sourceSession: { descriptor: session.descriptor },
      snapshot,
      adapter: cancellationAdapter,
    });
    auxiliaryControllers.push(cancellationController);
    const abortController = new AbortController();
    const cancelled = cancellationController.applyCommittedAsync(first, {
      signal: abortController.signal,
    });
    await cancellationAdapter.prepareStarted;
    abortController.abort(
      new DOMException("staged conformance cancellation", "AbortError"),
    );
    cancellationAdapter.releasePrepare();
    try {
      await cancelled;
      throw new Error("staged cancellation did not reject");
    } catch (error) {
      if (error.name !== "AbortError") {
        throw error;
      }
    }
    if (
      cancellationController.revisionId !== snapshot.revisionId ||
      cancellationAdapter.snapshot().metrics.commits !== 0 ||
      cancellationAdapter.snapshot().metrics.rollbacks !== 1 ||
      cancellationAdapter.snapshot().metrics.transactionDisposals !== 1
    ) {
      throw new Error("staged cancellation did not fail closed");
    }
    assertNoStagedResources(cancellationAdapter, "cancellation");

    await subscription.dispose();
    await controller.disposeAsync();
    await Promise.all(
      auxiliaryControllers.map((candidate) => candidate.disposeAsync()),
    );
    assertNoRetainedResources(adapter, "terminal disposal");
    assertNoRetainedResources(
      commitFailureAdapter,
      "commit-failure disposal",
    );
    assertNoRetainedResources(
      prepareFailureAdapter,
      "prepare-failure disposal",
    );
    assertNoRetainedResources(
      mismatchAdapter,
      "digest-mismatch disposal",
    );
    assertNoRetainedResources(
      cancellationAdapter,
      "cancellation disposal",
    );
    await session.dispose();
    await source.dispose();

    return Object.freeze({
      ...lifecycle,
      baseSnapshotId: snapshot.snapshotId,
      representation:
        snapshot.layers.find(
          (layer) => layer.kind === "live",
        )?.representation ?? null,
      revisionId: second.toRevisionId,
      deltaCount: received.length,
      asynchronousPreparePreservedCurrentScene: true,
      atomicGeometryPickCommit: true,
      staleRejectedBeforePrepare: true,
      prepareFailureReleasedResources: true,
      commitFailureRolledBack: true,
      digestMismatchRejected: true,
      cancellationReleasedResources: true,
      disposed: session.disposed,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => subscription?.dispose()),
      Promise.resolve().then(() => controller?.disposeAsync()),
      ...auxiliaryControllers.map((candidate) =>
        Promise.resolve().then(() => candidate.disposeAsync()),
      ),
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source.dispose()),
    ]);
  }
}
