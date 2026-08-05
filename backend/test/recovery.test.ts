import { describe, expect, test } from "bun:test";
import {
  createRun,
  getRun,
  insertStep,
  setRunEngineSession,
  setRunSandbox,
  setRunStatus,
  STALE_SUMMARY,
} from "../src/runs/repo";
import { recoverStaleRuns, type ReconcileFn } from "../src/runs/recovery";
import { reconcileOpencodeRun } from "../src/engines/opencode-server";
import type { EngineId } from "../src/db/schema";

// Boot restart-recovery orchestration, driven with a DETERMINISTIC fake probe so
// the reconcile/fail decision is exercised without touching Daytona. The real
// native-session probe (reconcileOpencodeRun) is proven end-to-end on :3503.

async function seedStaleRun(opts: {
  engine: EngineId;
  status: "queued" | "running";
  session?: string;
  sandbox?: string;
  withStep?: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({
    id,
    prompt: "interrupted turn",
    model: "claude-opus-5",
    engine: opts.engine,
    orgId: "org-skynet-dev",
    userId: null,
    parentRunId: null,
    threadId: id,
  });
  if (opts.status === "running") await setRunStatus(id, "running");
  if (opts.session) await setRunEngineSession(id, opts.session);
  if (opts.sandbox) await setRunSandbox(id, opts.sandbox);
  if (opts.withStep) {
    await insertStep({ runId: id, idx: 0, kind: "task", label: "Thinking…", chip: "opencode", code: null });
  }
  return id;
}

// Fake native probe: a "done" session reports a completed answer, a "running"
// one is still generating, anything else is unreachable.
const fakeReconcile: ReconcileFn = async ({ sessionId }) => {
  if (sessionId === "ses_done") return { outcome: "completed", summary: "the real answer" };
  if (sessionId === "ses_running") return { outcome: "in_progress" };
  return { outcome: "unreachable" };
};

describe("restart recovery", () => {
  test("reconciles a finished opencode session; fails everything unrecoverable", async () => {
    const done = await seedStaleRun({ engine: "opencode", status: "running", session: "ses_done", sandbox: "sb1", withStep: true });
    const stillGenerating = await seedStaleRun({ engine: "opencode", status: "running", session: "ses_running", sandbox: "sb2", withStep: true });
    const unreachable = await seedStaleRun({ engine: "opencode", status: "running", session: "ses_gone", sandbox: "sb3", withStep: true });
    const queued = await seedStaleRun({ engine: "opencode", status: "queued", session: "ses_done", sandbox: "sb4" });
    const noNativeIds = await seedStaleRun({ engine: "opencode", status: "running" });
    // A mock run whose (fake) session id WOULD reconcile — proves the engine gate
    // stops non-opencode runs from ever being probed.
    const mock = await seedStaleRun({ engine: "mock", status: "running", session: "ses_done", sandbox: "sb5" });

    const res = await recoverStaleRuns(fakeReconcile);

    // The one genuinely-finished session reconciles to completed with real text.
    const doneRun = await getRun(done);
    expect(doneRun?.status).toBe("completed");
    expect(doneRun?.summary).toBe("the real answer");

    // Still-generating / unreachable / queued / no-native-ids / non-opencode all
    // fail with the honest resumable summary — never a claimed completion.
    for (const id of [stillGenerating, unreachable, queued, noNativeIds, mock]) {
      const r = await getRun(id);
      expect(r?.status).toBe("failed");
      expect(r?.summary).toBe(STALE_SUMMARY);
    }

    // At least our six were handled (other test rows may add to the totals).
    expect(res.reconciled).toBeGreaterThanOrEqual(1);
    expect(res.failed).toBeGreaterThanOrEqual(5);
  });

  test("reconcile probe returns unreachable fast when Daytona is unconfigured", async () => {
    // The no-key guard must resolve instantly (never a hung network probe), so a
    // dead/unconfigured sandbox can never hang boot.
    const saved = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const t0 = Date.now();
      const r = await reconcileOpencodeRun({ sandboxId: "does-not-exist", sessionId: "ses_x", sinceMs: 0 });
      expect(r.outcome).toBe("unreachable");
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      if (saved !== undefined) process.env.DAYTONA_API_KEY = saved;
    }
  });
});
