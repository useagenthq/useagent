export interface SerialTaskQueue {
  enqueue(task: () => Promise<void>): void;
}

export function createSerialTaskQueue(
  onError: (error: unknown) => void,
  options: { readonly maxPendingTasks?: number } = {},
): SerialTaskQueue {
  const maxPendingTasks = options.maxPendingTasks ?? 256;
  if (!Number.isSafeInteger(maxPendingTasks) || maxPendingTasks < 1) {
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
