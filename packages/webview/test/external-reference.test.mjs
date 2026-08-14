import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDisplayLayerProperties,
  buildExternalLayerMap,
  buildExternalLinetypeMap,
  blockExternalReferenceIsDiscoverable,
  blockExternalReferenceIsDisplayable,
  blockExternalReferenceSavedState,
  composeExternalInstanceGraph,
  overrideExternalVertexProperties,
  remapLineVertexLayers,
  remapLineVertexLinetypes,
  remapTextEntityLayers,
  synchronizeExternalLayerProperties,
} from "../src/external-reference.mjs";

import { GpuLineBatchKind } from "../src/scene-cache.mjs";
import {
  buildInstanceGraph,
  createClipNode,
} from "../src/instance-graph.mjs";
import {
  instanceIsVisible,
  refreshInstanceVisibility,
} from "../src/instance-visibility.mjs";
import {
  identityMat4,
  translationMat4,
} from "../src/math.mjs";
import {
  indexDwgRenderDeltaTransforms,
  renderDeltaInstanceMatrix,
} from "../src/render-delta-transform.mjs";
import {
  indexDwgRenderDeltaStyles,
  renderDeltaInstanceStyle,
} from "../src/render-delta-style.mjs";
import {
  normalizedRenderDeltaTransformRecord,
  translatedTransformMatrix,
} from "./render-delta-transform-fixture.mjs";
import {
  normalizedRenderDeltaStyleRecord,
} from "./render-delta-style-fixture.mjs";
import {
  nestedInstanceGraph,
} from "./nested-instance-graph-fixture.mjs";

test("discovers saved external references without automatically displaying unloaded blocks", () => {
  const base = { flags: 1 << 2, xrefLoaded: true, xrefResolved: true };

  assert.equal(blockExternalReferenceIsDiscoverable(base), true);
  assert.equal(blockExternalReferenceSavedState(base), "enabled");
  assert.equal(blockExternalReferenceIsDisplayable(base), true);
  const unloaded = { ...base, xrefLoaded: false };
  assert.equal(blockExternalReferenceIsDiscoverable(unloaded), true);
  assert.equal(blockExternalReferenceSavedState(unloaded), "unloaded");
  assert.equal(
    blockExternalReferenceIsDisplayable(unloaded),
    false,
  );
  const unresolved = { ...base, xrefResolved: false };
  assert.equal(blockExternalReferenceIsDiscoverable(unresolved), true);
  assert.equal(blockExternalReferenceSavedState(unresolved), "unresolved");
  assert.equal(
    blockExternalReferenceIsDisplayable(unresolved),
    false,
  );
  assert.equal(
    blockExternalReferenceIsDiscoverable({ ...base, flags: 0 }),
    false,
  );
  assert.equal(
    blockExternalReferenceSavedState({ ...base, flags: 0 }),
    "not-xref",
  );
  assert.equal(
    blockExternalReferenceIsDisplayable({ ...base, flags: 0 }),
    false,
  );
});

function collection(...matrices) {
  const data = new Float64Array(matrices.length * 16);
  matrices.forEach((matrix, index) => data.set(matrix, index * 16));
  return Object.freeze({
    data,
    count: matrices.length,
    length: matrices.length,
  });
}

test("composes child model and block instances with the parent XREF insert", () => {
  const outer = {
    ...collection(translationMat4(100, 20, 0)),
    handles: new BigUint64Array([700n]),
    visibilityRows: new Uint32Array([1]),
  };
  const inner = {
    ...collection(translationMat4(5, 6, 0)),
    handles: new BigUint64Array([300n]),
  };
  const parent = {
    instancesByBlock: new Map([
      [7, outer],
    ]),
    layerVisibilityRows: [
      new Uint8Array([1]),
      new Uint8Array([1]),
    ],
    paperToModelScalesByVisibilityRow: new Float64Array([1, 5]),
    linetypeScalesByVisibilityRow: new Float64Array([1, 5]),
    annotationScalesByVisibilityRow: new Float64Array([0, 50]),
  };
  const child = {
    instancesByBlock: new Map([
      [3, inner],
    ]),
  };
  const batches = [
    { id: 0, kind: GpuLineBatchKind.ModelOverview, blockIndex: null },
    { id: 1, kind: GpuLineBatchKind.BlockDefinition, blockIndex: 3 },
  ];

  const composed = composeExternalInstanceGraph(parent, 7, child, batches);
  const model = composed.instanceGraph.instancesByBlock.get(-1);
  const block = composed.instanceGraph.instancesByBlock.get(3);

  assert.equal(composed.batches[0].kind, GpuLineBatchKind.BlockDefinition);
  assert.equal(composed.batches[0].blockIndex, -1);
  assert.equal(model.data[12], 100);
  assert.equal(model.data[13], 20);
  assert.equal(block.data[12], 105);
  assert.equal(block.data[13], 26);
  assert.equal(model.measurementData[12], 100);
  assert.equal(block.measurementData[12], 105);
  assert.equal(model.handles[0], 700n);
  assert.equal(block.handles[0], 300n);
  assert.equal(block.visibilityRows[0], 1);
  assert.deepEqual(
    [...composed.instanceGraph.paperToModelScalesByVisibilityRow],
    [1, 5],
  );
  assert.deepEqual(
    [...composed.instanceGraph.linetypeScalesByVisibilityRow],
    [1, 5],
  );
  assert.deepEqual(
    [...composed.instanceGraph.annotationScalesByVisibilityRow],
    [0, 50],
  );
});

test("resolves child root ByBlock and Layer 0 inheritance through an XREF", () => {
  const outer = {
    ...collection(translationMat4(100, 20, 0)),
    colors: new Uint32Array([(2 << 30) | 6]),
    layerIndices: new Uint32Array([4]),
    colorInherited: new Uint8Array([0]),
    layerInherited: new Uint8Array([0]),
    opacities: new Float32Array([0.4]),
    opacityInherited: new Uint8Array([0]),
  };
  const inner = {
    ...collection(translationMat4(5, 6, 0)),
    colors: new Uint32Array([(2 << 30) | 7]),
    layerIndices: new Uint32Array([0]),
    colorInherited: new Uint8Array([1]),
    layerInherited: new Uint8Array([1]),
    opacities: new Float32Array([1]),
    opacityInherited: new Uint8Array([1]),
  };
  const composed = composeExternalInstanceGraph(
    { instancesByBlock: new Map([[7, outer]]) },
    7,
    { instancesByBlock: new Map([[3, inner]]) },
    [],
    new Uint32Array([0, 9]),
  );
  const nested = composed.instanceGraph.instancesByBlock.get(3);

  assert.equal(nested.colors[0], ((2 << 30) | 6) >>> 0);
  assert.equal(nested.layerIndices[0], 4);
  assert.ok(Math.abs(nested.opacities[0] - 0.4) < 1e-6);
});

test("preserves parent and nested INSERT visibility through an XREF", () => {
  const insert = ({ handle, ownerHandle, blockIndex, layerIndex }) => ({
    handle,
    ownerHandle,
    blockIndex,
    layerIndex,
    flags: 0,
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
  const parentLayers = [
    { name: "0", color: (2 << 30) | 7, flags: 0 },
    { name: "HIDDEN-XREF", color: (2 << 30) | 1, flags: 1 },
    { name: "XREF|VISIBLE-CHILD", color: (2 << 30) | 2, flags: 0 },
  ];
  const parent = buildInstanceGraph(
    [
      { index: 0, handle: 100n, name: "*Model_Space", basePoint: [0, 0, 0] },
      { index: 1, handle: 101n, name: "XREF", basePoint: [0, 0, 0] },
    ],
    [
      insert({
        handle: 201n,
        ownerHandle: 100n,
        blockIndex: 1,
        layerIndex: 1,
      }),
    ],
    { layers: parentLayers },
  );
  const child = buildInstanceGraph(
    [
      { index: 0, handle: 300n, name: "*Model_Space", basePoint: [0, 0, 0] },
      { index: 1, handle: 301n, name: "CHILD", basePoint: [0, 0, 0] },
    ],
    [
      insert({
        handle: 401n,
        ownerHandle: 300n,
        blockIndex: 1,
        layerIndex: 1,
      }),
    ],
    {
      layers: [
        { name: "0", color: (2 << 30) | 7, flags: 0 },
        { name: "VISIBLE-CHILD", color: (2 << 30) | 2, flags: 0 },
      ],
    },
  );
  const composed = composeExternalInstanceGraph(
    parent,
    1,
    child,
    [],
    new Uint32Array([0, 2]),
  );
  const childInstances = composed.instanceGraph.instancesByBlock.get(1);

  assert.equal(instanceIsVisible(childInstances, 0), false);
  refreshInstanceVisibility(composed.instanceGraph, [true, true, true]);
  assert.equal(instanceIsVisible(childInstances, 0), true);
  refreshInstanceVisibility(composed.instanceGraph, [true, true, false]);
  assert.equal(instanceIsVisible(childInstances, 0), false);
});

test("ignores nested XREF instance opacity when XREFOVERRIDE is enabled", () => {
  const outer = {
    ...collection(identityMat4()),
    colors: new Uint32Array([(2 << 30) | 6]),
    colorInherited: new Uint8Array([0]),
    opacities: new Float32Array([0.8]),
    opacityInherited: new Uint8Array([0]),
  };
  const inner = {
    ...collection(identityMat4()),
    colors: new Uint32Array([(3 << 30) | 0x123456]),
    colorInherited: new Uint8Array([0]),
    opacities: new Float32Array([0.25]),
    opacityInherited: new Uint8Array([0]),
  };

  const composed = composeExternalInstanceGraph(
    { instancesByBlock: new Map([[7, outer]]) },
    7,
    { instancesByBlock: new Map([[3, inner]]) },
    [],
    null,
    null,
    1,
    true,
  );
  const nested = composed.instanceGraph.instancesByBlock.get(3);

  assert.equal(nested.colors[0], ((2 << 30) | 6) >>> 0);
  assert.ok(Math.abs(nested.opacities[0] - 0.8) < 1e-6);
});

test("composes XREF-local mask bases inside the parent order interval", () => {
  const outer = {
    ...collection(translationMat4(100, 20, 0)),
    maskBases: new Float32Array([4]),
  };
  const inner = {
    ...collection(translationMat4(5, 6, 0)),
    maskBases: new Uint32Array([3]),
  };
  const composed = composeExternalInstanceGraph(
    { instancesByBlock: new Map([[7, outer]]) },
    7,
    { instancesByBlock: new Map([[3, inner]]) },
    [],
    null,
    null,
    0.125,
  );

  assert.equal(
    composed.instanceGraph.instancesByBlock.get(-1).maskBases[0],
    4,
  );
  assert.equal(
    composed.instanceGraph.instancesByBlock.get(3).maskBases[0],
    4.375,
  );
});

test("maps XREF-dependent layers before falling back to local names", () => {
  const mapping = buildExternalLayerMap(
    [
      { name: "0" },
      { name: "1F|A-WALL" },
      { name: "A-DOOR" },
    ],
    [{ name: "A-WALL" }, { name: "A-DOOR" }, { name: "UNKNOWN" }],
    "1F",
  );

  assert.deepEqual([...mapping], [1, 2, 0]);
});

test("keeps external Layer 0 mapped to root Layer 0 for block inheritance", () => {
  const mapping = buildExternalLayerMap(
    [{ name: "0" }, { name: "1F|0" }],
    [{ name: "0" }],
    "1F",
  );

  assert.deepEqual([...mapping], [0]);
});

test("synchronizes only exact XREF-dependent host layers from the child", () => {
  const root = [
    { name: "0", color: 1, flags: 0, lineWeight: -3, linetype: "Continuous" },
    { name: "1F|A-WALL", color: 2, flags: 1 << 4, lineWeight: 25, linetype: "Hidden" },
    { name: "A-WALL", color: 3, flags: 0, lineWeight: 30, linetype: "Center" },
  ];
  const result = synchronizeExternalLayerProperties(
    root,
    [
      { name: "A-WALL", color: 99, flags: 0b101, lineWeight: 50, linetype: "Dashed" },
      { name: "UNKNOWN", color: 77, flags: 0, lineWeight: 18, linetype: "Continuous" },
    ],
    "1F",
  );

  assert.deepEqual([...result.changedIndices], [1]);
  assert.strictEqual(result.layers[0], root[0]);
  assert.deepEqual(result.layers[1], {
    name: "1F|A-WALL",
    color: 99,
    flags: (1 << 4) | 0b101,
    lineWeight: 50,
    linetype: "Dashed",
  });
  assert.strictEqual(result.layers[2], root[2]);
});

test("applies reloaded XREF layer properties without replacing viewport overrides", () => {
  const baseline = [
    { name: "0", color: 7, flags: 0, lineWeight: -3, linetype: "Continuous" },
    { name: "1F|A-WALL", color: 2, flags: 1 << 4, lineWeight: 25, linetype: "Hidden" },
  ];
  const display = [
    baseline[0],
    { ...baseline[1], color: 99, flags: (1 << 4) | 1, lineWeight: 50, linetype: "Dashed" },
  ];
  const instanceGraph = {
    layerVisibilityRows: [
      new Uint8Array([1, 1]),
      new Uint8Array([1, 1]),
    ],
    layerColorsByVisibilityRow: [
      new Uint32Array([7, 2]),
      new Uint32Array([7, 123]),
    ],
    layerLineWeightsByVisibilityRow: [
      new Int16Array([-3, 25]),
      new Int16Array([-3, 77]),
    ],
    layerLinetypesByVisibilityRow: [
      new Uint16Array([2, 3]),
      new Uint16Array([2, 8]),
    ],
  };
  const result = applyDisplayLayerProperties(
    instanceGraph,
    baseline,
    display,
    [
      { name: "Continuous", code: 2 },
      { name: "Hidden", code: 3 },
      { name: "Dashed", code: 4 },
    ],
  );

  assert.deepEqual(
    [...result.instanceGraph.layerColorsByVisibilityRow[0]],
    [7, 99],
  );
  assert.deepEqual(
    [...result.instanceGraph.layerLineWeightsByVisibilityRow[0]],
    [-3, 50],
  );
  assert.deepEqual(
    [...result.instanceGraph.layerLinetypesByVisibilityRow[0]],
    [2, 4],
  );
  assert.deepEqual(
    [...result.instanceGraph.layerColorsByVisibilityRow[1]],
    [7, 123],
  );
  assert.deepEqual(
    [...result.instanceGraph.layerLineWeightsByVisibilityRow[1]],
    [-3, 77],
  );
  assert.deepEqual(
    [...result.instanceGraph.layerLinetypesByVisibilityRow[1]],
    [2, 8],
  );
  assert.deepEqual([...result.layerLinetypeCodes], [2, 4]);
});

test("rewrites packed GPU vertex layer indices in place", () => {
  const buffer = new ArrayBuffer(72);
  const view = new DataView(buffer);
  view.setUint32(12, 1, true);
  view.setUint32(48, 9, true);

  remapLineVertexLayers(buffer, new Uint32Array([5, 7]));

  assert.equal(view.getUint32(12, true), 7);
  assert.equal(view.getUint32(48, true), 5);
});

test("maps and rewrites XREF linetype codes without changing other style bits", () => {
  const mapping = buildExternalLinetypeMap(
    [
      { name: "Continuous", code: 2 },
      { name: "CENTER", code: 8 },
    ],
    [
      { name: "Continuous", code: 2 },
      { name: "CENTER", code: 3 },
      { name: "MISSING", code: 4 },
    ],
  );
  const buffer = new ArrayBuffer(72);
  const view = new DataView(buffer);
  view.setUint32(28, (3 << 5) | 10 | (1 << 16), true);
  view.setUint32(64, (4 << 5) | 10, true);

  remapLineVertexLinetypes(buffer, mapping);

  assert.equal((view.getUint32(28, true) >>> 5) & 0x7ff, 8);
  assert.equal((view.getUint32(64, true) >>> 5) & 0x7ff, 2);
  assert.equal(view.getUint32(28, true) & (1 << 16), 1 << 16);
});

test("prefers the XREF-dependent linetype with the matching prefix", () => {
  const mapping = buildExternalLinetypeMap(
    [
      { name: "Continuous", code: 2 },
      { name: "CENTER", code: 8 },
      { name: "1F|CENTER", code: 9 },
    ],
    [{ name: "CENTER", code: 3 }],
    "1F",
  );

  assert.equal(mapping[3], 9);
});

test("forces XREF common display properties to ByLayer without changing other style bits", () => {
  const buffer = new ArrayBuffer(72);
  const view = new DataView(buffer);
  view.setUint32(16, ((3 << 30) | 0x123456) >>> 0, true);
  view.setUint32(28, (8 << 5) | 10 | (1 << 16) | (7 << 17), true);
  view.setUint32(52, ((2 << 30) | 4) >>> 0, true);
  view.setUint32(64, (3 << 5) | 25 | (1 << 21), true);

  overrideExternalVertexProperties(buffer);

  assert.equal(view.getUint32(16, true), 1 << 24);
  assert.equal(view.getUint32(52, true), 1 << 24);
  assert.equal(view.getUint32(28, true) & 0x1f, 2);
  assert.equal((view.getUint32(28, true) >>> 5) & 0x7ff, 0);
  assert.equal(view.getUint32(28, true) & (1 << 16), 1 << 16);
  assert.equal((view.getUint32(28, true) >>> 17) & 15, 7);
  assert.equal(view.getUint32(64, true) & (1 << 21), 1 << 21);
});

test("forces both XREF fill colors to ByLayer without interpreting fill metadata as line style", () => {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint32(16, ((2 << 30) | 1) >>> 0, true);
  view.setUint32(20, ((2 << 30) | 5) >>> 0, true);
  view.setUint32(28, 0xdeadbeef, true);

  overrideExternalVertexProperties(buffer, {
    stride: 32,
    lineStyle: false,
    secondaryColor: true,
  });

  assert.equal(view.getUint32(16, true), 1 << 24);
  assert.equal(view.getUint32(20, true), 1 << 24);
  assert.equal(view.getUint32(28, true), 0xdeadbeef);
});

test("remaps text layers and linetypes without copying the source table", () => {
  let lazyValueReads = 0;
  const source = {
    length: 1,
    readDisplayRecord(_index, target) {
      target.layerIndex = 1;
      target.linetypeCode = 3;
      return target;
    },
    readValue() {
      lazyValueReads += 1;
      return "면적";
    },
    get() {
      return { layerIndex: 1, linetypeCode: 3, value: "면적" };
    },
  };
  const remapped = remapTextEntityLayers(
    source,
    new Uint32Array([3, 9]),
    new Uint16Array([0, 1, 2, 8]),
  );

  const display = remapped.readDisplayRecord(0, {});
  assert.equal(display.layerIndex, 9);
  assert.equal(display.linetypeCode, 8);
  assert.equal(remapped.readValue(0), "면적");
  assert.equal(lazyValueReads, 1);
  assert.equal(remapped.get(0).layerIndex, 9);
  assert.equal(remapped.get(0).linetypeCode, 8);
  assert.equal(remapped.get(0).value, "면적");
});

test("forces XREF text common properties to ByLayer lazily", () => {
  const source = {
    length: 1,
    readDisplayRecord(_index, target) {
      Object.assign(target, {
        layerIndex: 1,
        color: ((3 << 30) | 0x123456) >>> 0,
        lineWeight: 35,
        linetypeCode: 3,
      });
      return target;
    },
    readValue() {
      return "참조";
    },
    get() {
      return {
        layerIndex: 1,
        color: ((3 << 30) | 0x123456) >>> 0,
        lineWeight: 35,
        linetypeCode: 3,
      };
    },
  };
  const remapped = remapTextEntityLayers(
    source,
    new Uint32Array([3, 9]),
    new Uint16Array([0, 1, 2, 8]),
    { externalReferenceOverrides: true },
  );

  assert.deepEqual(remapped.readDisplayRecord(0, {}), {
    layerIndex: 9,
    color: 1 << 24,
    lineWeight: -1,
    linetypeCode: 0,
  });
  assert.deepEqual(remapped.get(0), {
    layerIndex: 9,
    color: 1 << 24,
    lineWeight: -1,
    linetypeCode: 0,
  });
});

test("an absent parent insertion produces no external batches", () => {
  const composed = composeExternalInstanceGraph(
    { instancesByBlock: new Map() },
    7,
    { instancesByBlock: new Map() },
    [
      {
        id: 0,
        kind: GpuLineBatchKind.ModelOverview,
        blockIndex: null,
      },
    ],
  );

  assert.equal(composed.batches.length, 0);
  assert.equal(composed.instanceGraph.instanceCount, 0);
  assert.deepEqual(identityMat4().length, 16);
});

test("keeps a parent context for a child that contains only nested XREFs", () => {
  const composed = composeExternalInstanceGraph(
    {
      instancesByBlock: new Map([
        [7, collection(translationMat4(10, 20, 0))],
      ]),
    },
    7,
    {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set(),
    },
    [],
  );

  assert.equal(composed.batches.length, 0);
  assert.equal(composed.instanceGraph.instanceCount, 1);
  assert.equal(
    composed.instanceGraph.instancesByBlock.get(-1).data[12],
    10,
  );
});

test("drops unused line batches but keeps a text-only child block context", () => {
  const composed = composeExternalInstanceGraph(
    {
      instancesByBlock: new Map([
        [7, collection(translationMat4(100, 20, 0))],
      ]),
    },
    7,
    {
      instancesByBlock: new Map([
        [4, collection(translationMat4(5, 6, 0))],
      ]),
      modelBlockIndices: new Set([0]),
    },
    [
      {
        id: 0,
        kind: GpuLineBatchKind.BlockDefinition,
        blockIndex: 3,
      },
      {
        id: 1,
        kind: GpuLineBatchKind.BlockDefinition,
        blockIndex: 5,
      },
    ],
  );

  assert.deepEqual(composed.batches, []);
  assert.equal(composed.instanceGraph.instanceCount, 2);
  const textBlock = composed.instanceGraph.instancesByBlock.get(4);
  assert.equal(textBlock.count, 1);
  assert.equal(textBlock.data[12], 105);
  assert.equal(textBlock.data[13], 26);
});

test("combines parent and child XCLIP chains for an external reference", () => {
  const outer = {
    ...collection(translationMat4(100, 20, 0)),
    clipIds: new Uint32Array([1]),
  };
  const inner = {
    ...collection(translationMat4(5, 6, 0)),
    clipIds: new Uint32Array([1]),
  };
  const parent = {
    instancesByBlock: new Map([[7, outer]]),
    clipNodes: [
      createClipNode(1, 0, [
        [90, 10, 0],
        [120, 10, 0],
        [120, 40, 0],
        [90, 40, 0],
      ]),
    ],
  };
  const child = {
    instancesByBlock: new Map([[3, inner]]),
    clipNodes: [
      createClipNode(1, 0, [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ]),
    ],
  };

  const composed = composeExternalInstanceGraph(parent, 7, child, []);
  const block = composed.instanceGraph.instancesByBlock.get(3);

  assert.equal(block.clipIds[0], 2);
  assert.equal(composed.instanceGraph.clipNodes[1].parentId, 1);
  assert.deepEqual(composed.instanceGraph.clipNodes[1].points[0], [
    100,
    20,
    0,
  ]);
});

test("propagates one sparse XREF root delta through its nested child graph", () => {
  const outer = {
    ...collection(
      translationMat4(100, 200, 0),
      translationMat4(1_000, 2_000, 0),
    ),
    handles: new BigUint64Array([700n, 701n]),
  };
  const child = nestedInstanceGraph();
  const composed = composeExternalInstanceGraph(
    {
      instancesByBlock: new Map([[7, outer]]),
      layers: child.layers,
      layerLinetypeCodes: child.layerLinetypeCodes,
    },
    7,
    child,
    [],
  ).instanceGraph;
  const transform = normalizedRenderDeltaTransformRecord({
    blockIndex: 0,
    instanceIndex: 0,
    handle: 700n,
    matrix: translatedTransformMatrix(200, 300, 0),
  });
  const transformEntry = Object.freeze({
    resourceKind: "transform",
    sceneId: "xref",
    record: transform.record,
    byteLength: transform.buffer.byteLength,
  });
  const transforms = indexDwgRenderDeltaTransforms(
    [transformEntry],
    {
      sourceId: "xref",
      instanceGraph: composed,
    },
  );
  const grandchildren = composed.instancesByBlock.get(3);

  assert.deepEqual(
    [...renderDeltaInstanceMatrix(transforms, grandchildren, 0)],
    translatedTransformMatrix(216, 328, 0),
  );
  assert.deepEqual(
    [...renderDeltaInstanceMatrix(transforms, grandchildren, 1)],
    translatedTransformMatrix(1_016, 2_028, 0),
  );
  assert.equal(transforms.derivedCount, 3);

  const style = normalizedRenderDeltaStyleRecord({
    blockIndex: 0,
    instanceIndex: 0,
    handle: 700n,
    visible: false,
  });
  const styles = indexDwgRenderDeltaStyles(
    [
      Object.freeze({
        resourceKind: "style",
        sceneId: "xref",
        record: style.record,
        byteLength: style.buffer.byteLength,
      }),
    ],
    {
      sourceId: "xref",
      instanceGraph: composed,
    },
  );

  assert.equal(
    renderDeltaInstanceStyle(styles, grandchildren, 0).visible,
    false,
  );
  assert.equal(
    renderDeltaInstanceStyle(styles, grandchildren, 1),
    null,
  );
  assert.equal(styles.derivedCount, 3);
});
