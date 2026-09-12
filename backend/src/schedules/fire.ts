import {
  acceptUnattendedRunCommand,
  BotHomeThreadTakenError,
  preflightRunCommandReplay,
  preflightUnattendedRunCommandReplay,
  type RunCommandIntent,
  type RunCommandOutcome,
} from "../commands";
import { findCommandByKey } from "../commands/repo";
import { acceptRunCancel } from "../commands/cancel";
import { pumpThread } from "../worker";
import {
  composeAutomationFireText,
  resolveSlackAutomationTargetForOrg,
} from "../slack/automation";
import { enqueuePostMessage } from "../slack/outbox";
import { recordFiring, type ScheduleRecord } from "./repo";
import type { ScheduleTrigger } from "../db/schema";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  explicitRepositoryResources,
  legacyParentResources,
  resolveRunIntake,
} from "../resources/run-intake";
import { resolveExecutableSkillPin } from "../skills/pins";
import { botFiringTarget } from "../bots/repo";
import { BotsDisabledError, botsEnabled } from "../bots/rollout";
import { acceptExistingThreadFollowup } from "../runs/thread-followups";
import type { MemoryScope } from "../memory/scope";
import { getRunForOrg } from "../runs/repo";
import { AUTOMATION_RUN_ORIGIN } from "../runs/origin";

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
 * immutable firing row. A firing is a fresh thread root (`parentRunId: null`,
 * `threadId === runId`) unless the schedule is a bot routine: then it posts
 * into the bot's home thread as a follow-up (or opens that thread with the
 * bot's standing rules when none exists yet). Shared by the 60s scheduler loop
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
  // The kill switch covers routines: with bots off, a bot's schedule does not
  // run at all (not even as a plain root), so "off" also means no spend.
  if (schedule.botId && !botsEnabled(schedule.orgId)) throw new BotsDisabledError(schedule.id);
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
  // A bot routine targets the bot's home thread; a deleted/archived bot falls
  // back to a plain root so the schedule keeps working instead of failing.
  const target = schedule.botId
    ? await botFiringTarget(schedule.orgId, schedule.botId)
    : null;
  const home = target?.head ?? null;
  const threadId = home ? home.threadId : runId;
  const memoryScope: MemoryScope = target ? target.bot.memoryScope : "org";
  const intent: RunCommandIntent = {
    prompt: schedule.prompt,
    model: schedule.model,
    engine: schedule.engine,
    parentRunId: home?.id ?? null,
    requestedRepos: home ? [] : schedule.repos,
    requestedResources: [],
    attachmentIds: [],
    memoryScope,
    skillId: home ? null : schedule.skillId,
    skillVersion: home ? null : schedule.skillVersion,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
  let outcome: RunCommandOutcome | null =
    await preflightUnattendedRunCommandReplay({
      orgId: schedule.orgId,
      idempotencyKey,
      intent,
      origin: AUTOMATION_RUN_ORIGIN,
    });
  // Firings accepted before durable origin provenance shipped remain valid
  // replays. Every newly accepted firing below persists the automation origin.
  if (outcome?.status === "conflict" && outcome.reason === "origin_mismatch") {
    outcome = await preflightRunCommandReplay({
      orgId: schedule.orgId,
      idempotencyKey,
      intent,
    });
  }
  // A first bot firing can lose the home-thread race after accepting a root
  // under the occurrence key. On retry the bot now has a home, so the current
  // follow-up-shaped intent cannot replay that root. Retry the only other valid
  // shape for this routine occurrence before treating the key as conflicting.
  if (
    outcome?.status === "conflict" &&
    outcome.reason === "payload_mismatch" &&
    target &&
    home
  ) {
    outcome = await preflightUnattendedRunCommandReplay({
      orgId: schedule.orgId,
      idempotencyKey,
      origin: AUTOMATION_RUN_ORIGIN,
      intent: {
        ...intent,
        parentRunId: null,
        requestedRepos: schedule.repos,
        skillId: schedule.skillId,
        skillVersion: schedule.skillVersion,
      },
    });
    if (
      outcome?.status === "conflict" &&
      outcome.reason === "origin_mismatch"
    ) {
      outcome = await preflightRunCommandReplay({
        orgId: schedule.orgId,
        idempotencyKey,
        intent: {
          ...intent,
          parentRunId: null,
          requestedRepos: schedule.repos,
          skillId: schedule.skillId,
          skillVersion: schedule.skillVersion,
        },
      });
    }
  }
  if (!outcome) {
    // A first occurrence still resolves immediately before persistence. Removed
    // access or an unavailable provider fails before a run/firing is created.
    const intake = await resolveRunIntake(
      home
        ? {
            source: "automation",
            text: "",
            inheritedResources:
              home.resolvedResources.length > 0
                ? home.resolvedResources
                : legacyParentResources(home.repos, "web"),
          }
        : {
            source: "automation",
            text: schedule.prompt,
            explicitResources: explicitRepositoryResources(schedule.repos),
          },
      { authorize: createRunResourceAuthorization(schedule.orgId) },
    );
    const command = {
      idempotencyKey,
      orgId: schedule.orgId,
      actorId: schedule.userId,
      acceptedModelPolicy: "persisted" as const,
      intent,
      run: {
        id: runId,
        prompt: schedule.prompt,
        model: schedule.model,
        engine: schedule.engine,
        parentRunId: home?.id ?? null,
        threadId,
        repos: [...intake.repos],
        resolvedResources: intake.resources,
        // Plain scheduled runs are fresh roots with organization memory; a bot
        // routine inherits the bot's scope.
        memoryScope,
        skillId: home ? null : schedule.skillId,
        skillVersion: home ? null : schedule.skillVersion,
        skillContentHash: home ? null : schedule.skillContentHash,
        // A scheduled turn is never a native provider command.
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    };
    if (home) {
      outcome = await acceptExistingThreadFollowup(
        schedule.orgId,
        home.id,
        command,
        AUTOMATION_RUN_ORIGIN,
      );
    } else {
      // A bot's first firing opens its home thread: the bot is stamped in the
      // same transaction as the root (`botHome`), so the pump can claim the run
      // the instant it exists and its first turn finds the bot. A lost race
      // rolls the root back; the retarget below posts into the winner instead.
      try {
        outcome = await acceptUnattendedRunCommand({
          ...command,
          origin: AUTOMATION_RUN_ORIGIN,
          ...(target ? { botHome: { botId: target.bot.id } } : {}),
        });
      } catch (error) {
        if (!(error instanceof BotHomeThreadTakenError)) throw error;
        outcome = null;
      }
    }
  }

  // A firing key can only conflict if the schedule's prompt/model/engine changed
  // between a crash and its retry (the payload fingerprint differs under the same
  // key). Refuse rather than silently fire a second run for one occurrence.
  if (outcome?.status === "conflict") {
    throw new Error(
      `schedule ${schedule.id} firing ${idempotencyKey} conflicted (${outcome.reason})`,
    );
  }

  // Resolve a root that lost the bot-home race through one stable follow-up.
  // The retarget command may already exist when recovery resumes after its
  // acceptance but before firing-record/pump; in that case reuse its run
  // directly instead of rebuilding an intent against a newer thread head.
  if (target) {
    const winner = await botFiringTarget(schedule.orgId, target.bot.id);
    const accepted = outcome ? await getRunForOrg(schedule.orgId, outcome.runId) : null;
    if (
      winner?.head &&
      (!accepted || accepted.threadId !== winner.head.threadId)
    ) {
      if (accepted) {
        await acceptRunCancel({
          orgId: schedule.orgId,
          actorId: null,
          runId: accepted.id,
        }).catch((error) => {
          console.error(
            `[schedules] could not cancel the stray bot root ${accepted.id}:`,
            error,
          );
        });
      }
      const retargetKey = `${idempotencyKey}:retarget`;
      const priorRetarget = await findCommandByKey(schedule.orgId, retargetKey);
      const priorRun = priorRetarget?.runId
        ? await getRunForOrg(schedule.orgId, priorRetarget.runId)
        : null;
      if (priorRun) {
        if (
          priorRun.threadId !== winner.head.threadId ||
          priorRun.prompt !== schedule.prompt ||
          priorRun.model !== schedule.model ||
          priorRun.engine !== schedule.engine ||
          priorRun.memoryScope !== memoryScope
        ) {
          throw new Error(
            `schedule ${schedule.id} retarget ${idempotencyKey} conflicted (payload_mismatch)`,
          );
        }
        outcome = { status: "replayed", runId: priorRun.id };
      } else {
        const inheritedResources =
          winner.head.resolvedResources.length > 0
            ? winner.head.resolvedResources
            : legacyParentResources(winner.head.repos, "web");
        const intake = await resolveRunIntake(
          { source: "automation", text: "", inheritedResources },
          { authorize: createRunResourceAuthorization(schedule.orgId) },
        );
        const retarget = {
          prompt: schedule.prompt,
          parentRunId: winner.head.id,
          skillId: null,
          skillVersion: null,
        };
        outcome = await acceptExistingThreadFollowup(
          schedule.orgId,
          winner.head.id,
          {
            idempotencyKey: retargetKey,
            orgId: schedule.orgId,
            actorId: schedule.userId,
            acceptedModelPolicy: "persisted",
            intent: { ...intent, ...retarget, requestedRepos: [] },
            run: {
              id: crypto.randomUUID(),
              prompt: schedule.prompt,
              model: schedule.model,
              engine: schedule.engine,
              parentRunId: winner.head.id,
              threadId: winner.head.threadId,
              repos: [...intake.repos],
              resolvedResources: intake.resources,
              memoryScope,
              skillId: null,
              skillVersion: null,
              skillContentHash: null,
              commandName: null,
              commandProvider: null,
              commandSessionId: null,
              commandCatalogRevision: null,
            },
          },
          AUTOMATION_RUN_ORIGIN,
        );
        if (outcome.status === "conflict") {
          throw new Error(
            `schedule ${schedule.id} retarget ${idempotencyKey} conflicted (${outcome.reason})`,
          );
        }
      }
    }
  }

  if (!outcome) {
    throw new Error(
      `schedule ${schedule.id} firing ${idempotencyKey} lost the home-thread race with no home to post into`,
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
  const notifyTarget = await resolveSlackAutomationTargetForOrg(
    schedule.notifications,
    schedule.orgId,
  );
  if (notifyTarget) {
    await enqueuePostMessage({
      idempotencyKey: `automation-notify:${idempotencyKey}`,
      orgId: schedule.orgId,
      teamId: notifyTarget.teamId,
      channel: notifyTarget.channel,
      text: composeAutomationFireText(schedule.name, acceptedRunId),
    });
  }

  // Dispatch the thread's mailbox. On `created` this starts the run; on `replayed`
  // it is an idempotent no-op if the original is already in flight (claimNextRun
  // CAS) and closes the gap if a prior fire crashed after accept but before pump.
  const acceptedRun = await getRunForOrg(schedule.orgId, acceptedRunId);
  if (!acceptedRun)
    throw new Error(
      `schedule ${schedule.id} accepted missing run ${acceptedRunId}`,
    );
  await pumpThread(acceptedRun.threadId);

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
