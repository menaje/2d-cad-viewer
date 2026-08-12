export class TaskQueueDisposedError extends Error {
  constructor() {
    super("task queue is disposed");
    this.name = "TaskQueueDisposedError";
  }
}

interface PendingTask<T> {
  readonly task: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export class BoundedTaskQueue {
  private readonly pending: PendingTask<unknown>[] = [];
  private active = 0;
  private disposed = false;

  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new RangeError("task queue concurrency must be positive");
    }
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new TaskQueueDisposedError());
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        task,
        resolve: resolve as PendingTask<unknown>["resolve"],
        reject,
      });
      this.drain();
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const error = new TaskQueueDisposedError();
    for (const pending of this.pending.splice(0)) {
      pending.reject(error);
    }
  }

  private drain(): void {
    while (
      !this.disposed &&
      this.active < this.concurrency &&
      this.pending.length > 0
    ) {
      const pending = this.pending.shift()!;
      this.active += 1;
      void Promise.resolve()
        .then(pending.task)
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
