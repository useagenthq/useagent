// Phase 1 slice-3b gate: a settled OpenCode run populates the canonical lane. Proves
// finalizeRun (the one terminal seam) translates the run's native frames + durable
// steps into canonical events and persists them ALONGSIDE the native lane - post-commit,
// best-effort, idempotent. DB-backed (skynet_test).

import { describe, expect, test, beforeAll } from "bun:test";
import { db } from "../src/db/client";
import { runs, providerEvents, steps } from "../src/db/schema";
import { finalizeRun } from "../src/runs/finalize";
import { loadCanonicalThread } from "../src/runs/canonical-events";
import { waitFor } from "./helpers"; // side-effect: imports src/index -> migrate

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
  test("a settled OpenCode run gets canonical events (post-commit, alongside native)", async () => {
    await finalizeRun(RUN, "completed", "done", 100);
    let canon = await loadRunCanonical();
    for (let i = 0; i < 20 && canon.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      canon = await loadRunCanonical();
    }
    const kinds = new Set(canon.map((e) => e.kind));
    expect(canon.length).toBeGreaterThan(0);
    expect(kinds.has("message.started")).toBe(true); // the anchor
    expect(kinds.has("message.delta")).toBe(true); // assistant text
    expect(kinds.has("tool.completed")).toBe(true); // the step tool row
    // immutable thread cursor present + monotonic
    expect(canon.every((e) => typeof e.deliverySeq === "number")).toBe(true);
  });

  test("idempotent: re-finalizing does NOT append duplicate canonical rows", async () => {
    const before = (await loadRunCanonical()).length;
    await finalizeRun(RUN, "completed", "done", 100);
    await new Promise((r) => setTimeout(r, 400));
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
    let canon = (await loadCanonicalThread(CRUN, 0)).filter((e) => e.runId === CRUN);
    for (let i = 0; i < 20 && canon.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      canon = (await loadCanonicalThread(CRUN, 0)).filter((e) => e.runId === CRUN);
    }
    const tools = canon.filter((e) => e.kind === "tool.completed");
    // the command + the task step map to tool.completed (2); the done step does not.
    expect(tools.length).toBe(2);
    // the bash tool row is keyed to its step id (the reducer's node key + lookup handle).
    expect(tools.some((e) => e.identity.nativeEventId === `${CRUN}-s0`)).toBe(true);
    expect(canon.some((e) => e.kind === "done" || e.identity.nativeEventId === `${CRUN}-s2`)).toBe(false);
  });
});
