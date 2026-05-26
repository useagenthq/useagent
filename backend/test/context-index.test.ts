import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../src/index"; // run committed migrations (incl. 0048_context_index) before DB assertions
import { ready as knowledgeReady, sql as knowledgeSql } from "../src/knowledge/store";
import {
  syncAutomationToContextIndex,
  syncKnowledgeToContextIndex,
  syncSkillToContextIndex,
} from "../src/context/projector";
import {
  countContextRows,
  getContextBySourceRef,
  searchContext,
  upsertContextRow,
} from "../src/context/store";
import { createSkillWithRevision, updateSkillWithRevision } from "../src/skills/repo";
import { createScheduleForOrg } from "../src/schedules/service";
import { publishDocument } from "../src/knowledge/wiki";
import { db } from "../src/db/client";
import { schedules, skills } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { executeContextTool } from "../src/knowledge/gateway/context-tools";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";

// ---------------------------------------------------------------------------
// Unified Context Index (Phase 1) — DB-backed. Proves the migration lands the
// table, the projector upserts idempotently per kind with the right source_ref,
// context_search ranks + filters + org-scopes + bounds, and context_read
// dispatches to the real store per kind and fails closed cross-org.
// ---------------------------------------------------------------------------

const org = `org-ctx-${crypto.randomUUID()}`;
const otherOrg = `org-ctx-other-${crypto.randomUUID()}`;

function claimsFor(orgId: string): ToolTokenClaims {
  return {
    orgId,
    userId: "user-ctx",
    threadId: "thread-ctx",
    runId: "run-ctx",
    scope: "run",
    exp: Date.now() + 60_000,
  };
}

async function cleanupOrg(orgId: string): Promise<void> {
  await knowledgeSql`DELETE FROM context_index WHERE org_id = ${orgId}`;
  await knowledgeSql`DELETE FROM knowledge_records WHERE org_id = ${orgId}`;
  await knowledgeSql`DELETE FROM knowledge_revisions WHERE org_id = ${orgId}`;
  await knowledgeSql`DELETE FROM knowledge_documents WHERE org_id = ${orgId}`;
  await db.delete(schedules).where(eq(schedules.orgId, orgId));
  await db.delete(skills).where(eq(skills.orgId, orgId));
}

beforeAll(async () => {
  // The knowledge substrate (knowledge_records/documents/revisions) is created
  // lazily by the knowledge store on first use; ensure it exists before the raw
  // SQL fixtures below touch those tables directly.
  await knowledgeReady();
});

afterAll(async () => {
  await cleanupOrg(org);
  await cleanupOrg(otherOrg);
});

describe("context_index migration + store", () => {
  test("the migration created the table (a fresh org has zero rows)", async () => {
    expect(await countContextRows(org)).toBe(0);
  });

  test("upsert is source-keyed idempotent: same source_ref replaces in place", async () => {
    const ref = `knowledge:idem-${crypto.randomUUID()}`;
    await upsertContextRow({
      orgId: org,
      kind: "knowledge",
      title: "First",
      searchableText: "First title body",
      sourceRef: ref,
      sourceKindId: "idem-1",
      version: null,
    });
    await upsertContextRow({
      orgId: org,
      kind: "knowledge",
      title: "Second",
      searchableText: "Second title body",
      sourceRef: ref,
      sourceKindId: "idem-1",
      version: null,
    });
    const row = await getContextBySourceRef(org, ref);
    expect(row?.title).toBe("Second"); // replaced, not duplicated
    const dupes = await knowledgeSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM context_index WHERE org_id = ${org} AND source_ref = ${ref}
    `;
    expect(dupes[0]?.n).toBe(1);
    // cleanup this probe row so it doesn't pollute later search assertions
    await knowledgeSql`DELETE FROM context_index WHERE org_id = ${org} AND source_ref = ${ref}`;
  });
});

describe("projector sync on write", () => {
  test("creating a skill projects a context_index row (skill:<id>@<version>)", async () => {
    const skill = await createSkillWithRevision({
      orgId: org,
      name: "Kubernetes rollback procedure",
      description: "Roll a bad deploy back to the previous revision.",
      tags: ["k8s", "rollback"],
      sections: {
        overview: ["A rollback restores the last-known-good ReplicaSet."],
        procedure: ["kubectl rollout undo deployment/api"],
        verify: ["kubectl rollout status deployment/api"],
      },
    });
    if (!skill) throw new Error("skill fixture failed");
    const row = await getContextBySourceRef(org, `skill:${skill.id}@1`);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("skill");
    expect(row?.version).toBe(1);
    expect(row?.searchable_text).toContain("kubectl rollout undo");
  });

  test("editing a skill re-projects the current version and drops the stale row", async () => {
    const skill = await createSkillWithRevision({
      orgId: org,
      name: "Grafana dashboard export",
      description: "Export a dashboard as JSON.",
      tags: [],
      sections: { overview: ["Use the share menu."], procedure: [], verify: [] },
    });
    if (!skill) throw new Error("skill fixture failed");
    await updateSkillWithRevision(org, skill.id, {
      description: "Export a dashboard as JSON via the API.",
      sections: { overview: ["Call GET /api/dashboards/uid."], procedure: [], verify: [] },
    });
    // v1 row is gone; only the current v2 row survives.
    expect(await getContextBySourceRef(org, `skill:${skill.id}@1`)).toBeNull();
    const v2 = await getContextBySourceRef(org, `skill:${skill.id}@2`);
    expect(v2?.version).toBe(2);
    expect(v2?.searchable_text).toContain("GET /api/dashboards/uid");
  });

  test("creating an automation projects an automation:<id> row", async () => {
    const schedule = await createScheduleForOrg(
      { orgId: org, userId: "user-ctx" },
      {
        name: "Weekly backlog triage",
        cron: "0 10 * * 1",
        prompt: "Triage the backlog and post a summary.",
        engine: "mock",
        model: "mock-model",
      },
    );
    const row = await getContextBySourceRef(org, `automation:${schedule.id}`);
    expect(row?.kind).toBe("automation");
    expect(row?.searchable_text).toContain("Triage the backlog");
  });

  test("publishing a wiki document projects a knowledge:<recordId> row", async () => {
    const [doc] = await knowledgeSql<{ id: string }[]>`
      INSERT INTO knowledge_documents (org_id, user_id, collection, title, status)
      VALUES (${org}, ${"user-ctx"}, 'wiki', ${"Onboarding checklist"}, 'draft')
      RETURNING id
    `;
    await knowledgeSql`
      INSERT INTO knowledge_revisions (document_id, org_id, content, content_hash)
      VALUES (${doc!.id}, ${org}, ${"Provision the laptop and grant SSO access."}, ${"h1"})
    `;
    await publishDocument(org, doc!.id);
    const [rec] = await knowledgeSql<{ id: string }[]>`
      SELECT id FROM knowledge_records WHERE org_id = ${org} AND external_id = ${`wiki:${doc!.id}`} LIMIT 1
    `;
    const row = await getContextBySourceRef(org, `knowledge:${rec!.id}`);
    expect(row?.kind).toBe("knowledge");
    expect(row?.searchable_text).toContain("grant SSO access");
  });
});

describe("context_search", () => {
  test("keyword rank returns the most relevant kind, filters by kind, and bounds results", async () => {
    // "rollback" appears in the k8s skill above; a kind filter to knowledge must
    // exclude it.
    const all = await searchContext({ orgId: org, query: "rollback deploy" });
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((h) => h.kind)).toContain("skill");

    const knowledgeOnly = await searchContext({
      orgId: org,
      query: "rollback deploy",
      kinds: ["knowledge"],
    });
    expect(knowledgeOnly.every((h) => h.kind === "knowledge")).toBe(true);

    const bounded = await searchContext({ orgId: org, query: "the", k: 2 });
    expect(bounded.length).toBeLessThanOrEqual(2);
  });

  test("is org-scoped: another org's rows never appear", async () => {
    await syncSkillToContextIndex({
      id: `cross-${crypto.randomUUID()}`,
      orgId: otherOrg,
      kind: "skill",
      name: "Cross tenant rollback secret",
      description: "Must never leak across orgs.",
      tags: [],
      sections: { overview: ["private"], procedure: [], verify: [] },
      currentVersion: 1,
    });
    const hits = await searchContext({ orgId: org, query: "rollback" });
    expect(hits.every((h) => !h.title.includes("Cross tenant"))).toBe(true);
  });

  test("the tool returns typed results with kind/title/snippet/source_ref/version", async () => {
    const result = await executeContextTool(claimsFor(org), "context_search", {
      query: "kubernetes rollback",
    });
    expect(result.isError).toBeUndefined();
    const results = (result.structuredContent?.results ?? []) as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    const first = results[0]!;
    expect(first).toHaveProperty("kind");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("snippet");
    expect(first).toHaveProperty("source_ref");
    expect(first).toHaveProperty("version");
    // keyword-only mode when no embed key (the test preload strips OPENAI_API_KEY)
    expect(result.structuredContent?.mode).toBe("keyword");
  });

  test("empty query is refused with an actionable message", async () => {
    const result = await executeContextTool(claimsFor(org), "context_search", { query: "  " });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("non-empty");
  });
});

describe("context_read", () => {
  test("dispatches a skill source_ref to the full authoritative skill body", async () => {
    const skill = await createSkillWithRevision({
      orgId: org,
      name: "Read dispatch skill",
      description: "A skill to read back in full.",
      tags: [],
      sections: { overview: ["The canary token is READCANARY42."], procedure: [], verify: [] },
    });
    if (!skill) throw new Error("skill fixture failed");
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: `skill:${skill.id}@1`,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("READCANARY42");
    expect(result.structuredContent?.kind).toBe("skill");
  });

  test("dispatches a knowledge source_ref to the document body", async () => {
    const [rec] = await knowledgeSql<{ id: string }[]>`
      SELECT id FROM knowledge_records WHERE org_id = ${org} AND external_id LIKE 'wiki:%' LIMIT 1
    `;
    if (!rec) throw new Error("expected a published wiki record from an earlier test");
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: `knowledge:${rec.id}`,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("grant SSO access");
    expect(result.structuredContent?.kind).toBe("knowledge");
  });

  test("dispatches an automation source_ref to the prompt + cron", async () => {
    const [sched] = await db.select().from(schedules).where(eq(schedules.orgId, org)).limit(1);
    if (!sched) throw new Error("expected an automation fixture");
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: `automation:${sched.id}`,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Triage the backlog");
    expect(result.structuredContent?.kind).toBe("automation");
  });

  test("cross-org read fails closed (not-found, no cross-tenant oracle)", async () => {
    const skill = await createSkillWithRevision({
      orgId: otherOrg,
      name: "Other org private skill",
      description: "secret",
      tags: [],
      sections: { overview: ["secret"], procedure: [], verify: [] },
    });
    if (!skill) throw new Error("skill fixture failed");
    // A caller in `org` cannot read `otherOrg`'s skill even with a valid ref.
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: `skill:${skill.id}@1`,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not available to your organization");
  });

  test("a malformed source_ref is refused with the remedy", async () => {
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: "not-a-real-ref",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("malformed");
  });
});
