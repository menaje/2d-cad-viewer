import assert from "node:assert/strict";
import test from "node:test";

import { identityMat4 } from "../src/math.mjs";
import {
  bitmapTargetSize,
  calculateRasterImageBounds,
  CanvasRasterImageOverlay,
  RasterImageAssetStore,
  requestedBitmapTargetSize,
} from "../src/raster-image-overlay.mjs";
import {
  normalizedRenderDeltaStyleRecord,
} from "./render-delta-style-fixture.mjs";
import {
  normalizedRenderDeltaTransformRecord,
  translatedTransformMatrix,
} from "./render-delta-transform-fixture.mjs";
import {
  dwgBlockRenderDependencyId,
} from "../src/render-delta-dependency.mjs";
import {
  NESTED_INSTANCE_BLOCKS,
  NESTED_INSTANCE_HANDLES,
  NESTED_INSTANCE_LAYERS,
  nestedInstanceGraph,
} from "./nested-instance-graph-fixture.mjs";

function imageTable(record, path = String.raw`.\image\도면.png`) {
  return {
    length: 1,
    readEntity(_index, target) {
      Object.assign(target, record);
      target.insertionPoint = [...record.insertionPoint];
      target.uVector = [...record.uVector];
      target.vVector = [...record.vVector];
      target.size = [...record.size];
      return target;
    },
    readPath() {
      return path;
    },
    readClipVertex(index, target) {
      target[0] = record.clipVertices[index][0];
      target[1] = record.clipVertices[index][1];
      return target;
    },
  };
}

function fakeCanvas() {
  const calls = {
    clips: [],
    clearRect: 0,
    drawImage: [],
    fillRect: [],
    lineDashes: [],
    strokes: 0,
    transforms: [],
  };
  const context = {
    filter: "none",
    globalAlpha: 1,
    beginPath() {},
    clearRect() {
      calls.clearRect += 1;
    },
    clip(rule) {
      calls.clips.push(rule);
    },
    closePath() {},
    drawImage(...values) {
      calls.drawImage.push({
        values,
        alpha: this.globalAlpha,
        filter: this.filter,
        imageSmoothingEnabled: this.imageSmoothingEnabled,
        imageSmoothingQuality: this.imageSmoothingQuality,
        transform: calls.transforms.at(-1),
      });
    },
    fillRect(...values) {
      calls.fillRect.push({
        values,
        alpha: this.globalAlpha,
        fillStyle: this.fillStyle,
        filter: this.filter,
        transform: calls.transforms.at(-1),
      });
    },
    lineTo() {},
    moveTo() {},
    rect() {},
    restore() {},
    save() {},
    setLineDash(values) {
      calls.lineDashes.push([...values]);
    },
    setTransform(...values) {
      calls.transforms.push(values);
    },
    stroke() {
      calls.strokes += 1;
    },
  };
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

function modelGraph() {
  return {
    rootInstances: {
      data: identityMat4(),
      clipIds: new Uint32Array([0]),
      layerIndices: new Uint32Array([0xffffffff]),
      opacities: new Float32Array([1]),
      visibilityRows: new Uint32Array([0]),
      count: 1,
    },
    instancesByBlock: new Map(),
    modelBlockIndices: new Set([0]),
    clipNodes: [],
  };
}

const visibleRecord = Object.freeze({
  handle: 901n,
  ownerHandle: 100n,
  layerIndex: 0,
  commonFlags: 0,
  displayProperties: 7,
  clipType: 1,
  clippingEnabled: true,
  brightness: 40,
  contrast: 60,
  fade: 10,
  clipMode: 0,
  firstClipVertex: 0,
  clipVertexCount: 2,
  insertionPoint: [0, 0, 0],
  uVector: [1, 0, 0],
  vVector: [0, 1, 0],
  size: [4, 3],
  clipVertices: [
    [0.5, 0.5],
    [2.5, 1.5],
  ],
});

const camera = Object.freeze({
  origin: [1.5, 1, 0],
  worldWidth: 8,
  worldHeight: 6,
});

test("bounds raster decode size for large referenced photographs", () => {
  const target = bitmapTargetSize(9_999, 4_712, 8_388_608, 4_096);

  assert.ok(target.width <= 4_096);
  assert.ok(target.height <= 4_096);
  assert.ok(target.width * target.height <= 8_388_608);
  assert.ok(target.width / target.height > 2.11);
  assert.ok(target.width / target.height < 2.13);
});

test("sizes raster decoding from the current on-screen footprint", () => {
  assert.deepEqual(
    requestedBitmapTargetSize(
      10_000,
      5_000,
      200,
      100,
      8_388_608,
      4_096,
    ),
    { width: 300, height: 150 },
  );
});

test("upgrades a screen-sized bitmap only after a meaningful zoom", async () => {
  const decoded = [];
  const store = new RasterImageAssetStore({
    maximumCompressedBytes: 64,
    maximumImagePixels: 8_388_608,
    maximumDecodedPixels: 16_777_216,
    decode: async (_blob, options) => {
      decoded.push([options.resizeWidth, options.resizeHeight]);
      return {
        width: options.resizeWidth,
        height: options.resizeHeight,
        close() {},
      };
    },
  });
  store.accept({
    cacheId: "root",
    imageIndex: 0,
    resourceId: "c".repeat(64),
    mimeType: "image/jpeg",
    width: 4_000,
    height: 2_000,
    bytes: new Uint8Array([1, 2, 3]).buffer,
  });

  await store.prepare("root", 0, { width: 200, height: 100 });
  assert.deepEqual(decoded, [[300, 150]]);
  await store.prepare("root", 0, { width: 400, height: 200 });
  assert.deepEqual(decoded, [
    [300, 150],
    [600, 300],
  ]);
  assert.equal(store.snapshot().decodedPixels, 180_000);
  store.dispose();
});

test("deduplicates compressed images and evicts decoded bitmaps by budget", async () => {
  const closed = [];
  const store = new RasterImageAssetStore({
    maximumCompressedBytes: 64,
    maximumImagePixels: 4,
    maximumDecodedPixels: 4,
    maximumDecodeDimension: 2,
    decode: async (_blob, options) => ({
      width: options.resizeWidth,
      height: options.resizeHeight,
      close() {
        closed.push(`${options.resizeWidth}x${options.resizeHeight}`);
      },
    }),
  });
  const firstId = "a".repeat(64);
  const secondId = "b".repeat(64);
  store.accept({
    cacheId: "root",
    imageIndex: 0,
    resourceId: firstId,
    mimeType: "image/png",
    width: 2,
    height: 2,
    bytes: new Uint8Array([1, 2, 3]).buffer,
  });
  store.accept({
    cacheId: "xref",
    imageIndex: 0,
    resourceId: firstId,
    mimeType: "image/png",
    width: 2,
    height: 2,
  });
  await store.prepare("root", 0);
  assert.equal(store.snapshot().resources, 1);
  assert.equal(store.snapshot().references, 2);
  assert.equal(store.snapshot().compressedBytes, 3);

  store.accept({
    cacheId: "root",
    imageIndex: 1,
    resourceId: secondId,
    mimeType: "image/jpeg",
    width: 2,
    height: 2,
    bytes: new Uint8Array([4, 5, 6]).buffer,
  });
  await store.prepare("root", 1);

  assert.equal(store.snapshot().decodedResources, 1);
  assert.equal(store.snapshot().decodedPixels, 4);
  assert.deepEqual(closed, ["2x2"]);
  store.dispose();
});

test("records a failed image reference until replacement content arrives", () => {
  const store = new RasterImageAssetStore({
    maximumCompressedBytes: 64,
  });
  const failure = new Error("missing image");
  store.reject("root", 0, failure);

  assert.deepEqual(store.lookup("root", 0), {
    status: "error",
    error: failure,
  });
  assert.equal(store.snapshot().failedReferences, 1);

  store.accept({
    cacheId: "root",
    imageIndex: 0,
    resourceId: "d".repeat(64),
    mimeType: "image/png",
    width: 2,
    height: 2,
    bytes: new Uint8Array([1, 2, 3]).buffer,
  });
  assert.notEqual(store.lookup("root", 0).status, "error");
  assert.equal(store.snapshot().failedReferences, 0);
  store.dispose();
});

test("requests only raster images that intersect the current screen", () => {
  const canvas = fakeCanvas();
  const requests = [];
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable(visibleRecord),
    blocks: [{ index: 0, handle: 100n }],
    layers: [{ name: "0" }],
    instanceGraph: modelGraph(),
    cacheId: "root",
    assetStore: {
      lookup: () => ({ status: "missing" }),
      snapshot: () => ({}),
    },
    requestAsset(request) {
      requests.push(request);
      return true;
    },
  });

  const visible = overlay.redraw(camera, [true]);
  assert.equal(visible.visibleOccurrences, 1);
  assert.equal(visible.requestedImages, 1);
  assert.equal(requests[0].path, String.raw`.\image\도면.png`);

  const offscreen = overlay.redraw(
    { ...camera, origin: [1_000, 1_000, 0] },
    [true],
  );
  assert.equal(offscreen.visibleOccurrences, 0);
  assert.equal(offscreen.requestedImages, 0);
});

test("draws a clipped placeholder for an unavailable raster image", () => {
  const canvas = fakeCanvas();
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable(visibleRecord),
    blocks: [{ index: 0, handle: 100n }],
    layers: [{ name: "0" }],
    instanceGraph: modelGraph(),
    cacheId: "root",
    assetStore: {
      lookup: () => ({ status: "error", error: new Error("missing") }),
      snapshot: () => ({ failedReferences: 1 }),
    },
  });

  const metrics = overlay.redraw(camera, [true]);

  assert.equal(metrics.failedImages, 1);
  assert.equal(metrics.loadedOccurrences, 0);
  assert.equal(canvas.calls.strokes, 2);
  assert.deepEqual(canvas.calls.lineDashes, [[6, 4], []]);
  assert.deepEqual(canvas.calls.clips, ["nonzero"]);
});

test("uses the clipped IMAGE footprint as fitted drawing bounds", () => {
  assert.deepEqual(
    calculateRasterImageBounds({
      imageEntities: imageTable(visibleRecord),
      blocks: [{ index: 0, handle: 100n }],
      instanceGraph: modelGraph(),
    }),
    {
      min: [0.5, 0.5, 0],
      max: [2.5, 1.5, 0],
    },
  );
});

test("converts top-origin IMAGE clip pixels to the placement basis", () => {
  const asymmetricClip = {
    ...visibleRecord,
    size: [10, 10],
    clipVertices: [
      [2, 1],
      [6, 3],
    ],
  };

  assert.deepEqual(
    calculateRasterImageBounds({
      imageEntities: imageTable(asymmetricClip),
      blocks: [{ index: 0, handle: 100n }],
      instanceGraph: modelGraph(),
    }),
    {
      min: [2, 6, 0],
      max: [6, 8, 0],
    },
  );
});

test("draws IMAGE placement with clipping and CAD display adjustments", () => {
  const canvas = fakeCanvas();
  const bitmap = { width: 4, height: 3 };
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable(visibleRecord),
    blocks: [{ index: 0, handle: 100n }],
    layers: [{ name: "0" }],
    instanceGraph: modelGraph(),
    cacheId: "root",
    assetStore: {
      lookup: () => ({
        status: "ready",
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      }),
      snapshot: () => ({ decodedBytes: 48 }),
    },
  });

  const metrics = overlay.redraw(camera, [true]);
  const drawn = canvas.calls.drawImage[0];
  assert.equal(metrics.loadedOccurrences, 1);
  assert.equal(metrics.clipOperations, 1);
  assert.deepEqual(canvas.calls.clips, ["nonzero"]);
  assert.deepEqual(drawn.values, [bitmap, 0, 0]);
  assert.deepEqual(drawn.transform, [100, 0, 0, 100, 200, 150]);
  assert.equal(drawn.alpha, 0.9);
  assert.equal(drawn.filter, "brightness(0.8) contrast(1.2)");
  assert.equal(drawn.imageSmoothingEnabled, true);
  assert.equal(drawn.imageSmoothingQuality, "high");

  overlay.setRenderDeltaState({
    invalidatedDependencyIds: [
      dwgBlockRenderDependencyId("root", 100n),
    ],
  });
  const invalidated = overlay.redraw(camera, [true]);
  assert.equal(invalidated.visibleOccurrences, 0);
  assert.equal(invalidated.loadedOccurrences, 0);
  assert.equal(canvas.calls.drawImage.length, 1);

  overlay.setRenderDeltaState();
  const restored = overlay.redraw(camera, [true]);
  assert.equal(restored.loadedOccurrences, 1);
  assert.equal(canvas.calls.drawImage.length, 2);
});

test("uses the saved IMAGEQUALITY draft sampling mode", () => {
  const canvas = fakeCanvas();
  const bitmap = { width: 4, height: 3 };
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable(visibleRecord),
    blocks: [{ index: 0, handle: 100n }],
    layers: [{ name: "0" }],
    instanceGraph: modelGraph(),
    cacheId: "root",
    rasterImageQualityHigh: false,
    assetStore: {
      lookup: () => ({
        status: "ready",
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      }),
      snapshot: () => ({}),
    },
  });

  const metrics = overlay.redraw(camera, [true]);

  assert.equal(metrics.rasterImageQuality, "draft");
  assert.equal(canvas.calls.drawImage[0].imageSmoothingEnabled, false);
  assert.equal(canvas.calls.drawImage[0].imageSmoothingQuality, "low");
});

test("uses XREF layer transparency instead of an explicit IMAGE transparency", () => {
  const bitmap = { width: 4, height: 3 };
  const makeOverlay = (canvas, externalReferenceOverrides) =>
    new CanvasRasterImageOverlay(canvas, {
      imageEntities: imageTable({
        ...visibleRecord,
        color: ((2 << 30) | (33 << 24) | 7) >>> 0,
      }),
      blocks: [{ index: 0, handle: 100n }],
      layers: [{ name: "0", color: ((2 << 30) | 7) >>> 0 }],
      instanceGraph: modelGraph(),
      cacheId: "xref",
      externalReferenceOverrides,
      assetStore: {
        lookup: () => ({
          status: "ready",
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
        }),
        snapshot: () => ({}),
      },
    });
  const nativeCanvas = fakeCanvas();
  const overrideCanvas = fakeCanvas();

  makeOverlay(nativeCanvas, false).redraw(camera, [true]);
  makeOverlay(overrideCanvas, true).redraw(camera, [true]);

  assert.ok(nativeCanvas.calls.drawImage[0].alpha < 0.5);
  assert.equal(overrideCanvas.calls.drawImage[0].alpha, 0.9);
});

test("draws the clipped IMAGE boundary for IMAGEFRAME values 1 and 2", () => {
  const canvas = fakeCanvas();
  const bitmap = { width: 4, height: 3 };
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable(visibleRecord),
    blocks: [{ index: 0, handle: 100n }],
    layers: [{ name: "0", color: (2 << 30) | 7 }],
    instanceGraph: modelGraph(),
    cacheId: "root",
    imageFrame: 2,
    assetStore: {
      lookup: () => ({
        status: "ready",
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      }),
      snapshot: () => ({}),
    },
  });

  const metrics = overlay.redraw(camera, [true]);
  assert.equal(metrics.imageFrames, 1);
  assert.equal(canvas.calls.strokes, 1);
});

test("draws embedded OLE presentations over an opaque paper background", () => {
  const canvas = fakeCanvas();
  const bitmap = { width: 4, height: 3 };
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable(
      visibleRecord,
      "@embedded/ole-901.emf",
    ),
    blocks: [{ index: 0, handle: 100n }],
    layers: [{ name: "0" }],
    instanceGraph: modelGraph(),
    cacheId: "root",
    rasterImageQualityHigh: false,
    assetStore: {
      lookup: () => ({
        status: "ready",
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      }),
      snapshot: () => ({ decodedBytes: 48 }),
    },
  });

  const metrics = overlay.redraw(camera, [true]);

  assert.equal(metrics.loadedOccurrences, 1);
  assert.deepEqual(canvas.calls.fillRect, [
    {
      values: [0, 0, 4, 3],
      alpha: 0.9,
      fillStyle: "#fff",
      filter: "brightness(0.8) contrast(1.2)",
      transform: [100, 0, 0, 100, 200, 150],
    },
  ]);
  assert.equal(canvas.calls.drawImage.length, 1);
  assert.equal(canvas.calls.drawImage[0].imageSmoothingEnabled, true);
  assert.equal(canvas.calls.drawImage[0].imageSmoothingQuality, "high");
});

test("draws repeated block images in absolute display order", () => {
  const canvas = fakeCanvas();
  const records = [10n, 20n].map((handle) => ({
    ...visibleRecord,
    handle,
    ownerHandle: 200n,
    clippingEnabled: false,
    clipVertexCount: 0,
    clipVertices: [],
  }));
  const imageEntities = {
    length: records.length,
    readEntity(index, target) {
      Object.assign(target, records[index]);
      target.insertionPoint = [...records[index].insertionPoint];
      target.uVector = [...records[index].uVector];
      target.vVector = [...records[index].vVector];
      target.size = [...records[index].size];
      return target;
    },
    readPath(index) {
      return `image-${index}.png`;
    },
    readClipVertex() {
      throw new Error("unclipped image must not read clip vertices");
    },
  };
  const matrix = identityMat4();
  const events = records.map((record, index) => ({
    kind: "entity",
    handle: record.handle,
    key: record.handle,
    prefix: index,
    contribution: 1,
  }));
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities,
    blocks: [
      { index: 0, handle: 100n, name: "*Model_Space" },
      { index: 1, handle: 200n, name: "RepeatedBlock" },
    ],
    layers: [{ name: "0" }],
    instanceGraph: {
      rootInstances: modelGraph().rootInstances,
      instancesByBlock: new Map([
        [
          1,
          {
            data: new Float64Array([...matrix, ...matrix]),
            maskBases: new Uint32Array([0, 2]),
            clipIds: new Uint32Array([0, 0]),
            layerIndices: new Uint32Array([0xffffffff, 0xffffffff]),
            opacities: new Float32Array([1, 1]),
            visibilityRows: new Uint32Array([0, 0]),
            count: 2,
          },
        ],
      ]),
      modelBlockIndices: new Set([0]),
      clipNodes: [],
    },
    cacheId: "root",
    maskOrder: {
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
    },
    assetStore: {
      lookup(_cacheId, imageIndex) {
        const bitmap = {
          name: imageIndex === 0 ? "A" : "B",
          width: 4,
          height: 3,
        };
        return {
          status: "ready",
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
        };
      },
      snapshot: () => ({}),
    },
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(
    canvas.calls.drawImage.map(({ values }) => values[0].name),
    ["A", "B", "A", "B"],
  );
});

test("selects visible IMAGE bounds and exposes its insertion point", () => {
  const canvas = fakeCanvas();
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable(visibleRecord),
    blocks: [{ index: 0, handle: 100n }],
    layers: [{ name: "0" }],
    instanceGraph: modelGraph(),
    cacheId: "root",
    sourceId: "root",
    sourceLabel: "현재 도면",
    hitTestingEnabled: true,
    assetStore: {
      lookup: () => ({ status: "missing" }),
      snapshot: () => ({}),
    },
  });

  overlay.redraw(camera, [true]);
  const selected = overlay.hitTest(300, 250, {
    snapKinds: ["entity"],
  });
  const insertion = overlay.hitTest(250, 400, {
    snapKinds: ["insertion"],
  });

  assert.equal(selected.entityType, "image");
  assert.equal(selected.sourceKindName, "이미지");
  assert.equal(selected.handle, 901n);
  assert.equal(selected.layerName, "0");
  assert.equal(selected.entityRecord.path, String.raw`.\image\도면.png`);
  assert.deepEqual(selected.displayPolygon, [
    [-0.5, 2.5, 0],
    [3.5, 2.5, 0],
    [3.5, -0.5, 0],
    [-0.5, -0.5, 0],
  ]);
  assert.equal(insertion.kind, "insertion");
  assert.deepEqual(insertion.displayPoint, [0, 0, 0]);
});

test("moves and rolls back a block IMAGE instance transform", () => {
  const canvas = fakeCanvas();
  const instances = Object.freeze({
    data: identityMat4(),
    measurementData: identityMat4(),
    handles: new BigUint64Array([0xc9n]),
    clipIds: new Uint32Array([0]),
    layerIndices: new Uint32Array([0xffffffff]),
    opacities: new Float32Array([1]),
    visibilityRows: new Uint32Array([0]),
    count: 1,
  });
  const instanceGraph = {
    rootInstances: modelGraph().rootInstances,
    instancesByBlock: new Map([[1, instances]]),
    insertsByOwner: new Map(),
    modelBlockIndices: new Set([0]),
    clipNodes: [],
  };
  const transform = normalizedRenderDeltaTransformRecord({
    blockIndex: 1,
    handle: 0xc9n,
    matrix: translatedTransformMatrix(10, 20, 0),
    measurementMatrix: translatedTransformMatrix(30, 40, 0),
  });
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable({
      ...visibleRecord,
      ownerHandle: 101n,
      clippingEnabled: false,
      clipVertexCount: 0,
    }),
    blocks: [
      { index: 0, handle: 100n },
      { index: 1, handle: 101n },
    ],
    layers: [{ name: "0" }],
    instanceGraph,
    cacheId: "root",
    sourceId: "root",
    hitTestingEnabled: true,
    assetStore: {
      lookup: () => ({ status: "missing" }),
      snapshot: () => ({}),
    },
  });
  const entry = Object.freeze({
    resourceKind: "transform",
    sceneId: "root",
    record: transform.record,
    byteLength: transform.buffer.byteLength,
  });

  overlay.setRenderDeltaTransforms([entry]);
  const movedMetrics = overlay.redraw(
    {
      origin: [10, 20, 0],
      worldWidth: 8,
      worldHeight: 6,
    },
    [true],
  );
  const moved = overlay.hitTest(400, 300, {
    snapKinds: ["insertion"],
  });

  assert.equal(movedMetrics.renderDeltaTransforms, 1);
  assert.deepEqual(moved.displayPoint, [10, 20, 0]);
  assert.deepEqual(moved.measurementPoint, [30, 40, 0]);

  overlay.setRenderDeltaTransforms([]);
  const restoredMetrics = overlay.redraw(
    {
      origin: [0, 0, 0],
      worldWidth: 8,
      worldHeight: 6,
    },
    [true],
  );
  const restored = overlay.hitTest(400, 300, {
    snapKinds: ["insertion"],
  });
  assert.equal(restoredMetrics.renderDeltaTransforms, 0);
  assert.deepEqual(restored.displayPoint, [0, 0, 0]);
  assert.deepEqual(restored.measurementPoint, [0, 0, 0]);
});

test("restyles and hides a block IMAGE occurrence", () => {
  const canvas = fakeCanvas();
  const instances = Object.freeze({
    data: identityMat4(),
    measurementData: identityMat4(),
    handles: new BigUint64Array([0xc9n]),
    clipIds: new Uint32Array([0]),
    layerIndices: new Uint32Array([0xffffffff]),
    opacities: new Float32Array([1]),
    visibilityRows: new Uint32Array([0]),
    count: 1,
  });
  const instanceGraph = {
    rootInstances: modelGraph().rootInstances,
    instancesByBlock: new Map([[1, instances]]),
    insertsByOwner: new Map(),
    modelBlockIndices: new Set([0]),
    clipNodes: [],
  };
  const bitmap = { width: 4, height: 3 };
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable({
      ...visibleRecord,
      ownerHandle: 101n,
      clippingEnabled: false,
      clipVertexCount: 0,
    }),
    blocks: [
      { index: 0, handle: 100n },
      { index: 1, handle: 101n },
    ],
    layers: [{ name: "0" }],
    instanceGraph,
    cacheId: "root",
    sourceId: "root",
    hitTestingEnabled: true,
    assetStore: {
      lookup: () => ({
        status: "ready",
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      }),
      snapshot: () => ({}),
    },
  });
  const styleEntry = (fixture) =>
    Object.freeze({
      resourceKind: "style",
      sceneId: "root",
      record: fixture.record,
      byteLength: fixture.buffer.byteLength,
    });
  const visibleStyle = normalizedRenderDeltaStyleRecord({
    blockIndex: 1,
    handle: 0xc9n,
    opacity: 0.5,
    visible: true,
  });
  const hiddenStyle = normalizedRenderDeltaStyleRecord({
    blockIndex: 1,
    handle: 0xc9n,
    visible: false,
  });

  overlay.setRenderDeltaState({
    styles: [styleEntry(visibleStyle)],
  });
  const styledMetrics = overlay.redraw(camera, [true]);
  assert.equal(styledMetrics.renderDeltaStyles, 1);
  assert.equal(styledMetrics.visibleOccurrences, 1);
  assert.equal(canvas.calls.drawImage.at(-1).alpha, 0.45);

  overlay.setRenderDeltaState({
    styles: [styleEntry(hiddenStyle)],
  });
  const drawCount = canvas.calls.drawImage.length;
  const hiddenMetrics = overlay.redraw(camera, [true]);
  assert.equal(hiddenMetrics.renderDeltaStyles, 1);
  assert.equal(hiddenMetrics.visibleOccurrences, 0);
  assert.equal(canvas.calls.drawImage.length, drawCount);
  assert.equal(
    overlay.hitTest(400, 300, {
      snapKinds: ["insertion"],
    }),
    null,
  );

  overlay.setRenderDeltaState();
  const restoredMetrics = overlay.redraw(camera, [true]);
  assert.equal(restoredMetrics.renderDeltaStyles, 0);
  assert.equal(canvas.calls.drawImage.at(-1).alpha, 0.9);
});

test("propagates a parent INSERT delta to a nested IMAGE", () => {
  const canvas = fakeCanvas();
  const instanceGraph = nestedInstanceGraph();
  const overlay = new CanvasRasterImageOverlay(canvas, {
    imageEntities: imageTable({
      ...visibleRecord,
      ownerHandle: NESTED_INSTANCE_BLOCKS[3].handle,
      clippingEnabled: false,
      clipVertexCount: 0,
    }),
    blocks: NESTED_INSTANCE_BLOCKS,
    layers: NESTED_INSTANCE_LAYERS,
    instanceGraph,
    cacheId: "root",
    sourceId: "root",
    hitTestingEnabled: true,
    assetStore: {
      lookup: () => ({ status: "missing" }),
      snapshot: () => ({}),
    },
  });
  const transform = normalizedRenderDeltaTransformRecord({
    blockIndex: 1,
    handle: NESTED_INSTANCE_HANDLES.outer,
    matrix: translatedTransformMatrix(20, 30, 0),
    measurementMatrix: translatedTransformMatrix(110, 220, 0),
  });
  const transformEntry = Object.freeze({
    resourceKind: "transform",
    sceneId: "root",
    record: transform.record,
    byteLength: transform.buffer.byteLength,
  });

  overlay.setRenderDeltaState({
    transforms: [transformEntry],
  });
  const movedMetrics = overlay.redraw(
    {
      origin: [26, 38, 0],
      worldWidth: 8,
      worldHeight: 6,
    },
    [true, true, true],
  );
  const moved = overlay.hitTest(400, 300, {
    snapKinds: ["insertion"],
  });

  assert.equal(movedMetrics.visibleOccurrences, 1);
  assert.deepEqual(moved.displayPoint, [26, 38, 0]);
  assert.deepEqual(moved.measurementPoint, [116, 228, 0]);

  const hidden = normalizedRenderDeltaStyleRecord({
    blockIndex: 1,
    handle: NESTED_INSTANCE_HANDLES.outer,
    visible: false,
  });
  overlay.setRenderDeltaState({
    styles: [
      Object.freeze({
        resourceKind: "style",
        sceneId: "root",
        record: hidden.record,
        byteLength: hidden.buffer.byteLength,
      }),
    ],
  });
  const hiddenMetrics = overlay.redraw(
    {
      origin: [16, 28, 0],
      worldWidth: 8,
      worldHeight: 6,
    },
    [true, true, true],
  );
  assert.equal(hiddenMetrics.visibleOccurrences, 0);
  assert.equal(
    overlay.hitTest(400, 300, {
      snapKinds: ["insertion"],
    }),
    null,
  );
});
