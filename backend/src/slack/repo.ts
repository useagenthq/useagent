/**
 * Slack thread ↔ run mapping. One row per Slack thread the bot has rooted,
 * keyed by `(channel, thread root ts)`. The FIRST bot interaction in a Slack
 * thread creates a skynet ROOT run and links it here; every later message in
 * that Slack thread resolves to the root and becomes a `parent_run_id` reply,
 * so the thread stays one skynet conversation with clean, un-nested prompts.
 */
import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { slackThreads } from "../db/schema";

export interface SlackThreadLink {
  rootRunId: string;
  orgId: string;
}

/** Where a Slack-originated run's reply must be posted (the thread it rooted).
 *  `cardTs` is the Block Kit run card's message ts when one has been posted, so a
 *  final update targets the SAME card (null = no card yet; post a fresh reply). */
export interface SlackThreadTarget {
  channel: string;
  threadTs: string;
  cardTs: string | null;
}

/** The skynet root run for a Slack thread, or null if the bot hasn't engaged it. */
export async function findSlackThread(
  channel: string,
  threadTs: string,
): Promise<SlackThreadLink | null> {
  const [row] = await db
    .select({ rootRunId: slackThreads.rootRunId, orgId: slackThreads.orgId })
    .from(slackThreads)
    .where(and(eq(slackThreads.channel, channel), eq(slackThreads.threadTs, threadTs)))
    .limit(1);
  return row ?? null;
}

/** The Slack channel + thread ts a run's reply belongs in, resolved from the run's
 *  THREAD (a Slack thread's `rootRunId` equals the skynet thread id every run in
 *  it shares). Null for a non-Slack run. Takes an Executor so run finalization can
 *  resolve it inside the finalization transaction. */
export async function findSlackThreadByRoot(
  rootRunId: string,
  exec: Executor = db,
): Promise<SlackThreadTarget | null> {
  const [row] = await exec
    .select({
      channel: slackThreads.channel,
      threadTs: slackThreads.threadTs,
      cardTs: slackThreads.cardTs,
    })
    .from(slackThreads)
    .where(eq(slackThreads.rootRunId, rootRunId))
    .limit(1);
  return row ?? null;
}

/** Link a Slack thread to the run that rooted it. Idempotent: a duplicate
 * (channel, threadTs) from a Slack retry race is ignored, keeping the original. */
export async function linkSlackThread(input: {
  channel: string;
  threadTs: string;
  rootRunId: string;
  orgId: string;
}): Promise<void> {
  await db.insert(slackThreads).values(input).onConflictDoNothing();
}

/** Persist the Block Kit run card's message ts on the thread it was posted into,
 *  so later progress/completion updates target the SAME card. Keyed by
 *  (channel, threadTs) - the card lives in exactly one thread. */
export async function setSlackCardTs(
  channel: string,
  threadTs: string,
  cardTs: string,
): Promise<void> {
  await db
    .update(slackThreads)
    .set({ cardTs })
    .where(and(eq(slackThreads.channel, channel), eq(slackThreads.threadTs, threadTs)));
}

/** The run card's message ts for a rooted Slack thread (null before it is posted).
 *  Used by the live-progress watcher to advance the card in place. */
export async function getSlackCardTsByRoot(rootRunId: string): Promise<{
  channel: string;
  threadTs: string;
  cardTs: string | null;
} | null> {
  const [row] = await db
    .select({
      channel: slackThreads.channel,
      threadTs: slackThreads.threadTs,
      cardTs: slackThreads.cardTs,
    })
    .from(slackThreads)
    .where(eq(slackThreads.rootRunId, rootRunId))
    .limit(1);
  return row ?? null;
}
