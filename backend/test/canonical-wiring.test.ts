// Phase 1 slice-3b gate: a settled OpenCode run populates the canonical lane. Proves
// finalizeRun (the one terminal seam) translates the run's native frames + durable
// steps into canonical events and persists them ALONGSIDE the native lane - post-commit,
// best-effort, idempotent. DB-backed (skynet_test).

import { describe, expect, test, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs, providerEvents, steps } from "../src/db/schema";
import { finalizeRun } from "../src/runs/finalize";
import { loadCanonicalThread } from "../src/runs/canonical-events";
import { runCanonicalizationOutboxOnce } from "../src/runs/canonicalization-outbox";
import { waitFor } from "./helpers"; // side-effect: imports src/index -> migrate

/** Drain the canonicalization outbox to completion for a specific run, deterministically
 *  (the background boot loop also ticks, so we poll for the `complete` record). Returns
 *  the outbox row so callers can assert the explicit completion watermark. */
async function drainCanonicalization(runId: string) {
  for (let i = 0; i < 30; i++) {
    await runCanonicalizationOutboxOnce();
    const [row] = (await db.execute(
      sql`select state, source_frame_max, source_step_count from canonicalization_outbox where run_id = ${runId}`,
    )) as unknown as Array<{ state: string; source_frame_max: number | null; source_step_count: number | null }>;
    if (row?.state === "complete" || row?.state === "dead") return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

const RUN = `cw_${crypto.randomUUID()}`;
const THREAD = RUN;

beforeAll(async () => {
  await waitFor(() => true, 1);
  await db.insert(runs).values({
    id: RUN, prompt: "wire", model: "claude-haiku-4-5", engine: "opencode", status: "running", threadId: THREAD,
  }).onConflictDoNothing();
  // Native frames: step-start (anchor), text, tool, step-finish.
  await db.insert(providerEvents).values([
    { id: `${RUN}-f0`, runId: RUN, threadId: THREAD, seq: 0, provider: "opencode", eventType: "part.step-start", nativeMessageId: "m1", nativePartId: "ps1", payload: "{}" },
    { id: `${RUN}-f1`, runId: RUN, threadId: THREAD, seq: 1, provider: "opencode", eventType: "part.text", nativeMessageId: "m1", nativePartId: "pt1", payload: JSON.stringify({ text: "hello" }) },
    { id: `${RUN}-f2`, runId: RUN, threadId: THREAD, seq: 2, provider: "opencode", eventType: "part.tool.completed", nativeMessageId: "m1", nativePartId: "pc1", nativeCallId: "c1", payload: JSON.stringify({ type: "tool", tool: "bash" }) },
    { id: `${RUN}-f3`, runId: RUN, threadId: THREAD, seq: 3, provider: "opencode", eventType: "part.step-finish", nativeMessageId: "m1", nativePartId: "pf1", payload: "{}" },
  ]).onConflictDoNothing();
  // Durable step (the tool row).
  await db.insert(steps).values({
    id: `${RUN}-s0`, runId: RUN, idx: 0, kind: "command", label: "bash",
    codeJson: JSON.stringify({ tool: "bash", type: "tool", native: { sessionID: "ses_root", messageID: "m1", partID: "pc1", callID: "c1" } }),
  }).onConflictDoNothing();
});

async function loadRunCanonical() {
  const all = await loadCanonicalThread(THREAD, 0);
  return all.filter((e) => e.runId === RUN);
}

describe("canonical wiring: finalizeRun populates the canonical lane (skynet_test)", () => {
  test("a settled OpenCode run gets canonical events (via the durable outbox)", async () => {
    await finalizeRun(RUN, "completed", "done", 100);
    // Translation is now durable+async via the outbox — drain it to the explicit
    // `complete` record (source-watermark stability locked in), then read.
    const outbox = await drainCanonicalization(RUN);
    expect(outbox?.state).toBe("complete");
    // the completion record carries the exact source watermark it translated (4 frames -> max seq 3, 1 step)
    expect(Number(outbox?.source_frame_max)).toBe(3);
    expect(Number(outbox?.source_step_count)).toBe(1);
    const canon = await loadRunCanonical();
    const kinds = new Set(canon.map((e) => e.kind));
    expect(canon.length).toBeGreaterThan(0);
    expect(kinds.has("message.started")).toBe(true); // the anchor
    expect(kinds.has("message.delta")).toBe(true); // assistant text
    expect(kinds.has("tool.completed")).toBe(true); // the step tool row
    // immutable thread cursor present + monotonic
    expect(canon.every((e) => typeof e.deliverySeq === "number")).toBe(true);
  });

  test("idempotent: re-finalizing a COMPLETE run does NOT re-arm or duplicate", async () => {
    const before = (await loadRunCanonical()).length;
    // enqueueCanonicalization preserves a `complete` row (never regresses to pending),
    // so the worker never reprocesses it — no duplicate rows.
    await finalizeRun(RUN, "completed", "done", 100);
    await runCanonicalizationOutboxOnce();
    await new Promise((r) => setTimeout(r, 200));
    const [row] = (await db.execute(
      sql`select state from canonicalization_outbox where run_id = ${RUN}`,
    )) as unknown as Array<{ state: string }>;
    expect(row?.state).toBe("complete"); // stayed complete, was not re-armed
    const after = (await loadRunCanonical()).length;
    expect(after).toBe(before);
  });
});

// Claude ACP runs project their tool_call activity into `steps` (kind command/file,
// code_json { tool, title, input }) and emit almost NO native frames - that is exactly
// why the native-only buildTimeline left them blank on reload. finalizeRun now
// translates them too, so a claude tool step becomes a canonical tool row.
describe("canonical wiring: a settled Claude ACP run also populates canonical", () => {
  const CRUN = `cwc_${crypto.randomUUID()}`;
  beforeAll(async () => {
    await db.insert(runs).values({
      id: CRUN, prompt: "claude", model: "claude-haiku-4-5", engine: "claude", status: "running", threadId: CRUN,
    }).onConflictDoNothing();
    await db.insert(steps).values([
      // a real tool_call (execute/bash) - should become a canonical tool row
      { id: `${CRUN}-s0`, runId: CRUN, idx: 0, kind: "command", label: "ls -la", chip: "bash",
        codeJson: JSON.stringify({ tool: "execute", title: "Bash", input: { command: "ls -la" }, output: "..." }) },
      // a narration task step + the terminal done
      { id: `${CRUN}-s1`, runId: CRUN, idx: 1, kind: "task", label: "Thinking...", chip: "claude", codeJson: JSON.stringify({ tool: "task", title: "Thinking" }) },
      { id: `${CRUN}-s2`, runId: CRUN, idx: 2, kind: "done", label: "Done", codeJson: null },
    ]).onConflictDoNothing();
  });

  test("claude tool step -> canonical tool.completed (done step excluded)", async () => {
    await finalizeRun(CRUN, "completed", "listed", 100);
    const outbox = await drainCanonicalization(CRUN);
    expect(outbox?.state).toBe("complete");
    const canon = (await loadCanonicalThread(CRUN, 0)).filter((e) => e.runId === CRUN);
    const tools = canon.filter((e) => e.kind === "tool.completed");
    // the command + the task step map to tool.completed (2); the done step does not.
    expect(tools.length).toBe(2);
    // the bash tool row is keyed to its step id (the reducer's node key + lookup handle).
    expect(tools.some((e) => e.identity.nativeEventId === `${CRUN}-s0`)).toBe(true);
    expect(canon.some((e) => e.kind === "done" || e.identity.nativeEventId === `${CRUN}-s2`)).toBe(false);
  });
});
