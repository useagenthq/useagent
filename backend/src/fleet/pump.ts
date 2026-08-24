import {
  claimNextRun,
  requeueClaimedCommand,
  settleCommandForRun,
} from "../commands/dispatch";
import { admitClaimedRun } from "./admission";

// ---------------------------------------------------------------------------
// The gated pump: claim a thread's next queued command, consult the capacity
// gate, and spawn via the caller's worker-owned `spawn` only if a lease is
// granted. On a capacity defer the claim is undone so the run can be re-pumped
// later. Kept OUT of the worker (which passes `spawn`) so the gate glue lives in
// the fleet module and there is no worker<->fleet import cycle.
// ---------------------------------------------------------------------------

export async function pumpThreadWithGate(
  threadId: string,
  spawn: (runId: string) => void,
): Promise<string | null> {
  const next = await claimNextRun(threadId);
  if (!next) return null;
  const decision = await admitClaimedRun(next);
  if (!decision.admit) {
    if (decision.decision === "reject_invalid_request") {
      await settleCommandForRun(next);
      return null;
    }
    // No capacity yet — undo the claim so a later pump can retry this run.
    await requeueClaimedCommand(next).catch((err) =>
      console.error(`[fleet] requeue after capacity defer for ${next} failed:`, err),
    );
    return null;
  }
  spawn(next);
  return next;
}
