import assert from "node:assert/strict";
import test from "node:test";

import { buildInstanceGraph } from "../src/instance-graph.mjs";
import {
  instanceIsVisible,
  refreshInstanceVisibility,
} from "../src/instance-visibility.mjs";
import {
  batchRelativeInstanceMatrix,
  packedBoundsIntersect2D,
  rotationZMat4,
  transformedBounds2D,
  transformPoint,
} from "../src/math.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import { SceneCacheReader } from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

test("resolves nested block instances without copying block geometry", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const [blocks, inserts] = await Promise.all([
    reader.readBlocks(),
    reader.readInserts(),
  ]);
  const graph = buildInstanceGraph(blocks, inserts);

  assert.equal(graph.instanceCount, 2);
  assert.equal(graph.instancesByBlock.get(1).length, 1);
  assert.equal(graph.instancesByBlock.get(2).length, 1);
  assert.equal(
    graph.instancesByBlock.get(1).handles[0],
    inserts.find((insert) => insert.blockIndex === 1).handle,
  );
  assert.equal(
    graph.instancesByBlock.get(2).handles[0],
    inserts.find((insert) => insert.blockIndex === 2).handle,
  );
  assert.deepEqual(graph.diagnostics, {
    invalidOwner: 0,
    invalidTarget: 0,
    cycles: 0,
    depthLimit: 0,
    instanceLimit: 0,
    invalidClip: 0,
  });

  const blockAOrigin = transformPoint(
    graph.instancesByBlock.get(1).data,
    blocks[1].basePoint,
  );
  assert.deepEqual(blockAOrigin, [100, 200, 0]);

  const nestedOrigin = transformPoint(
    graph.instancesByBlock.get(2).data,
    blocks[2].basePoint,
  );
  assert.deepEqual(nestedOrigin, [90, 200, 0]);
});

test("propagates an INSERT XCLIP through nested block instances", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const metadata = await reader.readRenderMetadata();
  const graph = buildInstanceGraph(metadata.blocks, metadata.inserts, {
    insertClips: metadata.insertClips,
  });

  assert.equal(graph.clipNodes.length, 1);
  assert.equal(graph.instancesByBlock.get(1).clipIds[0], 1);
  assert.equal(graph.instancesByBlock.get(2).clipIds[0], 1);
  assert.deepEqual(graph.clipNodes[0].points, [
    [100, 240, 0],
    [140, 240, 0],
    [140, 280, 0],
    [100, 280, 0],
  ]);
});

test("inherits ByBlock color and Layer 0 from the containing INSERT", () => {
  const blocks = [
    { index: 0, handle: 100n, name: "*Model_Space", basePoint: [0, 0, 0] },
    { index: 1, handle: 101n, name: "A", basePoint: [0, 0, 0] },
    { index: 2, handle: 102n, name: "B", basePoint: [0, 0, 0] },
  ];
  const layers = [
    { name: "0", color: (2 << 30) | 1 },
    { name: "A-WALL", color: (2 << 30) | 5 },
  ];
  const insert = ({
    handle,
    ownerHandle,
    blockIndex,
    layerIndex,
    color,
    linetypeCode,
  }) => ({
    handle,
    ownerHandle,
    blockIndex,
    layerIndex,
    color,
    linetypeCode,
    columnCount: 1,
    rowCount: 1,
    insertPoint: [0, 0, 0],
    scale: [1, 1, 1],
    rotation: 0,
    normal: [0, 0, 1],
    columnSpacing: 0,
    rowSpacing: 0,
  });
  const graph = buildInstanceGraph(
    blocks,
    [
      insert({
        handle: 201n,
        ownerHandle: 100n,
        blockIndex: 1,
        layerIndex: 1,
        color: ((33 << 24) | (2 << 30) | 3) >>> 0,
        linetypeCode: 3,
      }),
      insert({
        handle: 202n,
        ownerHandle: 101n,
        blockIndex: 2,
        layerIndex: 0,
        color: ((2 << 24) | (1 << 30)) >>> 0,
        linetypeCode: 1,
      }),
    ],
    {
      layers,
      layerLinetypeCodes: new Uint16Array([2, 8]),
    },
  );

  const outer = graph.instancesByBlock.get(1);
  const nested = graph.instancesByBlock.get(2);
  assert.equal(
    outer.colors[0],
    ((33 << 24) | (2 << 30) | 3) >>> 0,
  );
  assert.equal(outer.layerIndices[0], 1);
  assert.equal(
    nested.colors[0],
    ((33 << 24) | (2 << 30) | 3) >>> 0,
  );
  assert.equal(nested.layerIndices[0], 1);
  assert.equal(nested.colorInherited[0], 0);
  assert.equal(nested.layerInherited[0], 0);
  assert.equal(nested.opacities[0], 0.5);
  assert.equal(nested.opacityInherited[0], 0);
  assert.equal(outer.linetypeCodes[0], 3);
  assert.equal(nested.linetypeCodes[0], 3);
  assert.equal(nested.linetypeInherited[0], 0);
  assert.equal(graph.layerZeroIndex, 0);
});

test("intersects nested INSERT layer and entity visibility", () => {
  const blocks = [
    { index: 0, handle: 100n, name: "*Model_Space", basePoint: [0, 0, 0] },
    { index: 1, handle: 101n, name: "OUTER", basePoint: [0, 0, 0] },
    { index: 2, handle: 102n, name: "CHILD", basePoint: [0, 0, 0] },
    { index: 3, handle: 103n, name: "SIBLING", basePoint: [0, 0, 0] },
  ];
  const layers = [
    { name: "0", color: (2 << 30) | 7, flags: 0 },
    { name: "HIDDEN-PARENT", color: (2 << 30) | 1, flags: 1 },
    { name: "VISIBLE-CHILD", color: (2 << 30) | 2, flags: 0 },
  ];
  const insert = ({
    handle,
    ownerHandle,
    blockIndex,
    layerIndex,
    flags = 0,
  }) => ({
    handle,
    ownerHandle,
    blockIndex,
    layerIndex,
    flags,
    color: 0,
    lineWeight: -1,
    linetypeCode: 0,
    columnCount: 1,
    rowCount: 1,
    insertPoint: [0, 0, 0],
    scale: [1, 1, 1],
    rotation: 0,
    normal: [0, 0, 1],
    columnSpacing: 0,
    rowSpacing: 0,
  });
  const graph = buildInstanceGraph(
    blocks,
    [
      insert({
        handle: 201n,
        ownerHandle: 100n,
        blockIndex: 1,
        layerIndex: 1,
      }),
      insert({
        handle: 202n,
        ownerHandle: 101n,
        blockIndex: 2,
        layerIndex: 2,
      }),
      insert({
        handle: 203n,
        ownerHandle: 100n,
        blockIndex: 3,
        layerIndex: 2,
        flags: 1,
      }),
    ],
    { layers },
  );
  const outer = graph.instancesByBlock.get(1);
  const child = graph.instancesByBlock.get(2);
  const sibling = graph.instancesByBlock.get(3);

  assert.equal(instanceIsVisible(outer, 0), false);
  assert.equal(instanceIsVisible(child, 0), false);
  assert.equal(instanceIsVisible(sibling, 0), false);

  refreshInstanceVisibility(graph, [true, true, true]);
  assert.equal(instanceIsVisible(outer, 0), true);
  assert.equal(instanceIsVisible(child, 0), true);
  assert.equal(instanceIsVisible(sibling, 0), false);

  refreshInstanceVisibility(graph, [true, true, false]);
  assert.equal(instanceIsVisible(outer, 0), true);
  assert.equal(instanceIsVisible(child, 0), false);
});

test("dimension picture references inherit their owner's world transform", () => {
  const blocks = [
    { index: 0, handle: 100n, name: "*Model_Space", basePoint: [0, 0, 0] },
    { index: 1, handle: 101n, name: "OWNER", basePoint: [10, 20, 0] },
    { index: 2, handle: 102n, name: "*D1", basePoint: [3, 4, 0] },
  ];
  const makeInstance = ({
    handle,
    ownerHandle,
    blockIndex,
    insertPoint,
    columnCount = 1,
  }) => ({
    handle,
    ownerHandle,
    blockIndex,
    columnCount,
    rowCount: 1,
    insertPoint,
    scale: [1, 1, 1],
    rotation: 0,
    normal: [0, 0, 1],
    columnSpacing: 0,
    rowSpacing: 0,
  });
  const graph = buildInstanceGraph(blocks, [
    makeInstance({
      handle: 201n,
      ownerHandle: 100n,
      blockIndex: 1,
      insertPoint: [100, 200, 0],
    }),
    makeInstance({
      handle: 202n,
      ownerHandle: 101n,
      blockIndex: 2,
      insertPoint: [3, 4, 0],
    }),
  ]);

  const ownerMatrix = graph.instancesByBlock.get(1).data;
  const pictureMatrix = graph.instancesByBlock.get(2).data;
  assert.equal(graph.instanceCount, 2);
  assert.equal(graph.instancesByBlock.get(1).handles[0], 201n);
  assert.equal(graph.instancesByBlock.get(2).handles[0], 202n);
  assert.deepEqual([...pictureMatrix], [...ownerMatrix]);
  assert.deepEqual(transformPoint(pictureMatrix, [7, 8, 0]), [97, 188, 0]);
});

test("bounds invalid, cyclic, deep, and oversized instance graphs", () => {
  const blocks = [
    { index: 0, handle: 100n, name: "*Model_Space", basePoint: [0, 0, 0] },
    { index: 1, handle: 101n, name: "A", basePoint: [0, 0, 0] },
    { index: 2, handle: 102n, name: "B", basePoint: [0, 0, 0] },
  ];
  const instance = (ownerHandle, blockIndex, columnCount = 1) => ({
    ownerHandle,
    blockIndex,
    columnCount,
    rowCount: 1,
    insertPoint: [0, 0, 0],
    scale: [1, 1, 1],
    rotation: 0,
    normal: [0, 0, 1],
    columnSpacing: 1,
    rowSpacing: 0,
  });

  const malformed = buildInstanceGraph(blocks, [
    instance(999n, 1),
    instance(100n, 99),
    instance(100n, 1),
    instance(101n, 1),
  ]);
  assert.equal(malformed.diagnostics.invalidOwner, 1);
  assert.equal(malformed.diagnostics.invalidTarget, 1);
  assert.equal(malformed.diagnostics.cycles, 1);

  const deep = buildInstanceGraph(
    blocks,
    [instance(100n, 1), instance(101n, 2)],
    { maximumDepth: 1 },
  );
  assert.equal(deep.instanceCount, 1);
  assert.equal(deep.diagnostics.depthLimit, 1);

  const oversized = buildInstanceGraph(
    blocks,
    [instance(100n, 1, 2)],
    { maximumInstances: 1 },
  );
  assert.equal(oversized.instanceCount, 1);
  assert.equal(oversized.diagnostics.instanceLimit, 1);
  assert.equal(oversized.truncated, true);
});

test("camera rebasing keeps a small batch offset at a large world coordinate", () => {
  const world = new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    1_000_000_000.25, 1_000_000_000.5, 0, 1,
  ]);
  const relative = batchRelativeInstanceMatrix(
    world,
    [0.125, 0.25, 0],
    [1_000_000_000, 1_000_000_000, 0],
  );

  assert.equal(relative[12], 0.375);
  assert.equal(relative[13], 0.75);
});

test("transforms an AABB for viewport intersection without expanding corners", () => {
  const rotation = rotationZMat4(Math.PI / 2);
  rotation[12] = 10;
  rotation[13] = 20;
  const transformed = transformedBounds2D(
    { min: [-2, -1, 0], max: [2, 1, 0] },
    rotation,
  );

  assert.ok(Math.abs(transformed[0] - 9) < 1e-12);
  assert.ok(Math.abs(transformed[1] - 18) < 1e-12);
  assert.ok(Math.abs(transformed[2] - 11) < 1e-12);
  assert.ok(Math.abs(transformed[3] - 22) < 1e-12);
  assert.equal(
    packedBoundsIntersect2D(transformed, {
      min: [10.5, 21, -Infinity],
      max: [12, 23, Infinity],
    }),
    true,
  );
});
