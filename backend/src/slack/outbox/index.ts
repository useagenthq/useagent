// Public surface of the durable Slack outbox. Callers enqueue an outbound call
// (idempotent) and the relay delivers it durably; internal repo/delivery/types
// decomposition stays private.
import { enqueue } from "./repo";
import { kickSlackOutbox } from "./delivery";
import type { Executor } from "../../db/client";

export { startSlackOutboxRelay, stopSlackOutboxRelay, kickSlackOutbox, processDue } from "./delivery";
export { resetStuckDelivering, getByKey as getSlackOutbox } from "./repo";
export type { SlackOutboxRow } from "./repo";

/** Enqueue a run-completion reply INSIDE a caller's transaction (run
 *  finalization), so the reply commits atomically with the run reaching terminal.
 *  Returns whether a NEW row was created; the caller kicks the relay AFTER commit
 *  (the row isn't visible to the relay until then). */
export async function enqueuePostMessageTx(
  exec: Executor,
  entry: { idempotencyKey: string; channel: string; text: string; threadTs?: string },
): Promise<boolean> {
  return enqueue(
    {
      kind: "post_message",
      idempotencyKey: entry.idempotencyKey,
      payload: { channel: entry.channel, text: entry.text, threadTs: entry.threadTs },
    },
    exec,
  );
}

/** Durably enqueue the run-completion reply; the relay delivers it (survives a
 *  restart). Idempotent by `idempotencyKey`. */
export async function enqueuePostMessage(entry: {
  idempotencyKey: string;
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "post_message",
    idempotencyKey: entry.idempotencyKey,
    payload: { channel: entry.channel, text: entry.text, threadTs: entry.threadTs },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue a receipt reaction. Idempotent by `idempotencyKey`. */
export async function enqueueAddReaction(entry: {
  idempotencyKey: string;
  channel: string;
  timestamp: string;
  name: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "add_reaction",
    idempotencyKey: entry.idempotencyKey,
    payload: { channel: entry.channel, timestamp: entry.timestamp, name: entry.name },
  });
  if (created) kickSlackOutbox();
}
