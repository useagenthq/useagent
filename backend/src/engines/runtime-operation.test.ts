import { describe, expect, test } from "bun:test";
import { awaitRuntimeOperation } from "./runtime-operation";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function expectNoUnhandledRejection(run: () => Promise<void>) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await Bun.sleep(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("awaitRuntimeOperation", () => {
  test("resolves with the operation value without cleanup", async () => {
    let cleanupCalls = 0;
    const result = awaitRuntimeOperation(
      Promise.resolve("finished"),
      new AbortController().signal,
      async () => {
        cleanupCalls++;
      },
    );

    expect(await result).toBe("finished");
    expect(cleanupCalls).toBe(0);
  });

  test("rejects with the operation error without cleanup", async () => {
    const operationError = new Error("operation failed");
    let cleanupCalls = 0;
    const result = awaitRuntimeOperation(
      Promise.reject(operationError),
      new AbortController().signal,
      async () => {
        cleanupCalls++;
      },
    );

    await expect(result).rejects.toBe(operationError);
    expect(cleanupCalls).toBe(0);
  });

  test.each([
    ["resolves", (operation: ReturnType<typeof deferred<string>>) => operation.resolve("late value")],
    ["rejects", (operation: ReturnType<typeof deferred<string>>) => operation.reject(new Error("late error"))],
  ])("an operation that %s after a mid-flight abort is dropped", async (_outcome, settle) => {
    const operation = deferred<string>();
    const controller = new AbortController();
    const abortReason = new Error("cancelled");
    let cleanupCalls = 0;
    const result = awaitRuntimeOperation(operation.promise, controller.signal, async () => {
      cleanupCalls++;
    });

    controller.abort(abortReason);
    await expect(result).rejects.toBe(abortReason);
    expect(cleanupCalls).toBe(1);

    settle(operation);
    await operation.promise.catch(() => {});
    expect(cleanupCalls).toBe(2);
    await expect(result).rejects.toBe(abortReason);
  });

  test.each([
    ["resolves", (operation: ReturnType<typeof deferred<string>>) => operation.resolve("late value")],
    ["rejects", (operation: ReturnType<typeof deferred<string>>) => operation.reject(new Error("late error"))],
  ])("an operation that %s with an already-aborted signal is dropped", async (_outcome, settle) => {
    const operation = deferred<string>();
    const controller = new AbortController();
    const abortReason = new Error("already cancelled");
    let cleanupCalls = 0;
    controller.abort(abortReason);

    const result = awaitRuntimeOperation(operation.promise, controller.signal, async () => {
      cleanupCalls++;
    });
    await expect(result).rejects.toBe(abortReason);
    expect(cleanupCalls).toBe(1);

    settle(operation);
    await operation.promise.catch(() => {});
    expect(cleanupCalls).toBe(2);
    await expect(result).rejects.toBe(abortReason);
  });

  test("catches a cleanup rejection from the pre-aborted immediate call", async () => {
    await expectNoUnhandledRejection(async () => {
      const operation = deferred<string>();
      const controller = new AbortController();
      const abortReason = new Error("already cancelled");
      let cleanupCalls = 0;
      controller.abort(abortReason);

      const result = awaitRuntimeOperation(operation.promise, controller.signal, () => {
        cleanupCalls++;
        return Promise.reject(new Error("cleanup failed"));
      });

      await expect(result).rejects.toBe(abortReason);
      expect(cleanupCalls).toBe(1);
    });
  });

  test("catches a cleanup rejection from the abort listener", async () => {
    await expectNoUnhandledRejection(async () => {
      const operation = deferred<string>();
      const controller = new AbortController();
      const abortReason = new Error("cancelled");
      let cleanupCalls = 0;
      const result = awaitRuntimeOperation(operation.promise, controller.signal, () => {
        cleanupCalls++;
        return Promise.reject(new Error("cleanup failed"));
      });

      controller.abort(abortReason);
      await expect(result).rejects.toBe(abortReason);
      expect(cleanupCalls).toBe(1);
    });
  });

  test.each([
    ["resolve", (operation: ReturnType<typeof deferred<string>>) => operation.resolve("late value")],
    ["reject", (operation: ReturnType<typeof deferred<string>>) => operation.reject(new Error("late error"))],
  ])("catches a cleanup rejection from the late %s handler", async (_outcome, settle) => {
    await expectNoUnhandledRejection(async () => {
      const operation = deferred<string>();
      const controller = new AbortController();
      const abortReason = new Error("cancelled");
      let cleanupCalls = 0;
      const result = awaitRuntimeOperation(operation.promise, controller.signal, () => {
        cleanupCalls++;
        return cleanupCalls === 2
          ? Promise.reject(new Error("cleanup failed"))
          : Promise.resolve();
      });

      controller.abort(abortReason);
      await expect(result).rejects.toBe(abortReason);
      settle(operation);
      await operation.promise.catch(() => {});
      expect(cleanupCalls).toBe(2);
      await expect(result).rejects.toBe(abortReason);
    });
  });
});
