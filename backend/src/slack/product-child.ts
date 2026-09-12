import type { Executor } from "../db/client";
import { env } from "../env";
import { enqueuePostMessageTx } from "./outbox";
import { createSlackRunResponse, findSlackThreadForProductThread } from "./repo";
import { sessionUrl } from "./card";
import { slackPlainLabel } from "./mrkdwn";

/** Attach a newly accepted product child to its family's Slack thread and
 * enqueue one compact, idempotent start notice in the SAME transaction. */
export async function enqueueProductChildStartedTx(input: {
  readonly exec: Executor;
  readonly orgId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly title: string;
}): Promise<boolean> {
  const target = await findSlackThreadForProductThread(input.orgId, input.threadId, input.exec);
  if (!target) return false;
  await createSlackRunResponse({ runId: input.runId, ...target }, input.exec);
  const url = sessionUrl(env.FRONTEND_ORIGIN, input.threadId);
  const title = slackPlainLabel(input.title) || "Untitled child";
  return enqueuePostMessageTx(input.exec, {
    idempotencyKey: `slack-child:started:${target.teamId}:${input.runId}`,
    orgId: input.orgId,
    teamId: target.teamId,
    channel: target.channel,
    threadTs: target.threadTs,
    text: `Started child: *${title}* · <${url}|Open child session>`,
  });
}
