import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderCapability,
  RenderDeltaAspect,
  RenderDeltaOperationKind,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  RenderProtocolVersion,
  RenderRevisionEventStatus,
  ViewerDiagnosticSeverity,
  ViewerLayerKind,
  ViewerRepresentation,
  negotiateRenderProtocolVersion,
  parseContextReferenceDescriptor,
  parsePickResolveRequest,
  parseRangeHandleDescriptor,
  parseRenderDiagnosticBatchDescriptor,
  parseRenderDeltaDescriptor,
  parseRenderDeltaPayloadDescriptor,
  parseRenderIdentityDescriptor,
  parseRenderRevisionEventDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
  parseSourceRevealDescriptor,
} from "../src/index.mjs";

const revisionOne =
  "revision:sha256:1111111111111111111111111111111111111111111111111111111111111111";
const revisionTwo =
  "revision:sha256:2222222222222222222222222222222222222222222222222222222222222222";

function sessionInput(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:test",
    sourceId: "source:test",
    currentRevisionId: revisionOne,
    lastSuccessfulRevisionId: revisionOne,
    capabilities: [
      RenderCapability.RENDER_SNAPSHOT,
      RenderCapability.LAYER_MANIFEST,
      RenderCapability.RANGE_READ,
    ],
    resourceBudgetBytes: 1024,
    ...overrides,
  };
}

function rangeHandle(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    handleId: "range:base",
    sessionId: "session:test",
    sourceId: "source:base",
    revisionId: revisionOne,
    layerId: "layer:base",
    mediaType: "application/vnd.dwg-viewer.scene-cache",
    byteLength: 8,
    maximumRequestBytes: 4,
    remainingReadBytes: 8,
    sha256: "a".repeat(64),
    expiresAt: null,
    disposeWithSession: true,
    ...overrides,
  };
}

function snapshotInput(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:test",
    sourceId: "source:test",
    revisionId: revisionOne,
    snapshotId: "snapshot:test",
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
        rangeHandle: rangeHandle(),
      },
    ],
    ...overrides,
  };
}

function pickRequest(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:test",
    sourceId: "source:base",
    revisionId: revisionOne,
    snapshotId: "snapshot:test",
    layerId: "layer:base",
    renderId: "render:entity:42",
    pickId: "pick:entity:42",
    worldPosition: [10, 20, 0],
    worldBounds: {
      min: [9, 19, 0],
      max: [11, 21, 0],
    },
    ...overrides,
  };
}

function renderIdentity(overrides = {}) {
  return {
    ...pickRequest(),
    externalIdentityToken: "external:entity:42",
    ...overrides,
  };
}

function contextReference(overrides = {}) {
  const {
    worldPosition: _worldPosition,
    worldBounds: _worldBounds,
    ...identity
  } = renderIdentity();
  return {
    ...identity,
    contextId: "context:entity:42",
    expiresAt: null,
    disposeWithSession: true,
    ...overrides,
  };
}

function sourceReveal(overrides = {}) {
  const {
    worldPosition: _worldPosition,
    worldBounds: _worldBounds,
    ...identity
  } = renderIdentity();
  return {
    ...identity,
    revealId: "reveal:entity:42",
    label: "원본에서 보기",
    expiresAt: null,
    disposeWithSession: true,
    ...overrides,
  };
}

function deltaOperation(overrides = {}) {
  return {
    operationId: "operation:geometry:42",
    kind: RenderDeltaOperationKind.UPSERT,
    aspect: RenderDeltaAspect.GEOMETRY,
    layerId: "layer:base",
    sourceId: "source:base",
    renderIds: ["render:entity:42"],
    affectedWorldBounds: {
      min: [9, 19, 0],
      max: [12, 22, 1],
    },
    dependencyIds: [],
    externalIdentityToken: "external:entity:42",
    ...overrides,
  };
}

function deltaPayload(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    payloadId: "payload:delta:1",
    sessionId: "session:test",
    sourceId: "source:test",
    fromRevisionId: revisionOne,
    toRevisionId: revisionTwo,
    mediaType: "application/vnd.menaje.viewer.render-delta",
    byteLength: 256,
    sha256: "d".repeat(64),
    expiresAt: null,
    disposeWithSession: true,
    ...overrides,
  };
}

function renderDelta(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    deltaId: "delta:test:1",
    sessionId: "session:test",
    sourceId: "source:test",
    baseSnapshotId: "snapshot:test",
    fromRevisionId: revisionOne,
    toRevisionId: revisionTwo,
    sequence: 1,
    operations: [deltaOperation()],
    affectedWorldBounds: {
      min: [9, 19, 0],
      max: [12, 22, 1],
    },
    payload: deltaPayload(),
    ...overrides,
  };
}

function revisionEvent(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    eventId: "revision-event:test:1",
    sessionId: "session:test",
    sourceId: "source:test",
    revisionId: revisionOne,
    lastSuccessfulRevisionId: revisionOne,
    snapshotId: "snapshot:test",
    sequence: 1,
    status: RenderRevisionEventStatus.AVAILABLE,
    ...overrides,
  };
}

function diagnosticBatch(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    batchId: "diagnostics:test:1",
    sessionId: "session:test",
    sourceId: "source:test",
    revisionId: revisionOne,
    lastSuccessfulRevisionId: revisionOne,
    snapshotId: "snapshot:test",
    sequence: 1,
    diagnostics: [
      {
        diagnosticId: "diagnostic:test:1",
        severity: ViewerDiagnosticSeverity.WARNING,
        code: "RENDER_PARTIAL",
        message: "One bounded render item was skipped.",
        layerId: "layer:base",
        renderId: "render:entity:42",
        worldBounds: {
          min: [9, 19, 0],
          max: [11, 21, 0],
        },
      },
    ],
    ...overrides,
  };
}

test("negotiates the highest exact common semantic version", () => {
  assert.equal(
    negotiateRenderProtocolVersion(
      ["0.1.0", "0.2.0"],
      ["0.3.0", "0.2.0", "0.1.0"],
    ),
    "0.2.0",
  );
});

test("fails closed when no render protocol version overlaps", () => {
  assert.throws(
    () =>
      negotiateRenderProtocolVersion(
        ["0.1.0"],
        ["1.0.0"],
      ),
    (error) =>
      error instanceof RenderProtocolError &&
      error.code ===
        RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
  );
});

test("normalizes a bounded render session and requires base capabilities", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  assert.deepEqual(session.capabilities, [
    RenderCapability.LAYER_MANIFEST,
    RenderCapability.RANGE_READ,
    RenderCapability.RENDER_SNAPSHOT,
  ]);
  assert(Object.isFrozen(session));
  assert(Object.isFrozen(session.capabilities));

  assert.throws(
    () =>
      parseRenderSessionDescriptor(
        sessionInput({
          capabilities: [
            RenderCapability.RENDER_SNAPSHOT,
            RenderCapability.DIAGNOSTICS,
          ],
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
  );
});

test("rejects private Host fields and path-shaped public identity", () => {
  assert.throws(
    () =>
      parseRenderSessionDescriptor({
        ...sessionInput(),
        cacheId: "private-host-cache",
      }),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderSessionDescriptor(
        sessionInput({ sourceId: "file:///tmp/drawing.dwg" }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

test("binds snapshot layers and range handles to one session revision", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });
  assert.equal(snapshot.layers[0].rangeHandle.layerId, "layer:base");
  assert.equal(snapshot.layers[0].rangeHandle.revisionId, revisionOne);

  assert.throws(
    () =>
      parseRenderSnapshotDescriptor(
        snapshotInput({ revisionId: revisionTwo }),
        { session },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  assert.throws(
    () =>
      parseRenderSnapshotDescriptor(
        snapshotInput({
          layers: [
            {
              ...snapshotInput().layers[0],
              rangeHandle: rangeHandle({
                revisionId: revisionTwo,
              }),
            },
          ],
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
});

test("accepts source-neutral 2D, 3D, and semantic layer representations", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  const snapshot = parseRenderSnapshotDescriptor(
    snapshotInput({
      layers: [
        snapshotInput().layers[0],
        {
          layerId: "layer:three-dimensional",
          sourceId: "source:three-dimensional",
          revisionId: revisionOne,
          kind: ViewerLayerKind.LIVE,
          representation: ViewerRepresentation.THREE_DIMENSIONAL,
          order: 1,
          visible: true,
        },
        {
          layerId: "layer:semantic",
          sourceId: "source:semantic",
          revisionId: revisionOne,
          kind: ViewerLayerKind.DIAGNOSTIC,
          representation: ViewerRepresentation.SEMANTIC,
          order: 2,
          visible: true,
        },
      ],
    }),
    { session },
  );

  assert.deepEqual(
    snapshot.layers.map(({ representation }) => representation),
    ["2d", "3d", "semantic"],
  );
});

test("binds ordered revision events and preserves the last successful snapshot", () => {
  const session = parseRenderSessionDescriptor(
    sessionInput({
      capabilities: [
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.RENDER_SNAPSHOT,
        RenderCapability.REVISION_EVENTS,
      ],
    }),
  );
  const available = parseRenderRevisionEventDescriptor(
    revisionEvent(),
    { session, expectedSequence: 1 },
  );
  const failed = parseRenderRevisionEventDescriptor(
    revisionEvent({
      eventId: "revision-event:test:2",
      revisionId: revisionTwo,
      snapshotId: null,
      sequence: 2,
      status: RenderRevisionEventStatus.FAILED,
    }),
    { session, expectedSequence: 2 },
  );

  assert.equal(available.snapshotId, "snapshot:test");
  assert.equal(failed.lastSuccessfulRevisionId, revisionOne);
  assert.equal(failed.snapshotId, null);
  assert(Object.isFrozen(failed));

  assert.throws(
    () =>
      parseRenderRevisionEventDescriptor(
        revisionEvent({ sequence: 3 }),
        { session, expectedSequence: 2 },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.OUT_OF_ORDER,
  );
  assert.throws(
    () =>
      parseRenderRevisionEventDescriptor(
        revisionEvent({
          status: RenderRevisionEventStatus.FAILED,
        }),
        { session },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

test("normalizes bounded diagnostic batches and rejects ambiguous scope", () => {
  const session = parseRenderSessionDescriptor(
    sessionInput({
      capabilities: [
        RenderCapability.DIAGNOSTICS,
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.RENDER_SNAPSHOT,
      ],
    }),
  );
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });
  const batch = parseRenderDiagnosticBatchDescriptor(
    diagnosticBatch(),
    { session, snapshot, expectedSequence: 1 },
  );

  assert.equal(batch.diagnostics[0].severity, "warning");
  assert(Object.isFrozen(batch));
  assert(Object.isFrozen(batch.diagnostics));
  assert(Object.isFrozen(batch.diagnostics[0].worldBounds));

  assert.throws(
    () =>
      parseRenderDiagnosticBatchDescriptor(
        diagnosticBatch({
          diagnostics: [
            diagnosticBatch().diagnostics[0],
            diagnosticBatch().diagnostics[0],
          ],
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderDiagnosticBatchDescriptor(
        diagnosticBatch({
          diagnostics: [
            {
              ...diagnosticBatch().diagnostics[0],
              layerId: null,
            },
          ],
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderDiagnosticBatchDescriptor(
        diagnosticBatch({
          diagnostics: [
            {
              ...diagnosticBatch().diagnostics[0],
              layerId: "layer:missing",
            },
          ],
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
  );
});

test("requires range expiration or session disposal and bounded budgets", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  assert.throws(
    () =>
      parseRangeHandleDescriptor(
        rangeHandle({
          expiresAt: null,
          disposeWithSession: false,
        }),
        { session },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRangeHandleDescriptor(
        rangeHandle({ maximumRequestBytes: 2048 }),
        { session },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

test("binds pick and external identity to one snapshot layer revision", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });
  const request = parsePickResolveRequest(pickRequest(), {
    session,
    snapshot,
  });
  const identity = parseRenderIdentityDescriptor(renderIdentity(), {
    session,
    snapshot,
    request,
  });

  assert.equal(identity.externalIdentityToken, "external:entity:42");
  assert.deepEqual(identity.worldPosition, [10, 20, 0]);
  assert.deepEqual(identity.worldBounds, {
    min: [9, 19, 0],
    max: [11, 21, 0],
  });
  assert(Object.isFrozen(identity));
  assert(Object.isFrozen(identity.worldBounds));
  assert(Object.isFrozen(identity.worldBounds.min));
});

test("rejects stale, cross-layer, and path-shaped identity values", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });

  assert.throws(
    () =>
      parsePickResolveRequest(
        pickRequest({ revisionId: revisionTwo }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  assert.throws(
    () =>
      parsePickResolveRequest(
        pickRequest({ layerId: "layer:missing" }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
  );
  assert.throws(
    () =>
      parseRenderIdentityDescriptor(
        renderIdentity({
          externalIdentityToken: "file:///tmp/identity.json",
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderIdentityDescriptor(
        renderIdentity({ pickId: "pick:other" }),
        {
          session,
          snapshot,
          request: pickRequest(),
        },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
  );
});

test("keeps context and source reveal references opaque and disposable", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });
  const identity = parseRenderIdentityDescriptor(renderIdentity(), {
    session,
    snapshot,
  });
  const context = parseContextReferenceDescriptor(contextReference(), {
    session,
    snapshot,
    identity,
  });
  const reveal = parseSourceRevealDescriptor(sourceReveal(), {
    session,
    snapshot,
    identity,
  });

  assert.equal(context.contextId, "context:entity:42");
  assert.equal(reveal.revealId, "reveal:entity:42");
  assert.equal(reveal.label, "원본에서 보기");

  assert.throws(
    () =>
      parseContextReferenceDescriptor(
        contextReference({
          expiresAt: null,
          disposeWithSession: false,
        }),
        { session, snapshot, identity },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseSourceRevealDescriptor(
        sourceReveal({ externalIdentityToken: "external:other" }),
        { session, snapshot, identity },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
  );
});

test("normalizes atomic tombstone and bounded upsert delta operations", () => {
  const session = parseRenderSessionDescriptor(
    sessionInput({
      capabilities: [
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.RENDER_DELTA,
        RenderCapability.RENDER_SNAPSHOT,
      ],
    }),
  );
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });
  const delta = parseRenderDeltaDescriptor(
    renderDelta({
      operations: [
        deltaOperation(),
        deltaOperation({
          operationId: "operation:style:43",
          aspect: RenderDeltaAspect.STYLE,
          renderIds: ["render:entity:43"],
          externalIdentityToken: null,
        }),
      ],
    }),
    {
      session,
      snapshot,
      expectedRevisionId: revisionOne,
      expectedSequence: 1,
    },
  );

  assert.equal(delta.fromRevisionId, revisionOne);
  assert.equal(delta.toRevisionId, revisionTwo);
  assert.equal(delta.operations.length, 2);
  assert.equal(delta.payload.byteLength, 256);
  assert(Object.isFrozen(delta));
  assert(Object.isFrozen(delta.operations));

  const tombstone = parseRenderDeltaDescriptor(
    renderDelta({
      deltaId: "delta:test:tombstone",
      operations: [
        deltaOperation({
          operationId: "operation:tombstone:42",
          kind: RenderDeltaOperationKind.TOMBSTONE,
          aspect: RenderDeltaAspect.ENTITY,
          externalIdentityToken: null,
        }),
      ],
      payload: null,
    }),
    { session, snapshot },
  );
  assert.equal(
    tombstone.operations[0].kind,
    RenderDeltaOperationKind.TOMBSTONE,
  );
});

test("carries retained 3D ranges and visibility through the existing opaque delta envelope", () => {
  const session = parseRenderSessionDescriptor(
    sessionInput({
      capabilities: [
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.RENDER_DELTA,
        RenderCapability.RENDER_SNAPSHOT,
      ],
    }),
  );
  const {
    rangeHandle: _rangeHandle,
    ...baseLayer
  } = snapshotInput().layers[0];
  const threeDimensionalLayer = {
    ...baseLayer,
    representation: ViewerRepresentation.THREE_DIMENSIONAL,
  };
  const snapshot = parseRenderSnapshotDescriptor(
    snapshotInput({ layers: [threeDimensionalLayer] }),
    { session },
  );
  const operations = [
    deltaOperation({
      operationId: "operation:3d:geometry",
      renderIds: ["render:3d:geometry"],
    }),
    deltaOperation({
      operationId: "operation:3d:transform",
      aspect: RenderDeltaAspect.TRANSFORM,
      renderIds: ["render:3d:transform"],
    }),
    // Visibility is renderer packet state under the source-neutral STYLE
    // aspect; no format-specific visibility field is added to the wire shape.
    deltaOperation({
      operationId: "operation:3d:style-visibility",
      aspect: RenderDeltaAspect.STYLE,
      renderIds: ["render:3d:style-visibility"],
    }),
    deltaOperation({
      operationId: "operation:3d:identity",
      aspect: RenderDeltaAspect.IDENTITY,
      renderIds: ["render:3d:identity"],
    }),
    deltaOperation({
      operationId: "operation:3d:dependency",
      aspect: RenderDeltaAspect.DEPENDENCY,
      renderIds: ["render:3d:dependency"],
      dependencyIds: ["mesh:shared"],
    }),
    deltaOperation({
      operationId: "operation:3d:tombstone",
      kind: RenderDeltaOperationKind.TOMBSTONE,
      aspect: RenderDeltaAspect.ENTITY,
      renderIds: ["render:3d:tombstone"],
      externalIdentityToken: null,
    }),
  ];
  const parsed = parseRenderDeltaDescriptor(
    renderDelta({
      operations,
      payload: deltaPayload({
        mediaType: "application/vnd.example.retained-3d-delta",
      }),
    }),
    { session, snapshot },
  );

  assert.equal(
    parsed.payload.mediaType,
    "application/vnd.example.retained-3d-delta",
  );
  assert.deepEqual(
    parsed.operations.map((operation) => operation.aspect),
    [
      RenderDeltaAspect.GEOMETRY,
      RenderDeltaAspect.TRANSFORM,
      RenderDeltaAspect.STYLE,
      RenderDeltaAspect.IDENTITY,
      RenderDeltaAspect.DEPENDENCY,
      RenderDeltaAspect.ENTITY,
    ],
  );

  assert.throws(
    () =>
      parseRenderDeltaDescriptor(
        {
          ...renderDelta({ operations }),
          geometryRanges: [{ byteOffset: 0, byteLength: 256 }],
        },
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderDeltaDescriptor(
        renderDelta({
          operations: [
            {
              ...operations[0],
              primitive: "mesh",
            },
          ],
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

test("rejects stale, out-of-order, duplicate, and unbounded render deltas", () => {
  const session = parseRenderSessionDescriptor(
    sessionInput({
      capabilities: [
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.RENDER_DELTA,
        RenderCapability.RENDER_SNAPSHOT,
      ],
    }),
  );
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });

  assert.throws(
    () =>
      parseRenderDeltaDescriptor(renderDelta(), {
        session,
        snapshot,
        expectedRevisionId: revisionTwo,
        expectedSequence: 1,
      }),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  assert.throws(
    () =>
      parseRenderDeltaDescriptor(
        renderDelta({ sequence: 2 }),
        {
          session,
          snapshot,
          expectedRevisionId: revisionOne,
          expectedSequence: 1,
        },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.OUT_OF_ORDER,
  );
  assert.throws(
    () =>
      parseRenderDeltaDescriptor(
        renderDelta({
          operations: [
            deltaOperation(),
            deltaOperation({
              operationId: "operation:duplicate:42",
              aspect: RenderDeltaAspect.TRANSFORM,
            }),
          ],
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderDeltaDescriptor(
        renderDelta({
          affectedWorldBounds: {
            min: [10, 20, 0],
            max: [11, 21, 0],
          },
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderDeltaDescriptor(
        renderDelta({
          operations: [
            deltaOperation({
              renderIds: Array.from(
                { length: 4097 },
                (_, index) => `render:bounded:${index}`,
              ),
            }),
          ],
        }),
        { session, snapshot },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

test("binds delta payloads to session revisions without exposing paths", () => {
  const session = parseRenderSessionDescriptor(
    sessionInput({ resourceBudgetBytes: 512 }),
  );
  const payload = parseRenderDeltaPayloadDescriptor(deltaPayload(), {
    session,
    sourceId: "source:test",
    fromRevisionId: revisionOne,
    toRevisionId: revisionTwo,
  });
  assert.equal(payload.payloadId, "payload:delta:1");

  assert.throws(
    () =>
      parseRenderDeltaPayloadDescriptor(
        deltaPayload({ payloadId: "/tmp/render-delta.bin" }),
        {
          session,
          sourceId: "source:test",
          fromRevisionId: revisionOne,
          toRevisionId: revisionTwo,
        },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderDeltaPayloadDescriptor(
        deltaPayload({ byteLength: 1024 }),
        {
          session,
          sourceId: "source:test",
          fromRevisionId: revisionOne,
          toRevisionId: revisionTwo,
        },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

test("allows pick identity to follow an applied delta over its base snapshot", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });
  const request = parsePickResolveRequest(
    pickRequest({ revisionId: revisionTwo }),
    {
      session,
      snapshot,
      expectedRevisionId: revisionTwo,
    },
  );
  const identity = parseRenderIdentityDescriptor(
    renderIdentity({ revisionId: revisionTwo }),
    {
      session,
      snapshot,
      request,
      expectedRevisionId: revisionTwo,
    },
  );

  assert.equal(request.revisionId, revisionTwo);
  assert.equal(identity.revisionId, revisionTwo);
});
