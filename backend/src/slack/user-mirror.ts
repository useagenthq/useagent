import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { commands, member, runs, slackRunResponses, user as authUser } from "../db/schema";
import { enqueuePostMessageTx } from "./outbox";
import { slackMessageBody, slackPlainLabel } from "./mrkdwn";
import { findSlackThreadForProductThread } from "./repo";

type MirrorResult =
  | { readonly status: "not_linked" | "not_user_message" }
  | { readonly status: "ready"; readonly created: boolean; readonly idempotencyKey: string };

function acceptedSource(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { source?: unknown };
    return typeof parsed.source === "string" ? parsed.source : null;
  } catch {
    return null;
  }
}

/** Mirror a product-authored turn into an already linked Slack thread. The bot
 * speaks honestly on the user's behalf; it never impersonates a Slack member.
 * The durable command payload is the trusted channel provenance. The response
 * row check keeps pre-provenance Slack runs from echoing during an upgrade. */
export async function enqueueSlackUserMirrorForRun(
  runId: string,
  exec: Executor = db,
): Promise<MirrorResult> {
  const [run] = await exec.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run?.orgId || !run.userId || run.origin !== null) {
    return { status: "not_user_message" };
  }
  const [command] = await exec
    .select({ payload: commands.payload })
    .from(commands)
    .where(and(eq(commands.runId, run.id), eq(commands.kind, "run.create")))
    .limit(1);
  if (!command) return { status: "not_user_message" };
  if (acceptedSource(command.payload) === "slack") {
    return { status: "not_user_message" };
  }
  const [legacySlackResponse] = await exec
    .select({ runId: slackRunResponses.runId })
    .from(slackRunResponses)
    .where(eq(slackRunResponses.runId, run.id))
    .limit(1);
  if (legacySlackResponse) return { status: "not_user_message" };

  const thread = await findSlackThreadForProductThread(run.orgId, run.threadId, exec);
  if (!thread) return { status: "not_linked" };
  const [actor] = await exec
    .select({ name: authUser.name })
    .from(authUser)
    .innerJoin(
      member,
      and(eq(member.userId, authUser.id), eq(member.organizationId, run.orgId)),
    )
    .where(eq(authUser.id, run.userId))
    .limit(1);
  if (!actor) return { status: "not_user_message" };

  const idempotencyKey = `slack-web-user:${thread.teamId}:${run.id}`;
  const created = await enqueuePostMessageTx(exec, {
    idempotencyKey,
    orgId: run.orgId,
    teamId: thread.teamId,
    channel: thread.channel,
    threadTs: thread.threadTs,
    runId: run.id,
    messageRole: "user_mirror",
    text: `From ${slackPlainLabel(actor.name)} in useAgent:\n${slackMessageBody(run.prompt)}`,
  });
  return { status: "ready", created, idempotencyKey };
}
