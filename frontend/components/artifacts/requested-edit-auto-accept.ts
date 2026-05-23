import type {
  ArtifactWorkpieceProposalDescriptor,
  ArtifactWorkpieceState,
} from "@skynet/agent-client";

/** A structured edit or editing-focus within this window counts as "typing
 *  seconds ago": the agent's change is always routed through the proposal banner
 *  instead of applying directly, per the requested-edit contract. */
export const EDIT_ACTIVITY_WINDOW_MS = 10_000;

/** Live editor + thread signals, read at the instant an agent proposal arrives. */
export interface AutoAcceptGate {
  /** The open editor for this workpiece has unsaved edits. */
  readonly editorDirty: boolean;
  /** The open editor was edited or focused within EDIT_ACTIVITY_WINDOW_MS. */
  readonly editorRecentlyActive: boolean;
  /** The current/latest run of the thread the user is viewing - the run their own
   *  latest message started. Null outside a session, so auto-accept never fires. */
  readonly latestRunId: string | null;
  /** Current mainline revision (null until the mainline has loaded). */
  readonly mainlineRevision: number | null;
}

/** The requested-edit auto-accept contract: an agent change applies directly (the
 *  user's chat message WAS the acceptance) ONLY when the editor is clean and idle,
 *  the proposal came from the user's own latest run, and it applies without
 *  conflict. Every other case falls through to the normal proposal banner. Pure so
 *  the one-write-path gate stays unit-locked. */
export function shouldAutoAcceptRequestedEdit(
  proposal: Pick<
    ArtifactWorkpieceProposalDescriptor,
    "status" | "proposer_run_id" | "base_revision"
  >,
  gate: AutoAcceptGate,
): boolean {
  // Only a still-pending proposal can be folded in.
  if (proposal.status !== "pending") return false;
  // (a) Clean + idle: unsaved edits or typing seconds ago always get the banner.
  if (gate.editorDirty || gate.editorRecentlyActive) return false;
  // (b) The proposal is the user's own request: it came from the thread's latest run.
  if (gate.latestRunId === null || proposal.proposer_run_id !== gate.latestRunId) return false;
  // (c) No conflict: base_revision must equal current mainline (else Accept 409s).
  if (gate.mainlineRevision === null || proposal.base_revision !== gate.mainlineRevision) {
    return false;
  }
  return true;
}

/** From a fresh proposals refetch, the single newly-arrived proposal that
 *  qualifies to apply directly as the user's own requested edit, or null.
 *  Evaluated once per proposal (at arrival), never retroactively: already-seen ids
 *  are skipped so a proposal that lost the gate on arrival stays a banner. The
 *  newest qualifying wins, and only ONE applies per burst so a second same-base
 *  proposal never 409s against the revision the first just advanced. */
export function selectRequestedEditAutoAccept(params: {
  readonly pending: readonly ArtifactWorkpieceProposalDescriptor[];
  readonly seenProposalIds: ReadonlySet<string>;
  readonly gate: AutoAcceptGate;
}): ArtifactWorkpieceProposalDescriptor | null {
  const qualifying = params.pending.filter(
    (proposal) =>
      !params.seenProposalIds.has(proposal.id) &&
      shouldAutoAcceptRequestedEdit(proposal, params.gate),
  );
  return qualifying.at(-1) ?? null;
}

/** Undo an auto-accept by re-PATCHing the captured prior state through the normal
 *  save lane as a NEW revision (honest history, never a rollback deletion). Reads
 *  the current revision fresh for optimistic concurrency and retries once on a 409
 *  so a racing edit does not silently drop the undo. Returns whether the prior
 *  state was re-saved. */
export async function performUndoAutoAccept(deps: {
  readonly priorState: ArtifactWorkpieceState;
  /** GET the current mainline revision, or null if it cannot be read. */
  readonly readRevision: () => Promise<number | null>;
  /** PATCH the prior state at expected_revision; resolves the HTTP status code. */
  readonly patch: (expectedRevision: number, state: ArtifactWorkpieceState) => Promise<number>;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const revision = await deps.readRevision();
    if (revision === null) return false;
    const status = await deps.patch(revision, deps.priorState);
    if (status !== 409) return status >= 200 && status < 300;
  }
  return false;
}
