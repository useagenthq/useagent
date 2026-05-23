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
import type { OrgChange } from "@/lib/org-changes";

/** Refetch the proposals lane when THIS workpiece's proposal state changes: a
 *  proposal appearing mid-run ("proposed"), or an accept advancing mainline
 *  ("updated"). A brand-new artifact ("created") starts with an empty lane the
 *  mount fetch already covers, and other artifacts / change types are ignored.
 *  Pure so the live-banner contract is unit-locked, matching
 *  `shouldReloadOnArtifactSignal`. */
export function shouldRefetchProposalsOnSignal(change: OrgChange, artifactId: string): boolean {
  return (
    change.type === "artifact" &&
    change.artifactId === artifactId &&
    (change.action === "proposed" || change.action === "updated")
  );
}

/** A proposal is dead on arrival when mainline has advanced past the revision it
 *  was authored against: the backend accept gates on `base_revision === current`
 *  and returns 409 otherwise (artifacts/proposals.ts), so accepting would loop
 *  forever. Detecting it up front lets the card disable Accept and steer the user
 *  to re-propose instead of hitting the dead end. Pure so the state is unit-locked. */
export function proposalConflictsWithMainline(
  proposal: Pick<ArtifactWorkpieceProposalDescriptor, "base_revision">,
  mainlineRevision: number | null,
): boolean {
  return mainlineRevision !== null && proposal.base_revision !== mainlineRevision;
}

export interface WorkpieceProposalsController {
  /** Pending proposals for this workpiece, oldest first. */
  readonly pending: readonly ArtifactWorkpieceProposalDescriptor[];
  /** Current mainline state, so a proposal renders as a diff against truth. */
  readonly mainlineState: ArtifactWorkpieceState | null;
  /** Current mainline revision, so a stale proposal (base_revision behind this)
   *  is flagged as a conflict before its Accept can 409. Null until first load. */
  readonly mainlineRevision: number | null;
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
  const [mainlineRevision, setMainlineRevision] = useState<number | null>(null);
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
        if (result) {
          setMainlineState(result.state);
          setMainlineRevision(result.workpiece.state_revision);
        }
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
    if (shouldRefetchProposalsOnSignal(change, artifactId)) void refetch();
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

  return { pending, mainlineState, mainlineRevision, loading, busyId, error, accept, dismiss };
}
