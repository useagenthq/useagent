import {
  acceptRunCommand,
  preflightRunCommandReplay,
  type RunCommandIntent,
  type RunCommandOutcome,
} from "../commands";
import { slackConfig } from "../env";
import { pumpThread } from "../worker";
import {
  composeAutomationFireText,
  parseSlackAutomationTarget,
  slackChannelAllowed,
} from "../slack/automation";
import { enqueuePostMessage } from "../slack/outbox";
import { recordFiring, type ScheduleRecord } from "./repo";
import type { ScheduleTrigger } from "../db/schema";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  explicitRepositoryResources,
  resolveRunIntake,
} from "../resources/run-intake";
import { resolveExecutableSkillPin } from "../skills/pins";

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

export interface ScheduleFireOutcome {
  readonly runId: string;
  /** True only for the command-lane transaction that created this occurrence. */
  readonly created: boolean;
  /** True only when this call committed the durable firing row. This also
   * identifies crash recovery after command acceptance but before recording. */
  readonly firingRecorded: boolean;
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
 * firing rather than appending a second. Returns the accepted run id plus the
 * command lane's atomic created/replayed classification.
 */
export async function fireScheduleWithOutcome(
  schedule: ScheduleRecord,
  trigger: ScheduleTrigger,
  occurrence: Date = new Date(),
): Promise<ScheduleFireOutcome> {
  await resolveExecutableSkillPin(
    {
      skillId: schedule.skillId,
      skillVersion: schedule.skillVersion,
      skillContentHash: schedule.skillContentHash,
    },
    { requireContentHash: true },
  );
  const idempotencyKey = firingKey(schedule.id, trigger, occurrence);
  const runId = crypto.randomUUID();
  const intent: RunCommandIntent = {
    prompt: schedule.prompt,
    model: schedule.model,
    engine: schedule.engine,
    parentRunId: null,
    requestedRepos: schedule.repos,
    attachmentIds: [],
    memoryScope: "org",
    skillId: schedule.skillId,
    skillVersion: schedule.skillVersion,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
  let outcome: RunCommandOutcome | null = await preflightRunCommandReplay({
    orgId: schedule.orgId,
    idempotencyKey,
    intent,
  });
  if (!outcome) {
    // A first occurrence still resolves immediately before persistence. Removed
    // access or an unavailable provider fails before a run/firing is created.
    const intake = await resolveRunIntake(
      {
        source: "automation",
        text: schedule.prompt,
        explicitResources: explicitRepositoryResources(schedule.repos),
      },
      { authorize: createRunResourceAuthorization(schedule.orgId) },
    );
    outcome = await acceptRunCommand({
      idempotencyKey,
      orgId: schedule.orgId,
      actorId: schedule.userId,
      intent,
      run: {
        id: runId,
        prompt: schedule.prompt,
        model: schedule.model,
        engine: schedule.engine,
        parentRunId: null,
        threadId: runId,
        repos: [...intake.repos],
        resolvedResources: intake.resources,
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
  }

  // A firing key can only conflict if the schedule's prompt/model/engine changed
  // between a crash and its retry (the payload fingerprint differs under the same
  // key). Refuse rather than silently fire a second run for one occurrence.
  if (outcome.status === "conflict") {
    throw new Error(
      `schedule ${schedule.id} firing ${idempotencyKey} conflicted (${outcome.reason})`,
    );
  }

  const acceptedRunId = outcome.runId;
  // Idempotent (unique idempotency_key + onConflictDoNothing) — a retry after a
  // crash-before-record re-records the ORIGINAL run's firing, never a duplicate.
  // Recorded BEFORE the pump so run finalization (which resolves the automation
  // by run id for delivery.slack) always finds the firing row, even for a run
  // that finishes near-instantly. A crash between record and pump is closed by
  // the retry's pump below.
  const firingRecorded = await recordFiring({
    scheduleId: schedule.id,
    runId: acceptedRunId,
    trigger,
    idempotencyKey,
  });

  // Fire notification (notifications.slack): durably enqueue "automation fired"
  // to the configured channel through the existing Slack outbox. Keyed by the
  // occurrence's firing key, so a replayed/double-fired occurrence enqueues at
  // most once; the allowlist is re-checked at fire time (env may have changed
  // since enable). Skipped entirely when Slack is unconfigured (nothing could
  // deliver it) — the run itself is never blocked by notification config.
  const notifyTarget = parseSlackAutomationTarget(schedule.notifications);
  const slack = slackConfig();
  if (notifyTarget && slack && slackChannelAllowed(notifyTarget.channel, slack)) {
    await enqueuePostMessage({
      idempotencyKey: `automation-notify:${idempotencyKey}`,
      channel: notifyTarget.channel,
      text: composeAutomationFireText(schedule.name, acceptedRunId),
    });
  }

  // Dispatch the thread's mailbox. On `created` this starts the run; on `replayed`
  // it is an idempotent no-op if the original is already in flight (claimNextRun
  // CAS) and closes the gap if a prior fire crashed after accept but before pump.
  await pumpThread(acceptedRunId);

  return {
    runId: acceptedRunId,
    created: outcome.status === "created",
    firingRecorded,
  };
}

/** Preserve the original run-id-only contract for callers that do not need to
 * distinguish a fresh logical firing from an idempotent replay. */
export async function fireSchedule(
  schedule: ScheduleRecord,
  trigger: ScheduleTrigger,
  occurrence: Date = new Date(),
): Promise<string> {
  return (await fireScheduleWithOutcome(schedule, trigger, occurrence)).runId;
}
