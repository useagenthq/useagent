// Pure, framework-neutral canonical thread store. Indexes the provider-neutral
// canonical event lane so a sample UI (or the Skynet React hook via Slice 6) can render
// a thread WITHOUT a product store, React, or a provider parser. It owns ONLY the
// canonical lane; the Skynet product keeps its native compatibility projection.
//
// Semantics mirror the proven Skynet store (not a competing pattern):
//   - dedupe by `eventId`, keeping the LATEST `revision` (a stale/duplicate is a no-op);
//   - totally order by `deliverySeq`;
//   - coalesce a replay burst into ONE notification via `batch()`;
//   - `getSnapshot()` returns a STABLE reference until the next mutation (so a
//     useSyncExternalStore-style consumer never tears on an unchanged read).

import type { CanonicalThreadEvent } from "./thread-events";

export interface AgentTranscript {
  /** Canonical events, deduped by eventId (latest revision) + ordered by deliverySeq. */
  readonly events: readonly CanonicalThreadEvent[];
  /** Runs whose canonical projection reached the durable `complete` record (trustworthy). */
  readonly completeRuns: ReadonlySet<string>;
}

export interface CanonicalThreadStore {
  /** Ingest one canonical event. Returns whether the snapshot changed (a duplicate or a
   *  stale/older revision of a known eventId is an idempotent no-op -> false). */
  ingest(event: CanonicalThreadEvent): boolean;
  /** Mark a run's canonical projection complete (idempotent -> false if already marked). */
  markComplete(runId: string): boolean;
  /** Replace the whole index from an authoritative snapshot (reconnect/replay). */
  reconcile(events: readonly CanonicalThreadEvent[], completeRuns?: readonly string[]): void;
  /** Coalesce a burst of mutations into ONE listener notification (replay batching). */
  batch(apply: () => void): void;
  getSnapshot(): AgentTranscript;
  subscribe(listener: () => void): () => void;
}

const EMPTY: AgentTranscript = { events: [], completeRuns: new Set() };

export function createCanonicalThreadStore(): CanonicalThreadStore {
  const byId = new Map<string, CanonicalThreadEvent>(); // eventId -> latest-revision event
  const completeRuns = new Set<string>();
  const listeners = new Set<() => void>();

  let snapshot: AgentTranscript | null = EMPTY;
  let batchDepth = 0;
  let pendingNotify = false;

  const invalidate = (): void => {
    snapshot = null;
  };
  const notify = (): void => {
    if (batchDepth > 0) {
      pendingNotify = true;
      return;
    }
    for (const l of listeners) l();
  };

  /** A newer revision wins; a tie breaks on the higher deliverySeq. */
  const supersedes = (next: CanonicalThreadEvent, prev: CanonicalThreadEvent | undefined): boolean =>
    prev === undefined || next.revision > prev.revision || (next.revision === prev.revision && next.deliverySeq > prev.deliverySeq);

  return {
    ingest(event) {
      if (!supersedes(event, byId.get(event.eventId))) return false;
      byId.set(event.eventId, event);
      invalidate();
      notify();
      return true;
    },

    markComplete(runId) {
      if (completeRuns.has(runId)) return false;
      completeRuns.add(runId);
      invalidate();
      notify();
      return true;
    },

    reconcile(events, complete) {
      byId.clear();
      for (const e of events) {
        if (supersedes(e, byId.get(e.eventId))) byId.set(e.eventId, e);
      }
      completeRuns.clear();
      for (const r of complete ?? []) completeRuns.add(r);
      invalidate();
      notify();
    },

    batch(apply) {
      batchDepth++;
      try {
        apply();
      } finally {
        batchDepth--;
        if (batchDepth === 0 && pendingNotify) {
          pendingNotify = false;
          for (const l of listeners) l();
        }
      }
    },

    getSnapshot() {
      if (snapshot === null) {
        const events = [...byId.values()].sort((a, b) => a.deliverySeq - b.deliverySeq);
        snapshot = { events, completeRuns: new Set(completeRuns) };
      }
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
