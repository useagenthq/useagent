// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import { applyV2Event, applyV2StreamItem, type V2MirrorState } from "./runtime-v2-mirror";
import type { V2Projection, V2ThreadStreamItem } from "./runtime-v2-wire";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const THREAD = `${SANDBOX_NAME_PREFIX}-thread-1`;

function projection(overrides: Partial<V2Projection> = {}): V2Projection {
  return {
    thread: { id: THREAD, runtimeMode: "full-access", activeProviderThreadId: null },
    runs: [], messages: [], turnItems: [], providerSessions: [], providerThreads: [],
    runtimeRequests: [], subagents: [],
    ...overrides,
  };
}

const snapshot = (sequence: number, value = projection()): V2ThreadStreamItem =>
  ({ kind: "snapshot", snapshot: { snapshotSequence: sequence, projection: value } });

const message = (id: string, text: string) => ({
  id, runId: "run-1", role: "assistant", text, streaming: true, createdAt: "2026-10-03T00:00:00.000Z",
});

const event = (sequence: number, type: string, payload: unknown, threadId = THREAD): V2ThreadStreamItem =>
  ({ kind: "event", sequence, event: { type, threadId, payload } });

function run(items: readonly V2ThreadStreamItem[]): V2MirrorState | null {
  let state: V2MirrorState | null = null;
  for (const item of items) state = applyV2StreamItem(state, item, THREAD).state;
  return state;
}

describe("runtime thread mirror", () => {
  test("applies events across the gaps a global sequence leaves", () => {
    const state = run([
      snapshot(10),
      event(14, "message.updated", message("m1", "Hel")),
      event(91, "message.updated", message("m1", "Hello")),
    ]);
    expect(state?.sequence).toBe(91);
    expect(state?.projection.messages.map((entry) => entry.text)).toEqual(["Hello"]);
  });

  test("ignores replayed and reordered events at or below the cursor", () => {
    const state = run([
      snapshot(10),
      event(20, "message.updated", message("m1", "second")),
      event(15, "message.updated", message("m1", "first")),
      event(20, "message.updated", message("m1", "second again")),
    ]);
    expect(state?.projection.messages.map((entry) => entry.text)).toEqual(["second"]);
  });

  test("an older snapshot never rolls the state back; a newer one replaces it", () => {
    const newer = projection({ messages: [message("m2", "fresh") as never] });
    const state = run([snapshot(30), event(31, "message.updated", message("m1", "x")), snapshot(12), snapshot(40, newer)]);
    expect(state?.sequence).toBe(40);
    expect(state?.projection.messages.map((entry) => entry.id)).toEqual(["m2"]);
  });

  test("events before the first snapshot wait for it", () => {
    expect(run([event(5, "message.updated", message("m1", "x"))])).toBeNull();
  });

  test("an unknown event type still moves the cursor", () => {
    const first = applyV2StreamItem(run([snapshot(3)]), event(8, "checkpoint.captured", { id: "c1" }), THREAD);
    expect(first.changed).toBe(false);
    expect(first.state?.sequence).toBe(8);
  });

  test("a detached provider session leaves the projection", () => {
    const base = projection({
      providerSessions: [{ id: "ps-1", status: "ready", lastError: null }, { id: "ps-2", status: "ready", lastError: null }],
    });
    const next = applyV2Event(base, {
      type: "provider-session.detached", threadId: THREAD,
      payload: { providerSessionId: "ps-1", detachedAt: "2026-10-03T00:00:00.000Z" },
    });
    expect(next.providerSessions.map((session) => session.id)).toEqual(["ps-2"]);
  });

  test("a provider thread for this app thread becomes the active one", () => {
    const next = applyV2Event(projection(), {
      type: "provider-thread.updated", threadId: THREAD,
      payload: { id: "pt-1", appThreadId: THREAD, providerSessionId: "ps-1" },
    });
    expect(next.thread.activeProviderThreadId).toBe("pt-1");
    expect(next.providerThreads.map((entry) => entry.id)).toEqual(["pt-1"]);
  });

  test("thread events replace the thread record; runs upsert in place", () => {
    let next = applyV2Event(projection(), {
      type: "thread.runtime-mode-updated", threadId: THREAD,
      payload: { id: THREAD, runtimeMode: "approval-required" },
    });
    expect(next.thread.runtimeMode).toBe("approval-required");
    const runRecord = { id: "r1", ordinal: 1, userMessageId: `${SANDBOX_NAME_PREFIX}-message-a`, status: "running" };
    next = applyV2Event(next, { type: "run.created", threadId: THREAD, payload: runRecord });
    next = applyV2Event(next, { type: "run.updated", threadId: THREAD, payload: { ...runRecord, status: "completed" } });
    expect(next.runs).toEqual([{ ...runRecord, status: "completed" } as never]);
  });

  test("dropped frames are recovered by a resume replay without duplicating anything", () => {
    const frames = [
      event(11, "message.updated", message("m1", "a")),
      event(12, "turn-item.updated", { id: "i1", type: "command_execution", status: "running" }),
      event(13, "turn-item.updated", { id: "i1", type: "command_execution", status: "completed" }),
      event(14, "message.updated", message("m1", "ab")),
    ];
    const complete = run([snapshot(10), ...frames]);
    // The socket dropped after 11; the resume replays everything after the cursor, overlapping 11.
    const resumed = run([snapshot(10), frames[0]!, frames[0]!, ...frames.slice(0)]);
    expect(resumed).toEqual(complete);
  });
});
