import { describe, expect, test } from "bun:test";
import type { Executor } from "../db/client";
import { setRunEngineSession } from "./repo";

function updateExecutor(updatedIds: readonly string[]): {
  readonly exec: Executor;
  readonly values: Array<Record<string, unknown>>;
} {
  const values: Array<Record<string, unknown>> = [];
  const exec = {
    update: () => ({
      set: (value: Record<string, unknown>) => {
        values.push(value);
        return {
          where: () => ({
            returning: async () => updatedIds.map((id) => ({ id })),
          }),
        };
      },
    }),
  } as unknown as Executor;
  return { exec, values };
}

describe("run native session persistence", () => {
  test("rejects when the update did not durably match a run row", async () => {
    const { exec } = updateExecutor([]);

    await expect(
      setRunEngineSession("run-missing", "session-orphaned", exec),
    ).rejects.toThrow("setRunEngineSession: run run-missing not found (no row updated)");
  });

  test("resolves only after the canonical session id is returned by the update", async () => {
    const { exec, values } = updateExecutor(["run-1"]);

    await expect(
      setRunEngineSession("run-1", "session-canonical", exec),
    ).resolves.toBeUndefined();
    expect(values).toEqual([{ engineSessionId: "session-canonical" }]);
  });
});
