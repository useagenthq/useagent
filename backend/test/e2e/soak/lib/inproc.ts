/**
 * In-process harness helpers for storms that drive src modules DIRECTLY (native
 * sequencer, outbox delivery) rather than through HTTP. The storm sets env, then
 * `recreateDb()` + a dynamic import of src/index runs migrate+seed. Modeled on
 * test/manual/native-reconnect-live.ts.
 *
 * IMPORTANT: the caller MUST set process.env.DATABASE_URL / PORT and any
 * feature-gating env BEFORE importing any src module (the db client + migrator +
 * port are read at import time).
 */
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

export async function recreateDb(name: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

export async function dropDb(name: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
  } finally {
    await admin.end();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
