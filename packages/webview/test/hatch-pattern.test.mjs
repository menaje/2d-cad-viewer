import assert from "node:assert/strict";
import test from "node:test";

import { buildHatchPatternMesh } from "../src/hatch-pattern.mjs";
import { decodeMaskBucket } from "../src/mask-order.mjs";

function makePatternSource({
  basePoint = [0, 1],
  offset = [0, 2],
  dashes = [],
  withHole = false,
  ownerHandle = 0n,
  flags = 0,
  patternType = 0,
  angle = 0,
  coordinateOffset = [0, 0],
  rings = null,
  style = 0,
} = {}) {
  const sourceRings =
    rings ??
    [
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      ...(withHole
        ? [
            [
              [3.5, 3.5, 0],
              [3.5, 6.5, 0],
              [6.5, 6.5, 0],
              [6.5, 3.5, 0],
            ],
          ]
        : []),
    ];
  const vertices = sourceRings.flat().map((point) => [
    point[0] + coordinateOffset[0],
    point[1] + coordinateOffset[1],
    point[2],
  ]);
  let firstVertex = 0;
  const loops = sourceRings.map((ring, index) => {
    const loop = {
      hatchIndex: 0,
      pathFlags: index === 0 ? 1 : 0,
      sourcePathIndex: index,
      firstVertex,
      vertexCount: ring.length,
      sourceEdgeCount: ring.length,
      flags: 0,
      signedArea: index === 0 ? 100 : -9,
    };
    firstVertex += ring.length;
    return loop;
  });
  return {
    length: 1,
    readEntity(_index, target) {
      Object.assign(target, {
        index: 0,
        handle: 42n,
        ownerHandle,
        layerIndex: 0,
        color: (2 << 30) | 7,
        lineWeight: -1,
        commonFlags: 0,
        flags,
        style,
        patternType,
        firstLoop: 0,
        loopCount: loops.length,
        elevation: 0,
        normal: [0, 0, 1],
        firstPatternLine: 0,
        patternLineCount: 1,
      });
      return target;
    },
    readLoop(index, target) {
      Object.assign(target, loops[index]);
      return target;
    },
    readVertex(index, target) {
      target.splice(0, 3, ...vertices[index]);
      return target;
    },
    readPatternLine(_index, target) {
      Object.assign(target, {
        index: 0,
        hatchIndex: 0,
        sourceLineIndex: 0,
        angle,
        basePoint: [...basePoint],
        offset: [...offset],
        firstDash: 0,
        dashCount: dashes.length,
      });
      return target;
    },
    readPatternDash(index) {
      return dashes[index];
    },
  };
}

const camera = Object.freeze({
  origin: [5, 5, 0],
  worldWidth: 10,
  worldHeight: 10,
  width: 100,
  height: 100,
});

function modelArguments(source, options) {
  return [
    source,
    [],
    { modelBlockIndices: new Set() },
    camera,
    options,
  ];
}

function unpackSegments(result) {
  const view = new DataView(result.vertices.buffer);
  const segments = [];
  for (const batch of result.batches) {
    for (
      let vertex = batch.firstVertex;
      vertex < batch.firstVertex + batch.vertexCount;
      vertex += 2
    ) {
      const points = [];
      for (let endpoint = 0; endpoint < 2; endpoint += 1) {
        const offset = (vertex + endpoint) * 32;
        points.push([
          batch.origin[0] + view.getFloat32(offset, true),
          batch.origin[1] + view.getFloat32(offset + 4, true),
          batch.origin[2] + view.getFloat32(offset + 8, true),
        ]);
      }
      segments.push(points);
    }
  }
  return segments;
}

function translatedInstance(x, y) {
  return new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, 0, 1,
  ]);
}

test("clips continuous HATCH pattern lines around a nested hole", () => {
  const source = makePatternSource({ withHole: true });
  const result = buildHatchPatternMesh(...modelArguments(source));
  const segments = unpackSegments(result);

  assert.equal(result.metrics.renderedHatches, 1);
  assert.equal(result.metrics.segments, 6);
  assert.equal(result.vertices.byteLength, 6 * 2 * 32);
  assert.equal(result.identityRanges.count, 1);
  assert.deepEqual(
    [...result.identityRanges.data],
    [0, 12, 42, 0],
  );
  assert.deepEqual(
    segments
      .filter((segment) => segment[0][1] === 5)
      .map((segment) => [segment[0][0], segment[1][0]]),
    [
      [0, 3.5],
      [6.5, 10],
    ],
  );
});

test("omits HATCH patterns when drawing FILLMODE is disabled", () => {
  const source = makePatternSource({ withHole: true });
  const args = modelArguments(source);
  const result = buildHatchPatternMesh(
    args[0],
    args[1],
    args[2],
    args[3],
    { fillMode: false },
  );

  assert.equal(result.metrics.sourceHatches, 1);
  assert.equal(result.metrics.renderedHatches, 0);
  assert.equal(result.metrics.segments, 0);
  assert.equal(result.vertices.byteLength, 0);
  assert.equal(result.batches.length, 0);
});

test("packs a HATCH pattern local mask bucket into line vertices", () => {
  const source = makePatternSource();
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
              handle: 10n,
              key: 10n,
              prefix: 0,
              contribution: 1,
            },
          ],
        },
      ],
    ]),
  };
  const result = buildHatchPatternMesh(
    source,
    [],
    { modelBlockIndices: new Set() },
    camera,
    { maskOrder },
  );

  assert.equal(
    decodeMaskBucket(new DataView(result.vertices.buffer).getUint32(28, true)),
    1,
  );
});

test("preserves positive dashes and negative spaces", () => {
  const source = makePatternSource({
    offset: [0, 20],
    dashes: [2, -1],
  });
  const result = buildHatchPatternMesh(...modelArguments(source));

  assert.deepEqual(
    unpackSegments(result).map((segment) => [
      segment[0][0],
      segment[1][0],
    ]),
    [
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 10],
    ],
  );
});

test("renders zero-length dash entries as bounded screen dots", () => {
  const source = makePatternSource({
    offset: [0, 20],
    dashes: [0, -2],
  });
  const result = buildHatchPatternMesh(...modelArguments(source));

  assert.equal(result.metrics.segments, 6);
  for (const [start, end] of unpackSegments(result)) {
    assert.ok(Math.abs(end[0] - start[0]) <= 0.1 + 1e-6);
  }
});

test("preserves nested islands for normal, outer and ignore styles", () => {
  const rings = [
    [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ],
    [
      [3, 3, 0],
      [3, 7, 0],
      [7, 7, 0],
      [7, 3, 0],
    ],
    [
      [4, 4, 0],
      [6, 4, 0],
      [6, 6, 0],
      [4, 6, 0],
    ],
  ];
  const rangesForStyle = (style) =>
    unpackSegments(
      buildHatchPatternMesh(
        ...modelArguments(
          makePatternSource({
            basePoint: [0, 5],
            offset: [0, 20],
            rings,
            style,
          }),
        ),
      ),
    ).map(([start, end]) => [start[0], end[0]]);

  assert.deepEqual(rangesForStyle(0), [
    [0, 3],
    [4, 6],
    [7, 10],
  ]);
  assert.deepEqual(rangesForStyle(1), [
    [0, 3],
    [7, 10],
  ]);
  assert.deepEqual(rangesForStyle(2), [[0, 10]]);
});

test("keeps scanline parity when a pattern line touches a concave vertex", () => {
  const source = makePatternSource({
    basePoint: [0, 5],
    offset: [0, 20],
    rings: [
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [6, 10, 0],
        [5, 5, 0],
        [4, 10, 0],
        [0, 10, 0],
      ],
    ],
  });
  const result = buildHatchPatternMesh(...modelArguments(source));

  assert.deepEqual(
    unpackSegments(result).map(([start, end]) => [start[0], end[0]]),
    [
      [0, 5],
      [5, 10],
    ],
  );
  assert.equal(result.metrics.skippedInvalidIntersections, 0);
});

test("omits sub-pixel dense definitions before generating geometry", () => {
  const source = makePatternSource({ offset: [0, 0.01] });
  const result = buildHatchPatternMesh(...modelArguments(source));

  assert.equal(result.metrics.segments, 0);
  assert.equal(result.metrics.skippedDenseDefinitions, 1);
  assert.equal(result.vertices.byteLength, 0);
});

test("stops pattern generation at the caller segment budget", () => {
  const source = makePatternSource();
  const result = buildHatchPatternMesh(
    ...modelArguments(source, { maximumSegments: 2 }),
  );

  assert.equal(result.metrics.segments, 2);
  assert.equal(result.metrics.gpuLimitReached, true);
  assert.equal(result.metrics.truncatedHatches, 1);
});

test("adds the perpendicular pass for a double user-defined pattern", () => {
  const source = makePatternSource({
    basePoint: [1, 1],
    flags: 1 << 2,
    patternType: 0,
  });
  const result = buildHatchPatternMesh(...modelArguments(source));

  assert.equal(result.metrics.patternDefinitions, 2);
  assert.equal(result.metrics.doubleDefinitions, 1);
  assert.equal(result.metrics.segments, 10);
});

test("keeps rotated scaled definitions and their dash lengths", () => {
  const rootTwo = Math.sqrt(2);
  const source = makePatternSource({
    angle: Math.PI / 4,
    offset: [-rootTwo, rootTwo],
    dashes: [4, -2],
  });
  const result = buildHatchPatternMesh(...modelArguments(source));

  assert.ok(result.metrics.segments > 0);
  for (const [start, end] of unpackSegments(result)) {
    assert.ok(Math.abs((end[0] - start[0]) - (end[1] - start[1])) < 1e-5);
    assert.ok(Math.hypot(end[0] - start[0], end[1] - start[1]) <= 4 + 1e-5);
  }
});

test("rebases pattern vertices at large world coordinates", () => {
  const coordinateOffset = [1_000_000_000, 1_000_000_000];
  const source = makePatternSource({
    basePoint: [coordinateOffset[0], coordinateOffset[1] + 1],
    coordinateOffset,
  });
  const result = buildHatchPatternMesh(
    source,
    [],
    { modelBlockIndices: new Set() },
    {
      ...camera,
      origin: [coordinateOffset[0] + 5, coordinateOffset[1] + 5, 0],
    },
  );

  assert.equal(result.metrics.segments, 5);
  assert.ok(result.batches[0].origin[0] >= coordinateOffset[0]);
  assert.ok(result.metrics.maximumPositionError <= 1e-3);
});

test("clips shared block patterns to visible instances", () => {
  const source = makePatternSource({ ownerHandle: 100n });
  const first = translatedInstance(0, 0);
  const second = translatedInstance(100, 100);
  const matrices = new Float64Array(32);
  matrices.set(first);
  matrices.set(second, 16);
  const result = buildHatchPatternMesh(
    source,
    [{ index: 0, handle: 100n, name: "BLOCK_A" }],
    {
      modelBlockIndices: new Set(),
      instancesByBlock: new Map([
        [0, { data: matrices, count: 2, length: 2 }],
      ]),
      blockBoundsByIndex: [
        { min: [0, 0, 0], max: [10, 10, 0] },
      ],
    },
    camera,
  );

  assert.equal(result.metrics.visibleBlockInstances, 1);
  assert.equal(result.metrics.segments, 5);
  assert.ok(result.batches.every((batch) => batch.blockIndex === 0));
  assert.deepEqual([...result.batches[0].instanceIndices], [0]);
});

test("skips block HATCHes when every instance is off screen", () => {
  const source = makePatternSource({ ownerHandle: 100n });
  const matrix = translatedInstance(100, 100);
  const result = buildHatchPatternMesh(
    source,
    [{ index: 0, handle: 100n, name: "BLOCK_A" }],
    {
      modelBlockIndices: new Set(),
      instancesByBlock: new Map([
        [0, { data: matrix, count: 1, length: 1 }],
      ]),
      blockBoundsByIndex: [
        { min: [0, 0, 0], max: [10, 10, 0] },
      ],
    },
    camera,
  );

  assert.equal(result.metrics.segments, 0);
  assert.equal(result.metrics.skippedOffscreenHatches, 1);
});
