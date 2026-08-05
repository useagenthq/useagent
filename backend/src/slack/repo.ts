/**
 * Slack thread ↔ run mapping. One row per Slack thread the bot has rooted,
 * keyed by `(channel, thread root ts)`. The FIRST bot interaction in a Slack
 * thread creates a skynet ROOT run and links it here; every later message in
 * that Slack thread resolves to the root and becomes a `parent_run_id` reply,
 * so the thread stays one skynet conversation with clean, un-nested prompts.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { slackThreads } from "../db/schema";

export interface SlackThreadLink {
  rootRunId: string;
  orgId: string;
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
