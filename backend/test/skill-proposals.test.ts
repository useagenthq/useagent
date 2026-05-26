/**
 * Learning lane item 6 — skill revision proposals from repeated accepted
 * learnings. Proves:
 *  - accepting a draft with >= 2 similar PRIOR accepted drafts raises exactly
 *    one PROPOSED skill revision (deterministic title similarity, deduped);
 *  - a proposal changes nothing until an org admin accepts it, and the accept
 *    goes through the existing skills path (new playbook, or a new immutable
 *    revision of a same-name skill);
 *  - dismiss is recorded; members cannot resolve; listing is org-scoped.
 */
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  knowledgeDrafts,
  member,
  user,
  type KnowledgeDraftEvidence,
  type ProcedureTraceStep,
} from "../src/db/schema";
import { createRun } from "../src/runs/repo";
import { createOrgSession, json, type OrgSession } from "./helpers";

interface ProposalApi {
  id: string;
  skill_id: string | null;
  name: string;
  proposed_content: string;
  source_draft_ids: string[];
  status: string;
  resolved_skill_id: string | null;
  resolved_version: number | null;
}

const EVIDENCE: KnowledgeDraftEvidence = {
  reason: "long_multi_tool_run",
  engine: "mock",
  model: "test",
  durationMs: 1000,
  stepCount: 12,
  distinctStepKinds: 2,
  artifactCount: 0,
  artifactNames: [],
};

/** Insert an OPEN draft directly (the producer path is proven in
 *  knowledge-drafts.test.ts); returns its id. */
async function insertDraft(
  session: OrgSession,
  title: string,
  procedure?: ProcedureTraceStep[],
): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: title,
    model: "test",
    engine: "mock",
    orgId: session.orgId,
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  const [row] = await db
    .insert(knowledgeDrafts)
    .values({
      orgId: session.orgId,
      runId,
      threadId: runId,
      title,
      content: `## Task\n\n${title}\n\n## Outcome\n\nDone.\n`,
      evidence: procedure ? { ...EVIDENCE, procedure } : EVIDENCE,
    })
    .returning({ id: knowledgeDrafts.id });
  return row!.id;
}

async function acceptDraft(session: OrgSession, draftId: string) {
  return json<{ proposal_id: string | null }>(`/api/knowledge/drafts/${draftId}/accept`, {
    method: "POST",
    cookies: session.cookies,
  });
}

async function listProposals(session: OrgSession, status?: string) {
  const q = status ? `?status=${status}` : "";
  return json<{ proposals: ProposalApi[] }>(`/api/skills/proposals${q}`, {
    cookies: session.cookies,
  });
}

// Three phrasings of the same procedure (pairwise keyword Jaccard >= 0.5) plus
// an exact repeat used to prove open-proposal dedupe.
const SIMILAR_TITLES = [
  "Rotate API keys for payments",
  "Rotate the API keys for the payments service",
  "Rotate expired API keys for payments",
] as const;

describe("skill revision proposals", () => {
  test("the third similar accepted draft raises one deduped proposal", async () => {
    const org = await createOrgSession("sp-raise");
    const [d1, d2, d3] = await Promise.all(SIMILAR_TITLES.map((t) => insertDraft(org, t)));

    // First two accepts: fewer than 2 similar priors — no proposal.
    expect((await acceptDraft(org, d1!)).body.proposal_id).toBeNull();
    expect((await acceptDraft(org, d2!)).body.proposal_id).toBeNull();
    expect((await listProposals(org)).body.proposals).toHaveLength(0);

    // Third accept: 2 similar priors — the proposal is raised.
    const third = await acceptDraft(org, d3!);
    expect(third.status).toBe(200);
    expect(third.body.proposal_id).toBeTruthy();

    const { body } = await listProposals(org);
    expect(body.proposals).toHaveLength(1);
    const proposal = body.proposals[0]!;
    expect(proposal.status).toBe("proposed");
    // Named after the newest draft; brand-new skill (no same-name skill exists).
    expect(proposal.name).toBe("Rotate expired API keys for payments");
    expect(proposal.skill_id).toBeNull();
    expect(proposal.source_draft_ids.toSorted()).toEqual([d1!, d2!, d3!].toSorted());
    // The reviewer sees the exact SKILL.md an accept would materialize.
    expect(proposal.proposed_content).toContain("# Rotate expired API keys for payments");
    expect(proposal.proposed_content).toContain("## Procedure");

    // NOTHING changed in the skills catalog yet — proposals are inert.
    const skills = await json<{ skills: unknown[] }>("/api/skills", { cookies: org.cookies });
    expect(skills.body.skills).toHaveLength(0);

    // A fourth accept with the SAME title dedupes against the open proposal.
    const d4 = await insertDraft(org, "Rotate expired API keys for payments");
    expect((await acceptDraft(org, d4)).body.proposal_id).toBeNull();
    expect((await listProposals(org, "proposed")).body.proposals).toHaveLength(1);
  });

  test("drafts with procedure traces assemble the executable backbone into the proposal", async () => {
    const org = await createOrgSession("sp-backbone");
    const traceFor = (i: string): ProcedureTraceStep[] => [
      { tool: "bash", gist: `vault kv get payments/run-${i}`, ok: true },
      { tool: "edit", gist: ".env.production", ok: true },
      { tool: "bash", gist: "bun run deploy", ok: true },
    ];
    for (const [i, title] of SIMILAR_TITLES.entries()) {
      await acceptDraft(org, await insertDraft(org, title, traceFor(String(i))));
    }

    const proposal = (await listProposals(org)).body.proposals[0]!;
    // The Procedure section is the common ordered backbone (majority tools,
    // first-seen order, run-specific tokens generalized), not the generic
    // "search knowledge" fallback.
    expect(proposal.proposed_content).toContain("bash: vault kv get payments/run-2");
    expect(proposal.proposed_content).toContain("edit: .env.production");
    expect(proposal.proposed_content).not.toContain("Search org knowledge");
  });

  test("dissimilar accepted drafts never raise a proposal", async () => {
    const org = await createOrgSession("sp-dissimilar");
    for (const title of [
      "Rotate API keys for payments",
      "Generate the quarterly revenue report deck",
      "Backfill missing invoice rows in the warehouse",
    ]) {
      const id = await insertDraft(org, title);
      expect((await acceptDraft(org, id)).body.proposal_id).toBeNull();
    }
    expect((await listProposals(org)).body.proposals).toHaveLength(0);
  });

  test("accept (org admin) creates a real playbook through the skills path", async () => {
    const org = await createOrgSession("sp-accept");
    for (const title of SIMILAR_TITLES) {
      await acceptDraft(org, await insertDraft(org, title));
    }
    const proposal = (await listProposals(org)).body.proposals[0]!;

    const accept = await json<{ proposal: ProposalApi; skill_id: string; version: number }>(
      `/api/skills/proposals/${proposal.id}/accept`,
      { method: "POST", cookies: org.cookies },
    );
    expect(accept.status).toBe(200);
    expect(accept.body.version).toBe(1);
    expect(accept.body.proposal.status).toBe("accepted");
    expect(accept.body.proposal.resolved_skill_id).toBe(accept.body.skill_id);
    expect(accept.body.proposal.resolved_version).toBe(1);

    const skills = await json<{ skills: { id: string; name: string; kind: string; current_version: number }[] }>(
      "/api/skills",
      { cookies: org.cookies },
    );
    expect(skills.body.skills).toHaveLength(1);
    expect(skills.body.skills[0]!.id).toBe(accept.body.skill_id);
    expect(skills.body.skills[0]!.name).toBe(proposal.name);
    expect(skills.body.skills[0]!.kind).toBe("playbook");
    expect(skills.body.skills[0]!.current_version).toBe(1);

    // Already resolved: accept and dismiss both conflict now.
    expect(
      (await json(`/api/skills/proposals/${proposal.id}/accept`, { method: "POST", cookies: org.cookies }))
        .status,
    ).toBe(409);
    expect(
      (await json(`/api/skills/proposals/${proposal.id}/dismiss`, { method: "POST", cookies: org.cookies }))
        .status,
    ).toBe(409);
  });

  test("a same-name existing skill makes the accept mint a new revision", async () => {
    const org = await createOrgSession("sp-revision");
    // Hand-author the skill FIRST, named exactly like the newest draft's title.
    const created = await json<{ id: string; current_version: number }>("/api/skills", {
      method: "POST",
      cookies: org.cookies,
      body: {
        name: "Rotate expired API keys for payments",
        description: "Hand-authored v1",
        sections: { overview: ["v1"], procedure: ["step"], verify: ["check"] },
      },
    });
    expect(created.status).toBe(201);

    for (const title of SIMILAR_TITLES) {
      await acceptDraft(org, await insertDraft(org, title));
    }
    const proposal = (await listProposals(org)).body.proposals[0]!;
    // The proposal targets the existing skill (revision, not a new skill).
    expect(proposal.skill_id).toBe(created.body.id);

    const accept = await json<{ skill_id: string; version: number }>(
      `/api/skills/proposals/${proposal.id}/accept`,
      { method: "POST", cookies: org.cookies },
    );
    expect(accept.status).toBe(200);
    expect(accept.body.skill_id).toBe(created.body.id);
    expect(accept.body.version).toBe(2);

    const skills = await json<{ skills: { id: string; current_version: number }[] }>("/api/skills", {
      cookies: org.cookies,
    });
    expect(skills.body.skills).toHaveLength(1);
    expect(skills.body.skills[0]!.current_version).toBe(2);
  });

  test("dismiss is recorded; members cannot resolve; listing is org-scoped", async () => {
    const org = await createOrgSession("sp-dismiss");
    const outsider = await createOrgSession("sp-outsider");
    for (const title of SIMILAR_TITLES) {
      await acceptDraft(org, await insertDraft(org, title));
    }
    const proposal = (await listProposals(org)).body.proposals[0]!;

    // Org-scoped: the outsider sees nothing and cannot resolve by id.
    expect((await listProposals(outsider)).body.proposals).toHaveLength(0);
    expect(
      (await json(`/api/skills/proposals/${proposal.id}/dismiss`, {
        method: "POST",
        cookies: outsider.cookies,
      })).status,
    ).toBe(404);

    // A demoted member may list but not resolve.
    const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, org.email));
    await db
      .update(member)
      .set({ role: "member" })
      .where(and(eq(member.organizationId, org.orgId), eq(member.userId, account!.id)));
    expect((await listProposals(org)).status).toBe(200);
    const forbidden = await json<{ error: string }>(
      `/api/skills/proposals/${proposal.id}/accept`,
      { method: "POST", cookies: org.cookies },
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("organization_admin_required");

    // Re-promote and dismiss for real.
    await db
      .update(member)
      .set({ role: "owner" })
      .where(and(eq(member.organizationId, org.orgId), eq(member.userId, account!.id)));
    const dismiss = await json<{ proposal: ProposalApi }>(
      `/api/skills/proposals/${proposal.id}/dismiss`,
      { method: "POST", cookies: org.cookies },
    );
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.proposal.status).toBe("dismissed");
    // Recorded, never deleted; and still no skill was created.
    expect((await listProposals(org, "dismissed")).body.proposals).toHaveLength(1);
    const skills = await json<{ skills: unknown[] }>("/api/skills", { cookies: org.cookies });
    expect(skills.body.skills).toHaveLength(0);
  });
});
