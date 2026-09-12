import { and, asc, desc, eq, getTableColumns, inArray, like, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { alias } from "drizzle-orm/pg-core";
import {
  botHandoffs,
  bots,
  commands,
  runAdmissions,
  runs,
  threadRelationships,
  type EngineId,
  type ThreadRelationshipKind,
} from "../db/schema";
import { FOLLOWUP_KEY_PATTERN, parseMentionFollowupKey } from "../bots/handoff-keys";
import { boundedChildTitle } from "./child-session-policy";
import { BOT_HANDOFF_RUN_ORIGIN } from "./origin";
import { projectProductThreadStatus, type ProductThreadStatus } from "./thread-status";

export interface NewThreadRelationship {
  readonly orgId: string;
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly familyThreadId: string;
  readonly kind: ThreadRelationshipKind;
  readonly title: string;
  readonly sourceRunId: string;
  readonly sourceExecutionId?: string | null;
}

export interface ThreadRelationshipView {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly familyThreadId: string;
  readonly kind: ThreadRelationshipKind;
  readonly title: string;
  readonly sourceRunId: string;
  readonly sourceExecutionId: string | null;
  readonly status: ProductThreadStatus;
  readonly engine: EngineId;
  readonly model: string;
  readonly latestRunId: string;
  readonly latestSummary: string | null;
  readonly latestDurationMs: number | null;
  readonly latestActivityAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The bot this delegated thread was handed to through an @mention; null for
   *  roots and for children the agent opened itself. */
  readonly bot: {
    readonly id: string;
    readonly name: string;
    readonly avatarTone: string;
    readonly avatarIcon: string;
  } | null;
  /** Exact child turn admitted by each parent-run bot mention. */
  readonly handoffOutcomes: readonly {
    readonly sourceRunId: string;
    readonly status: ProductThreadStatus;
    readonly summary: string | null;
  }[];
  /** Parent-thread runs whose later @mention became a turn of this thread
   *  (the creating run is `sourceRunId`, not listed here). */
  readonly followUpRunIds: readonly string[];
}

export interface ThreadRelationshipCursor {
  /** Exact PostgreSQL epoch microseconds. Never round through JavaScript Date. */
  readonly createdAtMicros: string;
  readonly threadId: string;
}

interface StoredHandoffProvenance {
  readonly sourceRunId: string;
  readonly parentThreadId: string;
  readonly botId: string;
}

function storedHandoffProvenance(payload: string | null): StoredHandoffProvenance | null {
  if (!payload) return null;
  try {
    const body = JSON.parse(payload) as { botHandoff?: Record<string, unknown> };
    const provenance = body.botHandoff;
    if (
      provenance?.kind !== "bot_handoff_followup" ||
      typeof provenance.sourceRunId !== "string" ||
      typeof provenance.parentThreadId !== "string" ||
      typeof provenance.botId !== "string"
    ) return null;
    return {
      sourceRunId: provenance.sourceRunId,
      parentThreadId: provenance.parentThreadId,
      botId: provenance.botId,
    };
  } catch {
    return null;
  }
}

function cursorTimestamp(microseconds: string) {
  return sql`to_timestamp((${microseconds}::bigint / 1000000)::double precision)
    + ((${microseconds}::bigint % 1000000) * interval '1 microsecond')`;
}

export async function insertThreadRelationship(
  input: NewThreadRelationship,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(threadRelationships).values({
    orgId: input.orgId,
    threadId: input.threadId,
    parentThreadId: input.parentThreadId,
    familyThreadId: input.familyThreadId,
    kind: input.kind,
    title: boundedChildTitle(input.title),
    sourceRunId: input.sourceRunId,
    sourceExecutionId: input.sourceExecutionId ?? null,
  });
}

export async function ensureRootThreadRelationship(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly title: string;
}, exec: Executor = db): Promise<void> {
  await exec.insert(threadRelationships).values({
    orgId: input.orgId,
    threadId: input.threadId,
    parentThreadId: null,
    familyThreadId: input.threadId,
    kind: "root",
    title: boundedChildTitle(input.title.slice(0, 160) || "Untitled thread"),
    sourceRunId: input.threadId,
    sourceExecutionId: null,
  }).onConflictDoNothing({ target: [threadRelationships.orgId, threadRelationships.threadId] });
}

/** Repair one pre-rollout product root on demand. Internal/canary roots are
 * deliberately ineligible: relationship reads are a customer-facing surface. */
export async function ensureEligiblePublicRootThreadRelationship(input: {
  readonly orgId: string;
  readonly threadId: string;
}, exec: Executor = db): Promise<boolean> {
  const [eligible] = await exec.select({ id: runs.id, prompt: runs.prompt }).from(runs).where(and(
    eq(runs.orgId, input.orgId),
    eq(runs.id, input.threadId),
    eq(runs.threadId, input.threadId),
    sql`${runs.parentRunId} is null`,
    sql`${runs.origin} is null`,
  )).limit(1);
  if (!eligible) return false;
  await ensureRootThreadRelationship({
    orgId: input.orgId,
    threadId: input.threadId,
    title: eligible.prompt,
  }, exec);
  return true;
}

/** Idempotent boot repair for roots accepted while relationship writes were
 * rolled back. The same eligibility predicate is used by the lazy path above. */
export async function repairEligiblePublicRootThreadRelationships(
  exec: Executor = db,
): Promise<number> {
  const inserted = await exec.execute(sql`
    insert into thread_relationships (
      org_id, thread_id, parent_thread_id, family_thread_id, kind, title,
      source_run_id, source_execution_id, created_at, updated_at
    )
    select
      candidate.org_id, candidate.id, null, candidate.id, 'root',
      left(coalesce(nullif(btrim(candidate.prompt), ''), 'Untitled thread'), 160),
      candidate.id, null, candidate.created_at, candidate.updated_at
    from runs candidate
    where candidate.org_id is not null
      and candidate.id = candidate.thread_id
      and candidate.parent_run_id is null
      and candidate.origin is null
    on conflict (org_id, thread_id) do nothing
    returning thread_id
  `);
  return inserted.length;
}

export async function getThreadRelationship(
  orgId: string,
  threadId: string,
  exec: Executor = db,
): Promise<typeof threadRelationships.$inferSelect | null> {
  const [row] = await exec.select().from(threadRelationships).where(and(
    eq(threadRelationships.orgId, orgId),
    eq(threadRelationships.threadId, threadId),
  )).limit(1);
  return row ?? null;
}

async function latestViews(
  orgId: string,
  relationships: readonly (typeof threadRelationships.$inferSelect)[],
  exec: Executor,
): Promise<ThreadRelationshipView[]> {
  if (relationships.length === 0) return [];
  const threadIds = relationships.map((relationship) => relationship.threadId);
  const cancelCommands = alias(commands, "cancel_command");
  const runRows = await exec.select({
    id: runs.id,
    threadId: runs.threadId,
    status: runs.status,
    engine: runs.engine,
    model: runs.model,
    summary: runs.summary,
    durationMs: runs.durationMs,
    createdAt: runs.createdAt,
    updatedAt: runs.updatedAt,
    admissionState: runAdmissions.state,
    queueReason: runAdmissions.queueReason,
    cancelCount: sql<number>`count(${cancelCommands.id})::int`,
  }).from(runs)
    .leftJoin(runAdmissions, eq(runAdmissions.runId, runs.id))
    .leftJoin(
      cancelCommands,
      and(eq(cancelCommands.runId, runs.id), eq(cancelCommands.kind, "run.cancel")),
    )
    .where(and(eq(runs.orgId, orgId), inArray(runs.threadId, threadIds)))
    .groupBy(runs.id, runAdmissions.state, runAdmissions.queueReason)
    .orderBy(asc(runs.threadId), desc(runs.createdAt), desc(runs.id));
  const latestByThread = new Map<string, (typeof runRows)[number]>();
  const runById = new Map(runRows.map((row) => [row.id, row]));
  for (const row of runRows) if (!latestByThread.has(row.threadId)) latestByThread.set(row.threadId, row);
  const handoffRows = await exec.select({
    threadId: botHandoffs.threadId,
    botId: bots.id,
    botName: bots.name,
    avatarTone: bots.avatarTone,
    avatarIcon: bots.avatarIcon,
  })
    .from(botHandoffs)
    .innerJoin(bots, and(eq(bots.orgId, botHandoffs.orgId), eq(bots.id, botHandoffs.botId)))
    .where(and(eq(botHandoffs.orgId, orgId), inArray(botHandoffs.threadId, threadIds)));
  const botByThread = new Map(handoffRows.map((row) => [row.threadId, {
    id: row.botId,
    name: row.botName,
    avatarTone: row.avatarTone,
    avatarIcon: row.avatarIcon,
  }] as const));
  const followUpRows = await exec.select({
    threadId: runs.threadId,
    runId: commands.runId,
    key: commands.idempotencyKey,
    payload: commands.payload,
    origin: runs.origin,
  })
    .from(commands)
    .innerJoin(runs, and(eq(runs.id, commands.runId), eq(runs.orgId, commands.orgId)))
    .where(and(
      eq(commands.orgId, orgId),
      inArray(runs.threadId, threadIds),
      like(commands.idempotencyKey, FOLLOWUP_KEY_PATTERN),
    ))
    .orderBy(asc(commands.createdAt), asc(commands.id));
  const relationshipByThread = new Map(relationships.map((relationship) => [relationship.threadId, relationship]));
  const candidates: {
    threadId: string;
    parentThreadId: string;
    sourceRunId: string;
    childRunId: string;
  }[] = [];
  for (const row of followUpRows) {
    const key = row.key ? parseMentionFollowupKey(row.key) : null;
    const provenance = storedHandoffProvenance(row.payload);
    const relationship = relationshipByThread.get(row.threadId);
    const bot = botByThread.get(row.threadId);
    if (
      !key ||
      !provenance ||
      !row.runId ||
      row.origin !== BOT_HANDOFF_RUN_ORIGIN ||
      !relationship?.parentThreadId ||
      !bot ||
      key.sourceRunId !== provenance.sourceRunId ||
      key.parentThreadId !== provenance.parentThreadId ||
      key.botId !== provenance.botId ||
      provenance.parentThreadId !== relationship.parentThreadId ||
      provenance.botId !== bot.id
    ) continue;
    candidates.push({
      threadId: row.threadId,
      parentThreadId: provenance.parentThreadId,
      sourceRunId: provenance.sourceRunId,
      childRunId: row.runId,
    });
  }
  const sourceRunIds = [...new Set(candidates.map((candidate) => candidate.sourceRunId))];
  const sourceRows = sourceRunIds.length > 0
    ? await exec.select({ id: runs.id, threadId: runs.threadId }).from(runs).where(and(
        eq(runs.orgId, orgId),
        inArray(runs.id, sourceRunIds),
      ))
    : [];
  const sourceThreads = new Map(sourceRows.map((row) => [row.id, row.threadId]));
  const followUpsByThread = new Map<string, { sourceRunId: string; childRunId: string }[]>();
  for (const candidate of candidates) {
    if (sourceThreads.get(candidate.sourceRunId) !== candidate.parentThreadId) continue;
    const { threadId, sourceRunId, childRunId } = candidate;
    const list = followUpsByThread.get(threadId) ?? [];
    if (!list.some((item) => item.sourceRunId === sourceRunId)) {
      list.push({ sourceRunId, childRunId });
    }
    followUpsByThread.set(threadId, list);
  }
  const outcome = (sourceRunId: string, childRunId: string) => {
    const run = runById.get(childRunId);
    if (!run) return null;
    return {
      sourceRunId,
      status: projectProductThreadStatus({
        runStatus: run.status,
        admissionState: run.admissionState,
        queueReason: run.queueReason,
        cancelIntent: run.cancelCount > 0,
      }),
      summary: !run.summary
        ? null
        : run.summary.length > 1_000
          ? `${run.summary.slice(0, 999)}…`
          : run.summary,
    };
  };
  return relationships.flatMap((relationship) => {
    const latest = latestByThread.get(relationship.threadId);
    if (!latest) return [];
    const bot = botByThread.get(relationship.threadId) ?? null;
    const followUpOutcomes = bot
      ? (followUpsByThread.get(relationship.threadId) ?? [])
          .map(({ sourceRunId, childRunId }) => outcome(sourceRunId, childRunId))
          .filter((item): item is NonNullable<typeof item> => item !== null)
      : [];
    const initialOutcome = bot ? outcome(relationship.sourceRunId, relationship.threadId) : null;
    return [{
      threadId: relationship.threadId,
      parentThreadId: relationship.parentThreadId,
      familyThreadId: relationship.familyThreadId,
      kind: relationship.kind,
      title: relationship.title,
      sourceRunId: relationship.sourceRunId,
      sourceExecutionId: relationship.sourceExecutionId,
      status: projectProductThreadStatus({
        runStatus: latest.status,
        admissionState: latest.admissionState,
        queueReason: latest.queueReason,
        cancelIntent: latest.cancelCount > 0,
      }),
      engine: latest.engine,
      model: latest.model,
      latestRunId: latest.id,
      latestSummary: !latest.summary
        ? null
        : latest.summary.length > 1_000
          ? `${latest.summary.slice(0, 999)}…`
          : latest.summary,
      latestDurationMs: latest.durationMs,
      latestActivityAt: latest.updatedAt,
      createdAt: relationship.createdAt,
      updatedAt: relationship.updatedAt,
      bot,
      handoffOutcomes: initialOutcome ? [initialOutcome, ...followUpOutcomes] : followUpOutcomes,
      followUpRunIds: followUpOutcomes.map((item) => item.sourceRunId),
    }];
  });
}

export async function getThreadRelationshipView(
  orgId: string,
  threadId: string,
): Promise<ThreadRelationshipView | null> {
  const relationship = await getThreadRelationship(orgId, threadId);
  if (!relationship) return null;
  return (await latestViews(orgId, [relationship], db))[0] ?? null;
}

/** Customer boundary: a relationship is public only when its family anchor is
 * an ordinary root run. This also hides any legacy internal rows. */
export async function getPublicThreadRelationshipView(
  orgId: string,
  threadId: string,
): Promise<ThreadRelationshipView | null> {
  const relationship = await getThreadRelationship(orgId, threadId);
  if (!relationship) return null;
  const [publicRoot] = await db.select({ id: runs.id }).from(runs).where(and(
    eq(runs.orgId, orgId),
    eq(runs.id, relationship.familyThreadId),
    eq(runs.threadId, relationship.familyThreadId),
    sql`${runs.parentRunId} is null`,
    sql`${runs.origin} is null`,
  )).limit(1);
  if (!publicRoot) return null;
  return (await latestViews(orgId, [relationship], db))[0] ?? null;
}

export async function listThreadFamilyChildren(input: {
  readonly orgId: string;
  readonly familyThreadId: string;
  readonly limit: number;
  readonly after?: ThreadRelationshipCursor | null;
}): Promise<{
  readonly children: readonly ThreadRelationshipView[];
  readonly hasMore: boolean;
  readonly next: ThreadRelationshipCursor | null;
}> {
  const bounded = Math.min(100, Math.max(1, input.limit));
  const rows = await db.select({
    ...getTableColumns(threadRelationships),
    cursorCreatedAtMicros: sql<string>`((extract(epoch from ${threadRelationships.createdAt}) * 1000000)::bigint)::text`,
  }).from(threadRelationships).where(and(
    eq(threadRelationships.orgId, input.orgId),
    eq(threadRelationships.familyThreadId, input.familyThreadId),
    sql`${threadRelationships.threadId} <> ${input.familyThreadId}`,
    input.after
      ? sql`(${threadRelationships.createdAt}, ${threadRelationships.threadId}) > (${cursorTimestamp(input.after.createdAtMicros)}, ${input.after.threadId})`
      : undefined,
  )).orderBy(asc(threadRelationships.createdAt), asc(threadRelationships.threadId)).limit(bounded + 1);
  const hasMore = rows.length > bounded;
  const candidates = rows.slice(0, bounded);
  const last = candidates.at(-1);
  return {
    children: await latestViews(input.orgId, candidates, db),
    hasMore,
    next: hasMore && last
      ? { createdAtMicros: last.cursorCreatedAtMicros, threadId: last.threadId }
      : null,
  };
}

export async function listDirectThreadChildren(input: {
  readonly orgId: string;
  readonly parentThreadId: string;
  readonly limit: number;
}): Promise<readonly ThreadRelationshipView[]> {
  const bounded = Math.min(100, Math.max(1, input.limit));
  const rows = await db.select().from(threadRelationships).where(and(
    eq(threadRelationships.orgId, input.orgId),
    eq(threadRelationships.parentThreadId, input.parentThreadId),
  )).orderBy(asc(threadRelationships.createdAt), asc(threadRelationships.threadId)).limit(bounded);
  return latestViews(input.orgId, rows, db);
}

export async function listOrgThreadRelationships(input: {
  readonly orgId: string;
  readonly limit: number;
  readonly after?: ThreadRelationshipCursor | null;
}): Promise<{
  readonly relationships: readonly ThreadRelationshipView[];
  readonly hasMore: boolean;
  readonly next: ThreadRelationshipCursor | null;
}> {
  const bounded = Math.min(200, Math.max(1, input.limit));
  const rows = await db.select({
    ...getTableColumns(threadRelationships),
    cursorCreatedAtMicros: sql<string>`((extract(epoch from ${threadRelationships.createdAt}) * 1000000)::bigint)::text`,
  }).from(threadRelationships).where(and(
    eq(threadRelationships.orgId, input.orgId),
    // The same customer boundary as getPublicThreadRelationshipView: the FAMILY
    // anchor must be an ordinary root run. Judging each row by its own run hid
    // every bot handoff child (their runs carry the bot-handoff origin) from the
    // sidebar and the palette while /children still listed them.
    sql`exists (
      select 1 from runs relationship_root
      where relationship_root.org_id = ${input.orgId}
        and relationship_root.id = ${threadRelationships.familyThreadId}
        and relationship_root.thread_id = ${threadRelationships.familyThreadId}
        and relationship_root.parent_run_id is null
        and relationship_root.origin is null
    )`,
    input.after
      ? sql`(${threadRelationships.createdAt}, ${threadRelationships.threadId}) < (${cursorTimestamp(input.after.createdAtMicros)}, ${input.after.threadId})`
      : undefined,
  )).orderBy(desc(threadRelationships.createdAt), desc(threadRelationships.threadId)).limit(bounded + 1);
  const hasMore = rows.length > bounded;
  const candidates = rows.slice(0, bounded);
  const familyIds = [...new Set(candidates.map((row) => row.familyThreadId))];
  const familyRoots = familyIds.length === 0 ? [] : await db.select({
    ...getTableColumns(threadRelationships),
    cursorCreatedAtMicros: sql<string>`((extract(epoch from ${threadRelationships.createdAt}) * 1000000)::bigint)::text`,
  }).from(threadRelationships).where(and(
    eq(threadRelationships.orgId, input.orgId),
    inArray(threadRelationships.threadId, familyIds),
    sql`${threadRelationships.threadId} = ${threadRelationships.familyThreadId}`,
  ));
  const combined = new Map([...candidates, ...familyRoots].map((row) => [row.threadId, row]));
  const ordered = [...combined.values()].sort((left, right) => {
    const leftMicros = BigInt(left.cursorCreatedAtMicros);
    const rightMicros = BigInt(right.cursorCreatedAtMicros);
    if (leftMicros !== rightMicros) return leftMicros > rightMicros ? -1 : 1;
    return right.threadId.localeCompare(left.threadId);
  });
  const relationships = await latestViews(input.orgId, ordered, db);
  const last = candidates.at(-1);
  return {
    relationships,
    hasMore,
    next: hasMore && last
      ? { createdAtMicros: last.cursorCreatedAtMicros, threadId: last.threadId }
      : null,
  };
}

export async function assertNoThreadRelationshipCycle(input: {
  readonly orgId: string;
  readonly parentThreadId: string;
  readonly childThreadId: string;
}, exec: Executor = db): Promise<void> {
  if (input.parentThreadId === input.childThreadId) throw new Error("thread relationship cycle");
  const result = await exec.execute(sql`
    with recursive ancestors(thread_id, parent_thread_id, depth) as (
      select thread_id, parent_thread_id, 1 from thread_relationships
      where org_id = ${input.orgId} and thread_id = ${input.parentThreadId}
      union all
      select r.thread_id, r.parent_thread_id, a.depth + 1
      from thread_relationships r join ancestors a on r.thread_id = a.parent_thread_id
      where r.org_id = ${input.orgId} and a.depth < 100
    )
    select 1 from ancestors where thread_id = ${input.childThreadId} limit 1`);
  if (result.length > 0) throw new Error("thread relationship cycle");
}
