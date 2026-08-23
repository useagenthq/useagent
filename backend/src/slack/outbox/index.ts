// Public surface of the durable Slack outbox. Callers enqueue an outbound call
// (idempotent) and the relay delivers it durably; internal repo/delivery/types
// decomposition stays private.
import { enqueue } from "./repo";
import { kickSlackOutbox } from "./delivery";
import { chunkSlackText } from "../chunk";
import type { Executor } from "../../db/client";
import type { SlackSessionStatus, SlackStreamChunk, SlackStreamTaskDisplayMode } from "../streaming";

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
  entry: {
    idempotencyKey: string;
    teamId?: string;
    channel: string;
    text: string;
    threadTs?: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "post_message",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        teamId: entry.teamId,
        channel: entry.channel,
        chunks: chunkSlackText(entry.text),
        threadTs: entry.threadTs,
      },
    },
    exec,
  );
}

/** Enqueue the FINAL run-card update INSIDE a caller's transaction (run
 *  finalization), so the settled card commits atomically with the run reaching
 *  terminal. At delivery it advances the card in place (chat.update) or, when no
 *  card ts exists, posts the CHUNKED answer as a fresh reply - the answer is never
 *  lost. Returns whether a NEW row was created. */
export async function enqueueUpdateCardTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    teamId: string;
    channel: string;
    threadTs: string;
    runId: string;
    blocks: unknown[];
    text: string;
    /** The full answer text; chunked here so a long fallback stays postable. */
    fallbackText: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "update_card",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        channel: entry.channel,
        teamId: entry.teamId,
        threadTs: entry.threadTs,
        runId: entry.runId,
        blocks: entry.blocks,
        text: entry.text,
        fallbackChunks: chunkSlackText(entry.fallbackText),
      },
    },
    exec,
  );
}

export async function enqueueStopStreamTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    teamId: string;
    channel: string;
    threadTs: string;
    runId: string;
    chunks: readonly SlackStreamChunk[];
    blocks: readonly unknown[];
    text: string;
    fallbackText: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "stop_stream",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        channel: entry.channel,
        teamId: entry.teamId,
        threadTs: entry.threadTs,
        runId: entry.runId,
        chunks: entry.chunks,
        blocks: entry.blocks,
        text: entry.text,
        fallbackChunks: chunkSlackText(entry.fallbackText),
      },
    },
    exec,
  );
}

export async function enqueueSessionStatusTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    teamId: string;
    channel: string;
    threadTs: string;
    status: SlackSessionStatus;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "set_session_status",
      idempotencyKey: entry.idempotencyKey,
      payload: { teamId: entry.teamId, channel: entry.channel, threadTs: entry.threadTs, status: entry.status },
    },
    exec,
  );
}

export async function enqueueStartStreamTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    teamId: string;
    channel: string;
    threadTs: string;
    runId: string;
    taskDisplayMode: SlackStreamTaskDisplayMode;
    chunks: readonly SlackStreamChunk[];
    fallbackBlocks: readonly unknown[];
    fallbackText: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "start_stream",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        channel: entry.channel,
        teamId: entry.teamId,
        threadTs: entry.threadTs,
        runId: entry.runId,
        taskDisplayMode: entry.taskDisplayMode,
        chunks: entry.chunks,
        fallbackBlocks: entry.fallbackBlocks,
        fallbackText: entry.fallbackText,
      },
    },
    exec,
  );
}

export async function enqueueAddReactionTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    teamId?: string;
    channel: string;
    timestamp: string;
    name: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "add_reaction",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        teamId: entry.teamId,
        channel: entry.channel,
        timestamp: entry.timestamp,
        name: entry.name,
      },
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
    teamId?: string;
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
        teamId: entry.teamId,
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
  teamId?: string;
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "post_message",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      teamId: entry.teamId,
      channel: entry.channel,
      chunks: chunkSlackText(entry.text),
      threadTs: entry.threadTs,
    },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue the initial Block Kit RUN CARD post (survives a restart). The
 *  relay posts it and stores the returned message ts on slack_threads. Idempotent
 *  by `idempotencyKey`. */
export async function enqueuePostCard(entry: {
  idempotencyKey: string;
  teamId: string;
  channel: string;
  threadTs: string;
  runId: string;
  blocks: unknown[];
  text: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "post_card",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      channel: entry.channel,
      teamId: entry.teamId,
      threadTs: entry.threadTs,
      runId: entry.runId,
      blocks: entry.blocks,
      text: entry.text,
    },
  });
  if (created) kickSlackOutbox();
}

export async function enqueueStartStream(entry: {
  idempotencyKey: string;
  teamId: string;
  channel: string;
  threadTs: string;
  runId: string;
  taskDisplayMode: SlackStreamTaskDisplayMode;
  chunks: readonly SlackStreamChunk[];
  fallbackBlocks: readonly unknown[];
  fallbackText: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "start_stream",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      channel: entry.channel,
      teamId: entry.teamId,
      threadTs: entry.threadTs,
      runId: entry.runId,
      taskDisplayMode: entry.taskDisplayMode,
      chunks: entry.chunks,
      fallbackBlocks: entry.fallbackBlocks,
      fallbackText: entry.fallbackText,
    },
  });
  if (created) kickSlackOutbox();
}

export async function enqueueAppendStream(entry: {
  idempotencyKey: string;
  teamId: string;
  channel: string;
  threadTs: string;
  runId: string;
  chunks: readonly SlackStreamChunk[];
  fallbackBlocks: readonly unknown[];
  fallbackText: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "append_stream",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      channel: entry.channel,
      teamId: entry.teamId,
      threadTs: entry.threadTs,
      runId: entry.runId,
      chunks: entry.chunks,
      fallbackBlocks: entry.fallbackBlocks,
      fallbackText: entry.fallbackText,
    },
  });
  if (created) kickSlackOutbox();
}

export async function enqueueSessionStatus(entry: {
  idempotencyKey: string;
  teamId: string;
  channel: string;
  threadTs: string;
  status: SlackSessionStatus;
}): Promise<void> {
  const created = await enqueue({
    kind: "set_session_status",
    idempotencyKey: entry.idempotencyKey,
    payload: { teamId: entry.teamId, channel: entry.channel, threadTs: entry.threadTs, status: entry.status },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue a receipt reaction. Idempotent by `idempotencyKey`. */
export async function enqueueAddReaction(entry: {
  idempotencyKey: string;
  teamId?: string;
  channel: string;
  timestamp: string;
  name: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "add_reaction",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      teamId: entry.teamId,
      channel: entry.channel,
      timestamp: entry.timestamp,
      name: entry.name,
    },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue an artifact upload into a thread. The relay reads the same
 * immutable artifact bytes served to the browser. Idempotent by key. */
export async function enqueueUploadFile(entry: {
  idempotencyKey: string;
  teamId?: string;
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
      teamId: entry.teamId,
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
