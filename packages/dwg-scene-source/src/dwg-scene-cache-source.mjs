import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  RenderProtocolVersion,
  SupportedRenderProtocolVersions,
  ViewerLayerKind,
  ViewerRepresentation,
  parseRangeHandleDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
} from "@menaje/viewer-render-protocol";

import { validateRange } from "./range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

export const DEFAULT_DWG_RANGE_REQUEST_BYTES = 8 * 1024 * 1024;
export const DWG_SCENE_CACHE_MEDIA_TYPE =
  "application/vnd.dwg-viewer.scene-cache.v1.20";

function protocolError(code, message, details = {}) {
  return new RenderProtocolError(code, message, details);
}

function throwIfAborted(signal) {
  signal?.throwIfAborted?.();
  if (signal?.aborted) {
    const error = new Error("operation aborted");
    error.name = "AbortError";
    throw signal.reason ?? error;
  }
}

function binaryBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new TypeError("DWG Scene Cache range source returned non-binary data");
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function exactHandle(left, right) {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.handleId === right.handleId &&
    left.sessionId === right.sessionId &&
    left.sourceId === right.sourceId &&
    left.revisionId === right.revisionId &&
    left.layerId === right.layerId &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.maximumRequestBytes === right.maximumRequestBytes &&
    left.remainingReadBytes === right.remainingReadBytes &&
    left.sha256 === right.sha256 &&
    left.expiresAt === right.expiresAt &&
    left.disposeWithSession === right.disposeWithSession
  );
}

async function disposeResources(...resources) {
  const results = await Promise.allSettled(
    resources
      .filter(Boolean)
      .map((resource) => Promise.resolve().then(() => resource.dispose?.())),
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "DWG Scene Cache disposal failed");
  }
}

export function createSceneCacheRevisionId(cacheSha256) {
  if (
    typeof cacheSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(cacheSha256)
  ) {
    throw new TypeError(
      "Scene Cache digest must be a lowercase SHA-256 hex value",
    );
  }
  return `render-revision:sha256:${cacheSha256}`;
}

class DwgSceneCacheSession {
  #rangeSource;
  #reader;
  #snapshot;
  #rangeHandle;
  #remainingReadBytes;
  #disposed = false;
  #disposePromise;

  constructor({
    rangeSource,
    reader,
    descriptor,
    snapshot,
    rangeHandle,
  }) {
    this.#rangeSource = rangeSource;
    this.#reader = reader;
    this.descriptor = descriptor;
    this.#snapshot = snapshot;
    this.#rangeHandle = rangeHandle;
    this.#remainingReadBytes = rangeHandle.remainingReadBytes;
  }

  async getSnapshot({ signal } = {}) {
    if (this.#disposed) {
      throw protocolError(
        RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
        "DWG Scene Cache session is disposed",
      );
    }
    throwIfAborted(signal);
    return this.#snapshot;
  }

  async readRange(handle, offset, length, { signal } = {}) {
    if (this.#disposed) {
      throw protocolError(
        RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
        "DWG Scene Cache session is disposed",
      );
    }
    throwIfAborted(signal);
    const parsed = parseRangeHandleDescriptor(handle, {
      session: this.descriptor,
      layer: this.#snapshot.layers[0],
    });
    if (!exactHandle(parsed, this.#rangeHandle)) {
      throw protocolError(
        RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
        "range handle does not belong to this DWG Scene Cache session",
      );
    }
    try {
      validateRange(offset, length, this.#rangeHandle.byteLength);
    } catch (error) {
      throw protocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        error instanceof Error ? error.message : "invalid Scene Cache range",
      );
    }
    if (
      length > this.#rangeHandle.maximumRequestBytes ||
      length > this.#remainingReadBytes
    ) {
      throw protocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "Scene Cache range exceeds its request or remaining read budget",
        {
          length,
          maximumRequestBytes: this.#rangeHandle.maximumRequestBytes,
          remainingReadBytes: this.#remainingReadBytes,
        },
      );
    }
    if (length === 0) {
      return new ArrayBuffer(0);
    }
    this.#remainingReadBytes -= length;
    const bytes = binaryBuffer(
      await this.#rangeSource.read(offset, length, { signal }),
    );
    throwIfAborted(signal);
    if (this.#disposed) {
      throw protocolError(
        RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
        "DWG Scene Cache session was disposed during a range read",
      );
    }
    if (bytes.byteLength !== length) {
      throw protocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "DWG Scene Cache range source returned a short read",
        { expected: length, received: bytes.byteLength },
      );
    }
    return bytes;
  }

  dispose() {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#reader?.cache?.clear?.();
      this.#reader = undefined;
      this.#disposePromise = Promise.resolve();
    }
    return this.#disposePromise;
  }
}

export class DwgSceneCacheSource {
  #rangeSource;
  #configuration;
  #session;
  #opened = false;
  #disposed = false;
  #disposePromise;

  constructor({
    rangeSource,
    sessionId,
    sourceId,
    revisionId,
    cacheSha256,
    layerId = "layer:dwg-base",
    snapshotId = `snapshot:dwg:${cacheSha256}`,
    resourceBudgetBytes = rangeSource?.size,
    maximumRangeRequestBytes = Math.min(
      DEFAULT_DWG_RANGE_REQUEST_BYTES,
      resourceBudgetBytes ?? 0,
    ),
    readBudgetBytes = resourceBudgetBytes,
  }) {
    if (!rangeSource || typeof rangeSource.read !== "function") {
      throw new TypeError(
        "DwgSceneCacheSource requires a bounded binary range source",
      );
    }
    positiveSafeInteger(rangeSource.size, "Scene Cache source size");
    positiveSafeInteger(resourceBudgetBytes, "Scene Cache resource budget");
    positiveSafeInteger(
      maximumRangeRequestBytes,
      "Scene Cache maximum range request",
    );
    positiveSafeInteger(readBudgetBytes, "Scene Cache read budget");
    if (
      maximumRangeRequestBytes > resourceBudgetBytes ||
      readBudgetBytes > resourceBudgetBytes
    ) {
      throw new RangeError(
        "Scene Cache range budgets must fit the session resource budget",
      );
    }
    this.supportedProtocolVersions = SupportedRenderProtocolVersions;
    this.#rangeSource = rangeSource;
    this.#configuration = Object.freeze({
      sessionId,
      sourceId,
      revisionId,
      cacheSha256,
      layerId,
      snapshotId,
      resourceBudgetBytes,
      maximumRangeRequestBytes,
      readBudgetBytes,
    });
  }

  async open({ protocolVersion, signal } = {}) {
    if (this.#disposed) {
      throw protocolError(
        RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
        "DWG Scene Cache source is disposed",
      );
    }
    if (this.#opened) {
      throw protocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "DWG Scene Cache source can open only one session",
      );
    }
    if (protocolVersion !== RenderProtocolVersion) {
      throw protocolError(
        RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
        `DWG Scene Cache source does not support ${protocolVersion}`,
        { supportedVersions: this.supportedProtocolVersions },
      );
    }
    throwIfAborted(signal);
    this.#opened = true;
    const reader = await SceneCacheReader.open(this.#rangeSource);
    throwIfAborted(signal);
    if (this.#disposed) {
      reader.cache.clear();
      throw protocolError(
        RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
        "DWG Scene Cache source was disposed while opening",
      );
    }
    const descriptor = parseRenderSessionDescriptor({
      protocolVersion,
      sessionId: this.#configuration.sessionId,
      sourceId: this.#configuration.sourceId,
      currentRevisionId: this.#configuration.revisionId,
      lastSuccessfulRevisionId: this.#configuration.revisionId,
      capabilities: [
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.RANGE_READ,
        RenderCapability.RENDER_SNAPSHOT,
      ],
      resourceBudgetBytes: this.#configuration.resourceBudgetBytes,
    });
    const rangeHandle = {
      protocolVersion,
      handleId: `range:scene-cache:${this.#configuration.cacheSha256}`,
      sessionId: descriptor.sessionId,
      sourceId: descriptor.sourceId,
      revisionId: descriptor.lastSuccessfulRevisionId,
      layerId: this.#configuration.layerId,
      mediaType: DWG_SCENE_CACHE_MEDIA_TYPE,
      byteLength: reader.header.fileSize,
      maximumRequestBytes:
        this.#configuration.maximumRangeRequestBytes,
      remainingReadBytes: this.#configuration.readBudgetBytes,
      sha256: this.#configuration.cacheSha256,
      expiresAt: null,
      disposeWithSession: true,
    };
    const snapshot = parseRenderSnapshotDescriptor(
      {
        protocolVersion,
        sessionId: descriptor.sessionId,
        sourceId: descriptor.sourceId,
        revisionId: descriptor.lastSuccessfulRevisionId,
        snapshotId: this.#configuration.snapshotId,
        sequence: 0,
        layers: [
          {
            layerId: this.#configuration.layerId,
            sourceId: descriptor.sourceId,
            revisionId: descriptor.lastSuccessfulRevisionId,
            kind: ViewerLayerKind.BASE,
            representation: ViewerRepresentation.TWO_DIMENSIONAL,
            order: 0,
            visible: true,
            rangeHandle,
          },
        ],
      },
      { session: descriptor },
    );
    this.#session = new DwgSceneCacheSession({
      rangeSource: this.#rangeSource,
      reader,
      descriptor,
      snapshot,
      rangeHandle: snapshot.layers[0].rangeHandle,
    });
    return this.#session;
  }

  dispose() {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#disposePromise = disposeResources(
        this.#session,
        this.#rangeSource,
      );
    }
    return this.#disposePromise;
  }
}
