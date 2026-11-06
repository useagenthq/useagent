import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import { runtimeModeFor } from "./permission-mode";
import type { RuntimeEnvironmentRequest } from "./runtime-environment-client";
import { buildRuntimeTurnStartCommand, type RuntimeMode, type RuntimeThreadSnapshot } from "./runtime-orchestration";
import { ensureRuntimeThreadMode } from "./runtime-thread-mode";
import type { RuntimeCommand } from "./runtime-v2-wire";
import { v2Projection, v2Snapshot } from "./runtime-v2.test-support";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

type RequestFn = NonNullable<Parameters<typeof ensureRuntimeThreadMode>[0]["request"]>;
type DispatchFn = NonNullable<Parameters<typeof ensureRuntimeThreadMode>[0]["dispatch"]>;
const SANDBOX = {} as SandboxHandle;
const THREAD = `${SANDBOX_NAME_PREFIX}-thread-thread-1`;

function view(runtimeMode: RuntimeMode | undefined, sequence = 1): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: THREAD,
      ...(runtimeMode ? { runtimeMode } : {}),
      latestTurn: null,
      messages: [],
      activities: [],
      session: null,
    },
  };
}

const read = (runtimeMode: RuntimeMode | undefined, sequence: number) => v2Snapshot(sequence, v2Projection({
  thread: { id: THREAD, ...(runtimeMode ? { runtimeMode } : {}), activeProviderThreadId: null },
}));

/** Reads answer with the given modes in order (the last one repeats); dispatches are recorded. */
function harness(reported: Array<RuntimeMode | undefined>) {
  const reads: RuntimeEnvironmentRequest[] = [];
  const commands: RuntimeCommand[] = [];
  let count = 0;
  const request = (async (_sandbox: SandboxHandle, req: RuntimeEnvironmentRequest) => {
    reads.push(req);
    const mode = reported[Math.min(count, reported.length - 1)];
    count += 1;
    return read(mode, 10 + count);
  }) as unknown as RequestFn;
  const dispatch = (async (_sandbox: SandboxHandle, command: RuntimeCommand) => {
    commands.push(command);
    return { sequence: 1 };
  }) as unknown as DispatchFn;
  return { reads, commands, request, dispatch };
}

/** The runtime as protocol 2 defines it: a turn runs with the mode stored on the
 *  thread, and only thread.runtime-mode.set changes the stored mode. */
function recordedRuntime(initialMode: RuntimeMode) {
  const thread = { runtimeMode: initialMode, sequence: 1 };
  const turns: RuntimeMode[] = [];
  const request = (async () => read(thread.runtimeMode, thread.sequence)) as unknown as RequestFn;
  const dispatch = (async (_sandbox: SandboxHandle, command: RuntimeCommand) => {
    if (command.type === "thread.runtime-mode.set") {
      thread.runtimeMode = command.runtimeMode as RuntimeMode;
      thread.sequence += 1;
    } else if (command.type === "message.dispatch") {
      turns.push(thread.runtimeMode);
      thread.sequence += 1;
    }
    return { sequence: thread.sequence };
  }) as unknown as DispatchFn;
  const startTurn = () => dispatch(
    SANDBOX,
    buildRuntimeTurnStartCommand({ runId: "run-2", threadId: "thread-1", model: undefined }, "codex", "change the file"),
    new AbortController().signal,
  );
  return { thread, turns, request, dispatch, startTurn };
}

describe("runtime thread mode before a turn", () => {
  test("a thread already in the run's mode is left alone", async () => {
    const { reads, commands, request, dispatch } = harness([]);
    const prior = view("full-access");
    const result = await ensureRuntimeThreadMode({
      sandbox: SANDBOX, threadId: THREAD, runtimeMode: "full-access", snapshot: prior,
      signal: new AbortController().signal, request, dispatch,
    });
    expect(result).toBe(prior);
    expect(reads).toEqual([]);
    expect(commands).toEqual([]);
  });

  test("a reply that changes the mode sets it on the thread and proceeds once the runtime reports it", async () => {
    const { reads, commands, request, dispatch } = harness(["full-access", "approval-required"]);
    const result = await ensureRuntimeThreadMode({
      sandbox: SANDBOX, threadId: THREAD, runtimeMode: "approval-required", snapshot: view("full-access"),
      signal: new AbortController().signal, request, dispatch, settleIntervalMs: 1,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "thread.runtime-mode.set", threadId: THREAD, runtimeMode: "approval-required" });
    expect(commands[0]).not.toHaveProperty("createdAt");
    expect(reads.every((req) => req.method === "GET" && req.path.endsWith("/bounded"))).toBe(true);
    expect(result.thread.runtimeMode).toBe("approval-required");
    expect(result.snapshotSequence).toBe(12);
  });

  test("a thread that keeps its old mode fails the turn instead of running wider than the run allows", async () => {
    const kept = harness(["full-access"]);
    await expect(ensureRuntimeThreadMode({
      sandbox: SANDBOX, threadId: THREAD, runtimeMode: "approval-required", snapshot: view("full-access"),
      signal: new AbortController().signal, request: kept.request, dispatch: kept.dispatch, settleIntervalMs: 1,
    })).rejects.toThrow("kept thread mode full-access instead of approval-required");
    const unknown = harness([undefined]);
    await expect(ensureRuntimeThreadMode({
      sandbox: SANDBOX, threadId: THREAD, runtimeMode: "approval-required", snapshot: view(undefined),
      signal: new AbortController().signal, request: unknown.request, dispatch: unknown.dispatch, settleIntervalMs: 1,
    })).rejects.toThrow("kept thread mode unknown");
  });

  test("every mode transition reaches the turn only through the mode step", async () => {
    // The turn's own message names no mode at all: only the stored thread does.
    expect(buildRuntimeTurnStartCommand({ runId: "r", threadId: "t" }, "codex", "x")).not.toHaveProperty("runtimeMode");
    const transitions: Array<[RuntimeMode, "read-only" | "approval-required" | "full-access"]> = [
      ["full-access", "read-only"],
      ["full-access", "approval-required"],
      ["approval-required", "full-access"],
    ];
    for (const [threadMode, runMode] of transitions) {
      const wanted = runtimeModeFor(runMode);
      const bare = recordedRuntime(threadMode);
      await bare.startTurn();
      expect(bare.turns).toEqual([threadMode]);
      const guarded = recordedRuntime(threadMode);
      const settled = await ensureRuntimeThreadMode({
        sandbox: SANDBOX, threadId: THREAD, runtimeMode: wanted, snapshot: view(threadMode, 1),
        signal: new AbortController().signal, request: guarded.request, dispatch: guarded.dispatch, settleIntervalMs: 1,
      });
      expect(settled.thread.runtimeMode).toBe(wanted);
      await guarded.startTurn();
      expect(guarded.turns).toEqual([wanted]);
    }
  });
});
