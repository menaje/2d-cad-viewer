import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExternalLayerMap,
  buildExternalLinetypeMap,
  composeExternalInstanceGraph,
  remapLineVertexLayers,
  remapLineVertexLinetypes,
  remapTextEntityLayers,
} from "../src/external-reference.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";
import { createClipNode } from "../src/instance-graph.mjs";
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
