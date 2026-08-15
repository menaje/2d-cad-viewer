import {
  RenderDeltaOperationKind,
} from "@menaje/viewer-render-protocol";

function abortError(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("staged delta preparation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return Object.freeze({ promise, resolve });
}

function waitForRelease(gate, signal, ignoreAbort) {
  if (!gate) {
    return Promise.resolve();
  }
  if (ignoreAbort || !signal?.addEventListener) {
    return gate.promise;
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    gate.promise.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function sortedEntries(entries) {
  return Object.freeze(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([renderId, value]) =>
        Object.freeze({ renderId, ...value }),
      ),
  );
}

export class MockStagedRenderDeltaAdapter {
  #visible;
  #staged = null;
  #activeGpuBytes = 0;
  #disposed = false;
  #gate;
  #prepareStarted = deferred();
  #expectedPayloadSha256;
  #failPrepare;
  #failCommit;
  #ignoreAbortDuringPrepare;
  #metrics = {
    prepares: 0,
    commits: 0,
    rollbacks: 0,
    transactionDisposals: 0,
    adapterDisposals: 0,
  };

  constructor({
    revisionId,
    holdPrepare = false,
    expectedPayloadSha256 = null,
    failPrepare = false,
    failCommit = false,
    ignoreAbortDuringPrepare = false,
  }) {
    if (typeof revisionId !== "string" || revisionId.length === 0) {
      throw new TypeError("mock staged adapter requires a revision ID");
    }
    if (
      expectedPayloadSha256 !== null &&
      !/^[a-f0-9]{64}$/u.test(expectedPayloadSha256)
    ) {
      throw new TypeError("mock staged adapter digest is invalid");
    }
    this.#visible = Object.freeze({
      revisionId,
      geometryRevisionId: revisionId,
      pickRevisionId: revisionId,
      entities: new Map(),
      identities: new Map(),
    });
    this.#gate = holdPrepare ? deferred() : null;
    this.#expectedPayloadSha256 = expectedPayloadSha256;
    this.#failPrepare = Boolean(failPrepare);
    this.#failCommit = Boolean(failCommit);
    this.#ignoreAbortDuringPrepare = Boolean(ignoreAbortDuringPrepare);
  }

  get prepareStarted() {
    return this.#prepareStarted.promise;
  }

  releasePrepare() {
    if (!this.#gate) {
      return false;
    }
    this.#gate.resolve();
    this.#gate = null;
    return true;
  }

  snapshot() {
    const staged = this.#staged;
    return Object.freeze({
      disposed: this.#disposed,
      revisionId: this.#visible.revisionId,
      geometryRevisionId: this.#visible.geometryRevisionId,
      pickRevisionId: this.#visible.pickRevisionId,
      entities: sortedEntries(this.#visible.entities),
      identities: Object.freeze(
        [...this.#visible.identities.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([renderId, externalIdentityToken]) =>
            Object.freeze({ renderId, externalIdentityToken }),
          ),
      ),
      resources: Object.freeze({
        stagedRanges: staged?.ranges ?? 0,
        stagedWorkers: staged?.workers ?? 0,
        stagedCpuBytes: staged?.cpuBytes ?? 0,
        stagedGpuBytes: staged?.gpuBytes ?? 0,
        activeGpuBytes: this.#activeGpuBytes,
      }),
      metrics: Object.freeze({ ...this.#metrics }),
    });
  }

  async prepareDelta(delta, { signal } = {}) {
    if (this.#disposed) {
      throw new DOMException("mock staged adapter is disposed", "InvalidStateError");
    }
    if (this.#staged) {
      throw new DOMException(
        "mock staged adapter already owns a transaction",
        "InvalidStateError",
      );
    }
    throwIfAborted(signal);
    const payloadBytes = delta.payload?.byteLength ?? 0;
    const staged = {
      ranges: delta.payload ? 1 : 0,
      workers: 1,
      cpuBytes: payloadBytes,
      gpuBytes: payloadBytes,
    };
    this.#staged = staged;
    this.#metrics.prepares += 1;
    this.#prepareStarted.resolve();
    try {
      await waitForRelease(
        this.#gate,
        signal,
        this.#ignoreAbortDuringPrepare,
      );
      if (!this.#ignoreAbortDuringPrepare) {
        throwIfAborted(signal);
      }
      if (this.#failPrepare) {
        throw new Error("mock staged geometry preparation failed");
      }
      if (
        this.#expectedPayloadSha256 !== null &&
        delta.payload?.sha256 !== this.#expectedPayloadSha256
      ) {
        throw new Error("mock staged payload digest mismatch");
      }
    } catch (error) {
      this.#staged = null;
      throw error;
    }

    const entities = new Map(this.#visible.entities);
    const identities = new Map(this.#visible.identities);
    for (const operation of delta.operations) {
      for (const renderId of operation.renderIds) {
        if (operation.kind === RenderDeltaOperationKind.TOMBSTONE) {
          entities.delete(renderId);
          identities.delete(renderId);
        } else {
          entities.set(renderId, Object.freeze({
            aspect: operation.aspect,
            revisionId: delta.toRevisionId,
          }));
          identities.set(
            renderId,
            operation.externalIdentityToken,
          );
        }
      }
    }
    const next = Object.freeze({
      revisionId: delta.toRevisionId,
      geometryRevisionId: delta.toRevisionId,
      pickRevisionId: delta.toRevisionId,
      entities,
      identities,
    });
    let closed = false;
    const clearStaged = () => {
      if (this.#staged === staged) {
        this.#staged = null;
      }
    };
    return Object.freeze({
      commit: () => {
        if (closed) {
          throw new DOMException(
            "mock staged transaction is closed",
            "InvalidStateError",
          );
        }
        if (this.#failCommit) {
          throw new Error("mock staged atomic commit failed");
        }
        this.#visible = next;
        this.#activeGpuBytes = staged.gpuBytes;
        clearStaged();
        closed = true;
        this.#metrics.commits += 1;
      },
      rollback: async () => {
        if (!closed) {
          clearStaged();
          closed = true;
          this.#metrics.rollbacks += 1;
        }
      },
      dispose: async () => {
        clearStaged();
        this.#metrics.transactionDisposals += 1;
      },
    });
  }

  async dispose() {
    if (this.#disposed) {
      return false;
    }
    this.#disposed = true;
    this.#staged = null;
    this.#activeGpuBytes = 0;
    this.#metrics.adapterDisposals += 1;
    return true;
  }
}
