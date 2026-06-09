import { afterAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import {
  applyCanonicalExecutionTranscriptIndex,
  CANONICAL_EXECUTION_TRANSCRIPT_INDEX,
  inspectCanonicalExecutionTranscriptIndex,
  verifyCanonicalExecutionTranscriptIndex,
} from "../src/db/online-indexes/canonical-execution-transcript";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const databaseName = `useagent_online_index_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${databaseName}`;

const admin = postgres(ADMIN_URL, { max: 1 });
let databaseCreated = false;
let client: Sql | null = null;

async function cleanup(): Promise<void> {
  if (client) {
    await client.end().catch(() => {});
    client = null;
  }
  if (databaseCreated) {
    await admin`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
    `.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
    databaseCreated = false;
  }
}

function activeClient(): Sql {
  if (!client) throw new Error("canonical execution index test database is unavailable");
  return client;
}

afterAll(async () => {
  await cleanup();
  await admin.end();
});

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  client = postgres(testUrl.toString(), { max: 2 });
  const testDb = drizzle(client);
  await migrate(testDb, { migrationsFolder: `${import.meta.dir}/../drizzle` });
} catch (error) {
  await cleanup();
  await admin.end().catch(() => {});
  throw error;
}

describe("canonical execution transcript online index", () => {
  test("applies idempotently and verifies the exact catalog definition", async () => {
    expect(await applyCanonicalExecutionTranscriptIndex({
      databaseUrl: testUrl.toString(),
      statementTimeoutMs: 30_000,
    })).toEqual({ kind: "exact-valid" });
    expect(await applyCanonicalExecutionTranscriptIndex({
      databaseUrl: testUrl.toString(),
      statementTimeoutMs: 30_000,
    })).toEqual({ kind: "exact-valid" });
    await verifyCanonicalExecutionTranscriptIndex({ databaseUrl: testUrl.toString() });

    const reserved = await activeClient().reserve();
    try {
      expect(await inspectCanonicalExecutionTranscriptIndex(reserved)).toEqual({
        kind: "exact-valid",
      });
    } finally {
      reserved.release();
    }
  });

  test("the exact transcript query uses the owned index without a Sort", async () => {
    const client = activeClient();
    const runId = crypto.randomUUID();
    await client`
      INSERT INTO runs (id, org_id, prompt, model, engine, status, thread_id)
      VALUES (${runId}, 'index-test-org', 'index test', 'mock', 'mock', 'completed', ${runId})
    `;
    await client`
      INSERT INTO runs (id, org_id, prompt, model, engine, status, thread_id)
      SELECT
        'noise-index-' || generated.run_number,
        'index-test-org',
        'index noise',
        'mock',
        'mock',
        'completed',
        'noise-index-' || generated.run_number
      FROM generate_series(1, 50) AS generated(run_number)
    `;
    await client`
      INSERT INTO canonical_events
        (event_id, run_id, thread_id, seq, kind, ts, identity, body)
      SELECT
        noise.run_id || ':' || noise.seq,
        noise.run_id,
        noise.run_id,
        noise.seq,
        'message.completed',
        noise.seq,
        jsonb_build_object('provider', 'codex', 'nativeSessionId', 'noise-session'),
        jsonb_build_object('text', 'noise')
      FROM (
        SELECT 'noise-index-' || run_number AS run_id, seq
        FROM generate_series(1, 50) AS runs(run_number)
        CROSS JOIN generate_series(1, 250) AS events(seq)
      ) AS noise
    `;
    await client`
      INSERT INTO canonical_events
        (event_id, run_id, thread_id, seq, kind, ts, identity, body)
      SELECT
        ${runId} || ':' || generated.seq,
        ${runId},
        ${runId},
        generated.seq,
        'message.completed',
        generated.seq,
        jsonb_build_object('provider', 'codex', 'nativeSessionId', 'child-session'),
        jsonb_build_object('text', 'event ' || generated.seq)
      FROM generate_series(1, 20) AS generated(seq)
    `;
    await client`ANALYZE canonical_events`;
    const reserved = await client.reserve();
    try {
      await reserved.unsafe("SET enable_seqscan = off");
      const plan = await reserved<{ "QUERY PLAN": string }[]>`
        EXPLAIN (COSTS OFF)
        SELECT * FROM canonical_events
        WHERE run_id = ${runId}
          AND delivery_seq > 0
          AND identity->>'provider' = 'codex'
          AND identity->>'nativeSessionId' = 'child-session'
        ORDER BY delivery_seq ASC
        LIMIT 50
      `;
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toContain(CANONICAL_EXECUTION_TRANSCRIPT_INDEX);
      expect(text).not.toContain("Sort");
    } finally {
      reserved.release();
    }
  });
});
