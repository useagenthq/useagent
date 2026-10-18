// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
// Booting the app applies the migrations the projector writes through.
import "./helpers";
import { db } from "../src/db/client";
import { providerEvents, runs } from "../src/db/schema";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "../src/engines/opencode-canonical";
import { waitForRuntimeTurn } from "../src/engines/runtime-adapter";
import { followRuntimeThread } from "../src/engines/runtime-event-stream";
import { activityRevisions } from "../src/engines/turn-projector";
import { runtimeThreadId, runtimeUserMessageId } from "../src/engines/runtime-orchestration";
import type { RuntimeSocket } from "../src/engines/runtime-rpc-socket";
import { runtimeThreadView } from "../src/engines/runtime-v2-view";
import type { V2Projection, V2ThreadSnapshot } from "../src/engines/runtime-v2-wire";
import type { EmitStep, EngineRunContext } from "../src/engines/types";
import { getNativeFramesSince } from "../src/runs/native-events";
import { drainProviderEvents } from "../src/runs/provider-events";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { createSecretRedactor } from "../src/secrets/redact";
import { SANDBOX_NAME_PREFIX } from "../src/sandboxes/sandbox-names";

// One Codex turn in the event shapes of the runtime's orchestration protocol 2
// (packages/contracts/src/orchestrationV2.ts): the user message, the run, a
// command running then done, the context in use, a plan revised under its own
// id, the answer streaming then final, and the run completing. Sequences are
// global across the runtime, so the thread's own are sparse.
type Fields = Record<string, unknown>;
interface StreamEvent {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Fields;
}

const at = (second: number) => `2026-10-02T10:00:${String(second).padStart(2, "0")}.000Z`;
const ARRAYS: Readonly<Record<string, keyof V2Projection>> = {
  "run.created": "runs", "run.updated": "runs", "message.updated": "messages", "turn-item.updated": "turnItems",
  "provider-thread.updated": "providerThreads", "provider-session.updated": "providerSessions",
};

function codexTurn(threadId: string, userMessageId: string) {
  const item = (id: string, type: string, status: string, second: number, ordinal: number, extra: Fields = {}) => ({
    id, threadId, runId: "run-1", type, status, title: null, ordinal, updatedAt: at(second), startedAt: at(14), completedAt: null, ...extra,
  });
  const run = (status: string, second: number) => ({
    id: "run-1", threadId, ordinal: 2, userMessageId, status, providerThreadId: "pt-1",
    requestedAt: at(11), startedAt: at(13), completedAt: status === "completed" ? at(second) : null,
  });
  const answer = (text: string, streaming: boolean, second: number) => ({
    id: "msg-1", threadId, runId: "run-1", role: "assistant", text, streaming, createdAt: at(20), updatedAt: at(second), attachments: [],
  });
  const base: V2ThreadSnapshot = {
    snapshotSequence: 10,
    projection: {
      thread: { id: threadId, runtimeMode: "full-access", activeProviderThreadId: "pt-1" },
      runs: [{ id: "run-prior", threadId, ordinal: 1, userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-prior`, status: "completed", providerThreadId: "pt-1", requestedAt: at(1), startedAt: at(1), completedAt: at(3) }],
      messages: [
        { id: `${SANDBOX_NAME_PREFIX}-message-run-prior`, threadId, runId: "run-prior", role: "user", text: "hello", streaming: false, createdAt: at(1), updatedAt: at(1), attachments: [] },
        { id: "msg-prior", threadId, runId: "run-prior", role: "assistant", text: "Hi there.", streaming: false, createdAt: at(2), updatedAt: at(2), attachments: [] },
      ],
      turnItems: [{ ...item("i-prior", "command_execution", "completed", 2, 0, { input: "pwd" }), runId: "run-prior" }],
      providerSessions: [{ id: "ps-1", status: "ready", lastError: null }],
      providerThreads: [{ id: "pt-1", providerSessionId: "ps-1", appThreadId: threadId }],
      runtimeRequests: [],
      subagents: [],
    },
  };
  const events: StreamEvent[] = [
    { sequence: 11, type: "message.updated", payload: { id: userMessageId, threadId, runId: "run-1", role: "user", text: "List the files", streaming: false, createdAt: at(11), updatedAt: at(11), attachments: [] } },
    { sequence: 13, type: "run.created", payload: run("running", 13) },
    { sequence: 14, type: "provider-session.updated", payload: { id: "ps-1", status: "running", lastError: null } },
    { sequence: 19, type: "turn-item.updated", payload: item("i-cmd", "command_execution", "running", 19, 1, { input: "ls" }) },
    { sequence: 23, type: "turn-item.updated", payload: item("i-cmd", "command_execution", "completed", 23, 1, { input: "ls", exitCode: 0 }) },
    { sequence: 31, type: "provider-thread.updated", payload: { id: "pt-1", providerSessionId: "ps-1", appThreadId: threadId, contextUsage: { usedTokens: 18315, maxTokens: 258400, inputTokens: 18282, cachedInputTokens: 17152, outputTokens: 33 } } },
    { sequence: 32, type: "turn-item.updated", payload: item("i-plan", "todo_list", "running", 32, 2, { steps: [{ id: "1", text: "List the files", status: "running" }] }) },
    { sequence: 40, type: "message.updated", payload: answer("There are three files: ", true, 40) },
    { sequence: 41, type: "turn-item.updated", payload: item("i-plan", "todo_list", "completed", 41, 2, { steps: [{ id: "1", text: "List the files", status: "completed" }] }) },
    { sequence: 47, type: "message.updated", payload: answer("There are three files: a.ts, b.ts and c.ts.", true, 47) },
    { sequence: 48, type: "message.updated", payload: answer("There are three files: a.ts, b.ts and c.ts.", false, 48) },
    { sequence: 52, type: "provider-session.updated", payload: { id: "ps-1", status: "ready", lastError: null } },
    { sequence: 53, type: "run.updated", payload: run("completed", 53) },
  ];
  return { base, events };
}

/** A reference reducer, independent of the plane's mirror: the thread after `through`. */
function referenceSnapshot(base: V2ThreadSnapshot, events: readonly StreamEvent[], through: number): V2ThreadSnapshot {
  const projection: Record<string, unknown> = structuredClone(base.projection);
  for (const event of events) {
    if (event.sequence > through) break;
    const key = ARRAYS[event.type]!;
    const list = projection[key] as Fields[];
    const index = list.findIndex((entry) => entry.id === event.payload.id);
    projection[key] = index === -1 ? [...list, event.payload] : list.with(index, event.payload);
  }
  return { snapshotSequence: through, projection: projection as unknown as V2Projection };
}

/** A socket that subscribes the follower and delivers the turn as `mode` says. */
function scriptedOpen(base: V2ThreadSnapshot, events: readonly StreamEvent[], mode: "full-snapshots" | "incremental", threadId: string) {
  return (async ({ signal }: { signal: AbortSignal }) => {
    const socket: RuntimeSocket = {
      async stream(_tag, _payload, onValues) {
        if (!(await onValues([{ kind: "snapshot", ...base }, { kind: "synchronized" }]))) return;
        for (const event of events) {
          if (signal.aborted) return;
          const value = mode === "incremental"
            ? { kind: "event", sequence: event.sequence, event: { type: event.type, threadId, payload: event.payload } }
            : { kind: "snapshot", ...referenceSnapshot(base, events, event.sequence) };
          if (!(await onValues([value]))) return;
          await Bun.sleep(1);
        }
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
      async call() { return { sequence: 99 }; },
      close() {},
    };
    return socket;
  }) as unknown as NonNullable<Parameters<typeof followRuntimeThread>[0]["open"]>;
}

async function replay(mode: "full-snapshots" | "incremental", threadId: string) {
  const runId = `run-replay-${mode}-${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id: runId, orgId: `org-${runId}`, userId: "user-1", prompt: "List the files", model: "gpt-5.6-luna",
    engine: "codex", status: "running", threadId,
  });
  const runtimeThread = runtimeThreadId({ runId, threadId });
  const { base, events } = codexTurn(runtimeThread, runtimeUserMessageId(runId));
  const prior = runtimeThreadView(base);
  const steps: OpenCodeStep[] = [];
  const deltas: string[] = [];
  let reads = 0;
  const ctx = {
    runId,
    threadId,
    signal: new AbortController().signal,
    emit: async (step: EmitStep) => {
      const id = `step-${steps.length + 1}`;
      steps.push({ id, idx: steps.length, kind: step.kind, label: step.label, chip: step.chip ?? null, code_json: JSON.stringify(step.code_json ?? null) });
      return id;
    },
    updateStep: async (id: string, codeJson: unknown) => {
      steps.find((step) => step.id === id)!.code_json = JSON.stringify(codeJson);
    },
    publishDelta: (delta: string) => deltas.push(delta),
    setSummary() {},
    timing: { begin: () => () => {}, mark() {}, add() {} },
  } as unknown as EngineRunContext;

  const summary = await waitForRuntimeTurn(ctx, { id: "sandbox-replay" } as SandboxHandle, activityRevisions(prior), prior, createSecretRedactor([]), {
    watchLiveness: () => ({ signal: new AbortController().signal, heard() {}, dispose() {} }),
    readThreadSnapshot: async () => {
      reads += 1;
      throw new Error("a followed turn reads nothing over HTTP");
    },
    followRuntimeThread: (input) => followRuntimeThread({ ...input, open: scriptedOpen(base, events, mode, runtimeThread) }),
    guardForeignRuns: () => async () => [],
  }, "codex");

  await drainProviderEvents(runId);
  const rows = await db.select().from(providerEvents).where(eq(providerEvents.runId, runId)).orderBy(asc(providerEvents.seq));
  const frames = await getNativeFramesSince(runId, -1);
  const canonical = translateOpenCode(frames as unknown as OpenCodeFrame[], { runId, threadId, engine: "codex" }, steps);
  const normalized = (value: unknown) => JSON.stringify(value).replaceAll(runId, "RUN");
  return {
    reads,
    summary,
    deltas,
    steps: normalized(steps),
    rows: normalized(rows.map(({ createdAt: _createdAt, runId: _runId, ...row }) => row)),
    eventTypes: rows.map((row) => row.eventType),
    canonical: normalized(canonical.events),
    canonicalKinds: canonical.events.map((event) => event.kind),
  };
}

describe("runtime turn replay", () => {
  test("applying stream events records exactly what a full snapshot after every event records", async () => {
    const threadId = `thread-replay-${crypto.randomUUID()}`;
    const full = await replay("full-snapshots", threadId);
    const incremental = await replay("incremental", threadId);

    expect(full.summary).toBe("There are three files: a.ts, b.ts and c.ts.");
    expect(incremental.summary).toBe(full.summary);
    expect(incremental.deltas).toEqual(full.deltas);
    expect(full.deltas).toEqual(["There are three files: ", "a.ts, b.ts and c.ts."]);
    expect(incremental.steps).toBe(full.steps);
    expect(incremental.rows).toBe(full.rows);
    expect(incremental.canonical).toBe(full.canonical);
    // The ledger keeps the vocabulary every reader of a runtime turn already knows.
    expect(full.eventTypes).toEqual(expect.arrayContaining([
      "t3.activity.tool.updated", "t3.activity.tool.completed", "t3.activity.turn.plan.updated",
      "part.step-finish", "t3.message.started", "t3.message.updated",
    ]));
    expect(full.canonicalKinds).toEqual(expect.arrayContaining(["tool.started", "tool.completed", "plan.updated", "message.delta"]));
    // A followed turn never reads the thread over HTTP.
    expect(full.reads).toBe(0);
    expect(incremental.reads).toBe(0);
  });
});
