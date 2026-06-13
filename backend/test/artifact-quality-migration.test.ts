import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

test("0076 adds an empty append-only artifact quality ledger", async () => {
  const migrationsFolder = `${import.meta.dir}/../drizzle`;
  const partialFolder = await mkdtemp(join(tmpdir(), "useagent-0075-"));
  const databaseName = `useagent_aq_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const admin = postgres(ADMIN_URL, { max: 1 });
  const databaseUrl = new URL(ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;
  let client: ReturnType<typeof postgres> | null = null;

  try {
    const journal = JSON.parse(await Bun.file(`${migrationsFolder}/meta/_journal.json`).text()) as {
      version: string;
      dialect: string;
      entries: Array<{ tag: string; [key: string]: unknown }>;
    };
    const cutoff = journal.entries.findIndex((entry) => entry.tag === "0075_slack_delivery_receipts");
    const entries0075 = journal.entries.slice(0, cutoff + 1);
    await mkdir(join(partialFolder, "meta"), { recursive: true });
    await Bun.write(
      join(partialFolder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: entries0075 }, null, 2),
    );
    for (const entry of entries0075) {
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
      insert into runs (id, org_id, prompt, model, engine, status, thread_id)
      values ('quality-run', 'org-a', 'quality', 'test', 'mock', 'running', 'quality-run');
      insert into artifacts
        (id, org_id, run_id, thread_id, source_path, name, content_type, size_bytes, sha256, storage_key)
      values
        ('00000000-0000-4000-8000-000000000076', 'org-a', 'quality-run', 'quality-run', '/quality.pdf', 'quality.pdf', 'application/pdf', 1, '${"a".repeat(64)}', 'quality');
    `);
    await migrate(upgradeDb, { migrationsFolder });

    const empty = await client.unsafe<{ count: number }[]>(
      `select count(*)::int as count from artifact_quality_receipts`,
    );
    expect(empty[0]?.count).toBe(0);
    await client.unsafe(`
      insert into artifact_quality_receipts
        (id, org_id, artifact_id, thread_id, artifact_revision, subject_digest,
         quality_profile, export_format, export_digest, visual_digest,
         inspector_version, idempotency_key_hash, request_fingerprint)
      values
        ('00000000-0000-4000-8000-000000000077', 'org-a',
         '00000000-0000-4000-8000-000000000076', 'quality-run', 0, '${"a".repeat(64)}',
         'office_visual_v1', 'pdf', '${"b".repeat(64)}', '${"c".repeat(64)}',
         'trusted-inspector-1.0.0', '${"d".repeat(64)}', '${"e".repeat(64)}')
    `);
    let updateError: unknown;
    try {
      await client.unsafe(`
        update artifact_quality_receipts set inspector_version = 'changed'
        where id = '00000000-0000-4000-8000-000000000077'
      `);
    } catch (error) {
      updateError = error;
    }
    expect(String(updateError)).toContain("artifact quality receipts are immutable");
    let deleteError: unknown;
    try {
      await client.unsafe(`
        delete from artifact_quality_receipts
        where id = '00000000-0000-4000-8000-000000000077'
      `);
    } catch (error) {
      deleteError = error;
    }
    expect(String(deleteError)).toContain("artifact quality receipts are immutable");
    let scopeError: unknown;
    try {
      await client.unsafe(`
        insert into artifact_quality_receipts
          (org_id, artifact_id, thread_id, artifact_revision, subject_digest,
           quality_profile, export_format, export_digest, visual_digest,
           inspector_version, idempotency_key_hash, request_fingerprint)
        values
          ('org-b', '00000000-0000-4000-8000-000000000076', 'quality-run', 0,
           '${"a".repeat(64)}', 'office_visual_v1', 'pdf', '${"b".repeat(64)}',
           '${"c".repeat(64)}', 'trusted-inspector-1.0.0', '${"f".repeat(64)}', '${"0".repeat(64)}')
      `);
    } catch (error) {
      scopeError = error;
    }
    expect(scopeError).toBeTruthy();
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
}, 30_000);
