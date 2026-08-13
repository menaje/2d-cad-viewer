import assert from "node:assert/strict";
import test from "node:test";

import { buildInstanceGraph } from "../src/instance-graph.mjs";
import { buildMaskOrderPlan, decodeMaskBucket } from "../src/mask-order.mjs";
import {
  buildPrimitiveMeshes,
  PRIMITIVE_VERTEX_STRIDE,
} from "../src/primitive-mesh.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import {
  GpuLineBatchKind,
  SceneCacheReader,
} from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

async function primitiveFixture() {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const [source, metadata] = await Promise.all([
    reader.readPrimitiveSource(),
    reader.readRenderMetadata(),
  ]);
  const instanceGraph = buildInstanceGraph(
    metadata.blocks,
    metadata.inserts,
  );
  return { source, metadata, instanceGraph };
}

function entityTable(rows) {
  return {
    length: rows.length,
    readEntity(index, target) {
      Object.assign(target, rows[index]);
      return target;
    },
  };
}

function vertexTable(rows) {
  return {
    length: rows.length,
    readVertex(index, target) {
      Object.assign(target, rows[index]);
      target.position = [...rows[index].position];
      return target;
    },
  };
}

function primitivePointsForHandle(scene, handle) {
  const ranges = scene.identityRanges.data;
  const view = new DataView(scene.vertices.buffer);
  const points = [];
  for (let range = 0; range < ranges.length; range += 4) {
    const rangeHandle =
      BigInt(ranges[range + 2]) |
      (BigInt(ranges[range + 3]) << 32n);
    if (rangeHandle !== handle) {
      continue;
    }
    const end = ranges[range] + ranges[range + 1];
    for (let vertex = ranges[range]; vertex < end; vertex += 1) {
      const batch = scene.batches.find(
        (candidate) =>
          vertex >= candidate.firstVertex &&
          vertex < candidate.firstVertex + candidate.vertexCount,
      );
      const offset = vertex * PRIMITIVE_VERTEX_STRIDE;
      points.push(
        batch.origin.map(
          (origin, axis) =>
            origin + view.getFloat32(offset + axis * 4, true),
        ),
      );
    }
  }
  return points;
}

function withPolyline(source, entity, vertices) {
  return {
    ...source,
    polylines: entityTable([entity]),
    polylineVertices: vertexTable(vertices),
  };
}

function verticesForHandle(scene, handle) {
  const view = new DataView(scene.vertices.buffer);
  const points = [];
  for (const batch of scene.batches) {
    for (
      let vertex = batch.firstVertex;
      vertex < batch.firstVertex + batch.vertexCount;
      vertex += 1
    ) {
      const offset = vertex * PRIMITIVE_VERTEX_STRIDE;
      const encodedHandle =
        BigInt(view.getUint32(offset + 20, true)) |
        (BigInt(view.getUint32(offset + 24, true)) << 32n);
      if (encodedHandle !== handle) {
        continue;
      }
      points.push({
        blockIndex: batch.blockIndex,
        point: batch.origin.map(
          (origin, axis) => origin + view.getFloat32(offset + axis * 4, true),
        ),
      });
    }
  }
  return points;
}

test("builds instanced POINT markers and FILLMODE-aware SOLID meshes", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
  );

  assert.equal(result.metrics.sourcePoints, 1);
  assert.equal(result.metrics.renderedPoints, 1);
  assert.equal(result.metrics.sourceSolids, 2);
  assert.equal(result.metrics.renderedFilledSolids, 1);
  assert.equal(result.metrics.renderedOutlineSolids, 1);
  assert.equal(result.metrics.pointVertices, 1);
  assert.equal(result.metrics.solidFillVertices, 6);
  assert.equal(result.metrics.solidOutlineVertices, 6);
  assert.equal(result.metrics.pointGpuBytes, PRIMITIVE_VERTEX_STRIDE);
  assert.equal(
    result.metrics.solidFillGpuBytes,
    6 * PRIMITIVE_VERTEX_STRIDE,
  );
  assert.equal(
    result.metrics.solidOutlineGpuBytes,
    6 * PRIMITIVE_VERTEX_STRIDE,
  );
  assert.deepEqual(
    [...result.points.identityRanges.data],
    [0, 1, 501, 0],
  );
  assert.deepEqual(
    [...result.solidFills.identityRanges.data],
    [0, 6, 601, 0],
  );

  assert.equal(
    result.points.batches[0].kind,
    GpuLineBatchKind.BlockDefinition,
  );
  assert.equal(result.points.batches[0].blockIndex, 1);
  assert.deepEqual(result.points.batches[0].origin, [11, 2, 0]);
  const pointView = new DataView(result.points.vertices.buffer);
  assert.equal(pointView.getUint32(28, true) & 0xffff, 66);
  assert.equal(pointView.getFloat32(24, true), -3);
  assert.ok(
    Math.abs(pointView.getFloat32(20, true) - Math.PI / 6) < 1e-6,
  );

  assert.equal(
    result.solidFills.batches[0].kind,
    GpuLineBatchKind.ModelDetail,
  );
  assert.equal(result.solidFills.batches[0].blockIndex, null);
  assert.equal(
    result.solidOutlines.batches[0].kind,
    GpuLineBatchKind.BlockDefinition,
  );
  assert.equal(result.solidOutlines.batches[0].blockIndex, 1);
});

test("keeps small SOLID fills at large world coordinates", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const origin = [2_000_000, -2_000_000, 0];
  const translated = {
    ...source,
    solids: entityTable([
      {
        handle: 0x1234n,
        ownerHandle: metadata.blocks[0].handle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: 25,
        commonFlags: 0,
        linetypeCode: 0,
        fillMode: true,
        corners: [
          origin,
          [origin[0] + 1.5, origin[1], 0],
          [origin[0] + 1.5, origin[1] + 1.5, 0],
          [origin[0], origin[1] + 1.5, 0],
        ],
        normal: [0, 0, 1],
        thickness: 0,
      },
    ]),
  };

  const result = buildPrimitiveMeshes(
    translated,
    metadata.blocks,
    instanceGraph,
  );

  assert.equal(result.metrics.sourceSolids, 1);
  assert.equal(result.metrics.renderedFilledSolids, 1);
  assert.equal(result.metrics.skippedDegenerateTriangles, 0);
  assert.equal(result.metrics.solidFillVertices, 6);
});

test("renders visible 3DFACE edges in the shared surface buffer", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
  );

  assert.equal(result.metrics.sourceFaces, 5);
  assert.equal(result.metrics.renderedFaces, 5);
  assert.equal(result.metrics.renderedFaceEdges, 15);
  assert.equal(result.metrics.hiddenFaceEdges, 4);
  assert.equal(result.metrics.skippedDegenerateFaceEdges, 1);
  assert.equal(result.metrics.faceOutlineVertices, 30);
  assert.equal(result.metrics.solidOutlineVertices, 6);
  assert.equal(result.metrics.surfaceOutlineVertices, 36);
  assert.equal(
    result.metrics.faceOutlineGpuBytes,
    30 * PRIMITIVE_VERTEX_STRIDE,
  );
  assert.equal(result.metrics.gpuBytes, 43 * PRIMITIVE_VERTEX_STRIDE);
  assert.equal(result.solidOutlines.vertices.vertexCount, 36);
  assert.ok(
    result.solidOutlines.batches.some(
      (batch) =>
        batch.kind === GpuLineBatchKind.BlockDefinition &&
        batch.blockIndex === 1,
    ),
  );
});

test("restores 3DFACE invisible edges when SPLFRAME is enabled", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    { splineFrame: true },
  );

  assert.equal(result.metrics.renderedFaceEdges, 19);
  assert.equal(result.metrics.hiddenFaceEdges, 0);
  assert.equal(result.metrics.restoredFaceEdges, 4);
  assert.equal(result.metrics.faceOutlineVertices, 38);
});

test("renders WIPEOUT polygon, rectangular and full-image frames without masks", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    { wipeoutFrame: metadata.drawing.wipeoutFrame },
  );

  assert.equal(result.metrics.sourceWipeouts, 3);
  assert.equal(result.metrics.deferredWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutFrames, 3);
  assert.equal(result.metrics.renderedWipeoutFrameEdges, 12);
  assert.equal(result.metrics.skippedDegenerateWipeoutEdges, 0);
  assert.equal(result.metrics.wipeoutOutlineVertices, 24);
  assert.equal(
    result.metrics.wipeoutOutlineGpuBytes,
    24 * PRIMITIVE_VERTEX_STRIDE,
  );
  assert.equal(result.metrics.surfaceOutlineVertices, 60);
  assert.equal(result.metrics.gpuBytes, 67 * PRIMITIVE_VERTEX_STRIDE);

  const polygon = verticesForHandle(result.solidOutlines, 801n);
  assert.equal(polygon.length, 8);
  assert.deepEqual(
    [
      Math.min(...polygon.map(({ point }) => point[0])),
      Math.max(...polygon.map(({ point }) => point[0])),
      Math.min(...polygon.map(({ point }) => point[1])),
      Math.max(...polygon.map(({ point }) => point[1])),
    ],
    [50, 54, 0, 3],
  );

  const rectangle = verticesForHandle(result.solidOutlines, 802n);
  assert.equal(rectangle.length, 8);
  assert.ok(rectangle.every(({ blockIndex }) => blockIndex === 1));
  assert.deepEqual(
    [
      Math.min(...rectangle.map(({ point }) => point[0])),
      Math.max(...rectangle.map(({ point }) => point[0])),
      Math.min(...rectangle.map(({ point }) => point[1])),
      Math.max(...rectangle.map(({ point }) => point[1])),
    ],
    [59.5, 67.5, -0.5, 5.5],
  );

  const fullImage = verticesForHandle(result.solidOutlines, 803n);
  assert.equal(fullImage.length, 8);
  assert.deepEqual(
    [
      Math.min(...fullImage.map(({ point }) => point[0])),
      Math.max(...fullImage.map(({ point }) => point[0])),
      Math.min(...fullImage.map(({ point }) => point[1])),
      Math.max(...fullImage.map(({ point }) => point[1])),
    ],
    [69.5, 73.5, -0.5, 2.5],
  );
});

test("keeps WIPEOUT masks deferred and omits frames when the setting is off", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    { wipeoutFrame: 0 },
  );

  assert.equal(result.metrics.sourceWipeouts, 3);
  assert.equal(result.metrics.deferredWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutFrames, 0);
  assert.equal(result.metrics.renderedWipeoutFrameEdges, 0);
  assert.equal(result.metrics.wipeoutOutlineVertices, 0);
  assert.equal(result.metrics.wipeoutOutlineGpuBytes, 0);
  assert.equal(result.metrics.surfaceOutlineVertices, 36);
  assert.equal(result.metrics.gpuBytes, 43 * PRIMITIVE_VERTEX_STRIDE);
});

test("triangulates WIPEOUT masks with compressed draw-order buckets", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const [source, metadata, drawOrder] = await Promise.all([
    reader.readPrimitiveSource(),
    reader.readRenderMetadata(),
    reader.readDrawOrder(),
  ]);
  const maskOrder = buildMaskOrderPlan(
    drawOrder,
    source.wipeouts,
    metadata.blocks,
    metadata.inserts,
  );
  const instanceGraph = buildInstanceGraph(
    metadata.blocks,
    metadata.inserts,
    { maskOrder },
  );
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    { maskOrder, wipeoutFrame: 0 },
  );

  assert.equal(maskOrder.enabled, true);
  assert.equal(instanceGraph.maskOrderEnabled, true);
  assert.equal(result.metrics.maskOrderEnabled, true);
  assert.equal(result.metrics.renderedWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutMaskTriangles, 6);
  assert.equal(result.metrics.wipeoutMaskVertices, 18);
  assert.equal(
    result.metrics.wipeoutMaskGpuBytes,
    18 * PRIMITIVE_VERTEX_STRIDE,
  );
  const view = new DataView(result.wipeoutMasks.vertices.buffer);
  assert.ok(decodeMaskBucket(view.getUint32(28, true)) > 0);
});

test("stops each deferred primitive stream at its GPU budget", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    {
      maximumPointGpuBytes: PRIMITIVE_VERTEX_STRIDE,
      maximumSolidFillGpuBytes: PRIMITIVE_VERTEX_STRIDE * 3,
      maximumSolidOutlineGpuBytes: PRIMITIVE_VERTEX_STRIDE * 2,
    },
  );

  assert.equal(result.metrics.pointGpuLimitReached, false);
  assert.equal(result.metrics.solidFillGpuLimitReached, true);
  assert.equal(result.metrics.solidOutlineGpuLimitReached, true);
  assert.equal(result.solidFills.vertices.vertexCount, 3);
  assert.equal(result.solidOutlines.vertices.vertexCount, 2);
  assert.equal(
    result.metrics.gpuBytes,
    PRIMITIVE_VERTEX_STRIDE * 6,
  );
});

test("stops 3DFACE edges at the shared surface GPU budget", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    {
      maximumSolidOutlineGpuBytes: PRIMITIVE_VERTEX_STRIDE * 8,
    },
  );

  assert.equal(result.metrics.solidOutlineGpuLimitReached, false);
  assert.equal(result.metrics.faceOutlineGpuLimitReached, true);
  assert.equal(result.metrics.solidOutlineVertices, 6);
  assert.equal(result.metrics.faceOutlineVertices, 2);
  assert.equal(result.solidOutlines.vertices.vertexCount, 8);
  assert.equal(
    result.metrics.surfaceOutlineGpuBytes,
    PRIMITIVE_VERTEX_STRIDE * 8,
  );
});

test("stops WIPEOUT frames at the shared surface GPU budget", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    {
      maximumSolidOutlineGpuBytes: PRIMITIVE_VERTEX_STRIDE * 44,
      wipeoutFrame: 1,
    },
  );

  assert.equal(result.metrics.wipeoutOutlineGpuLimitReached, true);
  assert.equal(result.metrics.deferredWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutFrames, 1);
  assert.equal(result.metrics.renderedWipeoutFrameEdges, 4);
  assert.equal(result.metrics.wipeoutOutlineVertices, 8);
  assert.equal(result.solidOutlines.vertices.vertexCount, 44);
});

test("renders constant-width polylines as filled geometry and replaces their centerlines", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const handle = 0x123456789n;
  const polylineSource = withPolyline(
    source,
    {
      handle,
      ownerHandle: metadata.blocks[0].handle,
      layerIndex: 0,
      color: (2 << 30) | 7,
      lineWeight: 25,
      commonFlags: 0,
      linetypeCode: 0,
      firstVertex: 0,
      vertexCount: 2,
      polylineKind: 1,
      polylineFlags: 0,
      elevation: 0,
      normal: [0, 0, 1],
      defaultStartWidth: 0,
      defaultEndWidth: 0,
      constantWidth: 2,
    },
    [
      { position: [0, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
      { position: [10, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
    ],
  );

  const result = buildPrimitiveMeshes(
    polylineSource,
    metadata.blocks,
    instanceGraph,
    { fillMode: true },
  );
  const points = primitivePointsForHandle(result.solidFills, handle);

  assert.equal(result.metrics.sourceWidePolylines, 1);
  assert.equal(result.metrics.renderedFilledWidePolylines, 1);
  assert.equal(result.metrics.widePolylineFillVertices, 6);
  assert.deepEqual([...result.lineReplacementHandleWords], [0x23456789, 1]);
  assert.equal(points.length, 6);
  assert.deepEqual(
    [
      Math.min(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
      Math.max(...points.map((point) => point[1])),
    ],
    [0, 10, -1, 1],
  );
});

test("keeps the native hairline for a sub-precision polyline width", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const handle = 905n;
  const result = buildPrimitiveMeshes(
    withPolyline(
      source,
      {
        handle,
        ownerHandle: metadata.blocks[0].handle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: 25,
        commonFlags: 0,
        linetypeCode: 0,
        firstVertex: 0,
        vertexCount: 2,
        polylineKind: 1,
        polylineFlags: 0,
        elevation: 0,
        normal: [0, 0, 1],
        defaultStartWidth: 0,
        defaultEndWidth: 0,
        constantWidth: 1 / 32_000,
      },
      [
        { position: [0, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
        { position: [10, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
      ],
    ),
    metadata.blocks,
    instanceGraph,
    { fillMode: true },
  );

  assert.equal(result.metrics.renderedFilledWidePolylines, 1);
  assert.equal(primitivePointsForHandle(result.solidFills, handle).length, 6);
  assert.equal(result.lineReplacementHandleWords.length, 0);
});

test("ignores degenerate edge widths when preserving a native hairline", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const handle = 906n;
  const result = buildPrimitiveMeshes(
    withPolyline(
      source,
      {
        handle,
        ownerHandle: metadata.blocks[0].handle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: 25,
        commonFlags: 0,
        linetypeCode: 0,
        firstVertex: 0,
        vertexCount: 3,
        polylineKind: 1,
        polylineFlags: 0,
        elevation: 0,
        normal: [0, 0, 1],
        defaultStartWidth: 0,
        defaultEndWidth: 0,
        constantWidth: 0,
      },
      [
        { position: [0, 0, 0], bulge: 0, startWidth: 2, endWidth: 2, flags: 0 },
        { position: [0, 0, 0], bulge: 0, startWidth: 1 / 32_000, endWidth: 1 / 32_000, flags: 0 },
        { position: [10, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
      ],
    ),
    metadata.blocks,
    instanceGraph,
    { fillMode: true },
  );

  assert.equal(result.metrics.renderedFilledWidePolylines, 1);
  assert.equal(primitivePointsForHandle(result.solidFills, handle).length, 6);
  assert.equal(result.lineReplacementHandleWords.length, 0);
});

test("renders wide polyline boundaries when FILLMODE is disabled", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const handle = 901n;
  const result = buildPrimitiveMeshes(
    withPolyline(
      source,
      {
        handle,
        ownerHandle: metadata.blocks[0].handle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: 25,
        commonFlags: 0,
        linetypeCode: 0,
        firstVertex: 0,
        vertexCount: 2,
        polylineKind: 2,
        polylineFlags: 0,
        elevation: 0,
        normal: [0, 0, 1],
        defaultStartWidth: 2,
        defaultEndWidth: 2,
        constantWidth: 0,
      },
      [
        { position: [0, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
        { position: [10, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
      ],
    ),
    metadata.blocks,
    instanceGraph,
    { fillMode: false },
  );
  const points = primitivePointsForHandle(result.solidOutlines, handle);

  assert.equal(result.metrics.renderedOutlineWidePolylines, 1);
  assert.equal(result.metrics.widePolylineOutlineVertices, 8);
  assert.deepEqual([...result.lineReplacementHandleWords], [901, 0]);
  assert.equal(points.length, 8);
  assert.deepEqual(
    [
      Math.min(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
      Math.max(...points.map((point) => point[1])),
    ],
    [0, 10, -1, 1],
  );
});

test("tessellates a closed bulge polyline across its full outer width", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const handle = 903n;
  const result = buildPrimitiveMeshes(
    withPolyline(
      source,
      {
        handle,
        ownerHandle: metadata.blocks[0].handle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: 25,
        commonFlags: 0,
        linetypeCode: 0,
        firstVertex: 0,
        vertexCount: 2,
        polylineKind: 2,
        polylineFlags: 1,
        elevation: 0,
        normal: [0, 0, 1],
        defaultStartWidth: 1,
        defaultEndWidth: 1,
        constantWidth: 2,
      },
      [
        { position: [0, 0, 0], bulge: 1, startWidth: 0, endWidth: 0, flags: 0 },
        { position: [10, 0, 0], bulge: 1, startWidth: 0, endWidth: 0, flags: 0 },
      ],
    ),
    metadata.blocks,
    instanceGraph,
    { fillMode: true },
  );
  const points = primitivePointsForHandle(result.solidFills, handle);
  const bounds = [
    Math.min(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[1])),
  ];

  assert.ok(points.length > 100);
  assert.deepEqual([...result.lineReplacementHandleWords], [903, 0]);
  assert.ok(Math.abs(bounds[0] + 1) <= 2e-3);
  assert.ok(Math.abs(bounds[1] - 11) <= 2e-3);
  assert.ok(Math.abs(bounds[2] + 6) <= 2e-3);
  assert.ok(Math.abs(bounds[3] - 6) <= 2e-3);
});

test("keeps the native centerline when only part of a polyline has width", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    withPolyline(
      source,
      {
        handle: 902n,
        ownerHandle: metadata.blocks[0].handle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: 25,
        commonFlags: 0,
        linetypeCode: 0,
        firstVertex: 0,
        vertexCount: 3,
        polylineKind: 1,
        polylineFlags: 0,
        elevation: 0,
        normal: [0, 0, 1],
        defaultStartWidth: 0,
        defaultEndWidth: 0,
        constantWidth: 0,
      },
      [
        { position: [0, 0, 0], bulge: 0, startWidth: 2, endWidth: 2, flags: 0 },
        { position: [10, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
        { position: [20, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
      ],
    ),
    metadata.blocks,
    instanceGraph,
    { fillMode: true },
  );

  assert.equal(result.metrics.mixedWidthPolylines, 1);
  assert.equal(result.metrics.renderedFilledWidePolylines, 1);
  assert.equal(result.lineReplacementHandleWords.length, 0);
});

test("keeps the native centerline when a complete wide mesh exceeds its GPU budget", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    withPolyline(
      source,
      {
        handle: 904n,
        ownerHandle: metadata.blocks[0].handle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: 25,
        commonFlags: 0,
        linetypeCode: 0,
        firstVertex: 0,
        vertexCount: 2,
        polylineKind: 1,
        polylineFlags: 0,
        elevation: 0,
        normal: [0, 0, 1],
        defaultStartWidth: 0,
        defaultEndWidth: 0,
        constantWidth: 2,
      },
      [
        { position: [0, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
        { position: [10, 0, 0], bulge: 0, startWidth: 0, endWidth: 0, flags: 0 },
      ],
    ),
    metadata.blocks,
    instanceGraph,
    {
      fillMode: true,
      maximumSolidFillGpuBytes: 6 * PRIMITIVE_VERTEX_STRIDE,
    },
  );

  assert.equal(result.metrics.widePolylineGpuLimitReached, true);
  assert.equal(result.metrics.renderedFilledWidePolylines, 0);
  assert.equal(result.lineReplacementHandleWords.length, 0);
});
