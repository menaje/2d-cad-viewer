import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMaskOrderToInstanceGraph,
  buildInstanceGraph,
  CoordinateSpaceKind,
} from "../src/instance-graph.mjs";
import {
  identityMat4,
  translationMat4,
} from "../src/math.mjs";
import {
  buildMaskOrderPlan,
  decodeMaskBucket,
  encodeMaskBucket,
  MAX_GLOBAL_MASK_BUCKET,
  maskBucketBefore,
  maskBucketFor,
  maskSpanForBlock,
} from "../src/mask-order.mjs";

function makeDrawOrder(tables) {
  const entries = tables.flatMap((table) => table.entries);
  const firstEntries = [];
  let firstEntry = 0;
  for (const table of tables) {
    firstEntries.push(firstEntry);
    firstEntry += table.entries.length;
  }
  return {
    length: tables.length,
    entryCount: entries.length,
    readTable(index, target) {
      Object.assign(target, {
        index,
        handle: tables[index].handle,
        ownerHandle: tables[index].ownerHandle,
        firstEntry: firstEntries[index],
        entryCount: tables[index].entries.length,
      });
      return target;
    },
    readEntry(index, target) {
      Object.assign(target, entries[index], { index });
      return target;
    },
  };
}

function makeWipeouts(records) {
  return {
    length: records.length,
    readEntity(index, target) {
      Object.assign(target, records[index]);
      target.insertionPoint = [...records[index].insertionPoint];
      target.uVector = [...records[index].uVector];
      target.vVector = [...records[index].vVector];
      target.size = [...records[index].size];
      return target;
    },
    readClipVertex() {
      throw new Error("full-image masks do not read clip vertices");
    },
  };
}

function makeOrderedEntities(records) {
  return {
    length: records.length,
    readEntity(index, target) {
      return Object.assign(target, records[index]);
    },
  };
}

function insert({
  handle,
  ownerHandle,
  blockIndex,
  columnCount = 1,
}) {
  return {
    handle,
    ownerHandle,
    blockIndex,
    columnCount,
    rowCount: 1,
    insertPoint: [0, 0, 0],
    scale: [1, 1, 1],
    rotation: 0,
    normal: [0, 0, 1],
    columnSpacing: 10,
    rowSpacing: 0,
  };
}

function wipeout(handle, ownerHandle) {
  return {
    handle,
    ownerHandle,
    layerIndex: 0,
    commonFlags: 0,
    displayProperties: 1,
    clippingEnabled: false,
    clipType: 1,
    clipVertexCount: 0,
    firstClipVertex: 0,
    insertionPoint: [0, 0, 0],
    uVector: [1, 0, 0],
    vVector: [0, 1, 0],
    size: [2, 2],
  };
}

const blocks = [
  { index: 0, handle: 100n, name: "*Model_Space", basePoint: [0, 0, 0] },
  { index: 1, handle: 101n, name: "A", basePoint: [0, 0, 0] },
  { index: 2, handle: 102n, name: "B", basePoint: [0, 0, 0] },
];

test("compresses nested and array INSERT draw order into mask buckets", () => {
  const inserts = [
    insert({ handle: 10n, ownerHandle: 100n, blockIndex: 1 }),
    insert({
      handle: 20n,
      ownerHandle: 101n,
      blockIndex: 2,
      columnCount: 2,
    }),
  ];
  const plan = buildMaskOrderPlan(
    makeDrawOrder([
      {
        handle: 900n,
        ownerHandle: 101n,
        entries: [{ entityHandle: 30n, sortHandle: 15n }],
      },
    ]),
    makeWipeouts([
      wipeout(11n, 101n),
      wipeout(30n, 101n),
      wipeout(25n, 102n),
    ]),
    blocks,
    inserts,
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.generalOrderEnabled, false);
  assert.equal(maskSpanForBlock(plan, 2), 1);
  assert.equal(maskSpanForBlock(plan, 1), 4);
  assert.equal(maskSpanForBlock(plan, 0), 4);
  assert.equal(plan.maximumExpandedMasks, 4);
  assert.equal(maskBucketFor(plan, 101n, 11n), 1);
  assert.equal(maskBucketBefore(plan, 101n, 11n), 0);
  assert.equal(maskBucketFor(plan, 101n, 30n), 2);
  assert.equal(maskBucketBefore(plan, 101n, 20n), 2);
  assert.equal(maskBucketFor(plan, 101n, 21n), 4);

  const graph = buildInstanceGraph(blocks, inserts, { maskOrder: plan });
  assert.equal(graph.maskOrderEnabled, true);
  assert.deepEqual(
    [...graph.instancesByBlock.get(1).maskBases],
    [0],
  );
  assert.deepEqual(
    [...graph.instancesByBlock.get(2).maskBases],
    [2, 3],
  );
  const baseGraph = buildInstanceGraph(blocks, inserts);
  const attached = applyMaskOrderToInstanceGraph(
    baseGraph,
    blocks,
    plan,
  );
  assert.equal(
    attached.instancesByBlock.get(1).data,
    baseGraph.instancesByBlock.get(1).data,
  );
  assert.deepEqual(
    [...attached.instancesByBlock.get(2).maskBases],
    [2, 3],
  );
});

test("attaches mask order to paper and repeated model viewport roots", () => {
  const layoutBlocks = [
    blocks[0],
    {
      index: 1,
      handle: 101n,
      name: "*Paper_Space",
      basePoint: [0, 0, 0],
    },
    { index: 2, handle: 102n, name: "A", basePoint: [0, 0, 0] },
  ];
  const layoutInserts = [
    insert({ handle: 10n, ownerHandle: 100n, blockIndex: 2 }),
    insert({ handle: 11n, ownerHandle: 101n, blockIndex: 2 }),
  ];
  const plan = buildMaskOrderPlan(
    makeDrawOrder([]),
    makeWipeouts([
      wipeout(5n, 100n),
      wipeout(6n, 101n),
    ]),
    layoutBlocks,
    layoutInserts,
  );
  const rootContexts = [
    {
      blockIndex: 1,
      matrix: identityMat4(),
      measurementMatrix: identityMat4(),
      coordinateSpace: CoordinateSpaceKind.Paper,
      includeRootBatch: true,
      modelSpace: false,
      visibilityRow: 0,
    },
    {
      blockIndex: 0,
      matrix: identityMat4(),
      measurementMatrix: identityMat4(),
      coordinateSpace: CoordinateSpaceKind.Model,
      includeRootBatch: false,
      modelSpace: true,
      visibilityRow: 0,
    },
    {
      blockIndex: 0,
      matrix: translationMat4(100, 0, 0),
      measurementMatrix: identityMat4(),
      coordinateSpace: CoordinateSpaceKind.Model,
      includeRootBatch: false,
      modelSpace: true,
      visibilityRow: 0,
    },
  ];
  const options = {
    layers: [],
    rootContexts,
    layerVisibilityRows: [new Uint8Array(0)],
  };
  const expected = buildInstanceGraph(layoutBlocks, layoutInserts, {
    ...options,
    maskOrder: plan,
  });
  const base = buildInstanceGraph(
    layoutBlocks,
    layoutInserts,
    options,
  );
  const attached = applyMaskOrderToInstanceGraph(
    base,
    layoutBlocks,
    plan,
  );

  assert.equal(attached.maskOrderEnabled, true);
  assert.equal(
    attached.instancesByBlock.get(2).data,
    base.instancesByBlock.get(2).data,
  );
  assert.deepEqual(
    [...attached.instancesByBlock.get(1).maskBases],
    [...expected.instancesByBlock.get(1).maskBases],
  );
  assert.deepEqual(
    [...attached.instancesByBlock.get(2).maskBases],
    [...expected.instancesByBlock.get(2).maskBases],
  );
  assert.deepEqual(
    [...attached.modelInstances.maskBases],
    [...expected.modelInstances.maskBases],
  );
});

test("reserves one root-order interval for an external-reference insert", () => {
  const plan = buildMaskOrderPlan(
    makeDrawOrder([]),
    makeWipeouts([]),
    blocks,
    [insert({ handle: 10n, ownerHandle: 100n, blockIndex: 1 })],
    { reservedBlockSpans: new Uint32Array([0, 1, 0]) },
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.generalOrderEnabled, true);
  assert.equal(maskSpanForBlock(plan, 1), 1);
  assert.equal(maskSpanForBlock(plan, 0), 1);
  assert.equal(plan.maximumExpandedMasks, 1);
  assert.equal(plan.diagnostics.reservedInsertEvents, 1);
});

test("uses non-line entities and sort overrides as shared draw-order boundaries", () => {
  const plan = buildMaskOrderPlan(
    makeDrawOrder([
      {
        handle: 910n,
        ownerHandle: 100n,
        entries: [{ entityHandle: 80n, sortHandle: 15n }],
      },
    ]),
    makeWipeouts([]),
    blocks,
    [],
    {
      orderedEntitySources: [
        makeOrderedEntities([
          { handle: 10n, ownerHandle: 100n, commonFlags: 0 },
          { handle: 20n, ownerHandle: 100n, commonFlags: 0 },
          { handle: 90n, ownerHandle: 100n, commonFlags: 1 },
        ]),
      ],
    },
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.generalOrderEnabled, true);
  assert.equal(plan.masks.length, 0);
  assert.equal(plan.diagnostics.sourceOrderedEntities, 3);
  assert.equal(plan.diagnostics.activeOrderedEntities, 2);
  assert.equal(plan.maximumExpandedMasks, 3);
  assert.equal(maskBucketFor(plan, 100n, 5n), 0);
  assert.equal(maskBucketFor(plan, 100n, 10n), 1);
  assert.equal(maskBucketFor(plan, 100n, 80n), 2);
  assert.equal(maskBucketFor(plan, 100n, 17n), 2);
  assert.equal(maskBucketFor(plan, 100n, 20n), 3);
  assert.equal(maskBucketFor(plan, 100n, 90n), 3);
});

test("disables all masks on cyclic block graphs", () => {
  const cyclicBlocks = [
    ...blocks,
    { index: 3, handle: 103n, name: "C", basePoint: [0, 0, 0] },
  ];
  const plan = buildMaskOrderPlan(
    makeDrawOrder([]),
    makeWipeouts([wipeout(31n, 103n)]),
    cyclicBlocks,
    [
      insert({ handle: 40n, ownerHandle: 103n, blockIndex: 3 }),
    ],
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, "block-cycle");
  assert.equal(plan.diagnostics.cycles, 1);
});

test("disables all masks on duplicate critical sort keys", () => {
  const plan = buildMaskOrderPlan(
    makeDrawOrder([
      {
        handle: 901n,
        ownerHandle: 100n,
        entries: [
          { entityHandle: 41n, sortHandle: 5n },
          { entityHandle: 42n, sortHandle: 5n },
        ],
      },
    ]),
    makeWipeouts([
      wipeout(41n, 100n),
      wipeout(42n, 100n),
    ]),
    blocks,
    [],
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, "duplicate-event-order");
  assert.equal(plan.diagnostics.duplicateEventKeys, 1);
});

test("accepts the complete lossless RGB draw-order bucket range", () => {
  const plan = buildMaskOrderPlan(
    makeDrawOrder([]),
    makeWipeouts([wipeout(25n, 102n)]),
    blocks,
    [
      insert({
        handle: 10n,
        ownerHandle: 100n,
        blockIndex: 2,
        columnCount: MAX_GLOBAL_MASK_BUCKET,
      }),
    ],
  );

  assert.equal(MAX_GLOBAL_MASK_BUCKET, 32_767);
  assert.equal(plan.enabled, true);
  assert.equal(plan.maximumExpandedMasks, MAX_GLOBAL_MASK_BUCKET);
});

test("disables all masks above the lossless RGB draw-order bucket range", () => {
  const plan = buildMaskOrderPlan(
    makeDrawOrder([]),
    makeWipeouts([wipeout(25n, 102n)]),
    blocks,
    [
      insert({
        handle: 10n,
        ownerHandle: 100n,
        blockIndex: 2,
        columnCount: MAX_GLOBAL_MASK_BUCKET + 1,
      }),
    ],
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, "global-bucket-limit");
  assert.equal(plan.diagnostics.bucketLimit, 1);
});

test("disables unsupported inverted clipping instead of masking the wrong side", () => {
  const entity = {
    ...wipeout(50n, 100n),
    displayProperties: 5,
    clippingEnabled: true,
    clipMode: 1,
    clipType: 2,
    clipVertexCount: 4,
    firstClipVertex: 0,
  };
  const source = {
    length: 1,
    readEntity(_index, target) {
      Object.assign(target, entity);
      target.insertionPoint = [...entity.insertionPoint];
      target.uVector = [...entity.uVector];
      target.vVector = [...entity.vVector];
      target.size = [...entity.size];
      return target;
    },
    readClipVertex(index, target) {
      const points = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      target.splice(0, 2, ...points[index]);
      return target;
    },
  };
  const plan = buildMaskOrderPlan(
    makeDrawOrder([]),
    source,
    blocks,
    [],
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, "inverted-mask-clip");
  assert.equal(plan.diagnostics.invertedMasks, 1);
});

test("encodes a local mask bucket without changing lower style bits", () => {
  const original = 0x0001_ffff;
  const encoded = encodeMaskBucket(original, 16_513);

  assert.equal(decodeMaskBucket(encoded), 16_513);
  assert.equal(encoded & 0x0001_ffff, original);
});
