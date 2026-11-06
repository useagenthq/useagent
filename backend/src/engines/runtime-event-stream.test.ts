// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import { dispatchRuntimeCommand } from "./runtime-dispatch";
import { buildRuntimeThreadSubscription, followRuntimeThread } from "./runtime-event-stream";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import type { RuntimeSocket } from "./runtime-rpc-socket";
import { v2Message, v2Projection, v2Run } from "./runtime-v2.test-support";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const THREAD = `${SANDBOX_NAME_PREFIX}-thread-thread-1`;
const sandbox = { id: "sandbox-1" } as SandboxHandle;

type Batch = readonly unknown[];

interface ScriptedSocket {
  /** The subscription payload each socket was opened with. */
  readonly subscriptions: unknown[];
  readonly calls: unknown[];
  readonly open: Parameters<typeof followRuntimeThread>[0]["open"];
}

/** Each entry is one socket: the batches its subscription delivers, then how it ends. */
function scriptedSockets(sockets: ReadonlyArray<{ readonly batches: readonly Batch[]; readonly end?: Error }>): ScriptedSocket {
  const subscriptions: unknown[] = [];
  const calls: unknown[] = [];
  let index = 0;
  const open = async () => {
    const script = sockets[index++];
    if (!script) throw new Error("no more sockets");
    const socket: RuntimeSocket = {
      async stream(_tag, payload, onValues) {
        subscriptions.push(payload);
        for (const batch of script.batches) {
          if (!(await onValues(batch))) return;
        }
        if (script.end) throw script.end;
      },
      async call(_tag, payload) {
        calls.push(payload);
        return { sequence: 99 };
      },
      close() {},
    };
    return socket;
  };
  return { subscriptions, calls, open: open as never };
}

const snapshot = (sequence: number, runs = [v2Run({ id: "r0" })]) =>
  ({ kind: "snapshot", snapshotSequence: sequence, projection: v2Projection({ runs }) });
const event = (sequence: number, type: string, payload: unknown) =>
  ({ kind: "event", sequence, event: { type, threadId: THREAD, payload } });
const running = (id: string, ordinal: number) => v2Run({ id, ordinal, status: "running", completedAt: null });
const settled = (id: string, ordinal: number) => v2Run({ id, ordinal, status: "completed" });

describe("runtime thread follower", () => {
  test("subscribes for a bounded snapshot with a completion marker, resuming after a cursor", () => {
    expect(buildRuntimeThreadSubscription(THREAD)).toEqual({
      threadId: THREAD, acceptBoundedSnapshot: true, requestCompletionMarker: true,
    });
    expect(buildRuntimeThreadSubscription(THREAD, 41)).toEqual({
      threadId: THREAD, afterSequence: 41, acceptBoundedSnapshot: true, requestCompletionMarker: true,
    });
  });

  test("dispatches the turn once caught up, on the subscribed socket, and follows it to the end", async () => {
    const sockets = scriptedSockets([{ batches: [
      [snapshot(10)],
      [{ kind: "synchronized" }],
      [event(44, "run.created", running("r1", 2))],
      [event(57, "message.updated", v2Message({ id: "m1", runId: "r1", text: "Hi" }))],
      [event(90, "run.updated", settled("r1", 2))],
    ] }]);
    const order: string[] = [];
    const views: RuntimeThreadSnapshot[] = [];
    await followRuntimeThread({
      sandbox, threadId: THREAD, signal: new AbortController().signal, open: sockets.open, resumeDelayMs: 0,
      start: async () => {
        order.push("start");
        await dispatchRuntimeCommand(sandbox, { type: "message.dispatch", commandId: "c1", threadId: THREAD }, new AbortController().signal, {
          open: async () => { throw new Error("dispatch must reuse the turn socket"); },
        });
      },
      applySnapshot: async (view) => {
        order.push(`view:${view.snapshotSequence}`);
        views.push(view);
        return !(view.thread.latestTurn?.turnId === "r1" && view.thread.latestTurn.state === "completed");
      },
    });
    expect(order).toEqual(["view:10", "start", "view:44", "view:57", "view:90"]);
    expect(sockets.calls).toEqual([{ type: "message.dispatch", commandId: "c1", threadId: THREAD }]);
    expect(views.at(-1)?.thread.messages.map((message) => message.text)).toEqual(["Hi"]);
  });

  test("a dropped socket resumes from the applied sequence without repeating anything", async () => {
    const sockets = scriptedSockets([
      { batches: [[snapshot(10), { kind: "synchronized" }], [event(20, "run.created", running("r1", 2))]], end: new Error("socket lost") },
      { batches: [[event(20, "run.created", running("r1", 2)), event(31, "run.updated", settled("r1", 2)), { kind: "synchronized" }]] },
    ]);
    const sequences: number[] = [];
    let starts = 0;
    await followRuntimeThread({
      sandbox, threadId: THREAD, signal: new AbortController().signal, open: sockets.open, resumeDelayMs: 0,
      start: async () => { starts += 1; },
      applySnapshot: async (view) => {
        sequences.push(view.snapshotSequence);
        return !(view.thread.latestTurn?.turnId === "r1" && view.thread.latestTurn.state === "completed");
      },
    });
    expect(starts).toBe(1);
    expect(sequences).toEqual([10, 20, 31]);
    expect(sockets.subscriptions[1]).toMatchObject({ afterSequence: 20 });
  });

  test("a resume the runtime answers with a fresh snapshot replaces the state", async () => {
    const sockets = scriptedSockets([
      { batches: [[snapshot(10), { kind: "synchronized" }]], end: new Error("socket lost") },
      { batches: [[snapshot(400, [settled("r1", 2)]), { kind: "synchronized" }]] },
    ]);
    const sequences: number[] = [];
    await followRuntimeThread({
      sandbox, threadId: THREAD, signal: new AbortController().signal, open: sockets.open, resumeDelayMs: 0,
      applySnapshot: async (view) => {
        sequences.push(view.snapshotSequence);
        return view.thread.latestTurn?.turnId !== "r1";
      },
    });
    expect(sequences).toEqual([10, 400]);
  });

  test("the turn's own dispatch failure ends the follow without a resume", async () => {
    const sockets = scriptedSockets([{ batches: [[snapshot(10), { kind: "synchronized" }]] }]);
    const failure = new Error("refused");
    await expect(followRuntimeThread({
      sandbox, threadId: THREAD, signal: new AbortController().signal, open: sockets.open, resumeDelayMs: 0,
      start: async () => { throw failure; },
      applySnapshot: async () => true,
    })).rejects.toBe(failure);
    expect(sockets.subscriptions).toHaveLength(1);
  });

  test("a projection failure ends the follow without a resume", async () => {
    const sockets = scriptedSockets([{ batches: [[snapshot(10), { kind: "synchronized" }]] }]);
    const failure = new Error("turn failed");
    await expect(followRuntimeThread({
      sandbox, threadId: THREAD, signal: new AbortController().signal, open: sockets.open, resumeDelayMs: 0,
      applySnapshot: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  test("gives up after repeated reconnects that make no progress", async () => {
    const lost = new Error("socket lost");
    const sockets = scriptedSockets([
      { batches: [[snapshot(10), { kind: "synchronized" }]], end: lost },
      { batches: [], end: lost },
      { batches: [], end: lost },
      { batches: [], end: lost },
    ]);
    await expect(followRuntimeThread({
      sandbox, threadId: THREAD, signal: new AbortController().signal, open: sockets.open, resumeDelayMs: 0,
      applySnapshot: async () => true,
    })).rejects.toBe(lost);
    expect(sockets.subscriptions).toHaveLength(4);
  });

  test("a reconnect that only resends the same snapshot is not progress", async () => {
    const lost = new Error("socket lost");
    const same = { batches: [[snapshot(10), { kind: "synchronized" }]], end: lost };
    const sockets = scriptedSockets([same, same, same, same, same]);
    await expect(followRuntimeThread({
      sandbox, threadId: THREAD, signal: new AbortController().signal, open: sockets.open, resumeDelayMs: 0,
      applySnapshot: async () => true,
    })).rejects.toBe(lost);
    expect(sockets.subscriptions).toHaveLength(4);
  });

  test("an aborted follow resolves quietly", async () => {
    const controller = new AbortController();
    const sockets = scriptedSockets([{ batches: [[snapshot(10), { kind: "synchronized" }]], end: new Error("socket lost") }]);
    await followRuntimeThread({
      sandbox, threadId: THREAD, signal: controller.signal, open: sockets.open, resumeDelayMs: 0,
      applySnapshot: async () => {
        controller.abort();
        return true;
      },
    });
  });
});
