import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerWebGlComparisonStrategy,
  mountWebGlRevisionComparison,
} from "../src/public-api.mjs";

const BASE_REVISION = "revision:base";
const TARGET_REVISION = "revision:target";
const PREVIEW_ID = "preview:candidate";

class FakeElement {
  constructor(ownerDocument, tagName = "div") {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.bounds = {
      left: 0,
      top: 0,
      width: 640,
      height: 360,
    };
  }

  get nextSibling() {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] ?? null;
  }

  #detach(child) {
    if (!child.parentNode) {
      return;
    }
    const siblings = child.parentNode.children;
    const index = siblings.indexOf(child);
    if (index >= 0) {
      siblings.splice(index, 1);
    }
    child.parentNode = null;
  }

  append(...children) {
    for (const child of children) {
      this.#detach(child);
      this.children.push(child);
      child.parentNode = this;
    }
  }

  insertBefore(child, reference) {
    this.#detach(child);
    const index = this.children.indexOf(reference);
    this.children.splice(index, 0, child);
    child.parentNode = this;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.#detach(this);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect() {
    return this.bounds;
  }
}

class FakeCanvas extends FakeElement {
  constructor(ownerDocument) {
    super(ownerDocument, "canvas");
    this.width = 300;
    this.height = 150;
    this.clientWidth = 320;
    this.clientHeight = 180;
    this.pixel = "empty";
  }

  getContext(kind) {
    if (kind !== "2d") {
      return Object.freeze({ kind });
    }
    const canvas = this;
    return {
      clearRect() {
        canvas.pixel = "clear";
      },
      drawImage(source) {
        canvas.pixel = source.pixel;
      },
      save() {},
      restore() {},
      setLineDash() {},
      strokeRect() {
        canvas.pixel += ":highlight";
      },
      strokeStyle: "",
      lineWidth: 1,
    };
  }
}

class FakeDocument {
  createElement(tagName) {
    return tagName === "canvas"
      ? new FakeCanvas(this)
      : new FakeElement(this, tagName);
  }
}

function changedEntry(status, renderId) {
  return Object.freeze({
    status,
    operationId: `operation:${renderId}`,
    aspect: "geometry",
    layerId: "layer:main",
    sourceId: "source:comparison",
    renderId,
    affectedWorldBounds: Object.freeze({
      min: Object.freeze([-5, -5, 0]),
      max: Object.freeze([5, 5, 0]),
    }),
    externalIdentityToken:
      status === "removed" ? null : `external:${renderId}`,
  });
}

function diffSnapshot(overrides = {}) {
  const changedEntries = overrides.changedEntries ?? [
    changedEntry("added", "render:added"),
    changedEntry("removed", "render:removed"),
    changedEntry("modified", "render:modified"),
  ];
  const counts = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 97,
  };
  for (const entry of changedEntries) {
    counts[entry.status] += 1;
  }
  return Object.freeze({
    protocolVersion: "0.1.0",
    sessionId: "session:comparison",
    sourceId: "source:comparison",
    baseSnapshotId: "snapshot:base",
    baseRevisionId: BASE_REVISION,
    committedRevisionId: BASE_REVISION,
    revisionId: TARGET_REVISION,
    sequence: 1,
    previewId: PREVIEW_ID,
    affectedWorldBounds: Object.freeze({
      min: Object.freeze([-10, -10, 0]),
      max: Object.freeze([10, 10, 0]),
    }),
    counts: Object.freeze(counts),
    changedEntries: Object.freeze(changedEntries),
    ...overrides,
  });
}

class FakeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.revisionId = TARGET_REVISION;
    this.diff = null;
    this.captures = [];
    this.failCapture = null;
  }

  captureRaster(camera, size) {
    if (this.failCapture?.(this.revisionId, camera)) {
      this.failCapture = null;
      throw new Error("candidate capture failed");
    }
    const output = this.canvas.ownerDocument.createElement("canvas");
    output.width = size.width;
    output.height = size.height;
    output.pixel =
      `${this.revisionId}:${camera.origin.join(",")}` +
      `:${camera.worldHeight}:${this.diff ? "diff" : "native"}`;
    this.captures.push({
      revisionId: this.revisionId,
      camera,
      size,
    });
    return Object.freeze({
      canvas: output,
      metrics: Object.freeze({ drawCalls: 3 }),
    });
  }
}

class FakeDeltaAdapter {
  constructor(renderer) {
    this.renderer = renderer;
    this.activeRevisionId = TARGET_REVISION;
    this.previewId = PREVIEW_ID;
  }

  snapshot() {
    return Object.freeze({
      baseRevisionId: BASE_REVISION,
      committedRevisionId: BASE_REVISION,
      revisionId: this.activeRevisionId,
      presentedRevisionId: this.renderer.revisionId,
      previewId: this.previewId,
    });
  }

  presentRevision(revisionId) {
    if (
      ![BASE_REVISION, this.activeRevisionId].includes(revisionId)
    ) {
      throw new DOMException(
        "revision is not retained",
        "InvalidStateError",
      );
    }
    this.renderer.revisionId = revisionId;
    this.renderer.diff = null;
    return this.snapshot();
  }

  restoreActivePresentation() {
    this.renderer.revisionId = this.activeRevisionId;
    return this.snapshot();
  }

  applyDiffOverlay(presentation) {
    if (this.renderer.revisionId !== this.activeRevisionId) {
      throw new DOMException(
        "diff revision is stale",
        "InvalidStateError",
      );
    }
    this.renderer.diff = presentation;
    return presentation;
  }

  clearDiffOverlay() {
    this.renderer.diff = null;
    return null;
  }

  rollbackPreview() {
    this.activeRevisionId = BASE_REVISION;
    this.previewId = null;
    this.renderer.revisionId = BASE_REVISION;
    this.renderer.diff = null;
  }
}

function fixture({ document = new FakeDocument(), ...options } = {}) {
  const parent = document.createElement("main");
  const container = document.createElement("section");
  const renderCanvas = document.createElement("canvas");
  parent.append(renderCanvas, container);
  const renderer = new FakeRenderer(renderCanvas);
  const adapter = new FakeDeltaAdapter(renderer);
  const state = {
    diff: diffSnapshot(),
  };
  const presentation = Object.freeze({
    context: Object.freeze({
      snapshot: Object.freeze({
        sessionId: "session:comparison",
        sourceId: "source:comparison",
        snapshotId: "snapshot:base",
        revisionId: BASE_REVISION,
      }),
    }),
    scene: Object.freeze({ renderer }),
    renderer,
    async dispose() {},
  });
  const comparison = mountWebGlRevisionComparison({
    presentation,
    renderDeltaAdapter: adapter,
    renderDiffController: {
      snapshot() {
        return state.diff;
      },
    },
    container,
    camera: Object.freeze({
      origin: Object.freeze([0, 0, 0]),
      worldHeight: 100,
    }),
    getSurfaceSize() {
      return Object.freeze({ width: 320, height: 180 });
    },
    ...options,
  });
  return {
    adapter,
    comparison,
    container,
    parent,
    presentation,
    renderCanvas,
    renderer,
    state,
  };
}

test("renders exact current and candidate pixels through one WebGL renderer", () => {
  const value = fixture();
  const snapshot = value.comparison.snapshot();

  assert.equal(
    snapshot.strategy,
    ViewerWebGlComparisonStrategy
      .SINGLE_RENDERER_SERIAL_SNAPSHOT,
  );
  assert.equal(snapshot.frames.before.revisionId, BASE_REVISION);
  assert.equal(snapshot.frames.after.revisionId, TARGET_REVISION);
  assert.match(value.comparison.beforeSurface.pixel, /^revision:base/u);
  assert.match(value.comparison.afterSurface.pixel, /^revision:target/u);
  assert.match(value.comparison.afterSurface.pixel, /:diff$/u);
  assert.equal(snapshot.retainedPixelBytes, 320 * 180 * 4 * 2);
  assert.equal(value.renderer.revisionId, TARGET_REVISION);
  assert.notEqual(value.renderer.diff, null);
  assert.equal(value.renderCanvas.hidden, true);

  value.comparison.setCamera({
    origin: [20, 30, 0],
    worldHeight: 50,
  });
  assert.match(value.comparison.beforeSurface.pixel, /20,30,0:50/u);
  assert.match(value.comparison.afterSurface.pixel, /20,30,0:50/u);
  assert.deepEqual(
    value.comparison.snapshot().camera.camera,
    { origin: [20, 30, 0], worldHeight: 50 },
  );

  value.comparison.setSideVisibility({
    before: true,
    after: false,
  });
  const [splitView] = value.container.children;
  const [beforePanel, divider, afterPanel] = splitView.children;
  assert.equal(value.comparison.snapshot().ui.beforeVisible, true);
  assert.equal(value.comparison.snapshot().ui.afterVisible, false);
  assert.equal(beforePanel.hidden, false);
  assert.equal(afterPanel.hidden, true);
  assert.equal(divider.hidden, true);
  assert.equal(
    splitView.style.gridTemplateColumns,
    "minmax(0, 1fr)",
  );

  value.comparison.setRatio(0.4);
  value.comparison.setOrientation("vertical");
  assert.equal(
    splitView.style.gridTemplateColumns,
    "minmax(0, 1fr)",
  );
  assert.equal(
    splitView.style.gridTemplateRows,
    "minmax(0, 1fr)",
  );

  value.comparison.setSideVisibility({ after: true });
  assert.equal(beforePanel.hidden, false);
  assert.equal(afterPanel.hidden, false);
  assert.equal(divider.hidden, false);
  assert.equal(
    splitView.style.gridTemplateRows,
    "0.4fr 6px 0.6fr",
  );
  assert.throws(
    () =>
      value.comparison.setSideVisibility({
        before: false,
        after: false,
      }),
    /at least one side visible/u,
  );

  assert.equal(value.comparison.dispose(), true);
  assert.equal(value.renderCanvas.hidden, false);
  assert.equal(value.renderer.diff, null);
  assert.equal(value.comparison.dispose(), false);
});

test("maps only revision-exact picks and highlights corresponding modified entities", () => {
  const value = fixture();
  const mapped = value.comparison.select("before", {
    revisionId: BASE_REVISION,
    layerId: "layer:main",
    renderId: "render:modified",
  });

  assert.equal(mapped.mapped, true);
  assert.equal(mapped.corresponding, true);
  assert.match(value.comparison.beforeSurface.pixel, /:highlight$/u);
  assert.match(value.comparison.afterSurface.pixel, /:highlight$/u);

  const absent = value.comparison.select("after", {
    revisionId: TARGET_REVISION,
    layerId: "layer:main",
    renderId: "render:removed",
  });
  assert.deepEqual(absent, {
    mapped: false,
    corresponding: false,
    highlight: null,
  });
  assert.doesNotMatch(value.comparison.beforeSurface.pixel, /highlight/u);
  assert.doesNotMatch(value.comparison.afterSurface.pixel, /highlight/u);

  const beforePixel = value.comparison.beforeSurface.pixel;
  const afterPixel = value.comparison.afterSurface.pixel;
  assert.throws(
    () =>
      value.comparison.select("after", {
        revisionId: BASE_REVISION,
        layerId: "layer:main",
        renderId: "render:modified",
      }),
    /stale pick revision/u,
  );
  assert.equal(value.comparison.beforeSurface.pixel, beforePixel);
  assert.equal(value.comparison.afterSurface.pixel, afterPixel);
  value.comparison.dispose();
});

test("restores last-good pixels and camera when candidate rendering fails", () => {
  const value = fixture();
  const beforePixel = value.comparison.beforeSurface.pixel;
  const afterPixel = value.comparison.afterSurface.pixel;
  const camera = value.comparison.snapshot().camera.camera;
  value.renderer.failCapture = (revisionId, nextCamera) =>
    revisionId === TARGET_REVISION &&
    nextCamera.origin[0] === 10;

  assert.throws(
    () =>
      value.comparison.setCamera({
        origin: [10, 15, 0],
        worldHeight: 40,
      }),
    /candidate capture failed/u,
  );
  assert.equal(value.comparison.beforeSurface.pixel, beforePixel);
  assert.equal(value.comparison.afterSurface.pixel, afterPixel);
  assert.deepEqual(value.comparison.snapshot().camera.camera, camera);
  assert.equal(value.renderer.revisionId, TARGET_REVISION);
  assert.notEqual(value.renderer.diff, null);
  value.comparison.dispose();
});

test("rebinds both surfaces to the immutable current scene after preview rollback", () => {
  const value = fixture();
  const currentPixel = value.comparison.beforeSurface.pixel;
  value.adapter.rollbackPreview();
  value.state.diff = diffSnapshot({
    revisionId: BASE_REVISION,
    previewId: null,
    changedEntries: [],
  });

  value.comparison.synchronize();

  const snapshot = value.comparison.snapshot();
  assert.equal(value.comparison.beforeSurface.pixel, currentPixel);
  assert.match(value.comparison.afterSurface.pixel, /^revision:base/u);
  assert.match(value.comparison.afterSurface.pixel, /:native$/u);
  assert.equal(snapshot.binding.baseRevisionId, BASE_REVISION);
  assert.equal(snapshot.binding.revisionId, BASE_REVISION);
  assert.equal(snapshot.binding.previewId, null);
  assert.equal(value.renderer.revisionId, BASE_REVISION);
  assert.equal(value.renderer.diff, null);
  value.comparison.dispose();
});

test("fails closed before drawing when source or revision binding is stale", () => {
  const value = fixture();
  const beforePixel = value.comparison.beforeSurface.pixel;
  const afterPixel = value.comparison.afterSurface.pixel;
  value.state.diff = diffSnapshot({
    revisionId: "revision:unretained",
  });

  assert.throws(
    () => value.comparison.synchronize(),
    /revision binding is stale/u,
  );
  assert.equal(value.comparison.beforeSurface.pixel, beforePixel);
  assert.equal(value.comparison.afterSurface.pixel, afterPixel);
  value.comparison.dispose();
});

test("rejects a comparison surface allocation above the bounded pixel budget", () => {
  assert.throws(
    () =>
      fixture({
        maximumSurfacePixels: 100,
        getSurfaceSize() {
          return Object.freeze({ width: 11, height: 10 });
        },
      }),
    /pixel budget/u,
  );
});

test("restores injected surface placement without retaining its comparison bitmap", () => {
  const document = new FakeDocument();
  const beforeParent = document.createElement("div");
  const afterParent = document.createElement("div");
  const before = document.createElement("canvas");
  const after = document.createElement("canvas");
  before.width = 123;
  before.height = 45;
  before.style.display = "inline";
  before.style.width = "12px";
  before.style.height = "34px";
  before.setAttribute("data-viewer-webgl-comparison", "caller");
  after.width = 67;
  after.height = 89;
  beforeParent.append(before);
  afterParent.append(after);

  const value = fixture({
    document,
    beforeSurface: before,
    afterSurface: after,
  });
  assert.notEqual(before.parentNode, beforeParent);
  assert.notEqual(after.parentNode, afterParent);

  value.comparison.dispose();

  assert.equal(before.parentNode, beforeParent);
  assert.equal(after.parentNode, afterParent);
  assert.equal(beforeParent.children[0], before);
  assert.equal(afterParent.children[0], after);
  assert.equal(before.width, 123);
  assert.equal(before.height, 45);
  assert.equal(before.style.display, "inline");
  assert.equal(before.style.width, "12px");
  assert.equal(before.style.height, "34px");
  assert.equal(
    before.getAttribute("data-viewer-webgl-comparison"),
    "caller",
  );
  assert.equal(after.width, 67);
  assert.equal(after.height, 89);
  assert.equal(
    after.getAttribute("data-viewer-webgl-comparison"),
    null,
  );
});
