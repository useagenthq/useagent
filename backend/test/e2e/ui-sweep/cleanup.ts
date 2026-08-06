/**
 * Surgical cleanup of the sweep's throwaway runs on the SHARED `skynet` DB.
 * Deletes ONLY rows whose run.prompt contains the `uisweep` tag, child tables
 * first (no FK cascade in the schema). Never psql. Idempotent.
 *
 * Run:  DATABASE_URL=postgres://postgres@localhost:5432/skynet bun uisweep/cleanup.ts
 */
import postgres from "postgres";

const DB_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/skynet";
const sql = postgres(DB_URL, { max: 2 });

try {
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
} finally {
  await sql.end();
}
