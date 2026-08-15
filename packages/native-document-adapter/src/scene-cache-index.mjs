import {
  SectionKind,
} from "@menaje/dwg-scene-source/scene-cache";

import {
  AllNativeAdapterOperations,
  NativeAdapterOperation,
  NativeBackendKind,
  NativeCapabilityStatus,
  NativeDocumentAdapterProtocol,
  NativeQueryLimits,
} from "./constants.mjs";
import {
  adapterError,
  invalid,
} from "./diagnostics.mjs";
import {
  NativeAdapterErrorCode,
} from "./constants.mjs";
import {
  sourceFingerprint as parseSourceFingerprint,
} from "./validation.mjs";

const PRECISION_UNINDEXED = 0;
const PRECISION_EXACT = 1;
const PRECISION_CONSERVATIVE = 2;
const STRING_TABLE_PREFIX_BYTES = 16;

function finiteBounds(points) {
  if (
    points.length === 0 ||
    !points.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 3 &&
        point.every(Number.isFinite),
    )
  ) {
    return null;
  }
  const min = [...points[0]];
  const max = [...points[0]];
  for (const point of points.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return { min, max };
}

function vec3(view, offset) {
  return [
    view.getFloat64(offset, true),
    view.getFloat64(offset + 8, true),
    view.getFloat64(offset + 16, true),
  ];
}

function pointBounds(point) {
  return finiteBounds([point]);
}

function sphereBounds(center, radius) {
  if (
    !center.every(Number.isFinite) ||
    !Number.isFinite(radius) ||
    radius < 0
  ) {
    return null;
  }
  return {
    min: center.map((coordinate) => coordinate - radius),
    max: center.map((coordinate) => coordinate + radius),
  };
}

function planarImageBounds(
  insertionPoint,
  uVector,
  vVector,
  size,
) {
  if (
    !size.every(Number.isFinite) ||
    size.some((value) => value < 0)
  ) {
    return null;
  }
  const u = uVector.map((value) => value * size[0]);
  const v = vVector.map((value) => value * size[1]);
  return finiteBounds([
    insertionPoint,
    insertionPoint.map((value, axis) => value + u[axis]),
    insertionPoint.map((value, axis) => value + v[axis]),
    insertionPoint.map(
      (value, axis) => value + u[axis] + v[axis],
    ),
  ]);
}

function textType(view) {
  return [
    "TEXT",
    "MTEXT",
    "ATTDEF",
    "ATTRIB",
  ][view.getUint16(32, true)] ?? "TEXT";
}

const ENTITY_SECTIONS = Object.freeze([
  {
    kind: SectionKind.Lines,
    type: "LINE",
    bounds: (view) =>
      finiteBounds([vec3(view, 32), vec3(view, 56)]),
    precision: PRECISION_EXACT,
  },
  {
    kind: SectionKind.Arcs,
    type: "ARC",
    bounds: (view) =>
      sphereBounds(vec3(view, 32), view.getFloat64(56, true)),
    precision: PRECISION_CONSERVATIVE,
  },
  {
    kind: SectionKind.Circles,
    type: "CIRCLE",
    bounds: (view) =>
      sphereBounds(vec3(view, 32), view.getFloat64(56, true)),
    precision: PRECISION_CONSERVATIVE,
  },
  {
    kind: SectionKind.Inserts,
    type: "INSERT",
    bounds: () => null,
    precision: PRECISION_UNINDEXED,
  },
  {
    kind: SectionKind.PolylineHeaders,
    type: "POLYLINE",
    bounds: () => null,
    precision: PRECISION_UNINDEXED,
  },
  {
    kind: SectionKind.Ellipses,
    type: "ELLIPSE",
    bounds(view) {
      const major = vec3(view, 56);
      const ratio = Math.abs(view.getFloat64(104, true));
      return sphereBounds(
        vec3(view, 32),
        Math.hypot(...major) * Math.max(1, ratio),
      );
    },
    precision: PRECISION_CONSERVATIVE,
  },
  {
    kind: SectionKind.SplineHeaders,
    type: "SPLINE",
    bounds: () => null,
    precision: PRECISION_UNINDEXED,
  },
  {
    kind: SectionKind.TextEntities,
    stringTable: true,
    type: textType,
    bounds(view) {
      const insertion = vec3(view, 72);
      const width = Math.max(
        Math.abs(view.getFloat64(208, true)),
        Math.abs(view.getFloat64(224, true)),
      );
      const height = Math.max(
        Math.abs(view.getFloat64(168, true)),
        Math.abs(view.getFloat64(216, true)),
        Math.abs(view.getFloat64(232, true)),
      );
      return sphereBounds(insertion, Math.hypot(width, height));
    },
    precision: PRECISION_CONSERVATIVE,
  },
  {
    kind: SectionKind.HatchEntities,
    stringTable: true,
    type: "HATCH",
    bounds: () => null,
    precision: PRECISION_UNINDEXED,
  },
  {
    kind: SectionKind.PointEntities,
    type: "POINT",
    bounds: (view) => pointBounds(vec3(view, 32)),
    precision: PRECISION_EXACT,
  },
  {
    kind: SectionKind.SolidEntities,
    type: "SOLID",
    bounds: (view) =>
      finiteBounds(
        [0, 1, 2, 3].map((corner) =>
          vec3(view, 40 + corner * 24),
        ),
      ),
    precision: PRECISION_EXACT,
  },
  {
    kind: SectionKind.FaceEntities,
    type: "3DFACE",
    bounds: (view) =>
      finiteBounds(
        [0, 1, 2, 3].map((corner) =>
          vec3(view, 40 + corner * 24),
        ),
      ),
    precision: PRECISION_EXACT,
  },
  {
    kind: SectionKind.WipeoutEntities,
    type: "WIPEOUT",
    bounds: (view) =>
      planarImageBounds(
        vec3(view, 80),
        vec3(view, 104),
        vec3(view, 128),
        [
          view.getFloat64(152, true),
          view.getFloat64(160, true),
        ],
      ),
    precision: PRECISION_CONSERVATIVE,
  },
  {
    kind: SectionKind.ImageEntities,
    stringTable: true,
    type: "IMAGE",
    bounds: (view) =>
      planarImageBounds(
        vec3(view, 88),
        vec3(view, 112),
        vec3(view, 136),
        [
          view.getFloat64(160, true),
          view.getFloat64(168, true),
        ],
      ),
    precision: PRECISION_CONSERVATIVE,
  },
]);

function validateReader(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.getSection !== "function" ||
    typeof value.source?.read !== "function"
  ) {
    throw new TypeError(
      "Scene Cache native index requires an open SceneCacheReader",
    );
  }
  return value;
}

function positiveLimit(value, label, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new RangeError(`${label} exceeds its supported limit`);
  }
  return value;
}

function copyBounds(target, index, value) {
  const offset = index * 6;
  if (!value) {
    target.fill(Number.NaN, offset, offset + 6);
    return;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    target[offset + axis] = value.min[axis];
    target[offset + 3 + axis] = value.max[axis];
  }
}

function readStoredBounds(values, index) {
  const offset = index * 6;
  if (Number.isNaN(values[offset])) {
    return null;
  }
  return Object.freeze({
    min: Object.freeze([
      values[offset],
      values[offset + 1],
      values[offset + 2],
    ]),
    max: Object.freeze([
      values[offset + 3],
      values[offset + 4],
      values[offset + 5],
    ]),
  });
}

function intersects(left, right) {
  return left.min.every(
    (minimum, axis) =>
      minimum <= right.max[axis] &&
      left.max[axis] >= right.min[axis],
  );
}

function hexHandle(value) {
  return `handle:${value.toString(16).toUpperCase()}`;
}

function bigintHandle(value) {
  return BigInt(`0x${value.slice("handle:".length)}`);
}

function spaceId(owner) {
  return owner === 0n
    ? "space:model"
    : `space:handle-${owner.toString(16).toUpperCase()}`;
}

async function sha256(...parts) {
  const byteLength = parts.reduce(
    (sum, part) => sum + part.byteLength,
    0,
  );
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", joined),
  );
  return `sha256:${[...digest]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function cleanupReceipt(backendKind) {
  return Object.freeze({
    remainingTemporaryFiles: 0,
    remainingOutputReservations: 0,
    processExited:
      backendKind !== NativeBackendKind.WASM_WORKER,
    workerTerminated:
      backendKind === NativeBackendKind.WASM_WORKER,
  });
}

export class SceneCacheNativeIndex {
  #reader;
  #sourceFingerprint;
  #backendKind;
  #handles;
  #owners;
  #sectionKinds;
  #recordIndices;
  #layerIndices;
  #precisions;
  #bounds;
  #specificationByKind;
  #maximumScanEntries;
  #disposed = false;
  #recordsRead;
  #sourceBytesRead;

  constructor({
    reader,
    sourceFingerprint,
    backendKind,
    handles,
    owners,
    sectionKinds,
    recordIndices,
    layerIndices,
    precisions,
    bounds,
    recordsRead,
    sourceBytesRead,
    maximumScanEntries,
  }) {
    this.#reader = reader;
    this.#sourceFingerprint = sourceFingerprint;
    this.#backendKind = backendKind;
    this.#handles = handles;
    this.#owners = owners;
    this.#sectionKinds = sectionKinds;
    this.#recordIndices = recordIndices;
    this.#layerIndices = layerIndices;
    this.#precisions = precisions;
    this.#bounds = bounds;
    this.#recordsRead = recordsRead;
    this.#sourceBytesRead = sourceBytesRead;
    this.#maximumScanEntries = maximumScanEntries;
    this.#specificationByKind = new Map(
      ENTITY_SECTIONS.map((specification) => [
        specification.kind,
        specification,
      ]),
    );
  }

  get state() {
    return Object.freeze({
      disposed: this.#disposed,
      entries: this.#handles.length,
      recordsRead: this.#recordsRead,
      sourceBytesRead: this.#sourceBytesRead,
      packedIndexBytes:
        this.#handles.byteLength +
        this.#owners.byteLength +
        this.#sectionKinds.byteLength +
        this.#recordIndices.byteLength +
        this.#layerIndices.byteLength +
        this.#precisions.byteLength +
        this.#bounds.byteLength,
    });
  }

  #assertOpen() {
    if (this.#disposed) {
      adapterError(
        NativeAdapterErrorCode.SOURCE_DISPOSED,
        "Scene Cache native index is disposed",
      );
    }
  }

  #lowerBound(handle) {
    let low = 0;
    let high = this.#handles.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.#handles[middle] < handle) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  async #readRecord(position, signal) {
    this.#assertOpen();
    signal?.throwIfAborted?.();
    const kind = this.#sectionKinds[position];
    const specification = this.#specificationByKind.get(kind);
    const section = this.#reader.getSection(kind);
    const base = specification.stringTable
      ? STRING_TABLE_PREFIX_BYTES
      : 0;
    const offset =
      section.offset +
      base +
      this.#recordIndices[position] * section.recordSize;
    const buffer = await this.#reader.source.read(
      offset,
      section.recordSize,
      { signal },
    );
    signal?.throwIfAborted?.();
    if (
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength !== section.recordSize
    ) {
      adapterError(
        NativeAdapterErrorCode.BACKEND_FAILED,
        "Scene Cache native entity record is truncated",
      );
    }
    return { buffer, specification };
  }

  async #entity(position, signal) {
    const { buffer, specification } =
      await this.#readRecord(position, signal);
    const view = new DataView(buffer);
    const type =
      typeof specification.type === "function"
        ? specification.type(view)
        : specification.type;
    const handle = this.#handles[position];
    const owner = this.#owners[position];
    const fingerprint = await sha256(
      new TextEncoder().encode(
        `${this.#sourceFingerprint}\u0000${specification.kind}\u0000`,
      ),
      new Uint8Array(buffer),
    );
    const precision = this.#precisions[position];
    return Object.freeze({
      ref: Object.freeze({
        documentFingerprint: this.#sourceFingerprint,
        spaceId: spaceId(owner),
        nestedInstancePath: Object.freeze([]),
        handle: hexHandle(handle),
        entityFingerprint: fingerprint,
      }),
      type,
      layerIndex: this.#layerIndices[position],
      bounds: readStoredBounds(this.#bounds, position),
      boundsPrecision:
        precision === PRECISION_EXACT
          ? "exact"
          : precision === PRECISION_CONSERVATIVE
            ? "conservative"
            : "unindexed",
      summary: Object.freeze({
        sectionKind: specification.kind,
        recordIndex: this.#recordIndices[position],
        ownerHandle: hexHandle(owner),
      }),
    });
  }

  async queryEntity(reference, { signal } = {}) {
    this.#assertOpen();
    const handle = bigintHandle(reference.handle);
    const first = this.#lowerBound(handle);
    let fallback = null;
    for (
      let position = first;
      position < this.#handles.length &&
        this.#handles[position] === handle;
      position += 1
    ) {
      if (
        spaceId(this.#owners[position]) !== reference.spaceId
      ) {
        continue;
      }
      const entity = await this.#entity(position, signal);
      fallback ??= entity;
      if (
        entity.ref.entityFingerprint ===
        reference.entityFingerprint
      ) {
        return entity;
      }
    }
    return fallback;
  }

  async queryRegion(
    { bounds, types, position, pageSize },
    { signal } = {},
  ) {
    this.#assertOpen();
    const acceptedTypes = new Set(types);
    const entities = [];
    let scannedEntries = 0;
    let unindexedEntries = 0;
    let cursor = position;
    while (
      cursor < this.#handles.length &&
      scannedEntries < this.#maximumScanEntries &&
      entities.length < pageSize
    ) {
      signal?.throwIfAborted?.();
      const specification = this.#specificationByKind.get(
        this.#sectionKinds[cursor],
      );
      const storedBounds = readStoredBounds(this.#bounds, cursor);
      if (storedBounds === null) {
        unindexedEntries += 1;
      } else {
        const type =
          typeof specification.type === "string"
            ? specification.type
            : null;
        if (
          (acceptedTypes.size === 0 ||
            type === null ||
            acceptedTypes.has(type)) &&
          intersects(storedBounds, bounds)
        ) {
          const entity = await this.#entity(cursor, signal);
          if (
            acceptedTypes.size === 0 ||
            acceptedTypes.has(entity.type)
          ) {
            entities.push(entity);
          }
        }
      }
      cursor += 1;
      scannedEntries += 1;
    }
    return Object.freeze({
      entities: Object.freeze(entities),
      nextPosition:
        cursor < this.#handles.length ? cursor : null,
      scannedEntries,
      unindexedEntries,
    });
  }

  async dispose() {
    if (this.#disposed) {
      return cleanupReceipt(this.#backendKind);
    }
    this.#disposed = true;
    this.#handles.fill(0n);
    this.#owners.fill(0n);
    this.#sectionKinds.fill(0);
    this.#recordIndices.fill(0);
    this.#layerIndices.fill(0);
    this.#precisions.fill(0);
    this.#bounds.fill(Number.NaN);
    return cleanupReceipt(this.#backendKind);
  }
}

export async function createSceneCacheNativeIndex(
  readerValue,
  {
    sourceFingerprint,
    backendKind = NativeBackendKind.NATIVE_PROCESS,
    maximumEntries = NativeQueryLimits.maximumIndexEntries,
    maximumSourceBytes =
      NativeQueryLimits.maximumIndexSourceBytes,
    maximumReadBytes =
      NativeQueryLimits.maximumIndexReadBytes,
    maximumScanEntries = 65_536,
    signal,
  } = {},
) {
  const reader = validateReader(readerValue);
  const fingerprint = parseSourceFingerprint(sourceFingerprint);
  positiveLimit(
    maximumEntries,
    "native index entry limit",
    NativeQueryLimits.maximumIndexEntries,
  );
  positiveLimit(
    maximumSourceBytes,
    "native index source byte limit",
    NativeQueryLimits.maximumIndexSourceBytes,
  );
  positiveLimit(
    maximumReadBytes,
    "native index read byte limit",
    NativeQueryLimits.maximumIndexReadBytes,
  );
  positiveLimit(
    maximumScanEntries,
    "native index scan entry limit",
    NativeQueryLimits.maximumIndexEntries,
  );
  const present = ENTITY_SECTIONS.map((specification) => ({
    specification,
    section: reader.getSection(specification.kind),
  }));
  const entries = present.reduce(
    (sum, item) => sum + item.section.recordCount,
    0,
  );
  const sourceBytes = present.reduce(
    (sum, item) =>
      sum +
      item.section.recordCount * item.section.recordSize,
    0,
  );
  if (entries > maximumEntries || sourceBytes > maximumSourceBytes) {
    adapterError(
      NativeAdapterErrorCode.BUDGET_EXCEEDED,
      "Scene Cache native index exceeds its admission budget",
      { entries, sourceBytes },
    );
  }

  const handles = new BigUint64Array(entries);
  const owners = new BigUint64Array(entries);
  const sectionKinds = new Uint16Array(entries);
  const recordIndices = new Uint32Array(entries);
  const layerIndices = new Uint32Array(entries);
  const precisions = new Uint8Array(entries);
  const bounds = new Float64Array(entries * 6);
  let outputIndex = 0;
  let sourceBytesRead = 0;
  for (const { specification, section } of present) {
    const recordsPerRead = Math.max(
      1,
      Math.floor(maximumReadBytes / section.recordSize),
    );
    const base = specification.stringTable
      ? STRING_TABLE_PREFIX_BYTES
      : 0;
    for (
      let firstRecord = 0;
      firstRecord < section.recordCount;
      firstRecord += recordsPerRead
    ) {
      signal?.throwIfAborted?.();
      const recordCount = Math.min(
        recordsPerRead,
        section.recordCount - firstRecord,
      );
      const byteLength = recordCount * section.recordSize;
      const buffer = await reader.source.read(
        section.offset +
          base +
          firstRecord * section.recordSize,
        byteLength,
        { signal },
      );
      signal?.throwIfAborted?.();
      if (
        !(buffer instanceof ArrayBuffer) ||
        buffer.byteLength !== byteLength
      ) {
        adapterError(
          NativeAdapterErrorCode.BACKEND_FAILED,
          "Scene Cache native index source record is truncated",
        );
      }
      const view = new DataView(buffer);
      for (let local = 0; local < recordCount; local += 1) {
        const offset = local * section.recordSize;
        const recordView = new DataView(
          buffer,
          offset,
          section.recordSize,
        );
        const handle = view.getBigUint64(offset, true);
        if (handle === 0n) {
          invalid("Scene Cache native index contains a zero handle");
        }
        handles[outputIndex] = handle;
        owners[outputIndex] = view.getBigUint64(offset + 8, true);
        sectionKinds[outputIndex] = specification.kind;
        recordIndices[outputIndex] = firstRecord + local;
        layerIndices[outputIndex] = view.getUint32(
          offset + 16,
          true,
        );
        const entityBounds = specification.bounds(recordView);
        copyBounds(bounds, outputIndex, entityBounds);
        precisions[outputIndex] = entityBounds
          ? specification.precision
          : PRECISION_UNINDEXED;
        outputIndex += 1;
      }
      sourceBytesRead += byteLength;
    }
  }

  const order = new Uint32Array(entries);
  for (let index = 0; index < entries; index += 1) {
    order[index] = index;
  }
  order.sort((left, right) => {
    if (handles[left] < handles[right]) {
      return -1;
    }
    if (handles[left] > handles[right]) {
      return 1;
    }
    if (owners[left] < owners[right]) {
      return -1;
    }
    if (owners[left] > owners[right]) {
      return 1;
    }
    return sectionKinds[left] - sectionKinds[right];
  });
  const sorted = {
    handles: new BigUint64Array(entries),
    owners: new BigUint64Array(entries),
    sectionKinds: new Uint16Array(entries),
    recordIndices: new Uint32Array(entries),
    layerIndices: new Uint32Array(entries),
    precisions: new Uint8Array(entries),
    bounds: new Float64Array(entries * 6),
  };
  for (let target = 0; target < entries; target += 1) {
    const source = order[target];
    sorted.handles[target] = handles[source];
    sorted.owners[target] = owners[source];
    sorted.sectionKinds[target] = sectionKinds[source];
    sorted.recordIndices[target] = recordIndices[source];
    sorted.layerIndices[target] = layerIndices[source];
    sorted.precisions[target] = precisions[source];
    sorted.bounds.set(
      bounds.subarray(source * 6, source * 6 + 6),
      target * 6,
    );
  }
  handles.fill(0n);
  owners.fill(0n);
  sectionKinds.fill(0);
  recordIndices.fill(0);
  layerIndices.fill(0);
  precisions.fill(0);
  bounds.fill(Number.NaN);
  order.fill(0);

  return new SceneCacheNativeIndex({
    reader,
    sourceFingerprint: fingerprint,
    backendKind,
    ...sorted,
    recordsRead: entries,
    sourceBytesRead,
    maximumScanEntries,
  });
}

function capability(status, reason) {
  return Object.freeze({ status, reason });
}

export function createSceneCacheNativeDescriptor({
  sourceFingerprint,
  inputCapabilityId,
  sourceVersion = "AC1032",
  backendId = "backend:libredwg-native",
  backendKind = NativeBackendKind.NATIVE_PROCESS,
} = {}) {
  const blockedWriter =
    "LibreDWG 0.14 writer preservation is not admitted; " +
    "block before reserving an output";
  const capabilities = Object.fromEntries(
    AllNativeAdapterOperations.map((operation) => [
      operation,
      capability(NativeCapabilityStatus.BLOCKED, blockedWriter),
    ]),
  );
  capabilities[NativeAdapterOperation.READ] = capability(
    NativeCapabilityStatus.NATIVE,
    "LibreDWG source records are preserved in packed Scene Cache v1.26",
  );
  capabilities[NativeAdapterOperation.QUERY_ENTITY] = capability(
    NativeCapabilityStatus.MAPPED,
    "bounded packed handle index over source-precision Scene Cache records",
  );
  capabilities[NativeAdapterOperation.QUERY_REGION] = capability(
    NativeCapabilityStatus.MAPPED,
    "exact or conservative bounds are indexed; complex unindexed records are reported",
  );
  const fingerprint = parseSourceFingerprint(sourceFingerprint);
  return Object.freeze({
    protocol: NativeDocumentAdapterProtocol,
    sessionId:
      `session:native-${fingerprint.slice("sha256:".length, 30)}`,
    adapterId: "adapter:dwg-scene-cache-native-query",
    adapterVersion: "0.1.0",
    engineId: "engine:libredwg",
    engineVersion: "0.14",
    backendId,
    backendKind,
    license:
      backendKind === NativeBackendKind.NATIVE_PROCESS
        ? "GPL-3.0-or-later process artifact; MPL-2.0 contract"
        : "GPL-3.0-or-later qualification artifact; MPL-2.0 contract",
    sourceFingerprint: fingerprint,
    inputCapabilityId,
    sourceVersion,
    outputVersions: Object.freeze([
      "AC1015",
      "AC1018",
      "AC1021",
      "AC1024",
      "AC1027",
      "AC1032",
    ]),
    capabilities: Object.freeze(capabilities),
    limits: Object.freeze({
      maximumPageSize: NativeQueryLimits.maximumPageSize,
      maximumQueryPayloadBytes:
        NativeQueryLimits.maximumQueryPayloadBytes,
      maximumProposalBytes:
        NativeQueryLimits.maximumProposalBytes,
      maximumProposalOperations:
        NativeQueryLimits.maximumProposalOperations,
    }),
  });
}
