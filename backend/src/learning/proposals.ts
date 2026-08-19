import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db/client";
import {
  knowledgeDrafts,
  skillRevisionProposals,
  skills,
  type SkillProposalStatus,
} from "../db/schema";
import {
  createSkillWithRevision,
  getSkillForOrg,
  updateSkillWithRevision,
} from "../skills/repo";
import {
  assembleSkillProposal,
  MIN_SIMILAR_PRIOR_DRAFTS,
  SIMILARITY_THRESHOLD,
  titleSimilarity,
} from "./similarity";

// ---------------------------------------------------------------------------
// Skill revision proposals (item 6). When an ACCEPTED knowledge draft matches
// >= 2 similar prior accepted drafts (deterministic title-keyword similarity),
// the group is assembled into a PROPOSED skill revision. A proposal changes a
// live skill only on an explicit org-admin accept, and the change itself goes
// through the existing skills code path (create/updateSkillWithRevision), so
// versioning, immutable revisions, and run pinning all behave exactly as for a
// hand-edited skill. Human approval is the ONLY path to a live skill change.
// ---------------------------------------------------------------------------

export type SkillProposalRecord = typeof skillRevisionProposals.$inferSelect;

interface AcceptedDraftLike {
  id: string;
  orgId: string;
  runId: string;
  title: string;
}

/**
 * Raise a skill revision proposal for a just-accepted draft IF its title
 * matches >= MIN_SIMILAR_PRIOR_DRAFTS prior accepted drafts in the org.
 * Deterministic; deduplicated (no second open proposal with the same name).
 * Returns the created proposal id, or null when nothing was raised.
 */
export async function maybeProposeSkillRevision(
  draft: AcceptedDraftLike,
): Promise<string | null> {
  const priors = await db
    .select({
      id: knowledgeDrafts.id,
      runId: knowledgeDrafts.runId,
      title: knowledgeDrafts.title,
      createdAt: knowledgeDrafts.createdAt,
    })
    .from(knowledgeDrafts)
    .where(
      and(
        eq(knowledgeDrafts.orgId, draft.orgId),
        eq(knowledgeDrafts.status, "accepted"),
        ne(knowledgeDrafts.id, draft.id),
      ),
    );
  const similar = priors
    .filter((p) => titleSimilarity(p.title, draft.title) >= SIMILARITY_THRESHOLD)
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (similar.length < MIN_SIMILAR_PRIOR_DRAFTS) return null;

  const group = [...similar, draft].map((d) => ({
    id: d.id,
    runId: d.runId,
    title: d.title,
  }));
  const assembled = assembleSkillProposal(group);

  // Dedupe: one OPEN proposal per (org, name) — a fourth similar accept while
  // the reviewer hasn't decided yet must not stack duplicates.
  const [open] = await db
    .select({ id: skillRevisionProposals.id })
    .from(skillRevisionProposals)
    .where(
      and(
        eq(skillRevisionProposals.orgId, draft.orgId),
        eq(skillRevisionProposals.name, assembled.name),
        eq(skillRevisionProposals.status, "proposed"),
      ),
    )
    .limit(1);
  if (open) return null;

  // An existing same-name skill makes this a revision proposal; else brand-new.
  const [existingSkill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.orgId, draft.orgId), eq(skills.name, assembled.name)))
    .limit(1);

  const [row] = await db
    .insert(skillRevisionProposals)
    .values({
      orgId: draft.orgId,
      skillId: existingSkill?.id ?? null,
      name: assembled.name,
      description: assembled.description,
      sections: assembled.sections,
      sourceDraftIds: group.map((d) => d.id),
    })
    .returning({ id: skillRevisionProposals.id });
  return row?.id ?? null;
}

/** List an org's proposals, newest first; optional status filter. */
export async function listSkillProposals(
  orgId: string,
  status?: SkillProposalStatus,
  limit = 200,
): Promise<SkillProposalRecord[]> {
  return db
    .select()
    .from(skillRevisionProposals)
    .where(
      status
        ? and(eq(skillRevisionProposals.orgId, orgId), eq(skillRevisionProposals.status, status))
        : eq(skillRevisionProposals.orgId, orgId),
    )
    .orderBy(desc(skillRevisionProposals.createdAt), desc(skillRevisionProposals.id))
    .limit(limit);
}

export type AcceptProposalResult =
  | { ok: true; proposal: SkillProposalRecord; skillId: string; version: number }
  | { ok: false; error: "not_found" | "not_open" };

/**
 * Accept a proposal (org-admin only — enforced at the route): atomically claim
 * it (proposed → accepted), then apply it through the EXISTING skills path —
 * update the targeted skill (minting an immutable new revision), or create a
 * brand-new playbook with its version-1 revision. A same-name skill created
 * between proposal and accept is treated as the revision target. On apply
 * failure the claim is reverted so the proposal stays reviewable.
 */
export async function acceptSkillProposal(
  orgId: string,
  proposalId: string,
  userId: string | null,
): Promise<AcceptProposalResult> {
  const [proposal] = await db
    .update(skillRevisionProposals)
    .set({
      status: "accepted",
      resolvedBy: userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(skillRevisionProposals.id, proposalId),
        eq(skillRevisionProposals.orgId, orgId),
        eq(skillRevisionProposals.status, "proposed"),
      ),
    )
    .returning();
  if (!proposal) return { ok: false, error: await missingReason(orgId, proposalId) };

  try {
    const applied = await applyProposal(orgId, proposal);
    const [updated] = await db
      .update(skillRevisionProposals)
      .set({
        resolvedSkillId: applied.skillId,
        resolvedVersion: applied.version,
        updatedAt: new Date(),
      })
      .where(eq(skillRevisionProposals.id, proposalId))
      .returning();
    return { ok: true, proposal: updated ?? proposal, ...applied };
  } catch (err) {
    await db
      .update(skillRevisionProposals)
      .set({ status: "proposed", resolvedBy: null, resolvedAt: null, updatedAt: new Date() })
      .where(and(eq(skillRevisionProposals.id, proposalId), eq(skillRevisionProposals.orgId, orgId)));
    throw err;
  }
}

/** Apply an accepted proposal via the existing skills code path. */
async function applyProposal(
  orgId: string,
  proposal: SkillProposalRecord,
): Promise<{ skillId: string; version: number }> {
  // Resolve the revision target: the pinned skill (if still present), else a
  // same-name skill, else create a brand-new one.
  let targetId: string | null = null;
  if (proposal.skillId && (await getSkillForOrg(orgId, proposal.skillId))) {
    targetId = proposal.skillId;
  } else {
    const [byName] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.orgId, orgId), eq(skills.name, proposal.name)))
      .limit(1);
    targetId = byName?.id ?? null;
  }

  if (targetId) {
    const updated = await updateSkillWithRevision(orgId, targetId, {
      description: proposal.description,
      sections: proposal.sections,
    });
    if (!updated) throw new Error("skill revision target vanished during accept");
    return { skillId: updated.id, version: updated.currentVersion };
  }

  const created = await createSkillWithRevision({
    orgId,
    name: proposal.name,
    // A learned recurring procedure is a playbook (same substrate as skills).
    kind: "playbook",
    description: proposal.description,
    tags: ["learning"],
    sections: proposal.sections,
  });
  if (!created) throw new Error("skill name conflict during proposal accept");
  return { skillId: created.id, version: created.currentVersion };
}

/** Dismiss a proposal (recorded, never deleted). Guarded on status="proposed". */
export async function dismissSkillProposal(
  orgId: string,
  proposalId: string,
  userId: string | null,
): Promise<{ ok: true; proposal: SkillProposalRecord } | { ok: false; error: "not_found" | "not_open" }> {
  const [proposal] = await db
    .update(skillRevisionProposals)
    .set({
      status: "dismissed",
      resolvedBy: userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(skillRevisionProposals.id, proposalId),
        eq(skillRevisionProposals.orgId, orgId),
        eq(skillRevisionProposals.status, "proposed"),
      ),
    )
    .returning();
  if (!proposal) return { ok: false, error: await missingReason(orgId, proposalId) };
  return { ok: true, proposal };
}

/** Distinguish "no such proposal in this org" (404) from "already resolved" (409). */
async function missingReason(orgId: string, proposalId: string): Promise<"not_found" | "not_open"> {
  const [existing] = await db
    .select({ id: skillRevisionProposals.id })
    .from(skillRevisionProposals)
    .where(
      and(eq(skillRevisionProposals.id, proposalId), eq(skillRevisionProposals.orgId, orgId)),
    )
    .limit(1);
  return existing ? "not_open" : "not_found";
}
