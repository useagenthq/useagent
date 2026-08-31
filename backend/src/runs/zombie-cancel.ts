import { CANCEL_SUMMARY } from "../commands/cancel";
import { finalizeRun, resolveDurableFinalizationOutcome } from "./finalize";
import { deleteReconcile } from "./reconcile-queue";

export async function settleZombieCancel(runId: string): Promise<string | null> {
  console.warn(
    `[cancel] run ${runId} is 'running' with no live canceller; finalizing as stopped now.`,
  );
  const finalized = await finalizeRun(runId, "failed", CANCEL_SUMMARY, 0);
  const durable = await resolveDurableFinalizationOutcome(runId, finalized);
  await deleteReconcile(runId);
  return !finalized.applied && durable ? durable.status : null;
}
