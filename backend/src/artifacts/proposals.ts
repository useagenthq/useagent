import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  ArtifactProposalStatus,
  ArtifactWorkpieceKind,
  ArtifactWorkpieceProposalDescriptor,
} from "@skynet/artifact-workspace";
import { db } from "../db/client";
import { artifacts, artifactWorkpieceProposals } from "../db/schema";
import { getArtifactForOrg, type ArtifactRecord } from "./repo";
import { parseWorkpieceState } from "./workpiece";

export type ProposalRecord = typeof artifactWorkpieceProposals.$inferSelect;

export function toProposalDescriptor(row: ProposalRecord): ArtifactWorkpieceProposalDescriptor {
  return {
    id: row.id,
    artifact_id: row.artifactId,
    proposer_run_id: row.proposerRunId,
    kind: row.kind,
    base_revision: row.baseRevision,
    summary: row.summary,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolved_by: row.resolvedBy,
    resolved_revision: row.resolvedRevision,
    state: row.state,
  };
}

/** List proposals for a workpiece, oldest first, so the review queue matches the
 *  order the agent authored them. Defaults to the pending lane; pass a wider set
 *  to surface the recorded accept/dismiss history. */
export async function listWorkpieceProposals(input: {
  readonly orgId: string;
  readonly artifactId: string;
  readonly statuses?: readonly ArtifactProposalStatus[];
}): Promise<ProposalRecord[]> {
  const statuses = input.statuses ?? (["pending"] as const);
  return db
    .select()
    .from(artifactWorkpieceProposals)
    .where(
      and(
        eq(artifactWorkpieceProposals.orgId, input.orgId),
        eq(artifactWorkpieceProposals.artifactId, input.artifactId),
        inArray(artifactWorkpieceProposals.status, [...statuses]),
      ),
    )
    .orderBy(asc(artifactWorkpieceProposals.createdAt));
}

export async function getWorkpieceProposalForOrg(input: {
  readonly orgId: string;
  readonly artifactId: string;
  readonly proposalId: string;
}): Promise<ProposalRecord | null> {
  const [row] = await db
    .select()
    .from(artifactWorkpieceProposals)
    .where(
      and(
        eq(artifactWorkpieceProposals.orgId, input.orgId),
        eq(artifactWorkpieceProposals.artifactId, input.artifactId),
        eq(artifactWorkpieceProposals.id, input.proposalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type ProposeWorkpieceEditResult =
  | { readonly outcome: "not_found" }
  | { readonly outcome: "invalid_state"; readonly kind: ArtifactWorkpieceKind }
  | { readonly outcome: "proposed"; readonly artifact: ArtifactRecord; readonly proposal: ProposalRecord };

/** Record an agent edit as a PROPOSED revision. Mainline (artifacts.workpieceState
 *  / workpieceRevision) is left untouched; the proposal folds in only on an
 *  explicit accept. The proposed state is validated against the workpiece kind
 *  exactly like the human PATCH path so a bad proposal never reaches the UI. */
export async function proposeWorkpieceEdit(input: {
  readonly orgId: string;
  readonly artifactId: string;
  readonly proposerRunId: string;
  readonly state: unknown;
  readonly summary?: string | null;
}): Promise<ProposeWorkpieceEditResult> {
  const artifact = await getArtifactForOrg(input.orgId, input.artifactId);
  if (!artifact?.workpieceKind) return { outcome: "not_found" };

  const state = parseWorkpieceState(artifact.workpieceKind, input.state);
  if (!state) return { outcome: "invalid_state", kind: artifact.workpieceKind };

  const [proposal] = await db
    .insert(artifactWorkpieceProposals)
    .values({
      artifactId: artifact.id,
      orgId: input.orgId,
      proposerRunId: input.proposerRunId,
      kind: artifact.workpieceKind,
      baseRevision: artifact.workpieceRevision,
      state,
      summary: input.summary?.trim() ? input.summary.trim() : null,
    })
    .returning();
  if (!proposal) throw new Error("workpiece proposal insert returned no row");
  return { outcome: "proposed", artifact, proposal };
}

export type AcceptProposalResult =
  | { readonly outcome: "not_found" }
  | { readonly outcome: "already_resolved"; readonly proposal: ProposalRecord }
  | { readonly outcome: "revision_conflict" }
  | { readonly outcome: "accepted"; readonly artifact: ArtifactRecord; readonly proposal: ProposalRecord };

/** Fold a pending proposal into mainline as a new revision, preserving provenance
 *  (resolved_by / resolved_revision). Runs in one transaction with a row lock on
 *  the proposal so concurrent accepts serialize. The mainline bump is gated on the
 *  proposal's base_revision: if mainline has advanced since the proposal was
 *  authored (a human saved, or another proposal was accepted), the accept reports
 *  a revision_conflict instead of silently discarding that intervening edit - the
 *  user must re-review against the current mainline. */
export async function acceptWorkpieceProposal(input: {
  readonly orgId: string;
  readonly artifactId: string;
  readonly proposalId: string;
  readonly resolvedBy: string | null;
}): Promise<AcceptProposalResult> {
  return db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(artifactWorkpieceProposals)
      .where(
        and(
          eq(artifactWorkpieceProposals.orgId, input.orgId),
          eq(artifactWorkpieceProposals.artifactId, input.artifactId),
          eq(artifactWorkpieceProposals.id, input.proposalId),
        ),
      )
      .limit(1)
      .for("update");
    if (!proposal) return { outcome: "not_found" as const };
    if (proposal.status !== "pending") return { outcome: "already_resolved" as const, proposal };

    const [updated] = await tx
      .update(artifacts)
      .set({
        workpieceState: proposal.state,
        workpieceRevision: sql`${artifacts.workpieceRevision} + 1`,
      })
      .where(
        and(
          eq(artifacts.orgId, input.orgId),
          eq(artifacts.id, input.artifactId),
          eq(artifacts.workpieceRevision, proposal.baseRevision),
        ),
      )
      .returning();
    if (!updated) return { outcome: "revision_conflict" as const };

    const [resolved] = await tx
      .update(artifactWorkpieceProposals)
      .set({
        status: "accepted",
        resolvedAt: new Date(),
        resolvedBy: input.resolvedBy,
        resolvedRevision: updated.workpieceRevision,
      })
      .where(eq(artifactWorkpieceProposals.id, proposal.id))
      .returning();
    if (!resolved) throw new Error("locked proposal disappeared during accept");
    return { outcome: "accepted" as const, artifact: updated, proposal: resolved };
  });
}

/** Drop a pending proposal, recording the dismissal (status="dismissed" plus
 *  resolver + timestamp) rather than deleting it. Mainline is never touched. */
export async function dismissWorkpieceProposal(input: {
  readonly orgId: string;
  readonly artifactId: string;
  readonly proposalId: string;
  readonly resolvedBy: string | null;
}): Promise<ProposalRecord | null> {
  const [resolved] = await db
    .update(artifactWorkpieceProposals)
    .set({ status: "dismissed", resolvedAt: new Date(), resolvedBy: input.resolvedBy })
    .where(
      and(
        eq(artifactWorkpieceProposals.orgId, input.orgId),
        eq(artifactWorkpieceProposals.artifactId, input.artifactId),
        eq(artifactWorkpieceProposals.id, input.proposalId),
        eq(artifactWorkpieceProposals.status, "pending"),
      ),
    )
    .returning();
  return resolved ?? null;
}
