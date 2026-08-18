"use client";

import {
  type ArtifactDescriptor,
  type ArtifactWorkpieceProposalDescriptor,
  type ArtifactWorkpieceState,
  decodeWorkpieceProposalList,
  decodeWorkpieceResult,
} from "@skynet/agent-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import type { OrgChange } from "@/lib/org-changes";
import {
  performUndoAutoAccept,
  selectRequestedEditAutoAccept,
} from "./requested-edit-auto-accept";

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

/** Requested-edit auto-accept wiring. Present only inside a session (the standalone
 *  editor omits it), where a proposal that lands on an open, clean, idle workpiece
 *  from the user's own latest run is applied directly - their chat message was the
 *  acceptance. */
export interface RequestedEditAutoAcceptOptions {
  /** The thread's current/latest run, matched against a proposal's proposer_run_id. */
  readonly latestRunId: string | null;
  /** Reads the open editor's dirty + recent-activity gate at the instant a proposal
   *  arrives (live, so an edit mid-flight is never clobbered). */
  readonly readEditorGate: () => { readonly dirty: boolean; readonly recentlyActive: boolean };
}

/** A quiet "Agent edit applied - Undo" toast for one auto-accepted edit. The prior
 *  mainline state is captured internally so Undo can re-save it. */
export interface RequestedEditAutoAcceptToast {
  readonly id: string;
  readonly summary: string | null;
  readonly status: "applied" | "undoing" | "error";
}

interface InternalAutoAcceptToast extends RequestedEditAutoAcceptToast {
  /** The mainline state captured before this accept, re-saved on Undo. */
  readonly priorState: ArtifactWorkpieceState;
}

interface FreshProposals {
  readonly pending: readonly ArtifactWorkpieceProposalDescriptor[];
  readonly mainlineState: ArtifactWorkpieceState | null;
  readonly mainlineRevision: number;
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
  readonly accept: (proposalId: string) => Promise<boolean>;
  readonly dismiss: (proposalId: string) => Promise<boolean>;
  /** Toasts for edits applied directly on the user's request (one per accept). */
  readonly autoAcceptToasts: readonly RequestedEditAutoAcceptToast[];
  /** Re-save the state captured before that auto-accept as a NEW revision. */
  readonly undoAutoAccept: (toastId: string) => Promise<void>;
  readonly dismissAutoAcceptToast: (toastId: string) => void;
}

/** Loads the pending agent-proposed revisions for a workpiece and its current
 *  mainline state, refetching whenever the artifact's org-change signal fires
 *  (a proposal appearing mid-run, an accept advancing mainline, or a dismiss).
 *  Accept/dismiss post to the org-scoped endpoints; the rendered surface keeps
 *  showing mainline until an accept lands, so nothing here mutates the editor. */
export function useWorkpieceProposals(
  artifact: ArtifactDescriptor,
  autoAccept?: RequestedEditAutoAcceptOptions,
): WorkpieceProposalsController {
  const workpiece = artifact.workpiece;
  const stateUrl = workpiece?.state_url ?? null;
  const artifactId = artifact.id;
  const [pending, setPending] = useState<readonly ArtifactWorkpieceProposalDescriptor[]>([]);
  const [mainlineState, setMainlineState] = useState<ArtifactWorkpieceState | null>(null);
  const [mainlineRevision, setMainlineRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<readonly InternalAutoAcceptToast[]>([]);

  // Read live at signal time (outside the render closure): the auto-accept config,
  // the toasts, and each proposal already evaluated for auto-accept (so arrival is
  // the ONLY moment a proposal can apply directly - never retroactively).
  const autoAcceptRef = useRef(autoAccept);
  autoAcceptRef.current = autoAccept;
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  const seenRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const refetch = useCallback(async (): Promise<FreshProposals | null> => {
    if (!stateUrl) return null;
    setLoading(true);
    try {
      const [proposalsResponse, stateResponse] = await Promise.all([
        backendFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/proposals`, {
          cache: "no-store",
        }),
        backendFetch(stateUrl, { cache: "no-store" }),
      ]);
      let freshPending: readonly ArtifactWorkpieceProposalDescriptor[] | null = null;
      let freshState: ArtifactWorkpieceState | null = null;
      let freshRevision: number | null = null;
      if (proposalsResponse.ok) {
        const decoded = decodeWorkpieceProposalList(await proposalsResponse.json());
        if (decoded) {
          setPending(decoded);
          freshPending = decoded;
        }
      }
      if (stateResponse.ok) {
        const result = decodeWorkpieceResult(await stateResponse.json());
        if (result) {
          setMainlineState(result.state);
          setMainlineRevision(result.workpiece.state_revision);
          freshState = result.state;
          freshRevision = result.workpiece.state_revision;
        }
      }
      if (freshPending === null || freshRevision === null) return null;
      return { pending: freshPending, mainlineState: freshState, mainlineRevision: freshRevision };
    } catch {
      // Transient; the next org-change signal or remount repairs the view.
      return null;
    } finally {
      setLoading(false);
    }
  }, [artifactId, stateUrl]);

  const resolve = useCallback(
    async (proposalId: string, action: "accept" | "dismiss"): Promise<boolean> => {
      setBusyId(proposalId);
      setError(null);
      let ok = false;
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
        } else {
          ok = true;
        }
      } catch {
        setError(`The proposal could not be ${action === "accept" ? "accepted" : "dismissed"}.`);
      } finally {
        setBusyId(null);
        await refetch();
      }
      return ok;
    },
    [artifactId, refetch],
  );

  const accept = useCallback((proposalId: string) => resolve(proposalId, "accept"), [resolve]);
  const dismiss = useCallback((proposalId: string) => resolve(proposalId, "dismiss"), [resolve]);

  // The one write path: a qualifying proposal is applied through the SAME accept
  // endpoint the banner uses. Prior mainline is captured BEFORE the accept so Undo
  // can re-save it; the rendered view refreshes through the existing "updated"
  // live-reload lane (accept publishes it), so nothing here touches the editor.
  const maybeAutoAccept = useCallback(
    async (fresh: FreshProposals) => {
      const options = autoAcceptRef.current;
      if (!options) return;
      const gate = options.readEditorGate();
      const target = selectRequestedEditAutoAccept({
        pending: fresh.pending,
        seenProposalIds: seenRef.current,
        gate: {
          editorDirty: gate.dirty,
          editorRecentlyActive: gate.recentlyActive,
          latestRunId: options.latestRunId,
          mainlineRevision: fresh.mainlineRevision,
        },
      });
      // Every proposal present now is "seen": a proposal that lost the gate on
      // arrival stays a banner and is never auto-accepted on a later signal.
      for (const proposal of fresh.pending) seenRef.current.add(proposal.id);
      if (!target || fresh.mainlineState === null) return;
      const priorState = fresh.mainlineState;
      const applied = await accept(target.id);
      if (!applied) return;
      // One toast per accept; its Undo restores the state captured before THAT
      // accept. Rapid accepts stack (each honest), rather than coalescing.
      setToasts((prev) => [
        ...prev,
        {
          id: `${target.id}-${prev.length}`,
          summary: target.summary,
          status: "applied",
          priorState,
        },
      ]);
    },
    [accept],
  );

  // Mount: seed the seen set from whatever already pends (pre-existing proposals are
  // not the user's fresh request) and mark ready; only LIVE arrivals auto-accept.
  useEffect(() => {
    void (async () => {
      const fresh = await refetch();
      if (fresh) for (const proposal of fresh.pending) seenRef.current.add(proposal.id);
      initializedRef.current = true;
    })();
  }, [refetch]);

  useOrgChanges((change) => {
    if (!shouldRefetchProposalsOnSignal(change, artifactId)) return;
    void (async () => {
      const fresh = await refetch();
      if (!fresh) return;
      // Only a "proposed" signal (a NEW agent proposal) is an auto-accept candidate;
      // "updated" is mainline advancing (e.g. our own accept), never a fresh ask.
      const isNewProposal =
        change.type === "artifact" && change.action === "proposed" && initializedRef.current;
      if (isNewProposal) await maybeAutoAccept(fresh);
    })();
  });

  const undoAutoAccept = useCallback(
    async (toastId: string) => {
      const toast = toastsRef.current.find((entry) => entry.id === toastId);
      if (!toast || !stateUrl) return;
      setToasts((prev) =>
        prev.map((entry) => (entry.id === toastId ? { ...entry, status: "undoing" } : entry)),
      );
      const ok = await performUndoAutoAccept({
        priorState: toast.priorState,
        readRevision: async () => {
          try {
            const response = await backendFetch(stateUrl, { cache: "no-store" });
            if (!response.ok) return null;
            const result = decodeWorkpieceResult(await response.json());
            return result ? result.workpiece.state_revision : null;
          } catch {
            return null;
          }
        },
        patch: async (expectedRevision, state) => {
          try {
            const response = await backendFetch(stateUrl, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expected_revision: expectedRevision, state }),
            });
            return response.status;
          } catch {
            return 0;
          }
        },
      });
      if (ok) {
        setToasts((prev) => prev.filter((entry) => entry.id !== toastId));
        await refetch();
      } else {
        setToasts((prev) =>
          prev.map((entry) => (entry.id === toastId ? { ...entry, status: "error" } : entry)),
        );
      }
    },
    [refetch, stateUrl],
  );

  const dismissAutoAcceptToast = useCallback((toastId: string) => {
    setToasts((prev) => prev.filter((entry) => entry.id !== toastId));
  }, []);

  return {
    pending,
    mainlineState,
    mainlineRevision,
    loading,
    busyId,
    error,
    accept,
    dismiss,
    autoAcceptToasts: toasts.map(({ priorState: _priorState, ...pub }) => pub),
    undoAutoAccept,
    dismissAutoAcceptToast,
  };
}
