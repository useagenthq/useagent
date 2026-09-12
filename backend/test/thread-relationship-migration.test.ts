import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

test("0077 upgrades 0076 roots and installs relationship integrity", async () => {
  const migrationsFolder = `${import.meta.dir}/../drizzle`;
  const partialFolder = await mkdtemp(join(tmpdir(), "useagent-0076-"));
  const databaseName = `useagent_tr_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
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
    const cutoff = journal.entries.findIndex((entry) => entry.tag === "0076_artifact_quality_receipts");
    const entries0076 = journal.entries.slice(0, cutoff + 1);
    await mkdir(join(partialFolder, "meta"), { recursive: true });
    await Bun.write(
      join(partialFolder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: entries0076 }, null, 2),
    );
    for (const entry of entries0076) {
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
      insert into runs (id, org_id, prompt, model, engine, status, thread_id, origin)
      values
        ('public-root', 'org-upgrade', 'Public root', 'mock', 'mock', 'completed', 'public-root', null),
        ('internal-root', 'org-upgrade', 'Internal root', 'mock', 'mock', 'completed', 'internal-root', 'internal:canary');
      insert into runs (id, org_id, prompt, model, engine, status, thread_id, parent_run_id)
      values ('public-turn-2', 'org-upgrade', 'Second turn', 'mock', 'mock', 'completed', 'public-root', 'public-root');
    `);

    await migrate(upgradeDb, { migrationsFolder });

    const relationships = await client.unsafe<Array<{ thread_id: string; kind: string }>>(`
      select thread_id, kind from thread_relationships order by thread_id
    `);
    expect(relationships).toEqual([{ thread_id: "public-root", kind: "root" }]);

    const constraints = await client.unsafe<Array<{ conname: string }>>(`
      select conname from pg_constraint
      where conname in (
        'trg_validate_thread_relationship',
        'trg_validate_child_thread_batch',
        'trg_validate_child_thread_batch_item',
        'trg_validate_child_thread_batch_membership_batch',
        'trg_validate_child_thread_batch_membership_item'
      ) order by conname
    `);
    expect(constraints.map((row) => row.conname)).toHaveLength(5);

    let internalRootError: unknown;
    try {
      await client.unsafe(`
        insert into thread_relationships
          (org_id, thread_id, parent_thread_id, family_thread_id, kind, title, source_run_id)
        values ('org-upgrade', 'internal-root', null, 'internal-root', 'root', 'Internal', 'internal-root')
      `);
    } catch (error) {
      internalRootError = error;
    }
    expect(internalRootError).toBeTruthy();
  } finally {
    if (client) await client.end({ timeout: 1 });
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => {});
    await admin.end({ timeout: 1 });
    await rm(partialFolder, { recursive: true, force: true });
  }
}, 90_000);
