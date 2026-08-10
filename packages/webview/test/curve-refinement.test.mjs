import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCurveRefinementMesh,
  circularSegmentCount,
  CURVE_PIXEL_ERROR,
} from "../src/curve-refinement.mjs";
import { identityMat4 } from "../src/math.mjs";

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
      return target;
    },
  };
}

function scalarTable(values) {
  return {
    length: values.length,
    readValue(index) {
      return values[index];
    },
  };
}

function pointTable(points) {
  return {
    length: points.length,
    readPoint(index, target) {
      target.set?.(points[index]);
      if (!target.set) {
        target.splice(0, 3, ...points[index]);
      }
      return target;
    },
  };
}

function common(handle, ownerHandle = 100n) {
  return {
    handle,
    ownerHandle,
    layerIndex: 0,
    color: (2 << 30) | 7,
    lineWeight: 25,
    commonFlags: 0,
    linetypeCode: 2,
  };
}

function modelScene() {
  return {
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*MODEL_SPACE",
      },
    ],
    instanceGraph: {
      modelBlockIndices: new Set([0]),
      modelInstances: {
        data: identityMat4(),
        clipIds: new Uint32Array([0]),
        count: 1,
        length: 1,
      },
      instancesByBlock: new Map(),
      clipNodes: [],
    },
    camera: {
      origin: [0, 0, 0],
      worldWidth: 40,
      worldHeight: 40,
      width: 1_000,
      height: 1_000,
    },
  };
}

function sourceWithAllCurveKinds() {
  return {
    arcs: entityTable([
      {
        ...common(1n),
        center: [0, 0, 0],
        radius: 10,
        startParameter: 0,
        endParameter: Math.PI,
        normal: [0, 0, 1],
      },
    ]),
    circles: entityTable([
      {
        ...common(2n),
        center: [0, 0, 0],
        radius: 8,
        startParameter: 0,
        endParameter: Math.PI * 2,
        normal: [0, 0, 1],
      },
    ]),
    ellipses: entityTable([
      {
        ...common(3n),
        center: [0, 0, 0],
        majorAxis: [12, 0, 0],
        minorAxisRatio: 0.25,
        startParameter: 0,
        endParameter: Math.PI * 2,
        normal: [0, 0, 1],
      },
    ]),
    polylines: entityTable([
      {
        ...common(4n),
        firstVertex: 0,
        vertexCount: 3,
        polylineKind: 1,
        polylineFlags: 0,
        elevation: 0,
        normal: [0, 0, 1],
      },
    ]),
    polylineVertices: vertexTable([
      { position: [-5, 0, 0], bulge: 1 },
      { position: [5, 0, 0], bulge: 0 },
      { position: [7, 0, 0], bulge: 0 },
    ]),
    splines: entityTable([
      {
        ...common(5n),
        degree: 3,
        splineFlags: 0,
        firstKnot: 0,
        knotCount: 8,
        firstControlPoint: 0,
        controlPointCount: 4,
        firstWeight: 0,
        weightCount: 0,
        firstFitPoint: 0,
        fitPointCount: 0,
        knotParameterization: 0,
        beginTangent: [0, 0, 0],
        endTangent: [0, 0, 0],
      },
    ]),
    splineKnots: scalarTable([0, 0, 0, 0, 1, 1, 1, 1]),
    splineWeights: scalarTable([]),
    splineControlPoints: pointTable([
      [-10, -5, 0],
      [-5, 12, 0],
      [5, -12, 0],
      [10, 5, 0],
    ]),
    splineFitPoints: pointTable([]),
  };
}

function decodedSegments(refinement, handle) {
  const output = [];
  for (const entry of refinement.entries) {
    const view = new DataView(entry.vertices.buffer);
    for (
      let vertex = 0;
      vertex < entry.vertices.vertexCount;
      vertex += 2
    ) {
      const offset = vertex * 36;
      const vertexHandle =
        BigInt(view.getUint32(offset + 20, true)) |
        (BigInt(view.getUint32(offset + 24, true)) << 32n);
      if (vertexHandle !== handle) {
        continue;
      }
      output.push([
        [0, 1, 2].map(
          (axis) =>
            entry.batch.origin[axis] +
            view.getFloat32(offset + axis * 4, true),
        ),
        [0, 1, 2].map(
          (axis) =>
            entry.batch.origin[axis] +
            view.getFloat32(offset + 36 + axis * 4, true),
        ),
      ]);
    }
  }
  return output;
}

function decodedPatternDistances(refinement, handle) {
  const output = [];
  for (const entry of refinement.entries) {
    const view = new DataView(entry.vertices.buffer);
    for (
      let vertex = 0;
      vertex < entry.vertices.vertexCount;
      vertex += 2
    ) {
      const offset = vertex * 36;
      const vertexHandle =
        BigInt(view.getUint32(offset + 20, true)) |
        (BigInt(view.getUint32(offset + 24, true)) << 32n);
      if (vertexHandle === handle) {
        output.push([
          view.getFloat32(offset + 32, true),
          view.getFloat32(offset + 68, true),
        ]);
      }
    }
  }
  return output;
}

function distanceToSegments(point, segments) {
  let minimum = Infinity;
  for (const [start, end] of segments) {
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const parameter =
      lengthSquared <= 1e-20
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point[0] - start[0]) * deltaX +
                (point[1] - start[1]) * deltaY) /
                lengthSquared,
            ),
          );
    minimum = Math.min(
      minimum,
      Math.hypot(
        point[0] - (start[0] + deltaX * parameter),
        point[1] - (start[1] + deltaY * parameter),
      ),
    );
  }
  return minimum;
}

test("refines ARC, CIRCLE, ELLIPSE, bulge and NURBS within the GPU budget", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const refinement = buildCurveRefinementMesh(
    sourceWithAllCurveKinds(),
    blocks,
    instanceGraph,
    camera,
  );

  assert.equal(refinement.metrics.refined, 5);
  assert.equal(refinement.metrics.refinedHandles, 5);
  assert.equal(refinement.metrics.gpuLimitReached, false);
  assert.ok(refinement.byteLength > 0);
  assert.ok(refinement.byteLength <= 32 * 1024 * 1024);
  assert.ok(
    refinement.entries.every(
      (entry) => entry.vertices.byteLength <= 512 * 1024,
    ),
  );
  const polylineEnd = decodedSegments(refinement, 4n).at(-1)[1];
  assert.ok(Math.hypot(polylineEnd[0] - 7, polylineEnd[1]) <= 1e-6);
  assert.equal(polylineEnd[2], 0);
});

test("uses generated display vertices for legacy spline-fit polylines", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const source = sourceWithAllCurveKinds();
  source.arcs = entityTable([]);
  source.circles = entityTable([]);
  source.ellipses = entityTable([]);
  source.splines = entityTable([]);
  source.polylines = entityTable([
    {
      ...common(41n),
      firstVertex: 0,
      vertexCount: 4,
      polylineKind: 2,
      polylineFlags: 4,
      elevation: 0,
      normal: [0, 0, 1],
    },
  ]);
  source.polylineVertices = vertexTable([
    { position: [100, 100, 0], bulge: 0, flags: 16 },
    { position: [0, 0, 0], bulge: 1, flags: 8 },
    { position: [10, 0, 0], bulge: 0, flags: 8 },
    { position: [-100, 100, 0], bulge: 0, flags: 16 },
  ]);

  const refinement = buildCurveRefinementMesh(
    source,
    blocks,
    instanceGraph,
    camera,
  );
  const segments = decodedSegments(refinement, 41n);

  assert.ok(segments.length > 1);
  assert.ok(
    segments.flat(2).every((coordinate) => Math.abs(coordinate) <= 10.000001),
  );
  assert.ok(Math.hypot(...segments[0][0]) <= 1e-6);
  assert.ok(
    Math.hypot(
      segments.at(-1)[1][0] - 10,
      segments.at(-1)[1][1],
      segments.at(-1)[1][2],
    ) <= 1e-6,
  );
});

test("refines a fit-point-only SPLINE instead of joining its points", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const source = sourceWithAllCurveKinds();
  source.arcs = entityTable([]);
  source.circles = entityTable([]);
  source.ellipses = entityTable([]);
  source.polylines = entityTable([]);
  source.splines = entityTable([
    {
      ...common(51n),
      degree: 3,
      splineFlags: 0,
      knotParameterization: 0,
      firstKnot: 0,
      knotCount: 0,
      firstControlPoint: 0,
      controlPointCount: 0,
      firstWeight: 0,
      weightCount: 0,
      firstFitPoint: 0,
      fitPointCount: 4,
      beginTangent: [8, 0, 0],
      endTangent: [8, 0, 0],
    },
  ]);
  source.splineKnots = scalarTable([]);
  source.splineWeights = scalarTable([]);
  source.splineControlPoints = pointTable([]);
  const fitPoints = [
    [-10, 0, 0],
    [-4, 8, 0],
    [4, -6, 0],
    [10, 0, 0],
  ];
  source.splineFitPoints = pointTable(fitPoints);

  const refinement = buildCurveRefinementMesh(
    source,
    blocks,
    instanceGraph,
    camera,
  );
  const segments = decodedSegments(refinement, 51n);

  assert.equal(refinement.metrics.refined, 1);
  assert.ok(segments.length > fitPoints.length - 1);
  for (const point of fitPoints) {
    assert.ok(distanceToSegments(point, segments) <= 0.03);
  }
  const firstDelta = [
    segments[0][1][0] - segments[0][0][0],
    segments[0][1][1] - segments[0][0][1],
  ];
  assert.ok(firstDelta[0] > 0);
  assert.ok(Math.abs(firstDelta[1]) < firstDelta[0] * 0.2);
});

test("closes a periodic fit-point SPLINE with a smooth refined seam", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const source = sourceWithAllCurveKinds();
  source.arcs = entityTable([]);
  source.circles = entityTable([]);
  source.ellipses = entityTable([]);
  source.polylines = entityTable([]);
  source.splines = entityTable([
    {
      ...common(52n),
      degree: 3,
      splineFlags: 3,
      knotParameterization: 2,
      firstKnot: 0,
      knotCount: 0,
      firstControlPoint: 0,
      controlPointCount: 0,
      firstWeight: 0,
      weightCount: 0,
      firstFitPoint: 0,
      fitPointCount: 4,
      beginTangent: [0, 0, 0],
      endTangent: [0, 0, 0],
    },
  ]);
  source.splineKnots = scalarTable([]);
  source.splineWeights = scalarTable([]);
  source.splineControlPoints = pointTable([]);
  const fitPoints = [
    [-6, 0, 0],
    [0, 6, 0],
    [6, 0, 0],
    [0, -6, 0],
  ];
  source.splineFitPoints = pointTable(fitPoints);

  const refinement = buildCurveRefinementMesh(
    source,
    blocks,
    instanceGraph,
    camera,
  );
  const segments = decodedSegments(refinement, 52n);

  assert.ok(segments.length > fitPoints.length);
  assert.ok(Math.hypot(...segments[0][0].map((value, axis) => value - fitPoints[0][axis])) <= 1e-6);
  assert.ok(Math.hypot(...segments.at(-1)[1].map((value, axis) => value - fitPoints[0][axis])) <= 1e-6);
  for (const point of fitPoints) {
    assert.ok(distanceToSegments(point, segments) <= 0.03);
  }
});

test("restarts polyline linetype distance at vertices unless PLINEGEN is set", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const makeSource = (polylineFlags) => {
    const source = sourceWithAllCurveKinds();
    source.arcs = entityTable([]);
    source.circles = entityTable([]);
    source.ellipses = entityTable([]);
    source.splines = entityTable([]);
    source.polylines = entityTable([
      {
        ...common(42n),
        firstVertex: 0,
        vertexCount: 3,
        polylineKind: 1,
        polylineFlags,
        elevation: 0,
        normal: [0, 0, 1],
      },
    ]);
    source.polylineVertices = vertexTable([
      { position: [0, 0, 0], bulge: 0, flags: 0 },
      { position: [10, 0, 0], bulge: 1, flags: 0 },
      { position: [20, 0, 0], bulge: 0, flags: 0 },
    ]);
    return source;
  };
  const restarted = buildCurveRefinementMesh(
    makeSource(0),
    blocks,
    instanceGraph,
    camera,
  );
  const continuous = buildCurveRefinementMesh(
    makeSource(128),
    blocks,
    instanceGraph,
    camera,
  );
  const restartedDistances = decodedPatternDistances(restarted, 42n);
  const continuousDistances = decodedPatternDistances(continuous, 42n);

  assert.deepEqual(restartedDistances[0], [0, 10]);
  assert.equal(restartedDistances[1][0], 0);
  assert.ok(continuousDistances[1][0] >= 9.999);
});

test("circular sagitta plus f32 position error stays within 0.5 pixels", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const refinement = buildCurveRefinementMesh(
    sourceWithAllCurveKinds(),
    blocks,
    instanceGraph,
    camera,
  );
  const segments = decodedSegments(refinement, 2n);
  const pixelsPerWorld = camera.width / camera.worldWidth;
  let maximumError = 0;
  for (const [start, end] of segments) {
    const midpoint = [
      (start[0] + end[0]) * 0.5,
      (start[1] + end[1]) * 0.5,
    ];
    maximumError = Math.max(
      maximumError,
      (8 - Math.hypot(...midpoint)) * pixelsPerWorld,
    );
  }
  assert.ok(maximumError <= CURVE_PIXEL_ERROR);
  assert.ok(
    circularSegmentCount(8 * pixelsPerWorld, Math.PI * 2) > 16,
  );
});

test("keeps ellipse, bulge and cubic NURBS samples within 0.5 pixels", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const refinement = buildCurveRefinementMesh(
    sourceWithAllCurveKinds(),
    blocks,
    instanceGraph,
    camera,
  );
  const pixelsPerWorld = camera.width / camera.worldWidth;
  const ellipse = decodedSegments(refinement, 3n);
  const bulge = decodedSegments(refinement, 4n);
  const spline = decodedSegments(refinement, 5n);
  let maximumError = 0;
  for (let index = 0; index <= 2_000; index += 1) {
    const parameter = (Math.PI * 2 * index) / 2_000;
    maximumError = Math.max(
      maximumError,
      distanceToSegments(
        [12 * Math.cos(parameter), 3 * Math.sin(parameter)],
        ellipse,
      ) * pixelsPerWorld,
    );
  }
  for (let index = 0; index <= 1_000; index += 1) {
    const parameter = Math.PI + (Math.PI * index) / 1_000;
    maximumError = Math.max(
      maximumError,
      distanceToSegments(
        [5 * Math.cos(parameter), 5 * Math.sin(parameter)],
        bulge,
      ) * pixelsPerWorld,
    );
  }
  const controls = [
    [-10, -5],
    [-5, 12],
    [5, -12],
    [10, 5],
  ];
  for (let index = 0; index <= 2_000; index += 1) {
    const parameter = index / 2_000;
    const inverse = 1 - parameter;
    const point = [0, 1].map(
      (axis) =>
        controls[0][axis] * inverse ** 3 +
        controls[1][axis] * 3 * inverse ** 2 * parameter +
        controls[2][axis] * 3 * inverse * parameter ** 2 +
        controls[3][axis] * parameter ** 3,
    );
    maximumError = Math.max(
      maximumError,
      distanceToSegments(point, spline) * pixelsPerWorld,
    );
  }
  assert.ok(
    maximumError <= CURVE_PIXEL_ERROR,
    `maximum sampled deviation was ${maximumError} px`,
  );
});

test("shares one block curve mesh across repeated INSERT instances", () => {
  const source = sourceWithAllCurveKinds();
  source.arcs = entityTable([
    {
      ...common(11n, 200n),
      center: [0, 0, 0],
      radius: 2,
      startParameter: 0,
      endParameter: Math.PI,
      normal: [0, 0, 1],
    },
  ]);
  source.circles = entityTable([]);
  source.ellipses = entityTable([]);
  source.polylines = entityTable([]);
  source.splines = entityTable([]);
  const blocks = [
    { index: 0, handle: 100n, name: "*MODEL_SPACE" },
    { index: 1, handle: 200n, name: "반복블록" },
  ];
  const matrices = new Float64Array(100 * 16);
  for (let index = 0; index < 100; index += 1) {
    matrices.set(identityMat4(), index * 16);
  }
  const baseGraph = {
    modelBlockIndices: new Set([0]),
    modelInstances: {
      data: identityMat4(),
      count: 1,
      length: 1,
    },
    clipNodes: [],
  };
  const camera = {
    origin: [0, 0, 0],
    worldWidth: 20,
    worldHeight: 20,
    width: 1_000,
    height: 1_000,
  };
  const one = buildCurveRefinementMesh(
    source,
    blocks,
    {
      ...baseGraph,
      instancesByBlock: new Map([
        [
          1,
          {
            data: matrices.subarray(0, 16),
            count: 1,
            length: 1,
          },
        ],
      ]),
    },
    camera,
  );
  const repeated = buildCurveRefinementMesh(
    source,
    blocks,
    {
      ...baseGraph,
      instancesByBlock: new Map([
        [
          1,
          {
            data: matrices,
            count: 100,
            length: 100,
          },
        ],
      ]),
    },
    camera,
  );

  assert.equal(repeated.vertexCount, one.vertexCount);
  assert.equal(repeated.byteLength, one.byteLength);
  assert.equal(repeated.entries[0].batch.instanceIndices, null);
});

test("keeps coarse fallback when an entity cannot fit or a NURBS is invalid", () => {
  const { blocks, instanceGraph, camera } = modelScene();
  const source = sourceWithAllCurveKinds();
  source.arcs = entityTable([]);
  source.ellipses = entityTable([]);
  source.polylines = entityTable([]);
  source.splines = entityTable([
    {
      ...common(9n),
      degree: 3,
      splineFlags: 0,
      firstKnot: 0,
      knotCount: 8,
      firstControlPoint: 0,
      controlPointCount: 4,
      firstWeight: 0,
      weightCount: 0,
    },
  ]);
  source.splineKnots = scalarTable([0, 0, 1, 0, 1, 1, 1, 1]);
  const invalid = buildCurveRefinementMesh(
    source,
    blocks,
    instanceGraph,
    camera,
  );
  assert.equal(invalid.metrics.refinedHandles, 1);
  assert.equal(invalid.metrics.skippedInvalid, 1);

  source.splines = entityTable([]);
  const bounded = buildCurveRefinementMesh(
    source,
    blocks,
    instanceGraph,
    camera,
    { maximumGpuBytes: 72 },
  );
  assert.equal(bounded.metrics.refinedHandles, 0);
  assert.equal(bounded.metrics.gpuLimitReached, true);
  assert.equal(bounded.byteLength, 0);
});
