"use client";

import {
  type ArtifactDescriptor,
  type ArtifactWorkpieceProposalDescriptor,
  type ArtifactWorkpieceState,
  decodeWorkpieceProposalList,
  decodeWorkpieceResult,
} from "@skynet/agent-client";
import { useCallback, useEffect, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";

export interface WorkpieceProposalsController {
  /** Pending proposals for this workpiece, oldest first. */
  readonly pending: readonly ArtifactWorkpieceProposalDescriptor[];
  /** Current mainline state, so a proposal renders as a diff against truth. */
  readonly mainlineState: ArtifactWorkpieceState | null;
  readonly loading: boolean;
  /** The id of the proposal whose accept/dismiss is in flight, if any. */
  readonly busyId: string | null;
  readonly error: string | null;
  readonly accept: (proposalId: string) => Promise<void>;
  readonly dismiss: (proposalId: string) => Promise<void>;
}

/** Loads the pending agent-proposed revisions for a workpiece and its current
 *  mainline state, refetching whenever the artifact's org-change signal fires
 *  (a proposal appearing mid-run, an accept advancing mainline, or a dismiss).
 *  Accept/dismiss post to the org-scoped endpoints; the rendered surface keeps
 *  showing mainline until an accept lands, so nothing here mutates the editor. */
export function useWorkpieceProposals(artifact: ArtifactDescriptor): WorkpieceProposalsController {
  const workpiece = artifact.workpiece;
  const stateUrl = workpiece?.state_url ?? null;
  const artifactId = artifact.id;
  const [pending, setPending] = useState<readonly ArtifactWorkpieceProposalDescriptor[]>([]);
  const [mainlineState, setMainlineState] = useState<ArtifactWorkpieceState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!stateUrl) return;
    setLoading(true);
    try {
      const [proposalsResponse, stateResponse] = await Promise.all([
        backendFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/proposals`, {
          cache: "no-store",
        }),
        backendFetch(stateUrl, { cache: "no-store" }),
      ]);
      if (proposalsResponse.ok) {
        const decoded = decodeWorkpieceProposalList(await proposalsResponse.json());
        if (decoded) setPending(decoded);
      }
      if (stateResponse.ok) {
        const result = decodeWorkpieceResult(await stateResponse.json());
        if (result) setMainlineState(result.state);
      }
    } catch {
      // Transient; the next org-change signal or remount repairs the view.
    } finally {
      setLoading(false);
    }
  }, [artifactId, stateUrl]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useOrgChanges((change) => {
    if (
      change.type === "artifact" &&
      change.artifactId === artifactId &&
      (change.action === "proposed" || change.action === "updated")
    ) {
      void refetch();
    }
  });

  const resolve = useCallback(
    async (proposalId: string, action: "accept" | "dismiss") => {
      setBusyId(proposalId);
      setError(null);
      try {
        const response = await backendFetch(
          `/api/artifacts/${encodeURIComponent(artifactId)}/proposals/${encodeURIComponent(
            proposalId,
          )}/${action}`,
          { method: "POST" },
        );
        if (response.status === 409) {
          setError(
            action === "accept"
              ? "Mainline changed since this was proposed. Review the updated diff before accepting."
              : "This proposal was already resolved.",
          );
        } else if (!response.ok) {
          setError(`The proposal could not be ${action === "accept" ? "accepted" : "dismissed"}.`);
        }
      } catch {
        setError(`The proposal could not be ${action === "accept" ? "accepted" : "dismissed"}.`);
      } finally {
        setBusyId(null);
        await refetch();
      }
    },
    [artifactId, refetch],
  );

  const accept = useCallback((proposalId: string) => resolve(proposalId, "accept"), [resolve]);
  const dismiss = useCallback((proposalId: string) => resolve(proposalId, "dismiss"), [resolve]);

  return { pending, mainlineState, loading, busyId, error, accept, dismiss };
}
