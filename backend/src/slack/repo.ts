/**
 * Slack thread ↔ run mapping. One row per Slack thread the bot has rooted,
 * keyed by `(team, channel, thread root ts)`. The FIRST bot interaction in a Slack
 * thread creates a useAgent root run and links it here; every later message in
 * that Slack thread resolves to the root and becomes a `parent_run_id` reply,
 * so the thread stays one useAgent conversation with clean, un-nested prompts.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { slackRunResponses, slackThreads } from "../db/schema";
import type { SlackStreamTaskDisplayMode } from "./streaming";

export interface SlackThreadLink {
  rootRunId: string;
  orgId: string;
}

export interface SlackThreadTarget {
  teamId: string;
  channel: string;
  threadTs: string;
}

export interface SlackRunResponseTarget extends SlackThreadTarget {
  runId: string;
  nativeStreamTs: string | null;
  nativeStreamMode: SlackStreamTaskDisplayMode | null;
  fallbackMessageTs: string | null;
  /** Narration chars the native stream has accepted (offset fence + stop tail). */
  streamedChars: number;
}

/** The useAgent root run for a Slack thread, or null if the bot hasn't engaged it. */
export async function findSlackThread(
  teamId: string,
  channel: string,
  threadTs: string,
): Promise<SlackThreadLink | null> {
  const [row] = await db
    .select({ rootRunId: slackThreads.rootRunId, orgId: slackThreads.orgId })
    .from(slackThreads)
    .where(
      and(
        eq(slackThreads.teamId, teamId),
        eq(slackThreads.channel, channel),
        eq(slackThreads.threadTs, threadTs),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Resolve a Slack thread in the post-team-id schema. During the 0053 migration
 * legacy rows are temporarily stamped `__legacy__`; the first event from the
 * resolved workspace may adopt exactly one matching legacy row, but only when
 * its stored org matches the workspace org. Anything ambiguous or cross-org
 * returns null so ingress fails closed instead of routing across tenants. */
export async function findOrAdoptSlackThread(
  input: { teamId: string; channel: string; threadTs: string; orgId: string },
): Promise<SlackThreadLink | null> {
  return await db.transaction(async (tx) => {
    const [exact] = await tx
      .select({ rootRunId: slackThreads.rootRunId, orgId: slackThreads.orgId })
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.teamId, input.teamId),
          eq(slackThreads.channel, input.channel),
          eq(slackThreads.threadTs, input.threadTs),
        ),
      )
      .limit(1);
    if (exact) return exact.orgId === input.orgId ? exact : null;

    const legacyRows = await tx
      .select({ rootRunId: slackThreads.rootRunId, orgId: slackThreads.orgId })
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.teamId, "__legacy__"),
          eq(slackThreads.channel, input.channel),
          eq(slackThreads.threadTs, input.threadTs),
        ),
      )
      .limit(2);
    if (legacyRows.length !== 1) return null;
    const [legacy] = legacyRows;
    if (!legacy || legacy.orgId !== input.orgId) return null;

    await tx
      .update(slackThreads)
      .set({ teamId: input.teamId })
      .where(
        and(
          eq(slackThreads.teamId, "__legacy__"),
          eq(slackThreads.channel, input.channel),
          eq(slackThreads.threadTs, input.threadTs),
        ),
      );
    await tx
      .update(slackRunResponses)
      .set({ teamId: input.teamId, updatedAt: new Date() })
      .where(
        and(
          eq(slackRunResponses.teamId, "__legacy__"),
          eq(slackRunResponses.channel, input.channel),
          eq(slackRunResponses.threadTs, input.threadTs),
        ),
      );
    return legacy;
  });
}

/** The Slack channel + thread ts a run's reply belongs in, resolved from the run's
 *  THREAD (a Slack thread's `rootRunId` equals the useAgent thread id every run in
 *  it shares). Null for a non-Slack run. Takes an Executor so run finalization can
 *  resolve it inside the finalization transaction. */
export async function findSlackThreadByRoot(
  rootRunId: string,
  exec: Executor = db,
): Promise<SlackThreadTarget | null> {
  const [row] = await exec
    .select({
      teamId: slackThreads.teamId,
      channel: slackThreads.channel,
      threadTs: slackThreads.threadTs,
    })
    .from(slackThreads)
    .where(eq(slackThreads.rootRunId, rootRunId))
    .limit(1);
  return row ?? null;
}

/** Link a Slack thread to the run that rooted it. Idempotent: a duplicate
 * (channel, threadTs) from a Slack retry race is ignored, keeping the original. */
export async function linkSlackThread(input: {
  teamId: string;
  channel: string;
  threadTs: string;
  rootRunId: string;
  orgId: string;
}): Promise<void> {
  await db.insert(slackThreads).values(input).onConflictDoNothing();
}

export async function createSlackRunResponse(
  input: { runId: string; teamId: string; channel: string; threadTs: string },
  exec: Executor = db,
): Promise<void> {
  await exec.insert(slackRunResponses).values(input).onConflictDoNothing();
}

export async function findSlackRunResponse(
  runId: string,
  exec: Executor = db,
): Promise<SlackRunResponseTarget | null> {
  const [row] = await exec
    .select({
      runId: slackRunResponses.runId,
      teamId: slackRunResponses.teamId,
      channel: slackRunResponses.channel,
      threadTs: slackRunResponses.threadTs,
      nativeStreamTs: slackRunResponses.nativeStreamTs,
      nativeStreamMode: slackRunResponses.nativeStreamMode,
      fallbackMessageTs: slackRunResponses.fallbackMessageTs,
      streamedChars: slackRunResponses.streamedChars,
    })
    .from(slackRunResponses)
    .where(eq(slackRunResponses.runId, runId))
    .limit(1);
  return row ?? null;
}

export async function setSlackNativeStream(
  runId: string,
  nativeStreamTs: string,
  nativeStreamMode: SlackStreamTaskDisplayMode,
): Promise<void> {
  await db
    .update(slackRunResponses)
    .set({ nativeStreamTs, nativeStreamMode, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

/** The native stream failed for this run: forget its ts so every later append
 *  and the stop ride the Block Kit card path instead (fall back ONCE, no
 *  doomed per-row stream calls). */
export async function disableSlackNativeStream(runId: string): Promise<void> {
  await db
    .update(slackRunResponses)
    .set({ nativeStreamTs: null, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

/** Count narration chars the native stream ACCEPTED (after a successful append). */
export async function addSlackStreamedChars(runId: string, chars: number): Promise<void> {
  if (chars <= 0) return;
  await db
    .update(slackRunResponses)
    .set({ streamedChars: sql`${slackRunResponses.streamedChars} + ${chars}`, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

export async function setSlackFallbackMessageTs(runId: string, fallbackMessageTs: string): Promise<void> {
  await db
    .update(slackRunResponses)
    .set({ fallbackMessageTs, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

/** Compatibility wrapper for pre-native-stream card rows. New native delivery
 *  paths store card/fallback timestamps on slack_run_responses instead. */
export async function setSlackCardTs(
  rootRunId: string,
  cardTs: string,
): Promise<void> {
  await setSlackFallbackMessageTs(rootRunId, cardTs);
}

export async function getSlackCardTsByRoot(rootRunId: string): Promise<{
  teamId: string;
  channel: string;
  threadTs: string;
  cardTs: string | null;
} | null> {
  const response = await findSlackRunResponse(rootRunId);
  if (response) {
    return {
      teamId: response.teamId,
      channel: response.channel,
      threadTs: response.threadTs,
      cardTs: response.fallbackMessageTs,
    };
  }
  const thread = await findSlackThreadByRoot(rootRunId);
  return thread ? { ...thread, cardTs: null } : null;
}
