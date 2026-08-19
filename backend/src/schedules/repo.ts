import { and, desc, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  runs,
  scheduleFirings,
  schedules,
  type AutomationJson,
  type EngineId,
  type ScheduleTrigger,
} from "../db/schema";

// ---------------------------------------------------------------------------
// API serialization — snake_case wire contract, matching the runs/skills style.
// ---------------------------------------------------------------------------

export type ScheduleRecord = typeof schedules.$inferSelect;

export interface ApiSchedule {
  id: string;
  org_id: string;
  /** Creator identity — the user who created the schedule (its firing actor). */
  user_id: string | null;
  name: string;
  cron: string;
  /** IANA timezone the cron runs in; null = server local time. */
  timezone: string | null;
  prompt: string;
  engine: EngineId;
  model: string;
  skill_id: string | null;
  skill_version: number | null;
  skill_content_hash: string | null;
  repos: string[];
  tags: string[];
  delivery: AutomationJson | null;
  notifications: AutomationJson | null;
  run_actor_id: string | null;
  concurrency: AutomationJson | null;
  queue: AutomationJson | null;
  cost_limits: AutomationJson | null;
  frequency_limits: AutomationJson | null;
  approval_policy: AutomationJson | null;
  enablement_policy: AutomationJson | null;
  enabled: boolean;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiFiring {
  id: string;
  schedule_id: string;
  run_id: string;
  fired_at: string;
  trigger: ScheduleTrigger;
  /** Firing-time snapshot ("queued"). */
  status: string;
  /** Live run status/summary, joined from the runs log. Null if the run is gone. */
  run_status: string | null;
  run_summary: string | null;
}

function toSchedule(s: ScheduleRecord): ApiSchedule {
  return {
    id: s.id,
    org_id: s.orgId,
    user_id: s.userId,
    name: s.name,
    cron: s.cron,
    timezone: s.timezone,
    prompt: s.prompt,
    engine: s.engine,
    model: s.model,
    skill_id: s.skillId,
    skill_version: s.skillVersion,
    skill_content_hash: s.skillContentHash,
    repos: s.repos,
    tags: s.tags,
    delivery: s.delivery,
    notifications: s.notifications,
    run_actor_id: s.runActorId,
    concurrency: s.concurrency,
    queue: s.queue,
    cost_limits: s.costLimits,
    frequency_limits: s.frequencyLimits,
    approval_policy: s.approvalPolicy,
    enablement_policy: s.enablementPolicy,
    enabled: s.enabled,
    last_fired_at: s.lastFiredAt ? s.lastFiredAt.toISOString() : null,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export async function listSchedules(orgId: string): Promise<ApiSchedule[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.orgId, orgId))
    .orderBy(desc(schedules.createdAt), desc(schedules.id));
  return rows.map(toSchedule);
}

/** Org-scoped fetch — a cross-org (or missing) id resolves to null (→ 404). */
export async function getScheduleForOrg(
  orgId: string,
  id: string,
): Promise<ScheduleRecord | null> {
  const [row] = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

export async function createSchedule(input: {
  orgId: string;
  userId: string | null;
  name: string;
  cron: string;
  timezone: string | null;
  prompt: string;
  engine: EngineId;
  model: string;
  skillId: string | null;
  skillVersion: number | null;
  skillContentHash: string | null;
  repos: string[];
  tags: string[];
  delivery: AutomationJson | null;
  notifications: AutomationJson | null;
  runActorId: string | null;
  concurrency: AutomationJson | null;
  queue: AutomationJson | null;
  costLimits: AutomationJson | null;
  frequencyLimits: AutomationJson | null;
  approvalPolicy: AutomationJson | null;
  enablementPolicy: AutomationJson | null;
}): Promise<ApiSchedule> {
  const [row] = await db
    .insert(schedules)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      name: input.name,
      cron: input.cron,
      timezone: input.timezone,
      prompt: input.prompt,
      engine: input.engine,
      model: input.model,
      skillId: input.skillId,
      skillVersion: input.skillVersion,
      skillContentHash: input.skillContentHash,
      repos: input.repos,
      tags: input.tags,
      delivery: input.delivery,
      notifications: input.notifications,
      runActorId: input.runActorId,
      concurrency: input.concurrency,
      queue: input.queue,
      costLimits: input.costLimits,
      frequencyLimits: input.frequencyLimits,
      approvalPolicy: input.approvalPolicy,
      enablementPolicy: input.enablementPolicy,
      // enabled defaults FALSE at the column — never auto-fire on create.
    })
    .returning();
  return toSchedule(row!);
}

export async function updateSchedule(
  orgId: string,
  id: string,
  patch: Partial<
    Pick<
      typeof schedules.$inferInsert,
      | "name"
      | "cron"
      | "timezone"
      | "prompt"
      | "engine"
      | "model"
      | "skillId"
      | "skillVersion"
      | "skillContentHash"
      | "repos"
      | "tags"
      | "delivery"
      | "notifications"
      | "runActorId"
      | "concurrency"
      | "queue"
      | "costLimits"
      | "frequencyLimits"
      | "approvalPolicy"
      | "enablementPolicy"
      | "enabled"
    >
  >,
): Promise<ApiSchedule | null> {
  const [row] = await db
    .update(schedules)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(schedules.id, id), eq(schedules.orgId, orgId)))
    .returning();
  return row ? toSchedule(row) : null;
}

export async function deleteSchedule(orgId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const schedule = await tx
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.orgId, orgId)))
      .limit(1);
    if (!schedule[0]) return false;
    await tx.delete(scheduleFirings).where(eq(scheduleFirings.scheduleId, id));
    const deleted = await tx
      .delete(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.orgId, orgId)))
      .returning({ id: schedules.id });
    return deleted.length > 0;
  });
}

/** Enabled schedules across ALL orgs — the scheduler loop's tick query. */
export async function listEnabledSchedules(): Promise<ScheduleRecord[]> {
  return db.select().from(schedules).where(eq(schedules.enabled, true));
}

/** The schedule whose firing created `runId`, or null for a non-automation run.
 *  Takes an Executor so run finalization can resolve it inside its transaction
 *  (Slack delivery of the terminal summary enqueues atomically with terminal). */
export async function findScheduleForRun(
  runId: string,
  exec: Executor = db,
): Promise<ScheduleRecord | null> {
  const [row] = await exec
    .select({ schedule: schedules })
    .from(scheduleFirings)
    .innerJoin(schedules, eq(scheduleFirings.scheduleId, schedules.id))
    .where(eq(scheduleFirings.runId, runId))
    .limit(1);
  return row?.schedule ?? null;
}

/** Stamp the last-fired minute so the loop won't re-fire within the same minute. */
export async function markFired(id: string, firedAt: Date): Promise<void> {
  await db
    .update(schedules)
    .set({ lastFiredAt: firedAt })
    .where(eq(schedules.id, id));
}

// ---------------------------------------------------------------------------
// Firings — append-only. A firing row is never mutated; the live run outcome
// comes from joining the runs log at read time.
// ---------------------------------------------------------------------------

export async function recordFiring(input: {
  scheduleId: string;
  runId: string;
  trigger: ScheduleTrigger;
  /** Deterministic per-occurrence key (see fire.ts `firingKey`). Its UNIQUE
   *  index makes a retry after a crash-before-record a no-op instead of a dup. */
  idempotencyKey: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(scheduleFirings)
    .values({
      scheduleId: input.scheduleId,
      runId: input.runId,
      trigger: input.trigger,
      idempotencyKey: input.idempotencyKey,
      // The run is 'queued' the instant it is created; the reader joins for live status.
      status: "queued",
    })
    .onConflictDoNothing({ target: scheduleFirings.idempotencyKey })
    .returning({ id: scheduleFirings.id });
  return inserted.length === 1;
}

/** A schedule's firing history, newest first, enriched with the run's live status. */
export async function listFirings(scheduleId: string): Promise<ApiFiring[]> {
  const rows = await db
    .select({
      id: scheduleFirings.id,
      scheduleId: scheduleFirings.scheduleId,
      runId: scheduleFirings.runId,
      firedAt: scheduleFirings.firedAt,
      trigger: scheduleFirings.trigger,
      status: scheduleFirings.status,
      runStatus: runs.status,
      runSummary: runs.summary,
    })
    .from(scheduleFirings)
    .leftJoin(runs, eq(scheduleFirings.runId, runs.id))
    .where(eq(scheduleFirings.scheduleId, scheduleId))
    .orderBy(desc(scheduleFirings.firedAt), desc(scheduleFirings.id));

  return rows.map((r) => ({
    id: r.id,
    schedule_id: r.scheduleId,
    run_id: r.runId,
    fired_at: r.firedAt.toISOString(),
    trigger: r.trigger,
    status: r.status,
    run_status: r.runStatus ?? null,
    run_summary: r.runSummary ?? null,
  }));
}
