"use client";

// Fetch lane for gateway approvals (#77). NOT a polling loop: the thread's
// durable requests are read once on mount, then re-read only when a run's
// approval-signal SIGNATURE changes, which the thread SSE re-projects whenever
// an approval event lands/resolves (thread-store merge -> new turns -> new
// signature -> one revalidate). `refresh` is the manual nudge after this client
// resolves (or loses a 409 race on) an approval. Resolved requests stay in the
// list: a card that was approved or denied is thread history and survives reload.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGatewayApprovals, type GatewayApproval } from "@/lib/gateway-approvals";

export interface GatewayApprovalSignal {
  readonly runId: string;
  /** From gatewayApprovalSignature(); changes when approval events re-project. */
  readonly signature: string;
}

export function useGatewayApprovals(
  threadId: string,
  signals: readonly GatewayApprovalSignal[],
): {
  approvals: readonly GatewayApproval[];
  refresh: () => Promise<void>;
} {
  const [approvals, setApprovals] = useState<readonly GatewayApproval[]>([]);
  const generationRef = useRef(0);

  const key = signals.map((s) => `${s.runId}=${s.signature}`).join("|");

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    let fetched: GatewayApproval[];
    try {
      fetched = await fetchGatewayApprovals(threadId);
    } catch {
      // A failed sweep (403 / network) keeps the prior render instead of
      // blanking a card the user is looking at; the next signal change retries.
      return;
    }
    if (generation !== generationRef.current) return; // superseded by a newer fetch
    setApprovals(
      fetched.toSorted(
        (a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id),
      ),
    );
  }, [threadId]);

  useEffect(() => {
    void refresh();
    // `key` IS the dependency: it encodes each run's approval-event signature,
    // so an SSE re-projection triggers exactly one revalidate and identical
    // re-renders trigger none.
  }, [key, refresh]);

  return { approvals, refresh };
}
