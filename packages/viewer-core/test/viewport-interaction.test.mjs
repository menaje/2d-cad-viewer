import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  ViewportInteraction,
} from "../src/viewport-interaction.mjs";

test("keeps interaction timing policy in Viewer Core", () => {
  assert.equal(DETAIL_ZOOM_THRESHOLD, 0);
  assert.equal(DETAIL_DEBOUNCE_MS, 650);
  assert.equal(VIEW_COMMIT_DEBOUNCE_MS, 220);
});

test("requires product detail streaming through an injected factory", () => {
  assert.throws(
    () =>
      new ViewportInteraction(
        {
          render: {
            camera: {
              origin: [0, 0, 0],
              worldHeight: 100,
            },
          },
        },
        {},
      ),
    /detail streamer factory/u,
  );
});

test("coordinates one paused and latest-camera resume lifecycle across root and XREF streamers", async () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const streamers = [];
  const listeners = new Map();
  const pointerCaptures = new Set();
  let nextFrame = 1;
  const initialCamera = Object.freeze({
    origin: Object.freeze([0, 0, 0]),
    worldHeight: 100,
  });

  class FakeStreamer {
    constructor(id) {
      this.id = id;
      this.revision = 0;
      this.paused = false;
      this.calls = [];
      this.disposed = false;
    }

    pause() {
      if (this.paused) {
        return false;
      }
      this.paused = true;
      this.revision += 1;
      this.calls.push(["pause"]);
      return true;
    }

    resume(camera, options) {
      this.paused = false;
      this.revision += 1;
      this.calls.push(["resume", camera, options]);
      return this.snapshot();
    }

    setRenderCamera(camera, options) {
      this.calls.push(["camera", camera, options]);
    }

    setReviewEnabled() {}

    snapshot() {
      const pauses = this.calls.filter(([name]) => name === "pause").length;
      const resumes = this.calls.filter(([name]) => name === "resume").length;
      return {
        revision: this.revision,
        selectedBatches: 0,
        selectedBytes: 0,
        selectedInstances: 0,
        loading: 0,
        paused: this.paused,
        cache: { entries: 0, bytes: 0 },
        render: null,
        error: null,
        metrics: {
          interactionPauses: pauses,
          interactionResumes: resumes,
          coalescedUpdates: 0,
          loadStarts: 0,
          interactionLoadStarts: 0,
          cancellationRequests: 0,
          staleCompletions: 0,
          staleMounts: 0,
          gpuUploads: 0,
          settledUpdates: resumes,
          settledDetailLatencyMs: 0,
        },
      };
    }

    dispose() {
      this.disposed = true;
    }
  }

  globalThis.ResizeObserver = class {
    observe() {}

    disconnect() {}
  };
  globalThis.requestAnimationFrame = () => nextFrame++;
  globalThis.cancelAnimationFrame = () => {};

  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600 };
    },
    setPointerCapture(pointerId) {
      pointerCaptures.add(pointerId);
    },
    hasPointerCapture(pointerId) {
      return pointerCaptures.has(pointerId);
    },
    releasePointerCapture(pointerId) {
      pointerCaptures.delete(pointerId);
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
  };
  const renderer = {
    redraw(value) {
      return { camera: value };
    },
    cameraForView(value) {
      return value;
    },
    addDetailBatch() {},
    deleteDetailBatch() {},
    setDetailSelections() {},
    addExternalDetailBatch() {},
    deleteExternalDetailBatch() {},
    setExternalDetailSelections() {},
  };

  try {
    const interaction = new ViewportInteraction(
      {
        reader: {},
        renderer,
        metadata: { batches: [] },
        instanceGraph: {},
        render: { camera: initialCamera },
      },
      canvas,
      {
        createDetailStreamer() {
          const streamer = new FakeStreamer(
            streamers.length === 0 ? "root" : "xref",
          );
          streamers.push(streamer);
          return streamer;
        },
        keyboardTarget: { addEventListener() {} },
      },
    );
    interaction.addExternalDetailSource("xref:one", {}, [], {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const streamer of streamers) {
      streamer.calls.length = 0;
    }

    interaction.camera.focus([10, 0, 0], 80);
    interaction.scheduleDetail(20);
    interaction.camera.focus([30, 5, 0], 40);
    interaction.scheduleDetail(0);
    assert.equal(interaction.detailSnapshot().paused, true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(streamers.length, 2);
    for (const streamer of streamers) {
      assert.equal(
        streamer.calls.filter(([name]) => name === "pause").length,
        1,
      );
      const resumes = streamer.calls.filter(
        ([name]) => name === "resume",
      );
      assert.equal(resumes.length, 1);
      assert.deepEqual(resumes[0][1].origin, [30, 5, 0]);
      assert.deepEqual(resumes[0][2], {
        enabled: true,
        redraw: false,
        emit: false,
      });
    }
    const detail = interaction.detailSnapshot();
    assert.equal(detail.paused, false);
    assert.equal(detail.metrics.interactionPauses, 2);
    assert.equal(detail.metrics.interactionResumes, 2);
    assert.equal(detail.metrics.interactionLoadStarts, 0);
    assert.equal(detail.metrics.staleMounts, 0);

    for (const streamer of streamers) {
      streamer.calls.length = 0;
    }
    interaction.setWindowZoomEnabled(true);
    const pointerEvent = {
      button: 0,
      pointerId: 7,
      clientX: 100,
      clientY: 100,
      preventDefault() {},
      stopImmediatePropagation() {},
    };
    listeners.get("pointerdown")(pointerEvent);
    assert.equal(interaction.detailSnapshot().paused, true);
    listeners.get("pointerup")(pointerEvent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(interaction.detailSnapshot().paused, false);
    for (const streamer of streamers) {
      assert.deepEqual(
        streamer.calls.filter(([name]) =>
          name === "pause" || name === "resume"
        ).map(([name]) => name),
        ["pause", "resume"],
      );
    }

    interaction.dispose();
    assert.equal(streamers.every((streamer) => streamer.disposed), true);
  } finally {
    globalThis.ResizeObserver = OriginalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});
