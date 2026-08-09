import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstanceGraph,
  createClipNode,
} from "../src/instance-graph.mjs";
import {
  transformPoint,
  translationMat4,
} from "../src/math.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import { SceneCacheReader } from "../src/scene-cache.mjs";
import {
  annotativeTextRecordForInstance,
  cadMTextFlowsVertically,
  cadTextAlignmentOffsets,
  cadTextAlignmentWidth,
  cadTextEntityMatrix,
  CanvasTextOverlay,
  CompositeTextOverlay,
  layoutCadTextColumns,
  plainCadTextLines,
  registerLocalOutlineFont,
  systemFallbackFont,
  unregisterLocalOutlineFont,
  wrapCadTextLines,
} from "../src/text-overlay.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";
import {
  normalizedRenderDeltaTextRecord,
} from "./render-delta-text-fixture.mjs";
import {
  normalizedRenderDeltaStyleRecord,
} from "./render-delta-style-fixture.mjs";
import {
  normalizedRenderDeltaTransformRecord,
  translatedTransformMatrix,
} from "./render-delta-transform-fixture.mjs";
import {
  dwgTypeRenderDependencyId,
} from "../src/render-delta-dependency.mjs";

function fakeCanvas({ measureText } = {}) {
  const calls = {
    fillText: 0,
    fillTextArguments: [],
    lineTo: 0,
    stroke: 0,
    transforms: [],
    clips: [],
    saves: 0,
    restores: 0,
    fillStyles: [],
    strokeStyles: [],
    fonts: [],
    fills: 0,
    events: [],
  };
  let fillStyle;
  let strokeStyle;
  let font;
  const context = {
    beginPath() {},
    clip(rule) {
      calls.clips.push(rule);
    },
    closePath() {},
    clearRect() {},
    fillText(...arguments_) {
      calls.fillText += 1;
      calls.fillTextArguments.push(arguments_);
      calls.events.push("text");
    },
    fill() {
      calls.fills += 1;
      calls.events.push("fill");
    },
    lineTo() {
      calls.lineTo += 1;
    },
    moveTo() {},
    rect() {},
    restore() {
      calls.restores += 1;
    },
    save() {
      calls.saves += 1;
    },
    setTransform(...values) {
      calls.transforms.push(values);
    },
    stroke() {
      calls.stroke += 1;
    },
  };
  if (typeof measureText === "function") {
    context.measureText = measureText;
  }
  Object.defineProperties(context, {
    fillStyle: {
      get() {
        return fillStyle;
      },
      set(value) {
        fillStyle = value;
        calls.fillStyles.push(value);
      },
    },
    strokeStyle: {
      get() {
        return strokeStyle;
      },
      set(value) {
        strokeStyle = value;
        calls.strokeStyles.push(value);
      },
    },
    font: {
      get() {
        return font;
      },
      set(value) {
        font = value;
        calls.fonts.push(value);
      },
    },
  });
  return {
    calls,
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    getContext(kind) {
      return kind === "2d" ? context : null;
    },
  };
}

function compositingCanvas() {
  const makeContext = () => ({
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    filter: "none",
    setTransform() {},
    clearRect() {},
    drawImage() {},
  });
  const makeBackingCanvas = () => {
    const context = makeContext();
    return {
      width: 1,
      height: 1,
      getContext(kind) {
        return kind === "2d" ? context : null;
      },
    };
  };
  const context = makeContext();
  return {
    clientWidth: 10,
    clientHeight: 10,
    width: 10,
    height: 10,
    ownerDocument: {
      createElement(name) {
        return name === "canvas" ? makeBackingCanvas() : null;
      },
    },
    getContext(kind) {
      return kind === "2d" ? context : null;
    },
  };
}

async function textScene() {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const metadata = await reader.readRenderMetadata();
  return {
    metadata,
    textEntities: await reader.readTextEntities(),
    instanceGraph: buildInstanceGraph(metadata.blocks, metadata.inserts),
  };
}

const camera = Object.freeze({
  origin: [105, 201, 0],
  worldWidth: 20,
  worldHeight: 15,
});

test("uses explicit or text-style top-to-bottom MTEXT flow only", () => {
  assert.equal(
    cadMTextFlowsVertically({
      kind: 1,
      flowDirection: 2,
      style: { flags: 0 },
    }),
    true,
  );
  assert.equal(
    cadMTextFlowsVertically({
      kind: 1,
      flowDirection: 3,
      style: { flags: 1 << 4 },
    }),
    true,
  );
  assert.equal(
    cadMTextFlowsVertically({
      kind: 1,
      flowDirection: 3,
      style: { flags: 0 },
    }),
    false,
  );
  assert.equal(
    cadMTextFlowsVertically({
      kind: 1,
      flowDirection: 1,
      style: { flags: 1 << 4 },
    }),
    false,
  );
});

test("removes MTEXT controls without losing Korean or line breaks", () => {
  assert.deepEqual(
    plainCadTextLines("{\\H1.2x;배관}\\P점검\\U+00B0%%p", true),
    ["배관", "점검°±"],
  );
  assert.deepEqual(plainCadTextLines("한글%%d", false), ["한글°"]);
  assert.deepEqual(
    plainCadTextLines(
      String.raw`\U+B0B4\U+B824\U+AC10`,
      false,
    ),
    ["내려감"],
  );
  assert.equal(
    [...plainCadTextLines("한".repeat(5_000), false)[0]].length,
    4_096,
  );
});

test("finds a text occurrence by handle for workspace search navigation", async () => {
  const scene = await textScene();
  const overlay = new CanvasTextOverlay(fakeCanvas(), {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
  });

  const occurrence = overlay.findTextOccurrence("12C");

  assert.deepEqual(occurrence.point, [101, 201, 0]);
  assert.equal(occurrence.worldHeight, 0.5);
  assert.equal(overlay.findTextOccurrence("FFFF"), null);

  const visible = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  overlay.setRenderDeltaSuppressions([
    {
      sceneId: "external",
      handleLow: 300,
      handleHigh: 0,
    },
  ]);
  assert.notEqual(overlay.findTextOccurrence("12C"), null);

  overlay.setRenderDeltaSuppressions([
    {
      sceneId: "root",
      handleLow: 300,
      handleHigh: 0,
    },
  ]);
  const suppressed = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(overlay.findTextOccurrence("12C"), null);
  assert.equal(
    suppressed.visibleOccurrences,
    visible.visibleOccurrences - 1,
  );

  overlay.setRenderDeltaSuppressions([]);
  assert.notEqual(overlay.findTextOccurrence("12C"), null);
});

test("uses the viewport MTEXT annotation context for navigation geometry", async () => {
  const scene = await textScene();
  const overlay = new CanvasTextOverlay(fakeCanvas(), {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: Object.freeze({
      ...scene.instanceGraph,
      annotationScalesByVisibilityRow: new Float64Array([100]),
    }),
    glyphCache: { getGlyph: () => undefined },
  });

  const occurrence = overlay.findTextOccurrence("12D");

  assert.deepEqual(occurrence.point, [206, 402, 0]);
  assert.equal(occurrence.worldHeight, 1);
});

test("replaces and rolls back a native Canvas text record", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    maximumSourceTexts: 1,
    minimumPixelHeight: 0.1,
    sourceId: "root",
    hitTestingEnabled: true,
  });
  const baseline = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  const { record } = normalizedRenderDeltaTextRecord({
    handle: "12c",
    ownerHandle: "64",
    value: "수정 문자",
    insertionPoint: [102, 201, 0],
    alignmentPoint: [102, 201, 0],
    height: 0.5,
  });
  const entry = Object.freeze({
    resourceKind: "text",
    sceneId: "root",
    record,
    byteLength: 1_024,
  });
  const typeDependency = dwgTypeRenderDependencyId(
    "root",
    "text-style",
    0x401n,
  );

  overlay.setRenderDeltaState({
    suppressions: [
      {
        sceneId: "root",
        handleLow: 300,
        handleHigh: 0,
      },
    ],
    texts: [entry],
    invalidatedDependencyIds: [typeDependency],
  });
  const overlaid = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );

  assert.equal(overlaid.renderDeltaTexts, 1);
  assert.equal(
    overlaid.visibleOccurrences,
    baseline.visibleOccurrences,
  );
  assert.deepEqual(
    overlay.findTextOccurrence("12C").point,
    [102, 201, 0],
  );
  const selected = overlay.hitTest(280, 300, {
    snapKinds: ["entity"],
    tolerancePixels: 20,
  });
  assert.equal(selected?.entityRecord.value, "수정 문자");
  assert.equal(selected?.renderDelta, true);

  overlay.setRenderDeltaState({
    invalidatedDependencyIds: [typeDependency],
  });
  const invalidated = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(invalidated.visibleOccurrences, 0);
  assert.equal(overlay.findTextOccurrence("12C"), null);

  overlay.setRenderDeltaState();
  const restored = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(restored.renderDeltaTexts, 0);
  assert.deepEqual(
    overlay.findTextOccurrence("12C").point,
    [101, 201, 0],
  );
});

test("tints modified text and redraws removed base text without revealing hidden layers", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    maximumSourceTexts: 1,
    minimumPixelHeight: 0.1,
    sourceId: "root",
  });
  const { record } = normalizedRenderDeltaTextRecord({
    handle: "12c",
    ownerHandle: "64",
    value: "수정 문자",
    insertionPoint: [102, 201, 0],
    alignmentPoint: [102, 201, 0],
    height: 0.5,
  });
  const entry = Object.freeze({
    resourceKind: "text",
    sceneId: "root",
    record,
    byteLength: 1_024,
  });
  const unchanged = Object.freeze({
    color: null,
    opacity: 0.35,
    visible: true,
  });
  const modified = Object.freeze({
    color: "#d29922",
    opacity: 0.5,
    visible: true,
  });
  const removed = Object.freeze({
    color: "#f85149",
    opacity: 1,
    visible: true,
  });
  const modifiedEntry = Object.freeze({
    status: "modified",
    style: modified,
  });
  const modifiedResources = new WeakMap([
    [entry, modifiedEntry],
  ]);

  overlay.setRenderDeltaState({
    suppressions: [
      {
        sceneId: "root",
        handleLow: 300,
        handleHigh: 0,
      },
    ],
    texts: [entry],
    diffOverlay: Object.freeze({
      active: true,
      statusStyles: Object.freeze({ unchanged }),
      resourceEntries: modifiedResources,
      identityEntries: new Map(),
    }),
  });
  const modifiedMetrics = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(modifiedMetrics.visibleOccurrences, 1);
  assert.ok(
    canvas.calls.fillStyles.includes(
      "rgba(210, 153, 34, 0.5)",
    ),
  );
  const beforeHidden = canvas.calls.fillText;
  const hiddenMetrics = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => false),
  );
  assert.equal(hiddenMetrics.visibleOccurrences, 0);
  assert.equal(canvas.calls.fillText, beforeHidden);

  overlay.setRenderDeltaState({
    suppressions: [
      {
        sceneId: "root",
        handleLow: 300,
        handleHigh: 0,
      },
    ],
    diffOverlay: Object.freeze({
      active: true,
      statusStyles: Object.freeze({ unchanged }),
      resourceEntries: new WeakMap(),
      identityEntries: new Map([
        [
          "root\u00000:300",
          Object.freeze({
            status: "removed",
            style: removed,
          }),
        ],
      ]),
    }),
  });
  const removedMetrics = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(removedMetrics.visibleOccurrences, 1);
  assert.notEqual(overlay.findTextOccurrence("12C"), null);
  assert.ok(
    canvas.calls.fillStyles.includes(
      "rgba(248, 81, 73, 1)",
    ),
  );

  overlay.dispose();
});

test("styles block text per INSERT occurrence and keeps source-hidden text hidden", async () => {
  const scene = await textScene();
  const secondInsert = Object.freeze({
    ...scene.metadata.inserts[1],
    index: scene.metadata.inserts.length,
    handle: 0xcbn,
    insertPoint: [15, 0, 0],
  });
  const instanceGraph = buildInstanceGraph(
    scene.metadata.blocks,
    [...scene.metadata.inserts, secondInsert],
  );
  const instances = instanceGraph.instancesByBlock.get(2);
  assert.deepEqual([...instances.handles], [0xcan, 0xcbn]);
  const sourceText = normalizedRenderDeltaTextRecord({
    handle: "130",
    ownerHandle: "66",
    value: "A",
    insertionPoint: [0, 0, 0],
    alignmentPoint: [0, 0, 0],
    height: 0.5,
  }).record;
  const textEntities = Object.freeze({
    length: 1,
    get(index) {
      if (index !== 0) {
        throw new RangeError("text entity index is out of range");
      }
      return sourceText;
    },
  });
  const canvas = fakeCanvas();
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
    sourceId: "root",
  });
  const transform = normalizedRenderDeltaTransformRecord({
    blockIndex: 2,
    handle: 0xcan,
    matrix: translatedTransformMatrix(
      instances.data[12],
      instances.data[13],
      0,
    ),
  });
  const transformEntry = Object.freeze({
    resourceKind: "transform",
    sceneId: "root",
    record: transform.record,
    byteLength: transform.buffer.byteLength,
  });
  const unchanged = Object.freeze({
    color: null,
    opacity: 0.35,
    visible: true,
  });
  const modified = Object.freeze({
    color: "#d29922",
    opacity: 0.8,
    visible: true,
  });
  const modifiedEntry = Object.freeze({
    status: "modified",
    style: modified,
  });
  const diffOverlay = Object.freeze({
    active: true,
    statusStyles: Object.freeze({ unchanged }),
    resourceEntries: new WeakMap([
      [transformEntry, modifiedEntry],
    ]),
    identityEntries: new Map([
      ["root\u00000:202", modifiedEntry],
    ]),
  });
  const firstX = instances.data[12];
  const secondX = instances.data[16 + 12];
  const firstY = instances.data[13];
  const secondY = instances.data[16 + 13];
  const occurrenceCamera = {
    origin: [
      (firstX + secondX) * 0.5,
      (firstY + secondY) * 0.5,
      0,
    ],
    worldWidth: Math.max(Math.abs(firstX - secondX) + 20, 20),
    worldHeight: Math.max(Math.abs(firstY - secondY) + 15, 15),
  };

  overlay.setRenderDeltaState({
    transforms: [transformEntry],
    diffOverlay,
  });
  const styled = overlay.redraw(
    occurrenceCamera,
    scene.metadata.layers.map(() => true),
  );
  const amber = "rgba(210, 153, 34, 0.8)";
  assert.equal(styled.visibleOccurrences, 2);
  assert.equal(
    canvas.calls.fillStyles.filter((value) => value === amber).length,
    1,
  );

  const hiddenStyle = normalizedRenderDeltaStyleRecord({
    blockIndex: 2,
    handle: 0xcan,
    visible: false,
  });
  const hiddenStyleEntry = Object.freeze({
    resourceKind: "style",
    sceneId: "root",
    record: hiddenStyle.record,
    byteLength: hiddenStyle.buffer.byteLength,
  });
  const amberCount = canvas.calls.fillStyles.filter(
    (value) => value === amber,
  ).length;
  overlay.setRenderDeltaState({
    styles: [hiddenStyleEntry],
    diffOverlay: Object.freeze({
      ...diffOverlay,
      resourceEntries: new WeakMap([
        [hiddenStyleEntry, modifiedEntry],
      ]),
    }),
  });
  const hidden = overlay.redraw(
    occurrenceCamera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(hidden.visibleOccurrences, 1);
  assert.equal(
    canvas.calls.fillStyles.filter((value) => value === amber).length,
    amberCount,
  );
  assert.deepEqual(
    overlay.findTextOccurrence("130").point,
    [secondX, secondY, instances.data[16 + 14]],
  );

  const invisibleModified = Object.freeze({
    status: "modified",
    style: Object.freeze({
      ...modified,
      visible: false,
    }),
  });
  overlay.setRenderDeltaState({
    diffOverlay: Object.freeze({
      active: true,
      statusStyles: Object.freeze({ unchanged }),
      resourceEntries: new WeakMap(),
      identityEntries: new Map([
        ["root\u00000:202", invisibleModified],
      ]),
    }),
  });
  const filtered = overlay.redraw(
    occurrenceCamera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(filtered.visibleOccurrences, 1);
  assert.deepEqual(
    overlay.findTextOccurrence("130").point,
    [secondX, secondY, instances.data[16 + 14]],
  );

  overlay.setRenderDeltaState();
  const restored = overlay.redraw(
    occurrenceCamera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(restored.visibleOccurrences, 2);
  overlay.dispose();
});

test("moves block text through a sparse instance transform", async () => {
  const scene = await textScene();
  const overlay = new CanvasTextOverlay(fakeCanvas(), {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
    sourceId: "root",
  });
  const text = normalizedRenderDeltaTextRecord({
    handle: "130",
    ownerHandle: "66",
    value: "블록 문자",
    insertionPoint: [0, 0, 0],
    alignmentPoint: [0, 0, 0],
    height: 0.5,
  });
  const transform = normalizedRenderDeltaTransformRecord({
    blockIndex: 2,
    handle: 0xcan,
    matrix: translatedTransformMatrix(110, 210, 0),
    measurementMatrix: translatedTransformMatrix(120, 220, 0),
  });
  const textEntry = Object.freeze({
    resourceKind: "text",
    sceneId: "root",
    record: text.record,
    byteLength: text.buffer.byteLength,
  });
  const transformEntry = Object.freeze({
    resourceKind: "transform",
    sceneId: "root",
    record: transform.record,
    byteLength: transform.buffer.byteLength,
  });

  overlay.setRenderDeltaState({
    texts: [textEntry],
    transforms: [transformEntry],
  });
  const moved = overlay.findTextOccurrence("130");
  const metrics = overlay.redraw(
    {
      origin: [110, 210, 0],
      worldWidth: 20,
      worldHeight: 15,
    },
    scene.metadata.layers.map(() => true),
  );

  assert.deepEqual(moved.point, [110, 210, 0]);
  assert.equal(metrics.renderDeltaTransforms, 1);

  overlay.setRenderDeltaState({ texts: [textEntry] });
  assert.deepEqual(
    overlay.findTextOccurrence("130").point,
    [
      scene.instanceGraph.instancesByBlock.get(2).data[12],
      scene.instanceGraph.instancesByBlock.get(2).data[13],
      scene.instanceGraph.instancesByBlock.get(2).data[14],
    ],
  );

  const parentTransform = normalizedRenderDeltaTransformRecord({
    blockIndex: 1,
    handle: 0xc9n,
    matrix: translatedTransformMatrix(200, 300, 0),
    measurementMatrix: translatedTransformMatrix(400, 500, 0),
  });
  overlay.setRenderDeltaState({
    texts: [textEntry],
    transforms: [
      Object.freeze({
        resourceKind: "transform",
        sceneId: "root",
        record: parentTransform.record,
        byteLength: parentTransform.buffer.byteLength,
      }),
    ],
  });
  assert.deepEqual(
    overlay.findTextOccurrence("130").point,
    [205, 300, 0],
  );
});

test("restyles and hides block text through a sparse instance style", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
    sourceId: "root",
  });
  const text = normalizedRenderDeltaTextRecord({
    handle: "130",
    ownerHandle: "66",
    color: ((1 << 30) | (2 << 24)) >>> 0,
    value: "블록 문자",
    insertionPoint: [0, 0, 0],
    alignmentPoint: [0, 0, 0],
    height: 0.5,
  });
  const visibleStyle = normalizedRenderDeltaStyleRecord({
    blockIndex: 2,
    handle: 0xcan,
    color: 0x8000_0005,
    opacity: 0.25,
    visible: true,
  });
  const hiddenStyle = normalizedRenderDeltaStyleRecord({
    blockIndex: 2,
    handle: 0xcan,
    visible: false,
  });
  const textEntry = Object.freeze({
    resourceKind: "text",
    sceneId: "root",
    record: text.record,
    byteLength: text.buffer.byteLength,
  });
  const styleEntry = (fixture) =>
    Object.freeze({
      resourceKind: "style",
      sceneId: "root",
      record: fixture.record,
      byteLength: fixture.buffer.byteLength,
    });
  const instances =
    scene.instanceGraph.instancesByBlock.get(2);
  const camera = {
    origin: [instances.data[12], instances.data[13], 0],
    worldWidth: 20,
    worldHeight: 15,
  };

  overlay.setRenderDeltaState({
    texts: [textEntry],
    styles: [styleEntry(visibleStyle)],
  });
  const visibleMetrics = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(visibleMetrics.renderDeltaStyles, 1);
  assert.equal(visibleMetrics.visibleOccurrences, 2);
  assert.ok(
    canvas.calls.fillStyles.includes(
      "rgba(0, 0, 255, 0.25)",
    ),
  );

  overlay.setRenderDeltaState({
    texts: [textEntry],
    styles: [styleEntry(hiddenStyle)],
  });
  const hiddenMetrics = overlay.redraw(
    camera,
    scene.metadata.layers.map(() => true),
  );
  assert.equal(hiddenMetrics.renderDeltaStyles, 1);
  assert.equal(hiddenMetrics.visibleOccurrences, 1);
  assert.equal(overlay.findTextOccurrence("130"), null);

  overlay.setRenderDeltaState({ texts: [textEntry] });
  assert.notEqual(overlay.findTextOccurrence("130"), null);

  const hiddenParentStyle = normalizedRenderDeltaStyleRecord({
    blockIndex: 1,
    handle: 0xc9n,
    visible: false,
  });
  overlay.setRenderDeltaState({
    texts: [textEntry],
    styles: [
      Object.freeze({
        resourceKind: "style",
        sceneId: "root",
        record: hiddenParentStyle.record,
        byteLength: hiddenParentStyle.buffer.byteLength,
      }),
    ],
  });
  assert.equal(overlay.findTextOccurrence("130"), null);
});

test("selects rendered text by its screen footprint", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
    sourceId: "root",
    sourceLabel: "현재 도면",
    hitTestingEnabled: true,
  });

  overlay.redraw(camera, scene.metadata.layers.map(() => true));
  const selected = overlay.hitTest(242, 296, {
    snapKinds: ["entity"],
  });
  const insertion = overlay.hitTest(240, 300, {
    snapKinds: ["insertion"],
  });

  assert.equal(selected.entityType, "text");
  assert.equal(selected.sourceId, "root");
  assert.equal(selected.sourceLabel, "현재 도면");
  assert.equal(selected.handle, 300n);
  assert.equal(selected.sourceKindName, "TEXT");
  assert.equal(selected.entityRecord.value, "한글");
  assert.equal(selected.renderDelta, false);
  assert.equal(insertion.kind, "insertion");
  assert.deepEqual(insertion.displayPoint, [101, 201, 0]);
});

test("wraps MTEXT to its stored paragraph width", () => {
  assert.deepEqual(
    wrapCadTextLines(
      ["가나다 라마바사", "", "abcdef"],
      5,
      () => 1,
    ),
    ["가나다", "라마바사", "", "abcde", "f"],
  );
  assert.deepEqual(
    wrapCadTextLines(["폭 정보 없음"], 0, () => 1),
    ["폭 정보 없음"],
  );
});

test("splits bounded MTEXT columns and reverses only their visual order", () => {
  const columns = layoutCadTextColumns(
    ["A", "B", "C", "D"],
    {
      count: 2,
      width: 5,
      gutter: 1,
      heights: [3.334, 3.334],
      lineStep: 1.667,
      flowReversed: true,
    },
  );

  assert.deepEqual(
    columns.map(({ x, lines }) => ({ x, lines })),
    [
      { x: 6, lines: ["A", "B"] },
      { x: 0, lines: ["C", "D"] },
    ],
  );
  assert.equal(
    layoutCadTextColumns(["A"], { count: 10_000 }).length,
    64,
  );
});

test("maps common CAD TrueType files to platform-safe Korean fallbacks", () => {
  assert.equal(
    systemFallbackFont({ fontFile: "C:\\Windows\\Fonts\\malgun.ttf" }),
    '1px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
  );
  assert.equal(
    systemFallbackFont({ fontFile: "malgunbd.ttf" }),
    '700 1px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
  );
  assert.equal(
    systemFallbackFont({
      fontFile: "HCR Batang",
      trueTypeFont: "HCR Batang",
      inlineFontFamily: "HCR Batang",
      inlineBold: true,
    }),
    '700 1px "HCR Batang", "Batang", "AppleMyungjo", "Noto Serif KR", serif',
  );
  assert.equal(
    systemFallbackFont({ fontFile: "arial.ttf" }),
    '1px "Arial", "Helvetica Neue", Helvetica, sans-serif',
  );
  assert.equal(
    systemFallbackFont({ fontFile: "batang.ttf" }),
    '1px "Batang", "AppleMyungjo", "Noto Serif KR", serif',
  );
  assert.equal(
    registerLocalOutlineFont("굵은돋움체.TTF", "DwgLocalFont_1_7"),
    "굵은돋움체.ttf",
  );
  assert.equal(
    systemFallbackFont({ fontFile: "C:\\Fonts\\굵은돋움체.ttf" }),
    '1px "DwgLocalFont_1_7", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif',
  );
  assert.equal(
    systemFallbackFont({
      fontFile: "굵은돋움체.ttf",
      inlineBold: true,
      inlineItalic: true,
    }),
    'italic 700 1px "DwgLocalFont_1_7", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif',
  );
  assert.equal(unregisterLocalOutlineFont("굵은돋움체.ttf"), true);
});

test("falls back to system Korean text within a hard glyph budget", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    maximumFallbackGlyphs: 2,
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);
  assert.equal(metrics.fallbackGlyphs, 2);
  assert.equal(metrics.truncated, true);
  assert.equal(canvas.calls.fillText, 2);
  assert.ok(
    canvas.calls.transforms.some(
      ([a, b, c, d]) => a > 0 && b === 0 && c === 0 && d > 0,
    ),
  );
});

test("renders visible block ATTDEF text and skips only invisible definitions", () => {
  const canvas = fakeCanvas();
  const baseRecord = {
    ownerHandle: 200n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 2,
    flags: 0,
    insertionPoint: [0, 0, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 1,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const records = [
    {
      ...baseRecord,
      handle: 10n,
    },
    {
      ...baseRecord,
      handle: 11n,
      insertionPoint: [2, 0, 0],
      sourceFlags: 1 << 1,
    },
    {
      ...baseRecord,
      handle: 12n,
      insertionPoint: [4, 0, 0],
      sourceFlags: 1,
    },
    {
      ...baseRecord,
      handle: 13n,
      insertionPoint: [6, 0, 0],
      commonFlags: 1,
    },
  ];
  const values = ["A", "B", "C", "D"];
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: records.length,
      readDisplayRecord(index, target) {
        const record = records[index];
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        return target;
      },
      readValue(index) {
        return values[index];
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
      {
        index: 1,
        handle: 200n,
        name: "TITLE",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map([
        [
          1,
          {
            data: translationMat4(104, 201, 0),
            count: 1,
            length: 1,
          },
        ],
      ]),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);

  assert.equal(metrics.visitedSourceTexts, 4);
  assert.equal(metrics.visibleOccurrences, 2);
  assert.deepEqual(
    canvas.calls.fillTextArguments.map(([value]) => value),
    ["A", "B"],
  );
});

test("anchors justified TEXT with measured fallback-font metrics", () => {
  const canvas = fakeCanvas({
    measureText(character) {
      return {
        width: character === "A" ? 0.5 : 1.5,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: character === "A" ? 0.5 : 1.5,
        actualBoundingBoxAscent: 0.8,
        actualBoundingBoxDescent: 0.2,
      };
    },
  });
  const record = {
    handle: 5n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 0,
    flags: 1,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [107, 201.5, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 1,
    verticalAlignment: 2,
    generationFlags: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 2,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        return target;
      },
      readValue() {
        return "AB";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(canvas.calls.fillTextArguments, [
    ["A", -1, 0.30000000000000004],
    ["B", -0.5, 0.30000000000000004],
  ]);
  assert.ok(
    canvas.calls.transforms.some(
      ([a, b, c, d, e, f]) =>
        a === 40 &&
        b === 0 &&
        c === 0 &&
        d === 40 &&
        e === 480 &&
        f === 280,
    ),
  );
});

test("applies only the stored TEXT fit width between alignment points", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 13n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 0,
    flags: 1,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [109, 201, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 5,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 2,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        return target;
      },
      readValue() {
        return "AB";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(canvas.calls.fillTextArguments, [
    ["A", 0, -0],
    ["B", 1, -0],
  ]);
  assert.ok(
    canvas.calls.transforms.some(
      ([a, b, c, d]) => a === 80 && b === 0 && c === 0 && d === 40,
    ),
  );
});

test("uses the stored proportional height for aligned TEXT", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 14n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 0,
    flags: 1,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [109, 201, 0],
    normal: [0, 0, 1],
    height: 2,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 3,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 2,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        return target;
      },
      readValue() {
        return "AB";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(canvas.calls.fillTextArguments, [
    ["A", 0, -0],
    ["B", 1, -0],
  ]);
  assert.ok(
    canvas.calls.transforms.some(
      ([a, b, c, d]) => a === 80 && b === 0 && c === 0 && d === 80,
    ),
  );
});

test("maps TEXT insertion points from their stored OCS plane", () => {
  const matrix = cadTextEntityMatrix(
    {
      kind: 0,
      insertionPoint: [2, 3, 4],
      normal: [1, 0, 0],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      generationFlags: 0,
    },
    { flags: 0, widthFactor: 1 },
  );

  assert.deepEqual(transformPoint(matrix, [0, 0, 0]), [4, 2, 3]);
});

test("selects exact MTEXT annotation representations without blanket scaling", () => {
  const base = {
    kind: 1,
    flags: 1 << 2,
    insertionPoint: [10, 20, 0],
    xAxisDirection: [1, 0, 0],
    height: 100,
    columnCount: 2,
    columnFlags: 1,
    annotationContexts: [
      {
        scale: 50,
        isDefault: true,
        autoHeight: true,
        flowReversed: false,
        attachment: 1,
        insertionPoint: [10, 20, 0],
        xAxisDirection: [1, 0, 0],
        rectangleHeight: 500,
        rectangleWidth: 1_000,
        extentsWidth: 900,
        extentsHeight: 450,
        columnType: 2,
        columnWidth: 450,
        columnGutter: 100,
        columnHeights: new Float64Array([500, 550]),
      },
      {
        scale: 100,
        isDefault: false,
        autoHeight: false,
        flowReversed: true,
        attachment: 3,
        insertionPoint: [30, 40, 0],
        xAxisDirection: [0, 1, 0],
        rectangleHeight: 1_000,
        rectangleWidth: 2_000,
        extentsWidth: 1_800,
        extentsHeight: 900,
        columnType: 2,
        columnWidth: 900,
        columnGutter: 200,
        columnHeights: new Float64Array([1_000, 1_100]),
      },
    ],
  };
  const instances = { visibilityRows: new Uint32Array([1]) };
  const defaultDisplay = annotativeTextRecordForInstance(
    base,
    { annotationScalesByVisibilityRow: new Float64Array([0, 50]) },
    instances,
    0,
  );
  const alternateDisplay = annotativeTextRecordForInstance(
    base,
    { annotationScalesByVisibilityRow: new Float64Array([0, 100]) },
    instances,
    0,
  );
  const unmatchedDisplay = annotativeTextRecordForInstance(
    base,
    { annotationScalesByVisibilityRow: new Float64Array([0, 25]) },
    instances,
    0,
  );

  assert.strictEqual(defaultDisplay, base);
  assert.strictEqual(unmatchedDisplay, base);
  assert.equal(alternateDisplay.height, 200);
  assert.deepEqual(alternateDisplay.insertionPoint, [30, 40, 0]);
  assert.deepEqual(alternateDisplay.xAxisDirection, [0, 1, 0]);
  assert.equal(alternateDisplay.attachment, 3);
  assert.equal(alternateDisplay.rectangleWidth, 2_000);
  assert.equal(alternateDisplay.columnFlags & 1, 0);
  assert.equal(alternateDisplay.columnFlags & 2, 2);
  assert.deepEqual([...alternateDisplay.columnHeights], [1_000, 1_100]);
});

test("uses the alignment point for justified TEXT and attribute entities", () => {
  for (const kind of [0, 2, 3]) {
    const matrix = cadTextEntityMatrix(
      {
        kind,
        mtextType: 0,
        insertionPoint: [2, 3, 4],
        alignmentPoint: [5, 6, 7],
        normal: [1, 0, 0],
        height: 1,
        widthFactor: 1,
        rotation: 0,
        obliqueAngle: 0,
        horizontalAlignment: 1,
        verticalAlignment: 2,
        generationFlags: 0,
      },
      { flags: 0, widthFactor: 1 },
    );

    assert.deepEqual(
      transformPoint(matrix, [0, 0, 0]),
      [7, 5, 6],
      `kind ${kind}`,
    );
  }
});

test("derives Align and Fit rotation from their endpoint span", () => {
  for (const horizontalAlignment of [3, 5]) {
    const matrix = cadTextEntityMatrix(
      {
        kind: 0,
        mtextType: 0,
        insertionPoint: [0, 0, 0],
        alignmentPoint: [3, 4, 0],
        normal: [0, 0, 1],
        height: 1,
        widthFactor: 1,
        rotation: 0,
        obliqueAngle: 0,
        horizontalAlignment,
        verticalAlignment: 0,
        generationFlags: 0,
      },
      { flags: 0, widthFactor: 1 },
    );
    const point = transformPoint(matrix, [1, 0, 0]);
    assert.ok(Math.abs(point[0] - 0.6) < 1e-12);
    assert.ok(Math.abs(point[1] - 0.8) < 1e-12);
    assert.ok(Math.abs(point[2]) < 1e-12);
  }
});

test("uses embedded MTEXT insertion and world direction for multiline attributes", () => {
  const matrix = cadTextEntityMatrix(
    {
      kind: 3,
      mtextType: 1,
      insertionPoint: [1, 2, 3],
      alignmentPoint: [9, 9, 9],
      normal: [0, 0, 1],
      xAxisDirection: [0, 1, 0],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      horizontalAlignment: 2,
      verticalAlignment: 3,
      generationFlags: 0,
    },
    { flags: 0, widthFactor: 1 },
  );

  assert.deepEqual(transformPoint(matrix, [0, 0, 0]), [1, 2, 3]);
  assert.deepEqual(transformPoint(matrix, [1, 0, 0]), [1, 3, 3]);
});

test("computes every single-line TEXT justification offset from glyph metrics", () => {
  const horizontalOffsets = new Map([
    [0, 0],
    [1, -4],
    [2, -8],
    [3, 0],
    [4, -4],
    [5, 0],
  ]);
  const verticalOffsets = new Map([
    [0, 0],
    [1, 0.2],
    [2, -0.30000000000000004],
    [3, -0.8],
  ]);
  for (let horizontalAlignment = 0; horizontalAlignment <= 5;
    horizontalAlignment += 1) {
    for (let verticalAlignment = 0; verticalAlignment <= 3;
      verticalAlignment += 1) {
      const offsets = cadTextAlignmentOffsets(
        {
          kind: 0,
          mtextType: 0,
          horizontalAlignment,
          verticalAlignment,
        },
        { advance: 8, top: 0.8, bottom: -0.2 },
      );
      assert.deepEqual(
        offsets,
        {
          horizontal: horizontalOffsets.get(horizontalAlignment),
          baseline:
            horizontalAlignment === 4 && verticalAlignment === 0
              ? -0.30000000000000004
              : verticalOffsets.get(verticalAlignment),
        },
        `${horizontalAlignment}/${verticalAlignment}`,
      );
    }
  }
});

test("uses endpoint width only for baseline Align and Fit TEXT", () => {
  const record = {
    kind: 0,
    insertionPoint: [0, 0, 0],
    alignmentPoint: [3, 4, 0],
    height: 1,
    widthFactor: 1,
    mtextType: 0,
    style: { widthFactor: 1 },
  };

  for (let vertical = 0; vertical <= 3; vertical += 1) {
    for (let horizontal = 0; horizontal <= 5; horizontal += 1) {
      assert.equal(
        cadTextAlignmentWidth({
          ...record,
          horizontalAlignment: horizontal,
          verticalAlignment: vertical,
        }),
        vertical === 0 && (horizontal === 3 || horizontal === 5)
          ? 5
          : 0,
        `${horizontal}/${vertical}`,
      );
    }
  }
});

test("uses MTEXT extents for middle-center attachment", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 6n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 10,
    rectangleHeight: 4,
    extentsWidth: 10,
    extentsHeight: 4,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 5,
    mtextType: 0,
    valueByteLength: 2,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        return target;
      },
      readValue() {
        return "AB";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(canvas.calls.fillTextArguments[0], ["A", -1, -1]);
  assert.ok(
    canvas.calls.transforms.some(([a, b, c, d]) =>
      a === 200 && b === 0 && c === 0 && d === 40,
    ),
  );
});

test("uses the stored MTEXT WCS X-axis direction", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 7n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    xAxisDirection: [0, 1, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 0,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 1,
    mtextType: 0,
    columnType: 0,
    valueByteLength: 1,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        target.xAxisDirection = [...record.xAxisDirection];
        return target;
      },
      readValue() {
        return "A";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.ok(
    canvas.calls.transforms.some(
      ([a, b, c, d]) =>
        Math.abs(a) < 1e-9 &&
        Math.abs(b + 40) < 1e-9 &&
        Math.abs(c - 40) < 1e-9 &&
        Math.abs(d) < 1e-9,
    ),
  );
});

test("flows MTEXT into stored columns and paints its background first", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 8n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    xAxisDirection: [1, 0, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 0,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    backgroundScale: 1.5,
    backgroundColor: (2 << 30) | 2,
    backgroundTransparency: 0,
    backgroundFlags: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 1,
    mtextType: 0,
    columnType: 2,
    columnCount: 2,
    columnFlags: 0,
    columnWidth: 2,
    columnGutter: 1,
    columnHeights: new Float64Array([3.334, 3.334]),
    valueByteLength: 10,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        target.xAxisDirection = [...record.xAxisDirection];
        return target;
      },
      readValue() {
        return String.raw`A\PB\PC\PD`;
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);

  assert.equal(metrics.backgroundFills, 1);
  assert.equal(canvas.calls.fills, 1);
  assert.equal(canvas.calls.fillStyles[0], "rgba(255, 255, 0, 1)");
  assert.equal(canvas.calls.events[0], "fill");
  assert.equal(canvas.calls.fillTextArguments.length, 4);
  assert.equal(canvas.calls.fillTextArguments[2][1], 3);
  assert.equal(canvas.calls.fillTextArguments[3][1], 3);
});

test("renders bounded inline MTEXT font, color, height, width and slant", () => {
  const canvas = fakeCanvas();
  const requestedStyles = [];
  const inlineFontRequests = [];
  const record = {
    handle: 9n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    xAxisDirection: [1, 0, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 0,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 1,
    mtextType: 0,
    columnType: 0,
    columnCount: 0,
    columnFlags: 0,
    valueByteLength: 80,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        target.xAxisDirection = [...record.xAxisDirection];
        return target;
      },
      readValue() {
        return String.raw`{\fHCR Batang|b1|i0|c129|p18;\H0.5x;\W0.5;\T2;\Q20;\C2;\LA\l}B`;
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: {
      getGlyph(style) {
        requestedStyles.push(style);
        return undefined;
      },
    },
    minimumPixelHeight: 0.1,
    onInlineFonts(names) {
      inlineFontRequests.push(names);
    },
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(
    canvas.calls.fillTextArguments.map(([character]) => character),
    ["A", "B"],
  );
  assert.ok(
    requestedStyles.some(
      (style) =>
        style.fontFile === "HCR Batang" &&
        style.inlineBold === true &&
        style.inlineItalic === false,
    ),
  );
  assert.ok(
    canvas.calls.fonts.some((font) =>
      font.includes('"HCR Batang", "Batang"'),
    ),
  );
  assert.ok(
    canvas.calls.fillStyles.includes("rgba(255, 255, 0, 1)"),
  );
  assert.ok(
    canvas.calls.fillStyles.includes("rgba(255, 255, 255, 1)"),
  );
  assert.ok(
    canvas.calls.transforms.some(
      ([a, _b, c, d]) =>
        Math.abs(a - 10) < 1e-9 &&
        Math.abs(c) > 1 &&
        Math.abs(d - 20) < 1e-9,
    ),
  );
  assert.ok(
    canvas.calls.transforms.some(
      ([a, b, c, d]) => a === 40 && b === 0 && c === 0 && d === 40,
    ),
  );
  assert.ok(canvas.calls.lineTo >= 1);
  assert.ok(canvas.calls.stroke >= 1);
  assert.deepEqual(inlineFontRequests, [["HCR Batang"]]);
  overlay.redraw(camera, [true]);
  assert.equal(inlineFontRequests.length, 1);
});

test("renders MTEXT fractions and tolerances as stacked glyphs", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 10n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    xAxisDirection: [1, 0, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 0,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 1,
    flowDirection: 1,
    mtextType: 0,
    columnType: 0,
    columnCount: 0,
    columnFlags: 0,
    valueByteLength: 40,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        target.xAxisDirection = [...record.xAxisDirection];
        return target;
      },
      readValue() {
        return String.raw`\S1/2; \S3#4; \S+0.1^-0.2;`;
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);
  assert.deepEqual(
    canvas.calls.fillTextArguments.map(([character]) => character),
    ["1", "2", "3", "4", "+", "0", ".", "1", "-", "0", ".", "2"],
  );
  const verticalPositions = canvas.calls.fillTextArguments.map(
    ([_character, _x, y]) => y,
  );
  assert.ok(
    Math.max(...verticalPositions) - Math.min(...verticalPositions) >
      0.5,
  );
  assert.equal(canvas.calls.lineTo, 2);
  assert.equal(canvas.calls.stroke, 2);
  assert.equal(metrics.segments, 2);
});

test("renders MTEXT paragraph indents and custom tab stops", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 11n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    xAxisDirection: [1, 0, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 20,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 1,
    flowDirection: 1,
    mtextType: 0,
    columnType: 0,
    columnCount: 0,
    columnFlags: 0,
    valueByteLength: 24,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        target.xAxisDirection = [...record.xAxisDirection];
        return target;
      },
      readValue() {
        return String.raw`\pxt5,c10,r16;A^IBB^ICCCC^IDDD`;
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);
  assert.deepEqual(
    canvas.calls.fillTextArguments.map(([character, x]) => [
      character,
      x,
    ]),
    [
      ["A", 0],
      ["B", 5],
      ["B", 6],
      ["C", 8],
      ["C", 9],
      ["C", 10],
      ["C", 11],
      ["D", 13],
      ["D", 14],
      ["D", 15],
    ],
  );
});

test("renders top-to-bottom MTEXT as upright right-to-left columns", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 12n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    xAxisDirection: [1, 0, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 0,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 1,
    flowDirection: 2,
    mtextType: 0,
    columnType: 0,
    columnCount: 0,
    columnFlags: 0,
    valueByteLength: 8,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        target.xAxisDirection = [...record.xAxisDirection];
        return target;
      },
      readValue() {
        return String.raw`한글\P세로`;
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);
  const positions = canvas.calls.fillTextArguments.map(
    ([character, x, y]) => ({ character, x, y }),
  );
  assert.deepEqual(
    positions.map(({ character }) => character),
    ["한", "글", "세", "로"],
  );
  assert.equal(positions[0].x, positions[1].x);
  assert.equal(positions[2].x, positions[3].x);
  assert.ok(
    positions[0].x > positions[2].x,
    JSON.stringify(positions),
  );
  assert.ok(positions[1].y > positions[0].y);
  assert.ok(positions[3].y > positions[2].y);
});

test("resolves text ByLayer and ByBlock colors at the occurrence", () => {
  const canvas = fakeCanvas();
  const records = [
    {
      handle: 5n,
      ownerHandle: 100n,
      layerIndex: 0,
      color: 0,
      commonFlags: 0,
      kind: 0,
      insertionPoint: [105, 201, 0],
      alignmentPoint: [0, 0, 0],
      normal: [0, 0, 1],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      lineSpacingFactor: 1,
      sourceFlags: 0,
      horizontalAlignment: 0,
      verticalAlignment: 0,
      generationFlags: 0,
      attachment: 0,
      mtextType: 0,
      valueByteLength: 1,
      style: null,
    },
    {
      handle: 6n,
      ownerHandle: 200n,
      layerIndex: 0,
      color: 1 << 30,
      commonFlags: 0,
      kind: 0,
      insertionPoint: [0, 0, 0],
      alignmentPoint: [0, 0, 0],
      normal: [0, 0, 1],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      lineSpacingFactor: 1,
      sourceFlags: 0,
      horizontalAlignment: 0,
      verticalAlignment: 0,
      generationFlags: 0,
      attachment: 0,
      mtextType: 0,
      valueByteLength: 1,
      style: null,
    },
  ];
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: records.length,
      readDisplayRecord(index, target) {
        Object.assign(target, records[index]);
        target.insertionPoint = [...records[index].insertionPoint];
        target.alignmentPoint = [...records[index].alignmentPoint];
        target.normal = [...records[index].normal];
        return target;
      },
      readValue() {
        return "A";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
      {
        index: 1,
        handle: 200n,
        name: "ColoredBlock",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 1 }],
    instanceGraph: {
      instancesByBlock: new Map([
        [
          1,
          {
            data: translationMat4(105, 201, 0),
            colors: new Uint32Array([(2 << 30) | 3]),
            opacities: new Float32Array([1]),
            count: 1,
          },
        ],
      ]),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(canvas.calls.fillStyles, [
    "rgba(255, 0, 0, 1)",
    "rgba(0, 255, 0, 1)",
  ]);
  assert.deepEqual(canvas.calls.strokeStyles, canvas.calls.fillStyles);
});

test("draws repeated block text in absolute display order", () => {
  const canvas = fakeCanvas();
  const records = [10n, 20n].map((handle) => ({
    handle,
    ownerHandle: 200n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 0,
    insertionPoint: [0, 0, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 1,
    style: null,
  }));
  const first = translationMat4(104, 201, 0);
  const second = translationMat4(106, 201, 0);
  const events = records.map((record, index) => ({
    kind: "entity",
    handle: record.handle,
    key: record.handle,
    prefix: index,
    contribution: 1,
  }));
  const maskOrder = {
    enabled: true,
    generalOrderEnabled: true,
    modelOwnerHandle: 100n,
    owners: new Map([
      [
        200n,
        {
          overrides: new Map(),
          events,
        },
      ],
    ]),
    masks: [],
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: records.length,
      readDisplayRecord(index, target) {
        Object.assign(target, records[index]);
        target.insertionPoint = [...records[index].insertionPoint];
        target.alignmentPoint = [...records[index].alignmentPoint];
        target.normal = [...records[index].normal];
        return target;
      },
      readValue(index) {
        return index === 0 ? "A" : "B";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
      {
        index: 1,
        handle: 200n,
        name: "RepeatedBlock",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ name: "0", color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map([
        [
          1,
          {
            data: new Float64Array([...first, ...second]),
            maskBases: new Uint32Array([0, 2]),
            layerIndices: new Uint32Array([0xffffffff, 0xffffffff]),
            opacities: new Float32Array([1, 1]),
            count: 2,
          },
        ],
      ]),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    maskOrder,
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(
    canvas.calls.fillTextArguments.map(([value]) => value),
    ["A", "B", "A", "B"],
  );
});

test("streams composite text layers through one reusable Canvas", () => {
  const canvas = compositingCanvas();
  const composite = new CompositeTextOverlay(canvas);
  const redraws = [];
  const makeOverlay = (id) => ({
    id,
    canvas,
    orderCanvas: composite.orderCanvas,
    redraw(_camera, _layers, { clear }) {
      redraws.push([id, clear]);
      return {};
    },
    dispose() {},
  });
  composite.add(makeOverlay("root"));
  composite.add(makeOverlay("xref"));
  const composed = [];

  composite.redraw(camera, [true], {
    canDrawOrderedLayer: () => true,
    drawOrderedLayer(overlay) {
      composed.push(overlay.id);
      return { width: 10, height: 10, gpuBytes: 800 };
    },
  });

  assert.deepEqual(redraws, [
    ["root", true],
    ["xref", true],
  ]);
  assert.deepEqual(composed, ["root", "xref"]);
  assert.equal(composite.lastOrderedComposition.attempted, true);
  assert.equal(composite.lastOrderedComposition.succeeded, true);
  assert.equal(composite.lastOrderedComposition.results.length, 2);
});

test("draws cached SHX segments and obeys the frame segment cap", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const glyph = Object.freeze({
    advance: 1,
    segmentCount: 1,
    vertices: new Float32Array([0, 0, 1, 0]),
  });
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => glyph },
    maximumSegments: 3,
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);
  assert.equal(metrics.segments, 3);
  assert.equal(metrics.truncated, true);
  assert.equal(canvas.calls.lineTo, 3);
  assert.ok(canvas.calls.stroke > 0);
});

test("does not decode source strings that are outside the viewport", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const readValue = scene.textEntities.readValue.bind(scene.textEntities);
  let decodedValues = 0;
  scene.textEntities.readValue = (index) => {
    decodedValues += 1;
    return readValue(index);
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(
    {
      origin: [1_000_000, 1_000_000, 0],
      worldWidth: 200,
      worldHeight: 150,
    },
    [true],
  );

  assert.equal(decodedValues, 0);
});

test("clips only text below a later WIPEOUT mask", () => {
  const canvas = fakeCanvas();
  const records = [
    {
      handle: 5n,
      ownerHandle: 100n,
      layerIndex: 0,
      color: (2 << 30) | 7,
      commonFlags: 0,
      kind: 0,
      insertionPoint: [105, 201, 0],
      normal: [0, 0, 1],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      lineSpacingFactor: 1,
      sourceFlags: 0,
      horizontalAlignment: 0,
      attachment: 0,
      mtextType: 0,
      valueByteLength: 3,
      style: null,
    },
    {
      handle: 15n,
      ownerHandle: 100n,
      layerIndex: 0,
      color: (2 << 30) | 7,
      commonFlags: 0,
      kind: 0,
      insertionPoint: [105, 201, 0],
      normal: [0, 0, 1],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      lineSpacingFactor: 1,
      sourceFlags: 0,
      horizontalAlignment: 0,
      attachment: 0,
      mtextType: 0,
      valueByteLength: 3,
      style: null,
    },
  ];
  const textEntities = {
    length: records.length,
    readDisplayRecord(index, target) {
      Object.assign(target, records[index]);
      target.insertionPoint = [...records[index].insertionPoint];
      target.normal = [...records[index].normal];
      return target;
    },
    readValue() {
      return "한";
    },
  };
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
    masks: [
      {
        handle: 10n,
        ownerHandle: 100n,
        layerIndex: 0,
        localBucket: 1,
        points: [
          [100, 196, 0],
          [110, 196, 0],
          [110, 206, 0],
          [100, 206, 0],
        ],
      },
    ],
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities,
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    maskOrder,
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);

  assert.equal(metrics.visibleOccurrences, 2);
  assert.equal(metrics.maskOccurrences, 1);
  assert.equal(metrics.clippedTextOccurrences, 1);
  assert.equal(metrics.maskClipOperations, 1);
  assert.deepEqual(canvas.calls.clips, ["evenodd"]);
  assert.equal(canvas.calls.saves, 1);
  assert.equal(canvas.calls.restores, 1);

  overlay.setMaskVisibility(false);
  const withoutMasks = overlay.redraw(camera, [true]);
  assert.equal(withoutMasks.maskOccurrences, 0);
  assert.equal(withoutMasks.clippedTextOccurrences, 0);
  assert.equal(withoutMasks.maskClipOperations, 0);
  assert.deepEqual(canvas.calls.clips, ["evenodd"]);
});

test("transforms and clips external ATTRIB text with its XREF root", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 5n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 3,
    insertionPoint: [0, 0, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 3,
    style: null,
  };
  const textEntities = {
    length: 1,
    readDisplayRecord(_index, target) {
      Object.assign(target, record);
      target.insertionPoint = [...record.insertionPoint];
      target.normal = [...record.normal];
      return target;
    },
    readValue() {
      return "한";
    },
  };
  const rootInstances = {
    data: translationMat4(100, 0, 0),
    maskBases: new Uint32Array([0]),
    clipIds: new Uint32Array([1]),
    count: 1,
    length: 1,
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities,
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set(),
      rootInstances,
      clipNodes: [
        createClipNode(1, 0, [
          [90, -10, 0],
          [110, -10, 0],
          [110, 10, 0],
          [90, 10, 0],
        ]),
      ],
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
    sourceId: "xref-1",
  });

  const metrics = overlay.redraw(
    {
      origin: [100, 0, 0],
      worldWidth: 20,
      worldHeight: 15,
    },
    [true],
  );

  assert.equal(metrics.visibleOccurrences, 1);
  assert.equal(metrics.xclipOccurrences, 1);
  assert.equal(metrics.xclipOperations, 1);
  assert.deepEqual(canvas.calls.clips, ["nonzero"]);
  assert.equal(canvas.calls.saves, 1);
  assert.equal(canvas.calls.restores, 1);

  const { record: dynamicRecord } =
    normalizedRenderDeltaTextRecord({
      handle: "5",
      ownerHandle: "64",
      kind: 3,
      value: "외부 변경",
      insertionPoint: [1, 0, 0],
      alignmentPoint: [1, 0, 0],
    });
  overlay.setRenderDeltaState({
    suppressions: [
      {
        sceneId: "xref-1",
        handleLow: 5,
        handleHigh: 0,
      },
    ],
    texts: [
      Object.freeze({
        resourceKind: "text",
        sceneId: "xref-1",
        record: dynamicRecord,
        byteLength: 1_024,
      }),
    ],
  });
  const overlaid = overlay.redraw(
    {
      origin: [100, 0, 0],
      worldWidth: 20,
      worldHeight: 15,
    },
    [true],
  );
  assert.equal(overlaid.renderDeltaTexts, 1);
  assert.equal(overlaid.visibleOccurrences, 1);
  assert.deepEqual(overlay.findTextOccurrence("5").point, [
    101,
    0,
    0,
  ]);

  overlay.setRenderDeltaState();
  assert.deepEqual(overlay.findTextOccurrence("5").point, [
    100,
    0,
    0,
  ]);
});
