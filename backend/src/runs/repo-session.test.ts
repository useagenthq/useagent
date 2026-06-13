import { describe, expect, test } from "bun:test";
import type { Executor } from "../db/client";
import { providerSessionBinding } from "@useagent/agent-harness/canonical";
import { clearThreadSandbox, setRunEngineSession, setRunProviderSession } from "./repo";

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
    expect(values).toEqual([{
      engineSessionId: "session-canonical",
      providerSession: null,
    }]);
  });

  test("persists the typed binding and legacy native-id mirror atomically", async () => {
    const { exec, values } = updateExecutor(["run-1"]);
    const binding = providerSessionBinding({
      provider: "pi",
      nativeSessionId: "/sessions/pi.jsonl",
      protocolVersion: "oh-my-pi-rpc/18.0.3",
      runtime: { kind: "sandbox", id: "sandbox-1" },
      capabilities: {} as never,
      generation: 4,
    });

    await expect(setRunProviderSession("run-1", binding, exec)).resolves.toBeUndefined();
    expect(values).toEqual([{
      engineSessionId: binding.nativeSessionId,
      providerSession: binding,
    }]);
  });

  test("clears sandbox and provider-session mirrors atomically after release", async () => {
    const { exec, values } = updateExecutor(["run-1"]);

    await expect(
      clearThreadSandbox("org-1", "thread-1", "sandbox-1", exec),
    ).resolves.toBe(1);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      sandboxId: null,
      engineSessionId: null,
      providerSession: null,
    });
    expect(values[0]?.updatedAt).toBeInstanceOf(Date);
  });
});
