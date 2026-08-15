import assert from "node:assert/strict";
import test from "node:test";

import {
  DetailStreamingController,
} from "../src/detail-streaming-controller.mjs";

const camera = Object.freeze({
  origin: Object.freeze([0, 0, 0]),
  worldHeight: 100,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("streams adapter-selected detail with bounded cache lifecycle", async () => {
  const mounted = [];
  const unmounted = [];
  const selections = [];
  const candidate = Object.freeze({
    id: "detail:one",
    byteLength: 32,
    selectedInstanceCount: 2,
  });
  const selected = [candidate];
  Object.defineProperty(selected, "byteLength", {
    value: 32,
  });
  Object.freeze(selected);
  const controller = new DetailStreamingController(
    {
      selectCandidates() {
        return selected;
      },
      async loadCandidate(value) {
        return {
          id: value.id,
          byteLength: value.byteLength,
        };
      },
      mountCandidate(value) {
        mounted.push(value.id);
        return { id: value.id };
      },
      unmountCandidate(value) {
        unmounted.push(value.id);
      },
      setSelection(value) {
        selections.push(value.map((entry) => entry.id));
      },
      redraw(value) {
        return { camera: value };
      },
    },
    { concurrency: 1 },
  );

  controller.update(camera);
  const snapshot = await controller.whenIdle();

  assert.deepEqual(mounted, ["detail:one"]);
  assert.deepEqual(selections, [["detail:one"]]);
  assert.equal(snapshot.selectedBytes, 32);
  assert.equal(snapshot.selectedInstances, 2);
  assert.equal(snapshot.cache.entries, 1);

  assert.equal(controller.pause(), true);
  assert.equal(controller.snapshot().paused, true);
  assert.equal(controller.snapshot().cache.entries, 1);
  assert.deepEqual(unmounted, []);
  controller.resume(camera);
  await controller.whenIdle();
  assert.equal(controller.snapshot().cache.entries, 1);

  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  assert.deepEqual(unmounted, ["detail:one"]);
  assert.deepEqual(selections.at(-1), []);
});

test("rejects duplicate candidate identities before loading bytes", () => {
  let loads = 0;
  const candidate = Object.freeze({ id: 7, byteLength: 8 });
  const controller = new DetailStreamingController({
    selectCandidates() {
      return [candidate, candidate];
    },
    loadCandidate() {
      loads += 1;
      return { byteLength: 8 };
    },
    mountCandidate() {},
    unmountCandidate() {},
    setSelection() {},
    redraw(value) {
      return { camera: value };
    },
  });

  assert.throws(
    () => controller.update(camera),
    /duplicated/u,
  );
  assert.equal(loads, 0);
  controller.dispose();
});

test("pauses in-flight work, coalesces cameras, and resumes only the latest selection", async () => {
  const pending = new Map();
  const loads = [];
  const mounts = [];
  const redraws = [];
  const selections = [];
  const first = Object.freeze({ id: "first", byteLength: 8 });
  const middle = Object.freeze({ id: "middle", byteLength: 8 });
  const latestNear = Object.freeze({ id: "latest-near", byteLength: 8 });
  const latestFar = Object.freeze({ id: "latest-far", byteLength: 8 });
  const nowValues = [100, 145];
  const controller = new DetailStreamingController(
    {
      selectCandidates(value) {
        if (value.origin[0] === 0) {
          return [first];
        }
        if (value.origin[0] === 10) {
          return [middle];
        }
        return [latestNear, latestFar];
      },
      loadCandidate(candidate, { signal }) {
        const value = deferred();
        pending.set(candidate.id, value);
        loads.push({ id: candidate.id, signal });
        return value.promise;
      },
      mountCandidate(candidate) {
        mounts.push(candidate.id);
        return { id: candidate.id };
      },
      unmountCandidate() {},
      setSelection(value) {
        selections.push(value.map((candidate) => candidate.id));
      },
      redraw(value) {
        redraws.push(value);
        return { camera: value };
      },
    },
    {
      concurrency: 1,
      now() {
        return nowValues.shift() ?? 145;
      },
    },
  );

  controller.update(camera, { redraw: false });
  await waitFor(() => loads.length === 1, "the first detail read");
  assert.equal(loads[0].id, "first");
  assert.equal(loads[0].signal.aborted, false);

  assert.equal(controller.pause(), true);
  assert.equal(loads[0].signal.aborted, true);
  controller.update(
    { origin: [10, 0, 0], worldHeight: 100 },
    { redraw: false },
  );
  controller.update(
    { origin: [20, 0, 0], worldHeight: 100 },
    { redraw: false },
  );
  assert.deepEqual(loads.map((value) => value.id), ["first"]);
  assert.equal(controller.snapshot().pendingUpdate, true);

  pending.get("first").resolve({ byteLength: 8 });
  await controller.whenIdle();
  assert.deepEqual(mounts, []);
  assert.deepEqual(redraws, []);

  controller.resume();
  await waitFor(
    () => loads.some((value) => value.id === "latest-near"),
    "the nearest resumed detail read",
  );
  assert.equal(loads.some((value) => value.id === "middle"), false);
  pending.get("latest-near").resolve({ byteLength: 8 });
  await waitFor(
    () => loads.some((value) => value.id === "latest-far"),
    "the next distance-priority detail read",
  );
  pending.get("latest-far").resolve({ byteLength: 8 });
  const snapshot = await controller.whenIdle();

  assert.deepEqual(
    loads.map((value) => value.id),
    ["first", "latest-near", "latest-far"],
  );
  assert.deepEqual(mounts, ["latest-near", "latest-far"]);
  assert.deepEqual(selections.at(-1), ["latest-near", "latest-far"]);
  assert.equal(redraws.at(-1).origin[0], 20);
  assert.equal(snapshot.paused, false);
  assert.equal(snapshot.loading, 0);
  assert.deepEqual(snapshot.metrics, {
    interactionPauses: 1,
    interactionResumes: 1,
    coalescedUpdates: 2,
    loadStarts: 3,
    interactionLoadStarts: 0,
    cancellationRequests: 1,
    staleCompletions: 1,
    staleMounts: 0,
    gpuUploads: 2,
    settledUpdates: 1,
    settledDetailLatencyMs: 45,
  });
  controller.dispose();
});

test("terminal disposal aborts a deferred read without mounting a resource", async () => {
  const read = deferred();
  let readSignal;
  let mounts = 0;
  const controller = new DetailStreamingController({
    selectCandidates() {
      return [{ id: "deferred", byteLength: 8 }];
    },
    loadCandidate(candidate, { signal }) {
      readSignal = signal;
      return read.promise;
    },
    mountCandidate() {
      mounts += 1;
    },
    unmountCandidate() {},
    setSelection() {},
    redraw(value) {
      return { camera: value };
    },
  });

  controller.update(camera, { redraw: false });
  await waitFor(() => readSignal !== undefined, "the deferred read");
  controller.dispose();
  assert.equal(readSignal.aborted, true);
  read.resolve({ byteLength: 8 });
  const snapshot = await controller.whenIdle();

  assert.equal(mounts, 0);
  assert.equal(snapshot.cache.pending, 0);
  assert.equal(snapshot.cache.entries, 0);
  assert.equal(snapshot.metrics.staleMounts, 0);
});
