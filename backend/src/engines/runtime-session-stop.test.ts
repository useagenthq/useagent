// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import type { RuntimeEnvironmentRequest } from "./runtime-environment-client";
import { reloadRetainedSession, type SessionReloadDependencies } from "./runtime-session-stop";
import { RuntimeRpcError, type RuntimeCommand, type V2RunStatus } from "./runtime-v2-wire";
import { v2Projection, v2ProviderThread, v2Run, v2Session, v2Snapshot } from "./runtime-v2.test-support";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const THREAD = `${SANDBOX_NAME_PREFIX}-thread-thread-1`;
const reloadCommandState = { change: "OpenCode model limits", changed: true, revision: "revision-1" } as const;

/** A thread whose OpenCode session is `status` (none when null) after a run in `runStatus`. */
function thread(status: string | null, runStatus: V2RunStatus = "completed") {
  return v2Snapshot(1, v2Projection({
    runs: [v2Run({ id: "run-1", status: runStatus, completedAt: runStatus === "running" ? null : "x" })],
    providerSessions: status === null ? [] : [v2Session({ status })],
    providerThreads: status === null ? [] : [v2ProviderThread()],
  }));
}

const refusal = (detail: string) =>
  new RuntimeRpcError("orchestration.dispatchCommand", "OrchestrationV2DispatchCommandError", "Failed to dispatch orchestration V2 command", detail, [
    "Fail", "OrchestrationV2DispatchCommandError", "OrchestratorDispatchError",
  ]);

/** Reads answer with the next state (the last one repeats); detaches run `onDetach`. */
function harness(states: ReturnType<typeof thread>[], onDetach: (command: RuntimeCommand) => void = () => {}) {
  const calls: string[] = [];
  const commands: RuntimeCommand[] = [];
  let reads = 0;
  const dependencies: SessionReloadDependencies = {
    requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) => {
      calls.push(`${request.method} ${request.path}`);
      const state = states[Math.min(reads, states.length - 1)];
      reads += 1;
      return state as T;
    },
    dispatch: async (_sandbox, command) => {
      calls.push(`dispatch ${command.type}`);
      commands.push(command);
      onDetach(command);
      return { sequence: 1 };
    },
    wait: async () => {},
  };
  return { calls, commands, dependencies, reads: () => reads };
}

const reload = (dependencies: SessionReloadDependencies, overrides: Partial<Parameters<typeof reloadRetainedSession>[0]> = {}) =>
  reloadRetainedSession({
    sandbox: {} as never,
    signal: new AbortController().signal,
    threadId: THREAD,
    threadExists: true,
    ...reloadCommandState,
    dependencies,
    ...overrides,
  });

const READ = `GET /api/orchestration/threads/${THREAD}/bounded`;

describe("retained session reload", () => {
  test("names what changed in the detach, for Codex as for OpenCode", async () => {
    const { commands, dependencies } = harness([thread("ready"), thread(null)]);
    await expect(reload(dependencies, { change: "Codex configuration", revision: "a".repeat(64) })).resolves.toBe(true);
    expect(commands[0]).toMatchObject({ type: "provider-session.detach", reason: "Codex configuration changed." });
  });

  test("detaches the idle session and waits until it has left the thread", async () => {
    const { calls, commands, dependencies } = harness([thread("ready"), thread(null)]);
    await expect(reload(dependencies)).resolves.toBe(true);
    expect(calls).toEqual([READ, "dispatch provider-session.detach", READ]);
    expect(commands[0]).toMatchObject({ type: "provider-session.detach", threadId: THREAD, providerSessionId: "ps-1", reason: "OpenCode model limits changed." });
  });

  test("skips cold and unchanged OpenCode sessions", async () => {
    const { calls, dependencies } = harness([thread("ready")]);
    await reload(dependencies, { threadExists: false });
    await reload(dependencies, { changed: false });
    expect(calls).toEqual([]);
  });

  test("a thread without a session already has the new limits", async () => {
    const { calls, dependencies } = harness([thread(null)]);
    await expect(reload(dependencies)).resolves.toBe(true);
    expect(calls).toEqual([READ]);
  });

  test.each([
    ["running", "completed", "retained session is running"],
    ["starting", "completed", "retained session is starting"],
    ["waiting", "completed", "retained session is waiting"],
    ["ready", "running", "retained native turn is running"],
  ] as const)("refuses a %s session after a %s run", async (status, runStatus, message) => {
    const { calls, dependencies } = harness([thread(status, runStatus)]);
    await expect(reload(dependencies)).rejects.toThrow(message);
    expect(calls).toEqual([READ]);
  });

  test("fails closed on a malformed thread read", async () => {
    const { dependencies } = harness([{ snapshotSequence: 1, projection: { thread: { id: THREAD } } } as never]);
    await expect(reload(dependencies)).rejects.toThrow("malformed thread snapshot");
  });

  test("every attempt is its own detach command", async () => {
    const lost = harness([thread("ready")], () => { throw new Error("transport response lost"); });
    await expect(reload(lost.dependencies)).rejects.toThrow("transport response lost");
    const landed = harness([thread("ready"), thread(null)]);
    await expect(reload(landed.dependencies)).resolves.toBe(true);
    const ids = [lost.commands[0]!.commandId, landed.commands[0]!.commandId];
    for (const id of ids) expect(id).toMatch(new RegExp(`^${SANDBOX_NAME_PREFIX}-session-detach-revision-1-[0-9a-f-]{36}-${SANDBOX_NAME_PREFIX}-thread-thread-1$`));
    expect(ids[1]).not.toBe(ids[0]);
  });

  test("a detach whose answer was lost still counts once the session has left", async () => {
    const { dependencies } = harness([thread("ready"), thread(null)], () => { throw new Error("transport response lost"); });
    await expect(reload(dependencies)).resolves.toBe(true);
  });

  test("proceeds without acknowledgement when the runtime refuses the detach", async () => {
    const { calls, dependencies } = harness([thread("ready")], () => { throw refusal("Provider session ps-1 does not belong to thread t."); });
    await expect(reload(dependencies)).resolves.toBe(false);
    expect(calls).toEqual([READ, "dispatch provider-session.detach", READ]);
  });

  test("a refused detach of a session that left on its own applies the limits", async () => {
    const { dependencies } = harness([thread("ready"), thread(null)], () => { throw refusal("Provider session ps-1 does not belong to thread t."); });
    await expect(reload(dependencies)).resolves.toBe(true);
  });

  test("fails without acknowledgement when the thread re-engaged before the detach", async () => {
    const { dependencies } = harness([thread("ready"), thread("running")], () => { throw new Error("socket lost"); });
    await expect(reload(dependencies)).rejects.toThrow("reactivated before the detach");
  });

  test("fails closed on cancellation and on a detach that never lands", async () => {
    const reason = new Error("turn cancelled");
    const controller = new AbortController();
    const cancelled = harness([thread("ready")], () => controller.abort(reason));
    await expect(reload(cancelled.dependencies, { signal: controller.signal })).rejects.toBe(reason);

    const stuck = harness([thread("ready")]);
    await expect(reload({
      ...stuck.dependencies,
      wait: async (signal) => {
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    }, { deadlineMs: 10 })).rejects.toThrow("Timed out waiting for the retained session to stop after the OpenCode model limits changed");
    expect(stuck.commands).toHaveLength(1);
  });
});
