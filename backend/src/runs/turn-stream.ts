// ---------------------------------------------------------------------------
// Turn-stream — per-run, in-memory delta channel for LIVE assistant narration.
//
// The durable step log (Postgres) is discrete and arrives after a DB round-trip,
// so it can't carry live-typing text. This buffer gives the UI a fast, ephemeral
// channel: an engine publishes assistant-text deltas as they stream, and SSE
// subscribers receive each delta immediately (no DB in the path). Postgres stays
// the source of truth for replay — this buffer self-evicts a grace period after
// end(), and its contents are never authoritative.
//
// Ported/adapted from reference-eval's src/runs/turn-stream.ts: same capped-buffer +
// grace-timer + subscribe/unsubscribe shape, trimmed to our step model (the
// Slack-only first-block / surface-posted machinery has no consumer here, so it
// is intentionally dropped). Listeners here receive EACH delta (the live-typing
// channel), where QM's listeners were notified of Slack lifecycle events only.
// ---------------------------------------------------------------------------

/** A live delta's classification: undefined = answer text (buffered for late-
 *  subscriber catch-up); "reasoning" = provider thinking (fanned out live only,
 *  never buffered, so the catch-up snapshot stays pure answer narration). */
export type DeltaKind = "reasoning";

export type TurnStreamListener = (delta: string, kind?: DeltaKind) => void;

export interface TurnStream {
  /** Mark a run's stream open (idempotent); cancels a pending grace eviction. */
  begin(runId: string): void;
  /** Whether the run is currently streaming (not yet end()ed). */
  alive(runId: string): boolean;
  /** Append a delta to the capped buffer and fan it out to live subscribers.
   *  Only answer deltas (no `kind`) are buffered; "reasoning" is live-only. */
  publish(runId: string, delta: string, kind?: DeltaKind): void;
  /** The full buffered text so far, or null if nothing has been published. */
  snapshot(runId: string): string | null;
  /** Subscribe to a run's deltas; returns an unsubscribe fn. */
  subscribe(runId: string, listener: TurnStreamListener): () => void;
  /** Mark the stream done and schedule the entry for eviction after graceMs. */
  end(runId: string): void;
}

interface Entry {
  text: string;
  live: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface TurnStreamOptions {
  /** Hard cap on buffered chars per run (older text is not re-buffered). */
  maxChars?: number;
  /** How long after end() the entry lingers (lets a late subscriber snapshot). */
  graceMs?: number;
}

const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_GRACE_MS = 30_000;

export function createTurnStream(opts: TurnStreamOptions = {}): TurnStream {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const runs = new Map<string, Entry>();
  const listeners = new Map<string, Set<TurnStreamListener>>();

  const ensure = (runId: string): Entry => {
    let entry = runs.get(runId);
    if (!entry) {
      entry = { text: "", live: true, timer: null };
      runs.set(runId, entry);
    }
    return entry;
  };

  return {
    begin(runId) {
      const entry = runs.get(runId);
      if (entry) {
        entry.live = true;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
      } else {
        runs.set(runId, { text: "", live: true, timer: null });
      }
    },

    alive(runId) {
      return runs.get(runId)?.live ?? false;
    },

    publish(runId, delta, kind) {
      if (!delta) return;
      const entry = ensure(runId);
      entry.live = true;
      // A delta after end() revives the entry — cancel its pending eviction.
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      // Reasoning is transient live narration; keep it OUT of the buffered
      // answer text so the late-subscriber catch-up snapshot is pure answer.
      if (kind === undefined && entry.text.length < maxChars) {
        entry.text = (entry.text + delta).slice(0, maxChars);
      }
      for (const listener of listeners.get(runId) ?? []) listener(delta, kind);
    },

    snapshot(runId) {
      const text = runs.get(runId)?.text;
      return text ? text : null;
    },

    subscribe(runId, listener) {
      let set = listeners.get(runId);
      if (!set) {
        set = new Set();
        listeners.set(runId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
      };
    },

    end(runId) {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.live = false;
      if (entry.timer) return;
      const timer = setTimeout(() => runs.delete(runId), graceMs);
      timer.unref?.();
      entry.timer = timer;
    },
  };
}

// Process-wide singleton: the worker publishes deltas here, SSE routes subscribe.
// (Single-instance today — a Postgres-backed fan-out for multi-instance is noted
// as future work, matching reference-eval's postgres-session-state-bus, not built here.)
export const turnStream = createTurnStream();
