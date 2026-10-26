"use client";

// Messages the agent has not started yet, as numbered rows above the reply
// composer (never bubbles in the transcript). The backend runs ONE live turn
// per thread and queues replies as serial FIFO turns, so a row states its
// honest place in line. "Send now" is the EXISTING steering action (cancel the
// running turn; the lane promotes the head queued turn), offered on the head
// row only so the order is preserved. "Remove" is the same durable cancel on
// the queued run itself, which the API fails before it ever starts.

import { RiCloseLine } from "@remixicon/react";
import { useState } from "react";

export interface QueuedMessage {
  readonly id: string;
  /** 1-based place in the thread's whole serial queue (gateway children count). */
  readonly position: number;
  readonly text: string;
  /** Still being accepted by the API (the optimistic reply): no actions yet. */
  readonly pending?: boolean;
}

function Row({
  message,
  onSendNow,
  onRemove,
}: {
  message: QueuedMessage;
  onSendNow?: () => void;
  onRemove?: (id: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const remove = async () => {
    if (!onRemove || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onRemove(message.id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-session-ui="queued-message"
      className="flex items-center gap-2 rounded-lg border border-border-button-default bg-background-secondary-default px-2.5 py-1.5 text-body-2-regular"
    >
      <span className="w-4 shrink-0 text-right font-mono text-caption-1-regular text-text-tertiary tabular-nums">
        {message.position}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-primary">{message.text}</span>
      {failed && <span className="shrink-0 text-caption-1-regular text-text-error-primary">Could not remove</span>}
      {onSendNow && !message.pending && (
        <button
          type="button"
          onClick={onSendNow}
          title="Skips the waiting messages; this message is sent next"
          className="shrink-0 cursor-pointer text-caption-1-medium text-accent-500 underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          Send now
        </button>
      )}
      {onRemove && !message.pending && (
        <button
          type="button"
          aria-label={`Remove queued message ${message.position}`}
          title="Remove from the queue"
          disabled={busy}
          onClick={() => void remove()}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RiCloseLine className="size-4" aria-hidden />
        </button>
      )}
    </li>
  );
}

export function QueuedMessages({
  messages,
  sendNowFor,
  onSendNow,
  onRemove,
}: {
  /** Queue order, head first. */
  messages: readonly QueuedMessage[];
  /** Id of the message that may be sent now (the head of the whole queue while a turn runs). */
  sendNowFor?: string | null;
  onSendNow?: () => void;
  onRemove?: (id: string) => Promise<void> | void;
}) {
  if (messages.length === 0) return null;
  return (
    // Bounded: a long queue scrolls inside its own box so the input below stays reachable.
    <ol
      data-session-ui="queued-messages"
      aria-label="Queued messages"
      className="scrollbar-slim mb-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto"
    >
      {messages.map((message) => (
        <Row
          key={message.id}
          message={message}
          onSendNow={message.id === sendNowFor ? onSendNow : undefined}
          onRemove={onRemove}
        />
      ))}
    </ol>
  );
}
