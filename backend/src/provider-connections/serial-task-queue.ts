export interface SerialTaskQueue {
  enqueue(task: () => Promise<void>): void;
}

/** Runs tasks one at a time, in order; the first that throws ends the queue
 *  (`onError`). Past `maxPendingTasks` waiting tasks it fails closed, for a
 *  producer that must not build an unbounded backlog; a trusted one whose
 *  output must arrive whole passes Number.POSITIVE_INFINITY. */
export function createSerialTaskQueue(
  onError: (error: unknown) => void,
  options: { readonly maxPendingTasks?: number } = {},
): SerialTaskQueue {
  const maxPendingTasks = options.maxPendingTasks ?? 256;
  if (!(maxPendingTasks === Number.POSITIVE_INFINITY || Number.isSafeInteger(maxPendingTasks)) || maxPendingTasks < 1) {
    throw new Error("serial task queue limit is invalid");
  }
  const pending: Array<() => Promise<void>> = [];
  let draining = false;
  let failed = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const task = pending.shift();
        if (task) await task();
      }
    } catch (error) {
      failed = true;
      pending.length = 0;
      onError(error);
    } finally {
      draining = false;
    }
  }

  return {
    enqueue(task) {
      if (failed) return;
      if (pending.length >= maxPendingTasks) {
        failed = true;
        pending.length = 0;
        onError(new Error("serial task queue limit exceeded"));
        return;
      }
      pending.push(task);
      void drain();
    },
  };
}
