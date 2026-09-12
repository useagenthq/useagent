"use client";

// Fetch lane for gateway approvals (#77). NOT a polling loop: the effect keys
// on the turns' approval-signal SIGNATURES, which the thread SSE re-projects
// whenever an approval event lands/resolves (thread-store merge -> new turns ->
// new signature -> one revalidate). The fetch is THREAD-scoped: a request whose
// run has settled (the agent ended its turn to wait, as approval_request tells
// it to) is still the thread's to decide, so it renders wherever it was asked.
// `refresh` is the manual nudge after this client resolves (or loses a 409
// race on) an approval.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchGatewayApprovals, type GatewayApproval } from "@/lib/gateway-approvals";
import type { Turn } from "./conversation";
import { gatewayApprovalSignature } from "./gateway-approval-state";

export interface GatewayApprovalSignal {
  readonly runId: string;
  /** From gatewayApprovalSignature(); changes when approval events re-project. */
  readonly signature: string;
}

/** Same seam as the question card: the run's OWN projection decides. Every
 *  turn whose timeline carries an approval step / provider event signals the
 *  lane; a SETTLED turn signals too, since the agent ends its turn to wait for
 *  the person (the approval_request contract) and the decision continues the
 *  thread through a follow-up turn, so the card must outlive the run. */
export function gatewayApprovalSignals(turns: readonly Turn[]): GatewayApprovalSignal[] {
  const signals: GatewayApprovalSignal[] = [];
  for (const turn of turns) {
    const signature = gatewayApprovalSignature(
      turn.steps,
      turn.native?.nativeFrames ?? [],
      turn.canonical ?? [],
    );
    if (signature) signals.push({ runId: turn.run.id, signature });
  }
  return signals;
}

export function useGatewayApprovals(
  threadId: string,
  turns: readonly Turn[],
): {
  approvals: readonly GatewayApproval[];
  refresh: () => Promise<void>;
} {
  const signals = useMemo(() => gatewayApprovalSignals(turns), [turns]);
  const [approvals, setApprovals] = useState<readonly GatewayApproval[]>([]);
  // Approvals seen pending in THIS view: a card that resolves stays visible in
  // its resolved state, while a reload of already-resolved history shows nothing.
  const everPendingRef = useRef<Set<string>>(new Set());
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  const generationRef = useRef(0);

  const key = signals.map((s) => `${s.runId}=${s.signature}`).join("|");

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (signalsRef.current.length === 0) {
      setApprovals([]);
      return;
    }
    let fetched: GatewayApproval[];
    try {
      fetched = await fetchGatewayApprovals({ threadId });
    } catch {
      // A failed sweep (403 / network) keeps the prior render instead of
      // blanking a card the user is looking at; the next signal change retries.
      return;
    }
    if (generation !== generationRef.current) return; // superseded by a newer fetch
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
  }, [threadId]);

  useEffect(() => {
    void refresh();
    // `key` IS the dependency: it encodes both the signalling turn set and each
    // turn's approval-event signature, so an SSE re-projection triggers exactly
    // one revalidate and identical re-renders trigger none.
  }, [key, refresh]);

  return { approvals, refresh };
}
