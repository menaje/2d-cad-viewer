import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedTaskQueue,
  TaskQueueDisposedError,
} from "../src/bounded-task-queue";

test("bounds active tasks and keeps draining after a rejection", async () => {
  const queue = new BoundedTaskQueue(2);
  let active = 0;
  let peak = 0;
  const completed: number[] = [];
  const tasks = Array.from({ length: 6 }, (_, index) =>
    queue
      .run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        if (index === 2) {
          throw new Error("expected task failure");
        }
        completed.push(index);
        return index;
      })
      .catch((error: unknown) => {
        assert.match(String(error), /expected task failure/u);
        return -1;
      }),
  );

  assert.deepEqual(await Promise.all(tasks), [0, 1, -1, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(completed.sort((left, right) => left - right), [
    0,
    1,
    3,
    4,
    5,
  ]);
});

test("disposal rejects queued tasks without interrupting the active task", async () => {
  const queue = new BoundedTaskQueue(1);
  let release!: () => void;
  const active = queue.run(
    () =>
      new Promise<number>((resolve) => {
        release = () => resolve(1);
      }),
  );
  const queued = queue.run(async () => 2);

  await new Promise((resolve) => setImmediate(resolve));
  queue.dispose();
  release();

  assert.equal(await active, 1);
  await assert.rejects(queued, TaskQueueDisposedError);
  await assert.rejects(
    queue.run(async () => 3),
    TaskQueueDisposedError,
  );
});

test("rejects an invalid concurrency bound", () => {
  assert.throws(() => new BoundedTaskQueue(0), RangeError);
});
