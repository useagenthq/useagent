"use client";

// Fetch lane for gateway approvals (#77). NOT a polling loop: the effect keys
// on the runs' approval-signal SIGNATURES, which the thread SSE re-projects
// whenever an approval event lands/resolves (thread-store merge -> new turns ->
// new signature -> one revalidate). `refresh` is the manual nudge after this
// client resolves (or loses a 409 race on) an approval.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGatewayApprovals, type GatewayApproval } from "@/lib/gateway-approvals";

export interface GatewayApprovalSignal {
  readonly runId: string;
  /** From gatewayApprovalSignature(); changes when approval events re-project. */
  readonly signature: string;
}

export function useGatewayApprovals(signals: readonly GatewayApprovalSignal[]): {
  approvals: readonly GatewayApproval[];
  refresh: () => Promise<void>;
} {
  const [approvals, setApprovals] = useState<readonly GatewayApproval[]>([]);
  // Approvals seen pending in THIS view: a card that resolves stays visible in
  // its resolved state, while a reload of already-resolved history shows nothing.
  const everPendingRef = useRef<Set<string>>(new Set());
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  const generationRef = useRef(0);

  const key = signals.map((s) => `${s.runId}=${s.signature}`).join("|");

  const refresh = useCallback(async () => {
    const runIds = signalsRef.current.map((s) => s.runId);
    const generation = ++generationRef.current;
    if (runIds.length === 0) {
      setApprovals([]);
      return;
    }
    const settled = await Promise.allSettled(runIds.map(fetchGatewayApprovals));
    if (generation !== generationRef.current) return; // superseded by a newer fetch
    const fetched = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    // A wholly-failed sweep (403 / network) keeps the prior render instead of
    // blanking a card the user is looking at; the next signal change retries.
    if (fetched.length === 0 && settled.every((r) => r.status === "rejected")) return;
    for (const approval of fetched) {
      if (approval.status === "pending") everPendingRef.current.add(approval.id);
    }
    setApprovals(
      fetched
        .filter(
          (approval) =>
            approval.status === "pending" || everPendingRef.current.has(approval.id),
        )
        .toSorted(
          (a, b) =>
            a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id),
        ),
    );
  }, []);

  useEffect(() => {
    void refresh();
    // `key` IS the dependency: it encodes both the live run set and each run's
    // approval-event signature, so an SSE re-projection triggers exactly one
    // revalidate and identical re-renders trigger none.
  }, [key, refresh]);

  return { approvals, refresh };
}
