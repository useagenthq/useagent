import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

test("a seeded OSS 0073 database applies the appended finished-work migration", async () => {
  const migrationsFolder = `${import.meta.dir}/../drizzle`;
  const partialFolder = await mkdtemp(join(tmpdir(), "useagent-0073-"));
  const databaseName = `useagent_fw_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const admin = postgres(ADMIN_URL, { max: 1 });
  const databaseUrl = new URL(ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;
  let client: ReturnType<typeof postgres> | null = null;

  try {
    const journal = JSON.parse(
      await Bun.file(`${migrationsFolder}/meta/_journal.json`).text(),
    ) as {
      version: string;
      dialect: string;
      entries: Array<{ tag: string; [key: string]: unknown }>;
    };
    const entries0073 = journal.entries.slice(
      0,
      journal.entries.findIndex((entry) => entry.tag === "0073_daytona_user_connections") + 1,
    );
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
        (id, org_id, prompt, model, engine, status, thread_id)
      values
        ('root-a', 'org-a', 'root', 'test', 'mock', 'running', 'root-a'),
        ('child-a', 'org-a', 'child', 'test', 'mock', 'running', 'root-a'),
        ('root-b', 'org-b', 'root', 'test', 'mock', 'running', 'root-b');
      insert into slack_threads
        (team_id, channel, thread_ts, root_run_id, org_id, created_at)
      values
        ('team-old', 'channel-old', '100', 'root-a', 'org-a', '2026-01-01'),
        ('team-exact', 'channel-exact', '200', 'root-a', 'org-a', '2026-01-02'),
        ('team-b', 'channel-b', '300', 'root-b', 'org-b', '2026-01-01');
      insert into slack_run_responses
        (run_id, team_id, channel, thread_ts, fallback_message_ts, created_at, updated_at)
      values
        ('root-a', 'team-exact', 'channel-exact', '200', 'root-card', '2026-01-02', '2026-01-02'),
        ('child-a', 'team-old', 'channel-old', '100', 'old-child', '2026-01-01', '2026-01-01'),
        ('child-a', 'team-exact', 'channel-exact', '200', 'exact-child', '2026-01-02', '2026-01-02'),
        ('root-b', 'team-b', 'channel-b', '300', 'other-org', '2026-01-01', '2026-01-01');
    `);

    await migrate(upgradeDb, { migrationsFolder });

    const threads = await client.unsafe<{
      org_id: string;
      root_run_id: string;
      team_id: string;
      channel: string;
      thread_ts: string;
    }[]>(`select org_id, root_run_id, team_id, channel, thread_ts from slack_threads order by org_id`);
    expect(threads).toEqual([
      {
        org_id: "org-a",
        root_run_id: "root-a",
        team_id: "team-exact",
        channel: "channel-exact",
        thread_ts: "200",
      },
      {
        org_id: "org-b",
        root_run_id: "root-b",
        team_id: "team-b",
        channel: "channel-b",
        thread_ts: "300",
      },
    ]);
    const responses = await client.unsafe<{
      run_id: string;
      team_id: string;
      channel: string;
      thread_ts: string;
      fallback_message_ts: string;
    }[]>(`
      select run_id, team_id, channel, thread_ts, fallback_message_ts
      from slack_run_responses order by run_id
    `);
    expect(responses).toEqual([
      {
        run_id: "child-a",
        team_id: "team-exact",
        channel: "channel-exact",
        thread_ts: "200",
        fallback_message_ts: "exact-child",
      },
      {
        run_id: "root-a",
        team_id: "team-exact",
        channel: "channel-exact",
        thread_ts: "200",
        fallback_message_ts: "root-card",
      },
      {
        run_id: "root-b",
        team_id: "team-b",
        channel: "channel-b",
        thread_ts: "300",
        fallback_message_ts: "other-org",
      },
    ]);
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
