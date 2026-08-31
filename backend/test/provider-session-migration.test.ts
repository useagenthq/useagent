import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

test("a deployed 0073 database upgrades through typed sessions and Slack receipts", async () => {
  const migrationsFolder = `${import.meta.dir}/../drizzle`;
  const partialFolder = await mkdtemp(join(tmpdir(), "useagent-0073-"));
  const databaseName = `useagent_v003_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = postgres(ADMIN_URL, { max: 1 });
  const databaseUrl = new URL(ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;
  let client: ReturnType<typeof postgres> | null = null;

  try {
    const journal = JSON.parse(
      await Bun.file(`${migrationsFolder}/meta/_journal.json`).text(),
    ) as {
      entries: Array<{ tag: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    const cutoff = journal.entries.findIndex((entry) => entry.tag === "0073_daytona_user_connections");
    expect(cutoff).toBeGreaterThanOrEqual(0);
    const entries0073 = journal.entries.slice(0, cutoff + 1);
    await mkdir(join(partialFolder, "meta"), { recursive: true });
    await Bun.write(
      join(partialFolder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: entries0073 }, null, 2),
    );
    for (const entry of entries0073) {
      await Bun.write(
        join(partialFolder, `${entry.tag}.sql`),
        Bun.file(`${migrationsFolder}/${entry.tag}.sql`),
      );
    }

    await admin.unsafe(`create database "${databaseName}"`);
    client = postgres(databaseUrl.toString(), { max: 1 });
    const upgradeDb = drizzle(client);
    await migrate(upgradeDb, { migrationsFolder: partialFolder });
    await client.unsafe(`
      insert into runs
        (id, org_id, prompt, model, engine, status, thread_id, engine_session_id, sandbox_id)
      values
        ('legacy-run', 'org-legacy', 'legacy', 'openai/gpt-5.6-luna', 'opencode',
         'running', 'legacy-run', 'legacy-session', 'legacy-sandbox');
      insert into slack_outbox
        (id, idempotency_key, kind, payload, state)
      values
        ('legacy-outbox', 'legacy-outbox-key', 'post_message',
         '{"channel":"C1","chunks":["legacy"]}', 'delivered');
    `);

    await migrate(upgradeDb, { migrationsFolder });

    const [run] = await client.unsafe<{
      engine_session_id: string;
      provider_session: unknown;
    }[]>(`select engine_session_id, provider_session from runs where id = 'legacy-run'`);
    expect(run).toEqual({ engine_session_id: "legacy-session", provider_session: null });
    const [outbox] = await client.unsafe<{ receipt_emitted_at: Date | null }[]>(
      `select receipt_emitted_at from slack_outbox where id = 'legacy-outbox'`,
    );
    expect(outbox?.receipt_emitted_at).toBeNull();
    const indexes = await client.unsafe<{ indexname: string }[]>(`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'slack_outbox'
    `);
    expect(indexes.map((row) => row.indexname)).toContain("idx_slack_outbox_receipt_pending");
  } finally {
    if (client) await client.end();
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${databaseName} and pid <> pg_backend_pid()
    `.catch(() => {});
    await admin.unsafe(`drop database if exists "${databaseName}"`).catch(() => {});
    await admin.end();
    await rm(partialFolder, { recursive: true, force: true });
  }
});
