import { Hono } from "hono";
import {
  KNOWLEDGE_DRAFT_STATUSES,
  SKILL_PROPOSAL_STATUSES,
  type KnowledgeDraftStatus,
  type SkillProposalStatus,
} from "../db/schema";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { formatSkillMarkdown } from "../skills/format";
import {
  acceptKnowledgeDraft,
  dismissKnowledgeDraft,
  listKnowledgeDrafts,
  type KnowledgeDraftRecord,
} from "./drafts";
import {
  acceptSkillProposal,
  dismissSkillProposal,
  listSkillProposals,
  type SkillProposalRecord,
} from "./proposals";

// ---------------------------------------------------------------------------
// Learning review API — the human-governance surface over the learning lane.
//   /api/knowledge/drafts   — reviewable knowledge drafts (item 4)
//   /api/skills/proposals   — skill revision proposals (item 6)
// Listing is org-member visible; accept/dismiss are org-ADMIN operations
// (orgAdminScope), because they change (or decline to change) what the whole
// org's agents know and how they work.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDraftApi(d: KnowledgeDraftRecord) {
  return {
    id: d.id,
    run_id: d.runId,
    thread_id: d.threadId,
    title: d.title,
    content: d.content,
    evidence: d.evidence,
    status: d.status,
    accepted_record_id: d.acceptedRecordId,
    resolved_by: d.resolvedBy,
    resolved_at: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

function toProposalApi(p: SkillProposalRecord) {
  return {
    id: p.id,
    skill_id: p.skillId,
    name: p.name,
    description: p.description,
    sections: p.sections,
    // The exact SKILL.md text an accept would materialize — derived, so the
    // reviewer sees precisely what the skills lane will store.
    proposed_content: formatSkillMarkdown({
      name: p.name,
      description: p.description,
      sections: p.sections,
    }),
    source_draft_ids: p.sourceDraftIds,
    status: p.status,
    resolved_skill_id: p.resolvedSkillId,
    resolved_version: p.resolvedVersion,
    resolved_by: p.resolvedBy,
    resolved_at: p.resolvedAt ? p.resolvedAt.toISOString() : null,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

// Mounted at /api/knowledge/drafts (before /api/knowledge, like skills/import).
export const knowledgeDraftRoutes = new Hono<AppEnv>();
knowledgeDraftRoutes.use("*", orgScope);

// GET /api/knowledge/drafts?status=draft|accepted|dismissed — newest first.
knowledgeDraftRoutes.get("/", async (c) => {
  const raw = c.req.query("status");
  const status = (KNOWLEDGE_DRAFT_STATUSES as readonly string[]).includes(raw ?? "")
    ? (raw as KnowledgeDraftStatus)
    : undefined;
  const drafts = await listKnowledgeDrafts(c.get("orgId"), status);
  return c.json({ drafts: drafts.map(toDraftApi) });
});

// POST /api/knowledge/drafts/:id/accept — org admin; creates the REAL
// knowledge record via the existing store path and may raise a skill proposal.
knowledgeDraftRoutes.post("/:id/accept", orgAdminScope, async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "draft not found" }, 404);
  const result = await acceptKnowledgeDraft(c.get("orgId"), id, c.get("userId"));
  if (!result.ok) {
    return result.error === "not_found"
      ? c.json({ error: "draft not found" }, 404)
      : c.json({ error: "draft already resolved" }, 409);
  }
  return c.json({
    draft: toDraftApi(result.draft),
    record_id: result.recordId,
    proposal_id: result.proposalId,
  });
});

// POST /api/knowledge/drafts/:id/dismiss — org admin; recorded, never deleted.
knowledgeDraftRoutes.post("/:id/dismiss", orgAdminScope, async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "draft not found" }, 404);
  const result = await dismissKnowledgeDraft(c.get("orgId"), id, c.get("userId"));
  if (!result.ok) {
    return result.error === "not_found"
      ? c.json({ error: "draft not found" }, 404)
      : c.json({ error: "draft already resolved" }, 409);
  }
  return c.json({ draft: toDraftApi(result.draft) });
});

// Mounted at /api/skills/proposals (before /api/skills, like skills/import).
export const skillProposalRoutes = new Hono<AppEnv>();
skillProposalRoutes.use("*", orgScope);

// GET /api/skills/proposals?status=proposed|accepted|dismissed — newest first.
skillProposalRoutes.get("/", async (c) => {
  const raw = c.req.query("status");
  const status = (SKILL_PROPOSAL_STATUSES as readonly string[]).includes(raw ?? "")
    ? (raw as SkillProposalStatus)
    : undefined;
  const proposals = await listSkillProposals(c.get("orgId"), status);
  return c.json({ proposals: proposals.map(toProposalApi) });
});

// POST /api/skills/proposals/:id/accept — org admin; mints a REAL skill
// revision (or a new playbook) through the existing skills code path.
skillProposalRoutes.post("/:id/accept", orgAdminScope, async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "proposal not found" }, 404);
  const result = await acceptSkillProposal(c.get("orgId"), id, c.get("userId"));
  if (!result.ok) {
    return result.error === "not_found"
      ? c.json({ error: "proposal not found" }, 404)
      : c.json({ error: "proposal already resolved" }, 409);
  }
  return c.json({
    proposal: toProposalApi(result.proposal),
    skill_id: result.skillId,
    version: result.version,
  });
});

// POST /api/skills/proposals/:id/dismiss — org admin; recorded, never deleted.
skillProposalRoutes.post("/:id/dismiss", orgAdminScope, async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "proposal not found" }, 404);
  const result = await dismissSkillProposal(c.get("orgId"), id, c.get("userId"));
  if (!result.ok) {
    return result.error === "not_found"
      ? c.json({ error: "proposal not found" }, 404)
      : c.json({ error: "proposal already resolved" }, 409);
  }
  return c.json({ proposal: toProposalApi(result.proposal) });
});
