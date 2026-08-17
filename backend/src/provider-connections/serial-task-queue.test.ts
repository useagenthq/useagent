import { describe, expect, test } from "bun:test";
import { createSerialTaskQueue } from "./serial-task-queue";

describe("serial task queue", () => {
  test("fails closed when a slow consumer reaches its pending-task limit", async () => {
    const first = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const completed: number[] = [];
    const queue = createSerialTaskQueue((error) => errors.push(error), {
      maxPendingTasks: 1,
    });

    queue.enqueue(async () => {
      await first.promise;
      completed.push(1);
    });
    queue.enqueue(async () => {
      completed.push(2);
    });
    queue.enqueue(async () => {
      completed.push(3);
    });
    first.resolve();
    await Bun.sleep(0);

    expect(completed).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });
});
