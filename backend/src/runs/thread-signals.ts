import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Thread-change signal — a narrowly scoped, IN-PROCESS wake for connected thread
// streams (final_fix.md §4.5). Its ONLY job is to nudge an open
// `GET /api/runs/:rootRunId/thread-events` connection after committed product
// state changes, so an externally accepted run (Slack / schedules / Skills Run)
// or a queued-run cancellation becomes visible without the normal five-second
// discovery poll.
//
// This is NOT durable and makes NO cross-replica guarantee: the database stays
// the source of truth, and a missed signal is repaired by EventSource reconnect
// + full snapshot replay. Payloads carry IDs only — never secrets or provider
// payloads. Kept in its own module (imports nothing from the worker) so the
// lifecycle seams that publish it — command acceptance, run finalize, cancel,
// the worker's running transition — stay decoupled.
// ---------------------------------------------------------------------------

/** What moved a run to a state a connected thread stream should re-project. */
export type ThreadChangeKind = "created" | "running" | "settled" | "cancelled";

/** A committed thread change — IDs only, no payload. */
export interface ThreadChange {
  readonly runId: string;
  readonly kind: ThreadChangeKind;
}

export type ThreadChangeListener = (change: ThreadChange) => void;

const threadBus = new EventEmitter();
threadBus.setMaxListeners(0); // any number of concurrent thread-stream connections

const threadChannel = (threadId: string): string => `thread:${threadId}`;

/**
 * Subscribe to a thread's change signals. The listener is wrapped so a throwing
 * listener can never break the emitting lifecycle path (run acceptance / finalize
 * must not fail because one connection's handler threw). Returns an unsubscribe.
 */
export function subscribeThread(
  threadId: string,
  listener: ThreadChangeListener,
): () => void {
  const ch = threadChannel(threadId);
  const guarded: ThreadChangeListener = (change) => {
    try {
      listener(change);
    } catch (err) {
      console.error(`[thread-signals] listener threw for thread ${threadId}:`, err);
    }
  };
  threadBus.on(ch, guarded);
  return () => threadBus.off(ch, guarded);
}

/**
 * Publish a committed thread change to any connected stream. MUST be called only
 * AFTER the database transaction commits (a stream that wakes and re-reads must
 * see the committed state). Fire-and-forget and self-contained: it never throws
 * into the caller, so a lifecycle seam can publish without a guard of its own.
 */
export function publishThreadChange(threadId: string, change: ThreadChange): void {
  try {
    threadBus.emit(threadChannel(threadId), change);
  } catch (err) {
    console.error(`[thread-signals] publish failed for thread ${threadId}:`, err);
  }
}
