// Settled-run subagent visibility gate: a run whose child session was registered
// ONLY through the durable lifecycle row (the REST children reconciliation lane —
// exactly what a Daytona-buffered SSE stream leaves behind) still canonicalizes
// with a child.started for the child session AND a child.completed that carries
// the child's REAL identity, result, and cumulative usage summed from its
// part.step-finish frames. DB-backed (useAgent_test), through the REAL
// finalize -> canonicalization outbox -> sealed rows path.

import { describe, expect, test, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs, providerEvents } from "../src/db/schema";
import { finalizeRun } from "../src/runs/finalize";
import { loadCanonicalThread } from "../src/runs/canonical-events";
import { runCanonicalizationOutboxOnce } from "../src/runs/canonicalization-outbox";
import { waitFor } from "./helpers"; // side-effect: imports src/index -> migrate

async function drainCanonicalization(runId: string) {
  for (let i = 0; i < 30; i++) {
    await runCanonicalizationOutboxOnce();
    const [row] = (await db.execute(
      sql`select state from canonicalization_outbox where run_id = ${runId}`,
    )) as unknown as Array<{ state: string }>;
    if (row?.state === "complete" || row?.state === "dead") return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

const RUN = `su_${crypto.randomUUID()}`;
const THREAD = RUN;
// Real child session ids are globally unique (ses_*); keep the fixture's unique
// per execution too - provider_events.id is the PRIMARY KEY and the lifecycle
// row id is derived from the session id, so a reused session id would collide
// with a previous execution's row in the persistent useAgent_test database.
const PARENT = `ses_parent_${RUN.slice(3, 11)}`;
const CHILD = `ses_child_${RUN.slice(3, 11)}`;

const TASK_OUTPUT = `<task id="${CHILD}" state="completed">\n<task_result>\nPLTR closed at $162.66.\n</task_result>\n</task>`;

beforeAll(async () => {
  await waitFor(() => true, 1);
  await db.insert(runs).values({
    id: RUN, prompt: "subagent usage", model: "claude-haiku-4-5", engine: "opencode", status: "running", threadId: THREAD,
  }).onConflictDoNothing();
  await db.insert(providerEvents).values([
    // The child's durable lifecycle row EXACTLY as registerChildSession persists it
    // from the REST children reconciliation (no SSE frame ever arrived).
    {
      id: `pe_${CHILD}_lifecycle`, runId: RUN, threadId: THREAD, seq: 0, provider: "opencode",
      eventType: "session.updated", nativeSessionId: CHILD, nativeParentSessionId: PARENT,
      payload: JSON.stringify({ id: CHILD, parentID: PARENT, title: "Check PLTR (@general subagent)" }),
    },
    // Parent message anchor.
    {
      id: `${RUN}-f1`, runId: RUN, threadId: THREAD, seq: 1, provider: "opencode",
      eventType: "part.step-start", nativeSessionId: PARENT, nativeMessageId: "m1", nativePartId: "ps1",
      payload: "{}",
    },
    // The child's own step-finish frames carry the REAL token/cost counters.
    {
      id: `${RUN}-cf1`, runId: RUN, threadId: THREAD, seq: 2, provider: "opencode",
      eventType: "part.step-finish", nativeSessionId: CHILD, nativeMessageId: "cm1", nativePartId: "cp1",
      payload: JSON.stringify({ type: "step-finish", cost: 0.01, tokens: { input: 100, output: 40, reasoning: 5, cache: { read: 30, write: 0 } } }),
    },
    {
      id: `${RUN}-cf2`, runId: RUN, threadId: THREAD, seq: 3, provider: "opencode",
      eventType: "part.step-finish", nativeSessionId: CHILD, nativeMessageId: "cm2", nativePartId: "cp2",
      payload: JSON.stringify({ type: "step-finish", cost: 0.02, tokens: { input: 200, output: 60, reasoning: 10, cache: { read: 70, write: 0 } } }),
    },
    // The parent's task ToolPart completion names the child (metadata.sessionId +
    // <task id> output) and carries the result.
    {
      id: `${RUN}-f4`, runId: RUN, threadId: THREAD, seq: 4, provider: "opencode",
      eventType: "part.tool.completed", nativeSessionId: PARENT, nativeMessageId: "m1", nativePartId: "pt1", nativeCallId: "call_task_1",
      payload: JSON.stringify({
        type: "tool", tool: "task",
        state: {
          status: "completed",
          title: "Check PLTR",
          input: { description: "Check PLTR", subagent_type: "general" },
          output: TASK_OUTPUT,
          metadata: { sessionId: CHILD, parentSessionId: PARENT, model: { modelID: "haiku", providerID: "anthropic" } },
        },
      }),
    },
  ]).onConflictDoNothing();
});

describe("settled-run subagent usage (skynet_test)", () => {
  test("finalize canonicalizes child.started + child.completed with summed usage from step-finish frames", async () => {
    await finalizeRun(RUN, "completed", "done", 100);
    const outbox = await drainCanonicalization(RUN);
    expect(outbox?.state).toBe("complete");

    const canon = (await loadCanonicalThread(THREAD, 0)).filter((e) => e.runId === RUN) as Array<
      Record<string, unknown> & { kind: string }
    >;

    // The durable lifecycle row alone (no SSE session frame) establishes the child.
    const started = canon.filter(
      (e) => e.kind === "child.started" && (e.childId === CHILD || e.launchToolCallId === "call_task_1"),
    );
    expect(started.length).toBeGreaterThan(0);

    const completed = canon.find((e) => e.kind === "child.completed" && e.childId === CHILD) as
      | (Record<string, unknown> & { result?: string; state?: { usage?: Record<string, number> } })
      | undefined;
    expect(completed).toBeDefined();
    expect(completed?.result).toBe("PLTR closed at $162.66.");
    // Cumulative usage summed across the child's step-finish frames.
    expect(completed?.state?.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 100,
      reasoningOutputTokens: 15,
      cachedInputTokens: 100,
    });
    expect(completed?.state?.usage?.costUsd).toBeCloseTo(0.03, 10);
  });
});
