/**
 * Backfill the unified context_index projection from the four authoritative
 * stores that already exist in prod (the 120 knowledge docs, 77 playbooks,
 * skills, and automations). Idempotent: re-running projects the same rows in
 * place (source-keyed upsert by source_ref), so it is safe to run repeatedly.
 *
 * The operator runs this ONCE to populate the index from existing data; the
 * sync-on-write hooks keep it current thereafter.
 *
 * Usage:
 *   # one org (the admin/target org):
 *   ORG_ID=org-skynet-dev bun run backend/scripts/backfill-context-index.ts
 *   # every org present across the stores:
 *   bun run backend/scripts/backfill-context-index.ts --all
 *
 * Only skills, knowledge_records, and schedules are projected in Phase 1 (memory
 * lives in an external service; it has no local write-hook or backfill source
 * yet - deferred to a later phase).
 */
import { db } from "../src/db/client";
import { schedules, skills } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { sql as knowledgeSql } from "../src/knowledge/store";
import {
  syncAutomationToContextIndex,
  syncKnowledgeToContextIndex,
  syncSkillToContextIndex,
  type ContextKind,
} from "../src/context/projector";
import { countContextRows } from "../src/context/store";

interface KindSummary {
  skills: number;
  knowledge: number;
  automations: number;
}

const args = new Set(process.argv.slice(2));
const allOrgs = args.has("--all");
const targetOrg = process.env.ORG_ID?.trim() || null;

if (!allOrgs && !targetOrg) {
  console.error(
    "Set ORG_ID=<org> to backfill one org, or pass --all to backfill every org across the stores.",
  );
  process.exit(1);
}

/** Every distinct org_id present across the projectable stores. */
async function discoverOrgs(): Promise<string[]> {
  const [skillOrgs, scheduleOrgs, knowledgeOrgs] = await Promise.all([
    db.selectDistinct({ orgId: skills.orgId }).from(skills),
    db.selectDistinct({ orgId: schedules.orgId }).from(schedules),
    knowledgeSql<{ org_id: string }[]>`SELECT DISTINCT org_id FROM knowledge_records`,
  ]);
  const orgs = new Set<string>();
  for (const r of skillOrgs) orgs.add(r.orgId);
  for (const r of scheduleOrgs) orgs.add(r.orgId);
  for (const r of knowledgeOrgs) orgs.add(r.org_id);
  return [...orgs].filter(Boolean);
}

async function backfillSkills(orgId: string): Promise<number> {
  const rows = await db.select().from(skills).where(eq(skills.orgId, orgId));
  for (const row of rows) {
    await syncSkillToContextIndex({
      id: row.id,
      orgId: row.orgId,
      // "skill" | "playbook" from the store; both are valid ContextKind.
      kind: row.kind as ContextKind,
      name: row.name,
      description: row.description,
      tags: row.tags,
      sections: row.sections,
      currentVersion: row.currentVersion,
    });
  }
  return rows.length;
}

async function backfillKnowledge(orgId: string): Promise<number> {
  // knowledge_records are the agent-searchable rows (published wiki + accepted
  // distillations). external/public visibility only - drafts are never here.
  const rows = await knowledgeSql<
    { id: string; title: string; body: string }[]
  >`
    SELECT id, title, body FROM knowledge_records
    WHERE org_id = ${orgId} AND visibility IN ('internal', 'public')
  `;
  for (const row of rows) {
    await syncKnowledgeToContextIndex({
      recordId: row.id,
      orgId,
      title: row.title,
      body: row.body,
    });
  }
  return rows.length;
}

async function backfillAutomations(orgId: string): Promise<number> {
  const rows = await db.select().from(schedules).where(eq(schedules.orgId, orgId));
  for (const row of rows) {
    await syncAutomationToContextIndex({
      id: row.id,
      orgId: row.orgId,
      name: row.name,
      prompt: row.prompt,
      cron: row.cron,
      tags: row.tags,
    });
  }
  return rows.length;
}

async function backfillOrg(orgId: string): Promise<KindSummary> {
  const [skillCount, knowledgeCount, automationCount] = [
    await backfillSkills(orgId),
    await backfillKnowledge(orgId),
    await backfillAutomations(orgId),
  ];
  return { skills: skillCount, knowledge: knowledgeCount, automations: automationCount };
}

const orgs = allOrgs ? await discoverOrgs() : [targetOrg!];
console.log(`[backfill] projecting ${orgs.length} org(s) into context_index...`);

const totals: KindSummary = { skills: 0, knowledge: 0, automations: 0 };
for (const orgId of orgs) {
  const summary = await backfillOrg(orgId);
  const indexed = await countContextRows(orgId);
  totals.skills += summary.skills;
  totals.knowledge += summary.knowledge;
  totals.automations += summary.automations;
  console.log(
    `[backfill] ${orgId}: skills=${summary.skills} knowledge=${summary.knowledge} ` +
      `automations=${summary.automations} -> ${indexed} index rows`,
  );
}

console.log(
  `[backfill] done. projected skills=${totals.skills} knowledge=${totals.knowledge} ` +
    `automations=${totals.automations} across ${orgs.length} org(s).`,
);

// Close pooled connections so the script exits promptly.
await knowledgeSql.end({ timeout: 5 }).catch(() => {});
process.exit(0);
