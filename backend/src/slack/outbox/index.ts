// Public surface of the durable Slack outbox. Callers enqueue an outbound call
// (idempotent) and the relay delivers it durably; internal repo/delivery/types
// decomposition stays private.
import { enqueue } from "./repo";
import { kickSlackOutbox } from "./delivery";
import { chunkSlackText } from "../chunk";
import type { Executor } from "../../db/client";

export { startSlackOutboxRelay, stopSlackOutboxRelay, kickSlackOutbox, processDue } from "./delivery";
export { resetStuckDelivering, getByKey as getSlackOutbox } from "./repo";
export type { SlackOutboxRow } from "./repo";

/** Enqueue a run-completion reply INSIDE a caller's transaction (run
 *  finalization), so the reply commits atomically with the run reaching terminal.
 *  A long text is CHUNKED into sequential thread messages here - the one place
 *  every post_message enqueue passes through - never truncated (see ../chunk.ts).
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
      payload: { channel: entry.channel, chunks: chunkSlackText(entry.text), threadTs: entry.threadTs },
    },
    exec,
  );
}

/** Enqueue an artifact upload INSIDE a caller's transaction (run finalization),
 *  mirroring enqueuePostMessageTx: the file share commits atomically with the
 *  run reaching terminal. Returns whether a NEW row was created. */
export async function enqueueUploadFileTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    channel: string;
    threadTs?: string;
    filename: string;
    title?: string;
    artifactId: string;
    size: number;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "upload_file",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        channel: entry.channel,
        threadTs: entry.threadTs,
        filename: entry.filename,
        title: entry.title,
        artifactId: entry.artifactId,
        size: entry.size,
      },
    },
    exec,
  );
}

/** Durably enqueue an outbound message; the relay delivers it (survives a
 *  restart). Long texts chunk exactly like enqueuePostMessageTx. Idempotent by
 *  `idempotencyKey`. */
export async function enqueuePostMessage(entry: {
  idempotencyKey: string;
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "post_message",
    idempotencyKey: entry.idempotencyKey,
    payload: { channel: entry.channel, chunks: chunkSlackText(entry.text), threadTs: entry.threadTs },
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

/** Durably enqueue an artifact upload into a thread. The relay reads the same
 * immutable artifact bytes served to the browser. Idempotent by key. */
export async function enqueueUploadFile(entry: {
  idempotencyKey: string;
  channel: string;
  threadTs?: string;
  filename: string;
  title?: string;
  artifactId: string;
  size: number;
}): Promise<void> {
  const created = await enqueue({
    kind: "upload_file",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      channel: entry.channel,
      threadTs: entry.threadTs,
      filename: entry.filename,
      title: entry.title,
      artifactId: entry.artifactId,
      size: entry.size,
    },
  });
  if (created) kickSlackOutbox();
}
