"use client";

// Messages the agent has not started yet, as numbered rows above the reply
// composer (never bubbles in the transcript). The backend runs ONE live turn
// per thread and queues replies as serial FIFO turns, so a row states its
// honest place in line. "Send now" is the EXISTING steering action (cancel the
// running turn; the lane promotes the head queued turn), offered on the head
// row only so the order is preserved. "Remove" is the same durable cancel on
// the queued run itself, which the API fails before it ever starts.

import { RiCloseLine } from "@remixicon/react";
import { useRef, useState } from "react";

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
  index,
  onSendNow,
  onRemove,
}: {
  message: QueuedMessage;
  /** Place of this row in the rendered list; the anchor for focus after removal. */
  index: number;
  onSendNow?: () => void;
  onRemove?: (id: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const remove = async () => {
    if (!onRemove || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onRemove(message.id);
      // The app only sends the cancel here; the row leaves the list later,
      // when the thread updates. Focus a control that survives either way -
      // the next row's Remove, the previous row's when this was the last, or
      // the reply box when no other row remains - and never this row's own
      // button, which is about to unmount and would drop focus to the page.
      const own = removeButtonRef.current;
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-session-ui="queued-messages"] [aria-label^="Remove queued message"]',
        ),
      ].filter((button) => button !== own);
      if (buttons.length > 0) {
        buttons[Math.min(index, buttons.length - 1)]?.focus();
      } else {
        document
          .querySelector<HTMLElement>('[data-session-ui="reply-composer"] textarea')
          ?.focus();
      }
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
          title="Stops the current turn; this message starts immediately"
          className="shrink-0 cursor-pointer text-caption-1-medium text-accent-500 underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          Send now
        </button>
      )}
      {onRemove && !message.pending && (
        <button
          ref={removeButtonRef}
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
      {messages.map((message, index) => (
        <Row
          key={message.id}
          message={message}
          index={index}
          onSendNow={message.id === sendNowFor ? onSendNow : undefined}
          onRemove={onRemove}
        />
      ))}
    </ol>
  );
}
