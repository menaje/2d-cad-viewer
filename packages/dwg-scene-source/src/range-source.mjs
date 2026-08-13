// Canonical bounded range sources shared by the DWG adapter and Webview.
const MAX_SAFE_OFFSET = Number.MAX_SAFE_INTEGER;

function throwIfAborted(signal) {
  signal?.throwIfAborted?.();
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException("range read was aborted", "AbortError")
    );
  }
}

function validateRange(offset, length, size) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`invalid range offset: ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`invalid range length: ${length}`);
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > MAX_SAFE_OFFSET) {
    throw new RangeError("range end exceeds JavaScript's safe integer limit");
  }
  if (size !== undefined && size !== null && end > size) {
    throw new RangeError(`range ${offset}..${end} exceeds source size ${size}`);
  }
  return end;
}

export class BlobRangeSource {
  constructor(blob) {
    if (!(blob instanceof Blob)) {
      throw new TypeError("BlobRangeSource requires a Blob or File");
    }
    this.blob = blob;
    this.size = blob.size;
  }

  async read(offset, length, { signal } = {}) {
    throwIfAborted(signal);
    const end = validateRange(offset, length, this.size);
    const buffer = await this.blob.slice(offset, end).arrayBuffer();
    throwIfAborted(signal);
    return buffer;
  }
}

export class HttpRangeSource {
  constructor(url, { size, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("HttpRangeSource requires fetch");
    }
    this.url = url;
    this.size = size;
    this.fetchImpl = fetchImpl;
  }

  async read(offset, length, { signal } = {}) {
    throwIfAborted(signal);
    if (length === 0) {
      validateRange(offset, length, this.size);
      return new ArrayBuffer(0);
    }
    const end = validateRange(offset, length, this.size);
    const response = await this.fetchImpl(this.url, {
      headers: { Range: `bytes=${offset}-${end - 1}` },
      signal,
    });
    if (response.status !== 206) {
      throw new Error(
        `range request was not honored (expected HTTP 206, received ${response.status})`,
      );
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== length) {
      throw new Error(
        `short range response: expected ${length} bytes, received ${buffer.byteLength}`,
      );
    }
    return buffer;
  }
}

export class TrackedRangeSource {
  constructor(source) {
    this.source = source;
    this.size = source.size;
    this.requests = [];
    this.bytesRead = 0;
    this.maximumRequestBytes = 0;
    this.disposed = false;
    this.disposePromise = undefined;
  }

  async read(offset, length, options) {
    if (this.disposed) {
      throw new DOMException("range source disposed", "AbortError");
    }
    this.requests.push({ offset, length });
    this.bytesRead += length;
    this.maximumRequestBytes = Math.max(this.maximumRequestBytes, length);
    return this.source.read(offset, length, options);
  }

  snapshot() {
    return {
      requests: this.requests.length,
      bytesRead: this.bytesRead,
      maximumRequestBytes: this.maximumRequestBytes,
    };
  }

  dispose() {
    if (!this.disposePromise) {
      this.disposed = true;
      this.disposePromise = Promise.resolve().then(() =>
        this.source.dispose?.(),
      );
    }
    return this.disposePromise;
  }
}

export class MemoryRangeSource {
  constructor(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("MemoryRangeSource requires an ArrayBuffer");
    }
    this.buffer = buffer;
    this.size = buffer.byteLength;
  }

  async read(offset, length, { signal } = {}) {
    throwIfAborted(signal);
    const end = validateRange(offset, length, this.size);
    return this.buffer.slice(offset, end);
  }
}

export { validateRange };
