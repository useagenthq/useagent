import { acceptRunCommand } from "../commands";
import { pumpThread } from "../worker";
import { recordFiring, type ScheduleRecord } from "./repo";
import type { ScheduleTrigger } from "../db/schema";

/**
 * Deterministic per-occurrence idempotency key. A cron firing keys on the MINUTE
 * BUCKET of its occurrence (so the same logical occurrence retried after a crash
 * — or revisited by a later tick within the same minute — reuses the key), while
 * a manual "run now" keys on its wall-clock ms (each press is its own firing, per
 * the "manual has its own stable identity" rule). Mirrors Cloudflare's stable
 * `runId`-across-retries scheduler contract (mem_op 0.4).
 */
export function firingKey(
  scheduleId: string,
  trigger: ScheduleTrigger,
  occurrence: Date,
): string {
  if (trigger === "cron") {
    const bucket = Math.floor(occurrence.getTime() / 60_000) * 60_000;
    return `schedule:${scheduleId}:${bucket}`;
  }
  return `schedule:${scheduleId}:manual:${occurrence.getTime()}`;
}

/**
 * Fire a schedule: create a run through the durable command lane (the same
 * `acceptRunCommand` + mailbox pump `POST /api/runs` uses) and append an
 * immutable firing row. A firing is always a fresh thread root
 * (`parentRunId: null`, `threadId === runId`). Shared by the 60s scheduler loop
 * (`trigger: "cron"`) and the manual run-now route (`trigger: "manual"`).
 *
 * IDEMPOTENT per occurrence. The command lane is keyed by {@link firingKey}, so
 * the SAME occurrence — a double-fire, or a retry after a crash between accept
 * and record — resolves to the ORIGINAL run instead of a duplicate (the unique
 * `(org, idempotency_key)` index is the claim: it cannot accept two runs for one
 * occurrence). The firing row carries the same key under its own UNIQUE index,
 * so recording it is likewise idempotent — a retry re-records the original run's
 * firing rather than appending a second. Returns the accepted run id (fresh on
 * the first fire, the original on a replay).
 */
export async function fireSchedule(
  schedule: ScheduleRecord,
  trigger: ScheduleTrigger,
  occurrence: Date = new Date(),
): Promise<string> {
  const idempotencyKey = firingKey(schedule.id, trigger, occurrence);
  const runId = crypto.randomUUID();
  const outcome = await acceptRunCommand({
    idempotencyKey,
    orgId: schedule.orgId,
    actorId: schedule.userId,
    run: {
      id: runId,
      prompt: schedule.prompt,
      model: schedule.model,
      engine: schedule.engine,
      parentRunId: null,
      threadId: runId,
      repos: schedule.repos,
      // Scheduled runs are always fresh roots — organization memory by default.
      memoryScope: "org",
      skillId: schedule.skillId,
      skillVersion: schedule.skillVersion,
      skillContentHash: schedule.skillContentHash,
      // A scheduled turn is never a native provider command.
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    },
  });

  // A firing key can only conflict if the schedule's prompt/model/engine changed
  // between a crash and its retry (the payload fingerprint differs under the same
  // key). Refuse rather than silently fire a second run for one occurrence.
  if (outcome.status === "conflict") {
    throw new Error(
      `schedule ${schedule.id} firing ${idempotencyKey} conflicted (${outcome.reason})`,
    );
  }

  const acceptedRunId = outcome.runId;
  // Dispatch the thread's mailbox. On `created` this starts the run; on `replayed`
  // it is an idempotent no-op if the original is already in flight (claimNextRun
  // CAS) and closes the gap if a prior fire crashed after accept but before pump.
  await pumpThread(acceptedRunId);
  // Idempotent (unique idempotency_key + onConflictDoNothing) — a retry after a
  // crash-before-record re-records the ORIGINAL run's firing, never a duplicate.
  await recordFiring({
    scheduleId: schedule.id,
    runId: acceptedRunId,
    trigger,
    idempotencyKey,
  });
  return acceptedRunId;
}
