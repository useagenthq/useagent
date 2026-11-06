import { describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
// Booting the app applies the migrations the stored-frame test reads through.
import "./helpers";
import { db } from "../src/db/client";
import { providerEvents, runs } from "../src/db/schema";
import { makeNativeFrame } from "../src/runs/native-events";
import { drainProviderEvents } from "../src/runs/provider-events";
import { createSecretRedactor } from "../src/secrets/redact";
import { translateOpenCode } from "../src/engines/opencode-canonical";
import {
  runtimeActivityProviderEvent,
  type RuntimeActivity,
  type RuntimeThreadSnapshot,
} from "../src/engines/runtime-orchestration";
import { activityRevisions, createTurnProjector } from "../src/engines/turn-projector";
import type { EngineRunContext } from "../src/engines/types";
import { SANDBOX_NAME_PREFIX } from "../src/sandboxes/sandbox-names";

// A recorded Codex app-server transcript: the three thread/tokenUsage/updated
// notifications the root thread received during one turn (codex-cli 0.145.0,
// gpt-5.6-luna), taken verbatim from the runtime's own recording at its pinned
// source commit 90dc3ebbb74b (apps/server/src/provider/testFixtures/
// codexMultiAgentWire.json). Codex reports `total` for the whole thread and
// `last` for the newest model response.
const recorded = [
  {
    total: { totalTokens: 18261, inputTokens: 18228, cachedInputTokens: 11008, cacheWriteInputTokens: 0, outputTokens: 33, reasoningOutputTokens: 0 },
    last: { totalTokens: 18261, inputTokens: 18228, cachedInputTokens: 11008, cacheWriteInputTokens: 0, outputTokens: 33, reasoningOutputTokens: 0 },
    modelContextWindow: 258400,
  },
  {
    total: { totalTokens: 36576, inputTokens: 36510, cachedInputTokens: 28160, cacheWriteInputTokens: 0, outputTokens: 66, reasoningOutputTokens: 0 },
    last: { totalTokens: 18315, inputTokens: 18282, cachedInputTokens: 17152, cacheWriteInputTokens: 0, outputTokens: 33, reasoningOutputTokens: 0 },
    modelContextWindow: 258400,
  },
  {
    total: { totalTokens: 54933, inputTokens: 54846, cachedInputTokens: 45312, cacheWriteInputTokens: 0, outputTokens: 87, reasoningOutputTokens: 0 },
    last: { totalTokens: 18357, inputTokens: 18336, cachedInputTokens: 17152, cacheWriteInputTokens: 0, outputTokens: 21, reasoningOutputTokens: 0 },
    modelContextWindow: 258400,
  },
] as const;

const TURN_ID = "019fcfd6-1806-7de1-8564-de69fd55bffb";
const redact = createSecretRedactor([]);

/** The `context-window.updated` activity the runtime projects from one
 *  notification (its normalizeCodexTokenUsage at the pinned commit): the newest
 *  response's total is the context in use, the breakdown is that response's,
 *  `maxTokens` is the model's window. */
function contextWindowActivity(index: number, sequence = index + 1): RuntimeActivity {
  const usage = recorded[index]!;
  return {
    id: `evt-usage-${index + 1}`,
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: {
      usedTokens: usage.last.totalTokens,
      ...(usage.total.totalTokens > usage.last.totalTokens
        ? { totalProcessedTokens: usage.total.totalTokens }
        : {}),
      maxTokens: usage.modelContextWindow,
      inputTokens: usage.last.inputTokens,
      cachedInputTokens: usage.last.cachedInputTokens,
      outputTokens: usage.last.outputTokens,
      reasoningOutputTokens: usage.last.reasoningOutputTokens,
      lastUsedTokens: usage.last.totalTokens,
      lastInputTokens: usage.last.inputTokens,
      lastCachedInputTokens: usage.last.cachedInputTokens,
      lastOutputTokens: usage.last.outputTokens,
      lastReasoningOutputTokens: usage.last.reasoningOutputTokens,
      compactsAutomatically: true,
    },
    turnId: TURN_ID,
    sequence,
  };
}

function snapshot(activities: readonly RuntimeActivity[], sequence: number): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      latestTurn: { turnId: TURN_ID, state: "running", assistantMessageId: null },
      messages: [],
      activities,
      session: null,
    },
  };
}

describe("runtime usage frames", () => {
  test("the runtime's context-window activity becomes the usage frame the composer reads", () => {
    const event = runtimeActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      contextWindowActivity(2),
      redact,
    );
    // The payload below is the frame frontend/components/chat/native-events.test.ts
    // feeds deriveThreadContext: used 18357 of 258400, 17152 of it cache reads.
    expect(event).toEqual({
      id: "pe_run-1_t3_evt-usage-3",
      runId: "run-1",
      threadId: "thread-1",
      provider: "t3",
      eventType: "part.step-finish",
      nativeSessionId: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      nativeParentSessionId: null,
      nativeMessageId: null,
      nativePartId: "evt-usage-3",
      nativeCallId: null,
      payload: {
        tokens: { input: 18336, output: 21, reasoning: 0, cache: { read: 17152 }, total: 18357 },
        contextWindow: 258400,
        activity: contextWindowActivity(2),
      },
    });
  });

  test("a snapshot without a usable count and every other activity keep the runtime grammar", () => {
    const empty = contextWindowActivity(0);
    expect(runtimeActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      { ...empty, payload: { ...(empty.payload as Record<string, unknown>), usedTokens: 0 } },
      redact,
    )).toMatchObject({ id: "pe_run-1_t3_evt-usage-1", eventType: "t3.activity.context-window.updated" });
    expect(runtimeActivityProviderEvent(
      { runId: "run-1", threadId: "thread-1" },
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      { ...empty, id: "evt-tool", kind: "tool.completed", summary: "Ran ls", payload: { toolCallId: "call-1", data: { toolName: "shell" } } },
      redact,
    )).toMatchObject({ id: "pe_run-1_t3_evt-tool", eventType: "t3.activity.tool.completed", nativeCallId: "call-1" });
  });

  test("the real projector stores one frame per model call, revises it in place and never repeats it on replay", async () => {
    const runId = `run-usage-${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId,
      orgId: `org-${runId}`,
      userId: "user-1",
      prompt: "count tokens",
      model: "gpt-5.6-luna",
      engine: "codex",
      status: "running",
      threadId: runId,
    });
    const ctx = { runId, threadId: runId, emit: async () => "step-1" } as unknown as EngineRunContext;
    const stored = async () => {
      await drainProviderEvents(runId);
      return db
        .select()
        .from(providerEvents)
        .where(and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, "part.step-finish")))
        .orderBy(asc(providerEvents.seq));
    };
    const totals = (rows: Awaited<ReturnType<typeof stored>>) =>
      rows.map((row) => (JSON.parse(row.payload!) as { tokens: { total: number } }).tokens.total);

    const projector = createTurnProjector({ ctx, redact, engine: "codex", seen: new Map() });
    const first = contextWindowActivity(0);
    await projector.apply(snapshot([first], 1));
    expect(totals(await stored())).toEqual([18261]);

    // The same activity read again (a reconnect, or the continuation re-reading
    // the thread) and a recovery projector seeded with what the thread already
    // holds add nothing.
    await projector.apply(snapshot([first], 2));
    const recovered = createTurnProjector({ ctx, redact, engine: "codex", seen: projector.seen() });
    await recovered.apply(snapshot([first], 3));
    expect(await stored()).toHaveLength(1);

    // A revision under the runtime's own activity id replaces the row.
    const revised = { ...first, sequence: 2, payload: { ...(first.payload as Record<string, unknown>), usedTokens: 18270 } };
    await projector.apply(snapshot([revised], 4));
    const afterRevision = await stored();
    expect(afterRevision).toHaveLength(1);
    expect(afterRevision[0]!.id).toBe(`pe_${runId}_t3_evt-usage-1`);
    expect(totals(afterRevision)).toEqual([18270]);

    // Every later model call is its own frame; together they are exactly the
    // thread total Codex reported, so a ledger summing them counts each call once.
    // The first frame comes back at a newer revision with what the runtime
    // finally reported: an older revision in a later snapshot would be a stale
    // view of the activity and is left alone.
    await projector.apply(snapshot([contextWindowActivity(0, 3), contextWindowActivity(1), contextWindowActivity(2)], 5));
    const rows = await stored();
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3].map((n) => `pe_${runId}_t3_evt-usage-${n}`));
    expect(totals(rows)).toEqual([18261, 18315, 18357]);
    expect(totals(rows).reduce((sum, total) => sum + total, 0)).toBe(recorded[2].total.totalTokens);
    expect(rows.map((row) => row.seq)).toEqual([...rows.map((row) => row.seq)].sort((a, b) => a - b));
    expect(new Set(rows.map((row) => row.seq)).size).toBe(3);
    for (const row of rows) {
      expect(row.nativeMessageId).toBeNull();
      expect(row.nativeParentSessionId).toBeNull();
      expect(JSON.parse(row.payload!)).toMatchObject({ contextWindow: 258400 });
    }

    // The canonical lane treats a usage frame without a message as the
    // diagnostic it is: no fabricated message boundary, every frame accounted for.
    const frames = rows.map((row) => makeNativeFrame({
      eventId: row.id,
      seq: row.seq,
      provider: row.provider,
      eventType: row.eventType,
      sessionId: row.nativeSessionId,
      parentSessionId: row.nativeParentSessionId,
      messageId: row.nativeMessageId,
      partId: row.nativePartId,
      callId: row.nativeCallId,
      payloadText: row.payload,
    }));
    const canonical = translateOpenCode(frames, { runId, threadId: runId });
    expect(canonical.events.filter((event) => event.kind === "message.completed")).toHaveLength(0);
    expect(canonical.accounting).toHaveLength(3);
    expect(canonical.accounting.every((entry) => typeof entry.suppressed === "string")).toBe(true);
  });
  test("a resumed session's re-report of the last turn's usage is not a model call of the new run", async () => {
    const runId = `run-resume-usage-${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId, orgId: `org-${runId}`, userId: "user-1", prompt: "okay", model: "gpt-5.6-luna",
      engine: "codex", status: "running", threadId: runId,
    });
    const ctx = { runId, threadId: runId, emit: async () => "step-1" } as unknown as EngineRunContext;
    // The previous turn's last frame, then what Codex sends on thread/resume: the
    // same figures under a new runtime activity id and no turn.
    const previous = contextWindowActivity(0);
    const replay = { ...previous, id: "evt-resume-usage", turnId: null, sequence: 7 };
    const call = contextWindowActivity(1, 8);
    const projector = createTurnProjector({
      ctx, redact, engine: "codex", seen: activityRevisions(snapshot([previous], 1)),
    });

    await projector.apply(snapshot([previous, replay], 2));
    await projector.apply(snapshot([previous, replay, call], 3));

    await drainProviderEvents(runId);
    const rows = await db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, "part.step-finish")));
    expect(rows.map((row) => row.id)).toEqual([`pe_${runId}_t3_evt-usage-2`]);
  });
});
