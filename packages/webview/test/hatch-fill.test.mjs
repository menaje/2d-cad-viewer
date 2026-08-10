import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHatchFillMesh,
  hatchGradientMix,
  HatchGradientKind,
  HATCH_FILL_VERTEX_STRIDE,
} from "../src/hatch-fill.mjs";
import { buildInstanceGraph } from "../src/instance-graph.mjs";
import { decodeMaskBucket } from "../src/mask-order.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import {
  GpuLineBatchKind,
  SceneCacheReader,
} from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

async function hatchFixture() {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const metadata = await reader.readRenderMetadata();
  const source = await reader.readHatchSource();
  const instanceGraph = buildInstanceGraph(
    metadata.blocks,
    metadata.inserts,
  );
  return { metadata, source, instanceGraph };
}

function triangleArea(view, offset, origin) {
  const points = [];
  for (let corner = 0; corner < 3; corner += 1) {
    const vertexOffset = offset + corner * HATCH_FILL_VERTEX_STRIDE;
    points.push([
      origin[0] + view.getFloat32(vertexOffset, true),
      origin[1] + view.getFloat32(vertexOffset + 4, true),
    ]);
  }
  return (
    Math.abs(
      points[0][0] * (points[1][1] - points[2][1]) +
        points[1][0] * (points[2][1] - points[0][1]) +
        points[2][0] * (points[0][1] - points[1][1]),
    ) * 0.5
  );
}

test("triangulates a bounded gradient HATCH with a nested hole", async () => {
  const { metadata, source, instanceGraph } = await hatchFixture();
  const result = buildHatchFillMesh(
    source,
    metadata.blocks,
    instanceGraph,
  );

  assert.equal(result.metrics.sourceHatches, 1);
  assert.equal(result.metrics.gradientHatches, 1);
  assert.equal(result.metrics.renderedHatches, 1);
  assert.equal(result.metrics.triangles, 8);
  assert.equal(result.metrics.vertices, 24);
  assert.equal(result.metrics.gpuBytes, 24 * HATCH_FILL_VERTEX_STRIDE);
  assert.equal(result.metrics.gpuLimitReached, false);
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].kind, GpuLineBatchKind.ModelDetail);
  assert.equal(result.batches[0].blockIndex, null);
  assert.equal(result.identityRanges.count, 1);
  assert.deepEqual(
    [...result.identityRanges.data],
    [0, 24, 401, 0],
  );

  const view = new DataView(result.vertices.buffer);
  let area = 0;
  let minimumMix = 1;
  let maximumMix = 0;
  for (let triangle = 0; triangle < result.metrics.triangles; triangle += 1) {
    const triangleOffset =
      triangle * 3 * HATCH_FILL_VERTEX_STRIDE;
    area += triangleArea(view, triangleOffset, result.batches[0].origin);
    for (let corner = 0; corner < 3; corner += 1) {
      const offset =
        triangleOffset + corner * HATCH_FILL_VERTEX_STRIDE;
      const mix = view.getFloat32(offset + 24, true);
      minimumMix = Math.min(minimumMix, mix);
      maximumMix = Math.max(maximumMix, mix);
    }
  }
  assert.ok(Math.abs(area - 84) < 1e-6);
  assert.equal(minimumMix, 0);
  assert.equal(maximumMix, 1);
});

test("stops HATCH triangulation at the caller GPU budget", async () => {
  const { metadata, source, instanceGraph } = await hatchFixture();
  const result = buildHatchFillMesh(
    source,
    metadata.blocks,
    instanceGraph,
    { maximumGpuBytes: 3 * HATCH_FILL_VERTEX_STRIDE },
  );

  assert.equal(result.metrics.triangles, 1);
  assert.equal(result.metrics.gpuLimitReached, true);
  assert.equal(result.metrics.truncatedHatches, 1);
  assert.equal(result.vertices.byteLength, 3 * HATCH_FILL_VERTEX_STRIDE);
});

test("selects gradient endpoints by stop value without sorting source objects", async () => {
  const { metadata, source, instanceGraph } = await hatchFixture();
  const reversedColors = {
    length: source.length,
    readEntity: source.readEntity.bind(source),
    readLoop: source.readLoop.bind(source),
    readVertex: source.readVertex.bind(source),
    readGradientColor(index, target) {
      return source.readGradientColor(index === 0 ? 1 : 0, target);
    },
  };
  const result = buildHatchFillMesh(
    reversedColors,
    metadata.blocks,
    instanceGraph,
  );
  const view = new DataView(result.vertices.buffer);

  assert.equal(view.getUint32(16, true), ((3 << 30) | (255 << 16)) >>> 0);
  assert.equal(view.getUint32(20, true), ((3 << 30) | 255) >>> 0);
});

test("preserves all named AutoCAD gradient profiles for fragment evaluation", async () => {
  const { metadata, source, instanceGraph } = await hatchFixture();
  const pairs = [
    [
      "CYLINDER",
      "INVCYLINDER",
      HatchGradientKind.Cylinder,
      HatchGradientKind.InverseCylinder,
    ],
    [
      "SPHERICAL",
      "INVSPHERICAL",
      HatchGradientKind.Spherical,
      HatchGradientKind.InverseSpherical,
    ],
    [
      "HEMISPHERICAL",
      "INVHEMISPHERICAL",
      HatchGradientKind.Hemispherical,
      HatchGradientKind.InverseHemispherical,
    ],
    [
      "CURVED",
      "INVCURVED",
      HatchGradientKind.Curved,
      HatchGradientKind.InverseCurved,
    ],
  ];
  const build = (name) =>
    buildHatchFillMesh(
      {
        length: source.length,
        readEntity(index, target) {
          source.readEntity(index, target);
          target.gradientShift = 1;
          return target;
        },
        readLoop: source.readLoop.bind(source),
        readVertex: source.readVertex.bind(source),
        readGradientColor: source.readGradientColor.bind(source),
        readGradientName() {
          return name;
        },
      },
      metadata.blocks,
      instanceGraph,
    );

  for (const [name, inverseName, kind, inverseKind] of pairs) {
    const normal = build(name);
    const inverse = build(inverseName);
    assert.equal(normal.batches[0].gradient.kind, kind);
    assert.equal(inverse.batches[0].gradient.kind, inverseKind);
    for (const point of [
      [0, 0, 0],
      [5, 5, 0],
      [10, 10, 0],
    ]) {
      const sum =
        hatchGradientMix(point, normal.batches[0].gradient) +
        hatchGradientMix(point, inverse.batches[0].gradient);
      assert.ok(Math.abs(sum - 1) <= 1e-12);
    }
  }
});

test("falls back to LINEAR for an unknown gradient name with diagnostics", async () => {
  const { metadata, source, instanceGraph } = await hatchFixture();
  const result = buildHatchFillMesh(
    {
      length: source.length,
      readEntity: source.readEntity.bind(source),
      readLoop: source.readLoop.bind(source),
      readVertex: source.readVertex.bind(source),
      readGradientColor: source.readGradientColor.bind(source),
      readGradientName() {
        return "FUTURE_GRADIENT";
      },
    },
    metadata.blocks,
    instanceGraph,
  );

  assert.equal(result.batches[0].gradient.kind, HatchGradientKind.Linear);
  assert.equal(result.batches[0].gradient.name, "LINEAR");
  assert.equal(result.metrics.unsupportedGradientNames, 1);
});

test("packs a HATCH local mask bucket into existing fill vertices", async () => {
  const { metadata, source, instanceGraph } = await hatchFixture();
  const maskOrder = {
    enabled: true,
    modelOwnerHandle: 100n,
    owners: new Map([
      [
        100n,
        {
          overrides: new Map(),
          events: [
            {
              kind: "mask",
              handle: 400n,
              key: 400n,
              prefix: 0,
              contribution: 1,
            },
          ],
        },
      ],
    ]),
  };
  const result = buildHatchFillMesh(
    source,
    metadata.blocks,
    instanceGraph,
    { maskOrder },
  );

  assert.equal(
    decodeMaskBucket(new DataView(result.vertices.buffer).getUint32(28, true)),
    1,
  );
});
