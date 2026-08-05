/**
 * Remove rows created by the Playwright e2e suite from the dev `skynet`
 * database. Everything the specs create is tagged with the marker below (or,
 * for auth users, an `e2e-skynet-` email prefix). Idempotent + defensive:
 * each delete is independent so one failure never blocks the rest.
 *
 * Run automatically by the frontend e2e global teardown, or by hand:
 *   cd backend && bun run test/e2e-cleanup.ts
 */
import postgres from "postgres";

const MARKER = "[e2e-skynet]";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/skynet";

const sql = postgres(DATABASE_URL, { max: 1 });

async function step(label: string, fn: () => Promise<number>): Promise<void> {
  try {
    const n = await fn();
    console.log(`[e2e-cleanup] ${label}: ${n}`);
  } catch (e) {
    console.warn(`[e2e-cleanup] ${label} failed: ${(e as Error).message}`);
  }
}

// Runs + their steps (steps FK-reference runs, so steps go first).
await step("steps", async () => {
  const rows = await sql`
    DELETE FROM steps WHERE run_id IN (
      SELECT id FROM runs WHERE prompt LIKE ${"%" + MARKER + "%"}
    ) RETURNING id`;
  return rows.count;
});
await step("runs", async () => {
  const rows = await sql`DELETE FROM runs WHERE prompt LIKE ${"%" + MARKER + "%"} RETURNING id`;
  return rows.count;
});

// Skills created by the skills spec (belt-and-suspenders — the spec also
// deletes via the API).
await step("skills", async () => {
  const rows = await sql`DELETE FROM skills WHERE name LIKE ${"%" + MARKER + "%"} RETURNING id`;
  return rows.count;
});

// Knowledge records created by the knowledge spec. The distilled title/body may
// not contain the marker verbatim, so also sweep manual:web records whose stored
// text still carries it (the spec deletes its own record by id regardless).
await step("knowledge_records", async () => {
  const rows = await sql`
    DELETE FROM knowledge_records
    WHERE connector_instance_id = 'manual:web'
      AND (title ILIKE ${"%" + MARKER + "%"} OR body ILIKE ${"%" + MARKER + "%"})
    RETURNING id`;
  return rows.count;
});

// Auth users the auth/signup spec created (sessions/accounts/members cascade).
await step("sessions", async () => {
  const rows = await sql`
    DELETE FROM session WHERE user_id IN (
      SELECT id FROM "user" WHERE email LIKE 'e2e-skynet-%@example.com'
    ) RETURNING id`;
  return rows.count;
});
await step("accounts", async () => {
  const rows = await sql`
    DELETE FROM account WHERE user_id IN (
      SELECT id FROM "user" WHERE email LIKE 'e2e-skynet-%@example.com'
    ) RETURNING id`;
  return rows.count;
});
await step("users", async () => {
  const rows = await sql`DELETE FROM "user" WHERE email LIKE 'e2e-skynet-%@example.com' RETURNING id`;
  return rows.count;
});

await sql.end();
