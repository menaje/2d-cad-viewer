import earcut, { deviation } from "earcut";

// Bits 17–31 carry converter diagnostics that the shaders do not consume.
// Mask-enabled GPU payloads replace them while preserving mode/weight and
// the bit-16 invisibility flag.
export const MASK_BUCKET_STYLE_SHIFT = 17;
export const MAX_LOCAL_MASK_BUCKET = 0x7fff;
export const MAX_GLOBAL_MASK_BUCKET = 10_000;
// A root draw-order bucket is subdivided for XREF-local ordering. 1024 keeps
// the resulting depth values distinguishable in a 24-bit depth buffer across
// the complete root bucket range while leaving room in the RGB order map.
export const DRAW_ORDER_SUBDIVISIONS = 1024;

const DEFAULT_MAXIMUM_DEPTH = 64;
const DEFAULT_MAXIMUM_EVENTS = 250_000;
const MAXIMUM_TRIANGULATION_DEVIATION = 1e-6;

function compareOrder(leftKey, leftHandle, rightKey, rightHandle) {
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  if (leftHandle < rightHandle) {
    return -1;
  }
  if (leftHandle > rightHandle) {
    return 1;
  }
  return 0;
}

function pointsNear(left, right) {
  const scale = Math.max(
    1,
    ...left.map(Math.abs),
    ...right.map(Math.abs),
  );
  return left.every(
    (coordinate, axis) =>
      Math.abs(coordinate - right[axis]) <= scale * 1e-12,
  );
}

function wipeoutPoint(entity, localPoint) {
  return Object.freeze(
    [0, 1, 2].map(
      (axis) =>
        entity.insertionPoint[axis] +
        entity.uVector[axis] * localPoint[0] +
        entity.vVector[axis] * localPoint[1],
    ),
  );
}

function wipeoutBoundary(source, entity) {
  const usesClipBoundary =
    entity.clippingEnabled && (entity.displayProperties & 4) !== 0;
  let localPoints;
  if (usesClipBoundary && entity.clipType === 2) {
    localPoints = new Array(entity.clipVertexCount);
    for (let index = 0; index < entity.clipVertexCount; index += 1) {
      localPoints[index] = source.readClipVertex(
        entity.firstClipVertex + index,
        [0, 0],
      );
    }
  } else if (usesClipBoundary) {
    const start = source.readClipVertex(entity.firstClipVertex, [0, 0]);
    const end = source.readClipVertex(entity.firstClipVertex + 1, [0, 0]);
    localPoints = [
      [start[0], start[1]],
      [end[0], start[1]],
      [end[0], end[1]],
      [start[0], end[1]],
    ];
  } else {
    localPoints = [
      [-0.5, -0.5],
      [entity.size[0] - 0.5, -0.5],
      [entity.size[0] - 0.5, entity.size[1] - 0.5],
      [-0.5, entity.size[1] - 0.5],
    ];
  }

  const normalized = [];
  for (const point of localPoints) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !point.every(Number.isFinite)
    ) {
      return null;
    }
    if (
      normalized.length === 0 ||
      !pointsNear(normalized.at(-1), point)
    ) {
      normalized.push(Object.freeze([point[0], point[1]]));
    }
  }
  if (
    normalized.length > 2 &&
    pointsNear(normalized[0], normalized.at(-1))
  ) {
    normalized.pop();
  }
  if (normalized.length < 3) {
    return null;
  }

  let twiceArea = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const next = normalized[(index + 1) % normalized.length];
    twiceArea +=
      normalized[index][0] * next[1] -
      next[0] * normalized[index][1];
  }
  const scale = Math.max(
    1,
    ...normalized.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]),
  );
  if (Math.abs(twiceArea) <= scale * scale * 1e-12) {
    return null;
  }

  return Object.freeze(normalized.map((point) => wipeoutPoint(entity, point)));
}

function polygonProjection(points) {
  const origin = points[0];
  let normal = [0, 0, 0];
  for (let index = 1; index + 1 < points.length; index += 1) {
    const first = points[index].map(
      (coordinate, axis) => coordinate - origin[axis],
    );
    const second = points[index + 1].map(
      (coordinate, axis) => coordinate - origin[axis],
    );
    normal = [
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    ];
    if (Math.hypot(...normal) > 1e-12) {
      break;
    }
  }
  const absolute = normal.map(Math.abs);
  const dominant = absolute.indexOf(Math.max(...absolute));
  const axes =
    dominant === 0 ? [1, 2] : dominant === 1 ? [0, 2] : [0, 1];
  return points.flatMap((point) => [point[axes[0]], point[axes[1]]]);
}

function triangulateBoundary(points) {
  const coordinates = polygonProjection(points);
  const indices = earcut(coordinates, null, 2);
  const measuredDeviation = deviation(
    coordinates,
    null,
    2,
    indices,
  );
  if (
    indices.length === 0 ||
    indices.length % 3 !== 0 ||
    !Number.isFinite(measuredDeviation) ||
    measuredDeviation > MAXIMUM_TRIANGULATION_DEVIATION
  ) {
    return null;
  }
  return Object.freeze(indices);
}

function disabledPlan(diagnostics, reason, masks = []) {
  return Object.freeze({
    enabled: false,
    reason,
    owners: new Map(),
    blockSpans: new Uint32Array(0),
    masks: Object.freeze(masks),
    maximumExpandedMasks: 0,
    generalOrderEnabled: false,
    modelOwnerHandle: null,
    diagnostics: Object.freeze({ ...diagnostics, reason }),
  });
}

function readOrderedEntity(source, index, target) {
  if (typeof source.readDisplayRecord === "function") {
    return source.readDisplayRecord(index, target);
  }
  if (typeof source.readEntity === "function") {
    return source.readEntity(index, target);
  }
  if (typeof source.get === "function") {
    return source.get(index);
  }
  throw new TypeError("ordered entity source is not readable");
}

function checkedContribution(value, diagnostics) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_GLOBAL_MASK_BUCKET
  ) {
    diagnostics.bucketLimit += 1;
    throw new RangeError("expanded WIPEOUT order exceeds its bucket limit");
  }
  return value;
}

export function buildMaskOrderPlan(
  drawOrder,
  wipeoutSource,
  blocks,
  inserts,
  {
    maximumDepth = DEFAULT_MAXIMUM_DEPTH,
    maximumEvents = DEFAULT_MAXIMUM_EVENTS,
    orderedEntitySources = [],
    includeOverrideTargets = true,
    reservedBlockSpans = null,
  } = {},
) {
  const diagnostics = {
    tables: drawOrder.length,
    entries: drawOrder.entryCount,
    sourceMasks: wipeoutSource.length,
    sourceOrderedEntities: 0,
    activeOrderedEntities: 0,
    activeMasks: 0,
    events: 0,
    conflictingOverrides: 0,
    duplicateEventKeys: 0,
    invalidMasks: 0,
    invertedMasks: 0,
    invalidTargets: 0,
    cycles: 0,
    depthLimit: 0,
    localBucketLimit: 0,
    bucketLimit: 0,
    multipleModelRoots: 0,
    reservedBlockSpans: 0,
    reservedInsertEvents: 0,
  };
  if (
    !Number.isInteger(maximumDepth) ||
    maximumDepth < 1 ||
    !Number.isInteger(maximumEvents) ||
    maximumEvents < 1
  ) {
    throw new RangeError("mask-order limits must be positive integers");
  }
  if (!Array.isArray(orderedEntitySources)) {
    throw new TypeError("ordered entity sources must be an array");
  }
  if (typeof includeOverrideTargets !== "boolean") {
    throw new TypeError("draw-order override target mode must be boolean");
  }
  if (
    reservedBlockSpans !== null &&
    (!(reservedBlockSpans instanceof Uint32Array) ||
      reservedBlockSpans.length !== blocks.length)
  ) {
    throw new TypeError(
      "reserved block spans must be a block-sized Uint32Array",
    );
  }
  const reservedBlockSpan = (blockIndex) =>
    reservedBlockSpans?.[blockIndex] ?? 0;
  diagnostics.reservedBlockSpans = reservedBlockSpans
    ? reservedBlockSpans.reduce(
        (count, span) => count + (span > 0 ? 1 : 0),
        0,
      )
    : 0;
  const modelBlocks = blocks.filter(
    (block) => block.name.toUpperCase() === "*MODEL_SPACE",
  );
  const modelOwnerHandle =
    modelBlocks.length === 1 ? modelBlocks[0].handle : null;
  const canonicalOwner = (ownerHandle) =>
    ownerHandle === 0n && modelOwnerHandle !== null
      ? modelOwnerHandle
      : ownerHandle;

  const ownerBuilders = new Map();
  const ownerBuilder = (ownerHandle) => {
    let owner = ownerBuilders.get(ownerHandle);
    if (!owner) {
      owner = {
        ownerHandle,
        overrides: new Map(),
        events: [],
        eventByHandle: new Map(),
      };
      ownerBuilders.set(ownerHandle, owner);
    }
    return owner;
  };
  const addEvent = (ownerHandle, event) => {
    const owner = ownerBuilder(canonicalOwner(ownerHandle));
    const existing = owner.eventByHandle.get(event.handle);
    if (!existing) {
      owner.events.push(event);
      owner.eventByHandle.set(event.handle, event);
      return event;
    }
    if (event.kind === "entity") {
      return existing;
    }
    if (existing.kind !== "entity" && existing.kind !== event.kind) {
      diagnostics.duplicateEventKeys += 1;
      return existing;
    }
    Object.assign(existing, event);
    return existing;
  };

  const tableTarget = {};
  const entryTarget = {};
  for (let tableIndex = 0; tableIndex < drawOrder.length; tableIndex += 1) {
    const table = drawOrder.readTable(tableIndex, tableTarget);
    const owner = ownerBuilder(canonicalOwner(table.ownerHandle));
    for (let index = 0; index < table.entryCount; index += 1) {
      const entry = drawOrder.readEntry(table.firstEntry + index, entryTarget);
      const existing = owner.overrides.get(entry.entityHandle);
      if (existing !== undefined && existing !== entry.sortHandle) {
        diagnostics.conflictingOverrides += 1;
        continue;
      }
      owner.overrides.set(entry.entityHandle, entry.sortHandle);
      if (includeOverrideTargets) {
        addEvent(owner.ownerHandle, {
          kind: "entity",
          handle: entry.entityHandle,
          targetBlockIndex: null,
          cellCount: 1,
          contribution: 1,
          prefix: 0,
          mask: null,
        });
      }
    }
  }
  if (diagnostics.conflictingOverrides > 0) {
    return disabledPlan(diagnostics, "conflicting-sort-overrides");
  }

  const maskTarget = {
    insertionPoint: [0, 0, 0],
    uVector: [0, 0, 0],
    vVector: [0, 0, 0],
    size: [0, 0],
  };
  const masks = [];
  for (let index = 0; index < wipeoutSource.length; index += 1) {
    const entity = wipeoutSource.readEntity(index, maskTarget);
    if (
      (entity.displayProperties & 1) === 0 ||
      (entity.commonFlags & 1) !== 0
    ) {
      continue;
    }
    diagnostics.activeMasks += 1;
    if (
      entity.clippingEnabled &&
      (entity.displayProperties & 4) !== 0 &&
      entity.clipMode === 1
    ) {
      diagnostics.invertedMasks += 1;
      continue;
    }
    const points = wipeoutBoundary(wipeoutSource, entity);
    const triangles = points ? triangulateBoundary(points) : null;
    if (!points || !triangles) {
      diagnostics.invalidMasks += 1;
      continue;
    }
    const mask = {
      index,
      handle: entity.handle,
      ownerHandle: canonicalOwner(entity.ownerHandle),
      layerIndex: entity.layerIndex,
      points,
      triangles,
      localBucket: 0,
    };
    masks.push(mask);
    addEvent(entity.ownerHandle, {
      kind: "mask",
      handle: entity.handle,
      targetBlockIndex: null,
      cellCount: 1,
      contribution: 1,
      prefix: 0,
      mask,
    });
  }
  if (diagnostics.invalidMasks > 0) {
    return disabledPlan(diagnostics, "invalid-mask-boundary", masks);
  }
  if (diagnostics.invertedMasks > 0) {
    return disabledPlan(diagnostics, "inverted-mask-clip", masks);
  }
  if (modelBlocks.length !== 1) {
    diagnostics.multipleModelRoots += 1;
    return disabledPlan(diagnostics, "multiple-model-roots", masks);
  }

  const orderedTarget = {
    insertionPoint: [0, 0, 0],
    normal: [0, 0, 1],
    uVector: [0, 0, 0],
    vVector: [0, 0, 0],
    size: [0, 0],
  };
  for (const source of orderedEntitySources) {
    if (
      !source ||
      !Number.isSafeInteger(source.length) ||
      source.length < 0
    ) {
      throw new TypeError("ordered entity source has an invalid length");
    }
    diagnostics.sourceOrderedEntities += source.length;
    for (let index = 0; index < source.length; index += 1) {
      const entity = readOrderedEntity(source, index, orderedTarget);
      if (
        typeof entity?.handle !== "bigint" ||
        typeof entity?.ownerHandle !== "bigint"
      ) {
        throw new TypeError("ordered entity identity is invalid");
      }
      if ((entity.commonFlags & 1) !== 0) {
        continue;
      }
      diagnostics.activeOrderedEntities += 1;
      addEvent(entity.ownerHandle, {
        kind: "entity",
        handle: entity.handle,
        targetBlockIndex: null,
        cellCount: 1,
        contribution: 1,
        prefix: 0,
        mask: null,
      });
    }
  }

  for (const insert of inserts) {
    const columns = Math.max(insert.columnCount, 1);
    const rows = Math.max(insert.rowCount, 1);
    const cellCount = columns * rows;
    if (!Number.isSafeInteger(cellCount)) {
      diagnostics.bucketLimit += 1;
      return disabledPlan(diagnostics, "insert-array-limit", masks);
    }
    addEvent(insert.ownerHandle, {
      kind: "insert",
      handle: insert.handle,
      targetBlockIndex: insert.blockIndex,
      cellCount,
      contribution: 0,
      prefix: 0,
      mask: null,
    });
  }

  diagnostics.events = [...ownerBuilders.values()].reduce(
    (count, owner) => count + owner.events.length,
    0,
  );
  if (diagnostics.events > maximumEvents) {
    return disabledPlan(diagnostics, "event-limit", masks);
  }
  const hasDrawableOrderEvent = [...ownerBuilders.values()].some(
    (owner) =>
      owner.events.some(
        (event) =>
          event.kind === "mask" ||
          event.kind === "entity" ||
          (event.kind === "insert" &&
            reservedBlockSpan(event.targetBlockIndex) > 0),
      ),
  );
  if (!hasDrawableOrderEvent) {
    return disabledPlan(
      diagnostics,
      "no-critical-events",
      masks,
    );
  }

  for (const owner of ownerBuilders.values()) {
    for (const event of owner.events) {
      event.key = owner.overrides.get(event.handle) ?? event.handle;
    }
    owner.events.sort((left, right) =>
      compareOrder(left.key, left.handle, right.key, right.handle),
    );
    for (let index = 1; index < owner.events.length; index += 1) {
      if (owner.events[index - 1].key === owner.events[index].key) {
        diagnostics.duplicateEventKeys += 1;
      }
    }
  }
  if (diagnostics.duplicateEventKeys > 0) {
    return disabledPlan(diagnostics, "duplicate-event-order", masks);
  }

  const blockSpans = new Uint32Array(blocks.length);
  const states = new Uint8Array(blocks.length);
  const computeBlockSpan = (blockIndex, depth) => {
    if (
      !Number.isInteger(blockIndex) ||
      blockIndex < 0 ||
      blockIndex >= blocks.length
    ) {
      diagnostics.invalidTargets += 1;
      throw new RangeError("INSERT references an invalid block");
    }
    if (depth > maximumDepth) {
      diagnostics.depthLimit += 1;
      throw new RangeError("mask-order block nesting exceeds its depth limit");
    }
    if (states[blockIndex] === 2) {
      return blockSpans[blockIndex];
    }
    if (states[blockIndex] === 1) {
      diagnostics.cycles += 1;
      throw new RangeError("mask-order block graph contains a cycle");
    }
    states[blockIndex] = 1;
    const owner = ownerBuilders.get(blocks[blockIndex].handle);
    let span = 0;
    for (const event of owner?.events ?? []) {
      event.prefix = span;
      if (event.kind === "mask" || event.kind === "entity") {
        event.contribution = 1;
        if (event.mask) {
          event.mask.localBucket = span + 1;
        }
      } else {
        const childSpan = computeBlockSpan(
          event.targetBlockIndex,
          depth + 1,
        );
        event.contribution = checkedContribution(
          childSpan * event.cellCount,
          diagnostics,
        );
      }
      span = checkedContribution(span + event.contribution, diagnostics);
      if (span > MAX_LOCAL_MASK_BUCKET) {
        diagnostics.localBucketLimit += 1;
        throw new RangeError("block WIPEOUT order exceeds style-bit capacity");
      }
    }
    const reserved = reservedBlockSpan(blockIndex);
    if (reserved > 0) {
      span = checkedContribution(Math.max(span, reserved), diagnostics);
      if (span > MAX_LOCAL_MASK_BUCKET) {
        diagnostics.localBucketLimit += 1;
        throw new RangeError("reserved block order exceeds style-bit capacity");
      }
    }
    blockSpans[blockIndex] = span;
    states[blockIndex] = 2;
    return span;
  };

  try {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      computeBlockSpan(blockIndex, 1);
    }
  } catch {
    const reason =
      diagnostics.cycles > 0
        ? "block-cycle"
        : diagnostics.depthLimit > 0
          ? "block-depth-limit"
          : diagnostics.invalidTargets > 0
            ? "invalid-insert-target"
            : diagnostics.localBucketLimit > 0
              ? "local-bucket-limit"
              : "global-bucket-limit";
    return disabledPlan(diagnostics, reason, masks);
  }

  const modelIndices = modelBlocks.map((block) => block.index);
  const activeModelRoots = modelIndices.filter(
    (blockIndex) => blockSpans[blockIndex] > 0,
  );
  if (activeModelRoots.length > 1) {
    diagnostics.multipleModelRoots += 1;
    return disabledPlan(diagnostics, "multiple-model-roots", masks);
  }
  const maximumExpandedMasks =
    activeModelRoots.length === 0 ? 0 : blockSpans[activeModelRoots[0]];
  if (maximumExpandedMasks > MAX_GLOBAL_MASK_BUCKET) {
    diagnostics.bucketLimit += 1;
    return disabledPlan(diagnostics, "global-bucket-limit", masks);
  }

  const owners = new Map();
  for (const [ownerHandle, owner] of ownerBuilders) {
    owners.set(
      ownerHandle,
      Object.freeze({
        ownerHandle,
        overrides: owner.overrides,
        events: Object.freeze(
          owner.events.map((event) =>
            Object.freeze({
              kind: event.kind,
              handle: event.handle,
              key: event.key,
              targetBlockIndex: event.targetBlockIndex,
              cellCount: event.cellCount,
              contribution: event.contribution,
              prefix: event.prefix,
            }),
          ),
        ),
      }),
    );
  }
  diagnostics.reservedInsertEvents = [...ownerBuilders.values()].reduce(
    (count, owner) =>
      count +
      owner.events.filter(
        (event) =>
          event.kind === "insert" &&
          reservedBlockSpan(event.targetBlockIndex) > 0,
      ).length,
    0,
  );
  return Object.freeze({
    enabled: true,
    generalOrderEnabled:
      diagnostics.activeOrderedEntities > 0 ||
      diagnostics.reservedInsertEvents > 0,
    reason: null,
    owners,
    blockSpans,
    masks: Object.freeze(
      masks.map((mask) =>
        Object.freeze({
          ...mask,
          points: Object.freeze([...mask.points]),
          triangles: Object.freeze([...mask.triangles]),
        }),
      ),
    ),
    maximumExpandedMasks,
    modelOwnerHandle,
    diagnostics: Object.freeze({ ...diagnostics, reason: null }),
  });
}

function ownerOrder(plan, ownerHandle) {
  if (!plan?.enabled) {
    return undefined;
  }
  const canonical =
    ownerHandle === 0n && plan.modelOwnerHandle !== null
      ? plan.modelOwnerHandle
      : ownerHandle;
  return plan.owners.get(canonical);
}

function entityPosition(owner, entityHandle) {
  const key = owner.overrides.get(entityHandle) ?? entityHandle;
  let low = 0;
  let high = owner.events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const event = owner.events[middle];
    if (compareOrder(event.key, event.handle, key, entityHandle) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function maskBucketBefore(plan, ownerHandle, entityHandle) {
  const owner = ownerOrder(plan, ownerHandle);
  if (!owner || owner.events.length === 0) {
    return 0;
  }
  const position = entityPosition(owner, entityHandle);
  if (position >= owner.events.length) {
    const last = owner.events.at(-1);
    return last.prefix + last.contribution;
  }
  return owner.events[position].prefix;
}

export function maskBucketFor(plan, ownerHandle, entityHandle) {
  const owner = ownerOrder(plan, ownerHandle);
  if (!owner || owner.events.length === 0) {
    return 0;
  }
  const position = entityPosition(owner, entityHandle);
  const event = owner.events[position];
  if (
    event &&
    event.kind !== "insert" &&
    event.handle === entityHandle
  ) {
    return event.prefix + 1;
  }
  if (position >= owner.events.length) {
    const last = owner.events.at(-1);
    return last.prefix + last.contribution;
  }
  return event.prefix;
}

export function maskSpanForBlock(plan, blockIndex) {
  if (
    !plan?.enabled ||
    !Number.isInteger(blockIndex) ||
    blockIndex < 0 ||
    blockIndex >= plan.blockSpans.length
  ) {
    return 0;
  }
  return plan.blockSpans[blockIndex];
}

export function encodeMaskBucket(style, bucket) {
  if (
    !Number.isInteger(bucket) ||
    bucket < 0 ||
    bucket > MAX_LOCAL_MASK_BUCKET
  ) {
    throw new RangeError("local mask bucket exceeds style-bit capacity");
  }
  return (
    (style & ((1 << MASK_BUCKET_STYLE_SHIFT) - 1)) |
    (bucket << MASK_BUCKET_STYLE_SHIFT)
  ) >>> 0;
}

export function decodeMaskBucket(style) {
  return style >>> MASK_BUCKET_STYLE_SHIFT;
}
