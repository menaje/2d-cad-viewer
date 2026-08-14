import {
  RenderCapability,
  RenderDeltaAspect,
  RenderDeltaOperationKind,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  RenderProtocolVersion,
  SupportedRenderProtocolVersions,
  ViewerLayerKind,
  ViewerRepresentation,
  parsePickResolveRequest,
  parseRenderDeltaDescriptor,
  parseRenderIdentityDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
} from "@menaje/viewer-render-protocol";

function throwIfAborted(signal) {
  signal?.throwIfAborted?.();
  if (signal?.aborted) {
    const error = new Error("operation aborted");
    error.name = "AbortError";
    throw signal.reason ?? error;
  }
}

function sourceDisposed() {
  return new RenderProtocolError(
    RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
    "mock delta RenderSource is disposed",
  );
}

function bounds() {
  return {
    min: [9, 19, 0],
    max: [12, 22, 1],
  };
}

function operation({
  operationId,
  kind,
  aspect,
  externalIdentityToken,
}) {
  return {
    operationId,
    kind,
    aspect,
    layerId: "layer:delta-live",
    sourceId: "source:delta-live",
    renderIds: ["render:delta:42"],
    affectedWorldBounds: bounds(),
    dependencyIds: [],
    externalIdentityToken,
  };
}

function defaultDeltas(protocolVersion) {
  return [
    {
      protocolVersion,
      deltaId: "delta:mock:1",
      sessionId: "session:delta-mock",
      sourceId: "source:delta-mock",
      baseSnapshotId: "snapshot:delta-mock:base",
      fromRevisionId: "revision:delta-mock:1",
      toRevisionId: "revision:delta-mock:2",
      sequence: 1,
      operations: [
        operation({
          operationId: "operation:delta-mock:upsert",
          kind: RenderDeltaOperationKind.UPSERT,
          aspect: RenderDeltaAspect.GEOMETRY,
          externalIdentityToken: "external:delta-mock:42",
        }),
      ],
      affectedWorldBounds: bounds(),
      payload: {
        protocolVersion,
        payloadId: "payload:delta-mock:1",
        sessionId: "session:delta-mock",
        sourceId: "source:delta-mock",
        fromRevisionId: "revision:delta-mock:1",
        toRevisionId: "revision:delta-mock:2",
        mediaType: "application/vnd.dwg-viewer.mock-render-delta",
        byteLength: 128,
        sha256: "c".repeat(64),
        expiresAt: null,
        disposeWithSession: true,
      },
    },
    {
      protocolVersion,
      deltaId: "delta:mock:2",
      sessionId: "session:delta-mock",
      sourceId: "source:delta-mock",
      baseSnapshotId: "snapshot:delta-mock:base",
      fromRevisionId: "revision:delta-mock:2",
      toRevisionId: "revision:delta-mock:3",
      sequence: 2,
      operations: [
        operation({
          operationId: "operation:delta-mock:tombstone",
          kind: RenderDeltaOperationKind.TOMBSTONE,
          aspect: RenderDeltaAspect.ENTITY,
          externalIdentityToken: null,
        }),
      ],
      affectedWorldBounds: bounds(),
      payload: null,
    },
  ];
}

class MockRenderDeltaSession {
  #snapshot;
  #deltas;
  #listener;
  #cursor = 0;
  #revisionId = "revision:delta-mock:1";
  #disposed = false;

  constructor({ descriptor, snapshot, deltas }) {
    this.descriptor = descriptor;
    this.#snapshot = snapshot;
    this.#deltas = deltas;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw sourceDisposed();
    }
  }

  async getSnapshot({ signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    return this.#snapshot;
  }

  async subscribeRenderDeltas(listener, { signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    if (this.#listener) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.OUT_OF_ORDER,
        "mock delta source already has a subscriber",
      );
    }
    if (typeof listener !== "function") {
      throw new TypeError("mock delta listener must be a function");
    }
    this.#listener = listener;
    let closed = false;
    return {
      dispose: () => {
        if (closed) {
          return false;
        }
        closed = true;
        if (this.#listener === listener) {
          this.#listener = undefined;
        }
        return true;
      },
    };
  }

  async resolvePick(request, { signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    const parsed = parsePickResolveRequest(request, {
      session: this.descriptor,
      snapshot: this.#snapshot,
      expectedRevisionId: this.#revisionId,
    });
    if (
      this.#cursor !== 1 ||
      parsed.layerId !== "layer:delta-live" ||
      parsed.renderId !== "render:delta:42" ||
      parsed.pickId !== "pick:delta:42"
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
        "pick does not identify the active mock delta entity",
      );
    }
    return parseRenderIdentityDescriptor(
      {
        ...parsed,
        externalIdentityToken: "external:delta-mock:42",
      },
      {
        session: this.descriptor,
        snapshot: this.#snapshot,
        request: parsed,
        expectedRevisionId: this.#revisionId,
      },
    );
  }

  async emitNext({ signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    if (!this.#listener) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.OUT_OF_ORDER,
        "mock delta source has no active subscriber",
      );
    }
    const delta = this.#deltas[this.#cursor];
    if (!delta) {
      return null;
    }
    const accepted = await this.#listener(delta);
    if (accepted) {
      this.#cursor += 1;
      this.#revisionId = accepted.toRevisionId;
    }
    return accepted;
  }

  async emit(delta, { signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    if (!this.#listener) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.OUT_OF_ORDER,
        "mock delta source has no active subscriber",
      );
    }
    return this.#listener(delta);
  }

  async dispose() {
    this.#disposed = true;
    this.#listener = undefined;
  }
}

export class MockRenderDeltaSource {
  #configuredDeltas;
  #representation;
  #opened = false;
  #disposed = false;
  #session;

  constructor({
    deltas,
    representation = ViewerRepresentation.TWO_DIMENSIONAL,
  } = {}) {
    if (deltas !== undefined && !Array.isArray(deltas)) {
      throw new TypeError("mock render deltas must be an array");
    }
    if (!Object.values(ViewerRepresentation).includes(representation)) {
      throw new TypeError("mock render delta representation is invalid");
    }
    this.supportedProtocolVersions = SupportedRenderProtocolVersions;
    this.#configuredDeltas = deltas;
    this.#representation = representation;
  }

  async open({ protocolVersion, signal } = {}) {
    if (this.#disposed) {
      throw sourceDisposed();
    }
    if (this.#opened) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "MockRenderDeltaSource can open only one session",
      );
    }
    if (protocolVersion !== RenderProtocolVersion) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
        `MockRenderDeltaSource does not support ${protocolVersion}`,
      );
    }
    throwIfAborted(signal);
    this.#opened = true;
    const descriptor = parseRenderSessionDescriptor({
      protocolVersion,
      sessionId: "session:delta-mock",
      sourceId: "source:delta-mock",
      currentRevisionId: "revision:delta-mock:1",
      lastSuccessfulRevisionId: "revision:delta-mock:1",
      capabilities: [
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.PICK_RESOLVE,
        RenderCapability.RENDER_DELTA,
        RenderCapability.RENDER_SNAPSHOT,
      ],
      resourceBudgetBytes: 1024 * 1024,
    });
    const snapshot = parseRenderSnapshotDescriptor(
      {
        protocolVersion,
        sessionId: descriptor.sessionId,
        sourceId: descriptor.sourceId,
        revisionId: descriptor.lastSuccessfulRevisionId,
        snapshotId: "snapshot:delta-mock:base",
        sequence: 0,
        layers: [
          {
            layerId: "layer:delta-base",
            sourceId: "source:delta-base",
            revisionId: descriptor.lastSuccessfulRevisionId,
            kind: ViewerLayerKind.BASE,
            representation: this.#representation,
            order: 0,
            visible: true,
          },
          {
            layerId: "layer:delta-live",
            sourceId: "source:delta-live",
            revisionId: descriptor.lastSuccessfulRevisionId,
            kind: ViewerLayerKind.LIVE,
            representation: this.#representation,
            order: 1,
            visible: true,
          },
        ],
      },
      { session: descriptor },
    );
    let expectedRevisionId = snapshot.revisionId;
    let expectedSequence = 1;
    const deltas = (
      this.#configuredDeltas ?? defaultDeltas(protocolVersion)
    ).map((delta) => {
      const parsed = parseRenderDeltaDescriptor(delta, {
        session: descriptor,
        snapshot,
        expectedRevisionId,
        expectedSequence,
      });
      expectedRevisionId = parsed.toRevisionId;
      expectedSequence += 1;
      return parsed;
    });
    this.#session = new MockRenderDeltaSession({
      descriptor,
      snapshot,
      deltas: Object.freeze(deltas),
    });
    return this.#session;
  }

  async emitNext(options) {
    if (!this.#session) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.OUT_OF_ORDER,
        "MockRenderDeltaSource must be opened before emitting",
      );
    }
    return this.#session.emitNext(options);
  }

  async emit(delta, options) {
    if (!this.#session) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.OUT_OF_ORDER,
        "MockRenderDeltaSource must be opened before emitting",
      );
    }
    return this.#session.emit(delta, options);
  }

  async dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await this.#session?.dispose();
  }
}
