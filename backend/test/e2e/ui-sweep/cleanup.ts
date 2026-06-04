/**
 * Surgical cleanup of the sweep's throwaway fixtures on the SHARED `skynet` DB.
 * Deletes ONLY rows tagged `uisweep` (runs, skills, schedules, knowledge records
 * + documents), child tables first where there's no FK cascade. Never psql.
 * Idempotent.
 *
 * Run:  DATABASE_URL=postgres://postgres@localhost:5432/useagent bun uisweep/cleanup.ts
 */
import postgres from "postgres";

const DB_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/useagent";
const sql = postgres(DB_URL, { max: 2 });

try {
  // ── runs (scenarios 1–11, 16, 17 fixtures) ──────────────────────────────────
  const runs = await sql<{ id: string }[]>`select id from runs where prompt like '%uisweep%'`;
  const ids = runs.map((r) => r.id);
  console.log(`uisweep cleanup: ${ids.length} run(s) tagged 'uisweep'`);
  if (ids.length > 0) {
    // Child tables (no cascade). Guarded — some tables may not carry our rows.
    await sql`delete from provider_events where run_id in ${sql(ids)}`.catch((e) => console.log("  provider_events:", e.message));
    await sql`delete from steps where run_id in ${sql(ids)}`.catch((e) => console.log("  steps:", e.message));
    await sql`delete from commands where run_id in ${sql(ids)}`.catch((e) => console.log("  commands:", e.message));
    await sql`delete from memory_outbox where run_id in ${sql(ids)}`.catch(() => {});
    await sql`delete from slack_outbox where idempotency_key like '%' and run_id in ${sql(ids)}`.catch(() => {});
    await sql`delete from slack_threads where root_run_id in ${sql(ids)}`.catch(() => {});
    // Break the parent_run_id self-reference before deleting the runs.
    await sql`update runs set parent_run_id = null where id in ${sql(ids)}`;
    const del = await sql`delete from runs where id in ${sql(ids)}`;
    console.log(`  deleted ${del.count} run rows + children`);
  }

  // ── skills (scenario 12) — skill_revisions cascade on delete, but be explicit ─
  const skillIds = (await sql<{ id: string }[]>`select id from skills where name like '%uisweep%'`.catch(() => [])).map((r) => r.id);
  if (skillIds.length > 0) {
    await sql`delete from skill_revisions where skill_id in ${sql(skillIds)}`.catch(() => {});
    const del = await sql`delete from skills where id in ${sql(skillIds)}`;
    console.log(`  deleted ${del.count} skill(s) + revisions`);
  }

  // ── schedules (scenario 15) — schedule_firings child first (no cascade) ──────
  const schedIds = (await sql<{ id: string }[]>`select id from schedules where name like '%uisweep%'`.catch(() => [])).map((r) => r.id);
  if (schedIds.length > 0) {
    await sql`delete from schedule_firings where schedule_id in ${sql(schedIds)}`.catch(() => {});
    const del = await sql`delete from schedules where id in ${sql(schedIds)}`;
    console.log(`  deleted ${del.count} schedule(s) + firings`);
  }

  // ── knowledge records (scenarios 13 + 14) — tagged via external_id / connector,
  //    and the published wiki record whose title carries the tag (external_id is
  //    `wiki:<docId>`, so match title too) ──────────────────────────────────────
  const kbDel = await sql`delete from knowledge_records where external_id like '%uisweep%' or connector_instance_id like 'uisweep%' or title like '%uisweep%'`.catch((e) => { console.log("  knowledge_records:", e.message); return { count: 0 }; });
  if (kbDel.count) console.log(`  deleted ${kbDel.count} knowledge record(s)`);

  // ── wiki documents (scenario 14) — knowledge_revisions cascade ON DELETE ─────
  const docIds = (await sql<{ id: string }[]>`select id from knowledge_documents where title like '%uisweep%'`.catch(() => [])).map((r) => r.id);
  if (docIds.length > 0) {
    const del = await sql`delete from knowledge_documents where id in ${sql(docIds)}`; // revisions cascade
    console.log(`  deleted ${del.count} wiki document(s) + revisions`);
  }
} finally {
  await sql.end();
}
