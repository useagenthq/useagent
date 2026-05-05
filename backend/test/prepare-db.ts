/**
 * Prepare the isolated test database. Run once before `bun test` (see the
 * "test" script in package.json). Idempotent — safe to run repeatedly.
 *
 * DROP + CREATE `skynet_test` (via the postgres client — psql is unusable on
 * this machine, it hangs on a macOS permission dialog), then leave it EMPTY.
 * The schema is built by the same committed Drizzle migrations the server runs
 * at boot: importing `src/index` (which every test does, via helpers) runs
 * `migrate()` before any test executes. This exercises the real migration path
 * instead of a drizzle-kit `push`, so a schema drift would fail the suite.
 *
 * The knowledge module owns its own tables and creates them lazily at first use
 * (store.ts `ready()`), so they need no step here.
 */
import postgres from "postgres";

const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const TEST_DB = "skynet_test";

async function recreateDatabase(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    // Boot any lingering connections so DROP DATABASE succeeds.
    await admin`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = ${TEST_DB} AND pid <> pg_backend_pid()
    `.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    console.log(`[test] recreated empty database "${TEST_DB}" (boot migrator builds the schema)`);
  } finally {
    await admin.end();
  }
}

await recreateDatabase();
