import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../src/db/client";
import { scheduleFirings } from "../src/db/schema";
import { getScheduleForOrg, type ApiSchedule } from "../src/schedules/repo";
import { tick } from "../src/schedules/scheduler";
import { createOrgSession, json, waitFor } from "./helpers";
import { testDatabaseUrl } from "./test-database";

const MIGRATION = new URL("../drizzle/0114_schedule_zones.sql", import.meta.url);
/** The zone the suite's own clock runs in (bun test runs in UTC). */
const OWN_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Apply the zone migration as a backend whose clock runs in `timeZone` does:
 *  migrate() on the backend's pool in a fresh process started with that TZ,
 *  against a scratch record table so it applies again. Given OWN_ZONE, the
 *  suite's database ends as the boot migration left it. */
async function applyZoneMigrationAs(timeZone: string): Promise<void> {
  const tag = crypto.randomUUID().slice(0, 8);
  const folder = mkdtempSync(join(tmpdir(), "zone-migration-"));
  try {
    mkdirSync(join(folder, "meta"));
    copyFileSync(MIGRATION, join(folder, "0000_zones.sql"));
    writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({
      version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1, tag: "0000_zones", breakpoints: true }],
    }));
    const client = new URL("../src/db/client.ts", import.meta.url).pathname;
    const backend = Bun.spawn({
      cmd: [process.execPath, "-e", `const { db } = await import(${JSON.stringify(client)});
        const { migrate } = await import("drizzle-orm/postgres-js/migrator");
        await migrate(db, { migrationsFolder: ${JSON.stringify(folder)}, migrationsTable: ${JSON.stringify(`zone_migrations_${tag}`)} });
        process.exit(0);`],
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, TZ: timeZone, DATABASE_URL: testDatabaseUrl() },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([backend.exited, new Response(backend.stderr).text()]);
    if (exitCode !== 0) throw new Error(`migration as a ${timeZone} backend exited ${exitCode}: ${stderr}`);
  } finally {
    await db.execute(sql`drop table if exists drizzle.${sql.identifier(`zone_migrations_${tag}`)}`);
    rmSync(folder, { recursive: true, force: true });
  }
}

/** An enabled schedule created through the API in `timezone`. */
async function enabledSchedule(label: string, cron: string, timezone: string) {
  const session = await createOrgSession(label);
  const created = await json<ApiSchedule>("/api/schedules", {
    method: "POST",
    cookies: session.cookies,
    body: { name: label, cron, timezone, prompt: `prompt ${label}`, engine: "mock" },
  });
  expect(created.status).toBe(201);
  const enabled = await json<ApiSchedule>(`/api/schedules/${created.body.id}`, {
    method: "PATCH",
    cookies: session.cookies,
    body: { enabled: true },
  });
  expect(enabled.status).toBe(200);
  return { session, id: created.body.id };
}

async function disable(id: string): Promise<void> {
  await db.execute(sql`update schedules set enabled = false where id = ${id}`);
}

async function cronFirings(id: string): Promise<number> {
  const rows = await db
    .select({ id: scheduleFirings.id })
    .from(scheduleFirings)
    .where(and(eq(scheduleFirings.scheduleId, id), eq(scheduleFirings.trigger, "cron")));
  return rows.length;
}

/** Undo the migration's constraint and trigger, as the previous release had it. */
async function asBeforeTheMigration(): Promise<void> {
  await db.execute(sql`alter table schedules alter column timezone drop not null`);
  await db.execute(sql`drop trigger if exists schedules_timezone_fill on schedules`);
}

describe("schedule zone migration", () => {
  test("a schedule saved without a zone gets its backend's zone and fires when it did", async () => {
    await asBeforeTheMigration();
    const legacy = await enabledSchedule("zone-legacy", "45 1 * * *", "UTC");
    const zoned = await enabledSchedule("zone-kept", "0 9 * * *", "Asia/Kolkata");
    await db.execute(sql`update schedules set timezone = null where id = ${legacy.id}`);
    let olderBackendRow: string | null = null;
    try {
      // A backend whose own clock reads Lord Howe time (a half-hour DST change)
      // applies it the way a release does.
      await applyZoneMigrationAs("Australia/Lord_Howe");
      expect((await getScheduleForOrg(legacy.session.orgId, legacy.id))?.timezone).toBe("Australia/Lord_Howe");
      expect((await getScheduleForOrg(zoned.session.orgId, zoned.id))?.timezone).toBe("Asia/Kolkata");
      const [column] = await db.execute<{ nullable: string }>(sql`
        select is_nullable as nullable from information_schema.columns where table_name = 'schedules' and column_name = 'timezone'`);
      expect(column?.nullable).toBe("NO");

      // It fires on the clock it fired on before: 01:45 Lord Howe daylight time
      // (14:45Z), once, though the half-hour fall-back repeats 01:45 at 15:15Z.
      await tick(new Date("2026-04-04T14:45:10Z"));
      await tick(new Date("2026-04-04T15:15:10Z"));
      expect(await cronFirings(legacy.id)).toBe(1);

      // The previous backend serves until the swap and still saves a schedule
      // sent without a zone, or clears one, with none: each gets the same zone.
      const [inserted] = await db.execute<{ id: string; timezone: string }>(sql`
        insert into schedules (org_id, name, cron, timezone, prompt)
        values (${zoned.session.orgId}, 'older backend', '0 9 * * *', null, 'x') returning id, timezone`);
      olderBackendRow = inserted?.id ?? null;
      expect(inserted?.timezone).toBe("Australia/Lord_Howe");
      await db.execute(sql`update schedules set timezone = null where id = ${zoned.id}`);
      expect((await getScheduleForOrg(zoned.session.orgId, zoned.id))?.timezone).toBe("Australia/Lord_Howe");
    } finally {
      await disable(legacy.id);
      await disable(zoned.id);
      if (olderBackendRow) await db.execute(sql`delete from schedules where id = ${olderBackendRow}`);
      await applyZoneMigrationAs(OWN_ZONE);
    }
  });

  test("it goes through beside a writer that holds a schedule's row lock with its UPDATE still to run", async () => {
    await asBeforeTheMigration();
    const legacy = await enabledSchedule("zone-locked-writer", "0 9 * * *", "UTC");
    await db.execute(sql`update schedules set timezone = null where id = ${legacy.id}`);
    const olderBackend = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} });
    const { promise: locked, resolve: rowLocked } = Promise.withResolvers<number>();
    const { promise: go, resolve: write } = Promise.withResolvers<void>();
    let migrated: Promise<void> | null = null;
    try {
      const writer = olderBackend.begin(async (tx) => {
        await tx`select id from schedules where id = ${legacy.id} for update`;
        const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        rowLocked(Number(backend!.pid));
        await go;
        await tx`update schedules set name = 'renamed by the older backend', timezone = null, updated_at = now()
          where id = ${legacy.id}`;
      });
      const pid = await locked;
      migrated = applyZoneMigrationAs("America/New_York");
      // The migration is parked behind the writer before the writer goes on.
      await waitFor(async () => {
        const [row] = await db.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`);
        return Number(row?.waiting) > 0;
      });
      write();
      await writer;
      await migrated;
      const row = await getScheduleForOrg(legacy.session.orgId, legacy.id);
      expect(row?.name).toBe("renamed by the older backend");
      expect(row?.timezone).toBe("America/New_York");
    } finally {
      write();
      await migrated?.catch(() => {});
      await olderBackend.end({ timeout: 5 });
      await disable(legacy.id);
      await applyZoneMigrationAs(OWN_ZONE);
    }
  });

  test("applied outside a backend it guesses no zone: it refuses rows that need one", async () => {
    const migration = await readFile(MIGRATION, "utf8");
    // A pool that names no backend zone, like a scratch database migrated by a
    // test or a tool. With every schedule zoned there is nothing to name.
    const scratch = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} });
    const apply = () =>
      scratch.begin(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
      });
    await apply();
    await asBeforeTheMigration();
    const legacy = await enabledSchedule("zone-unknown-clock", "0 9 * * *", "UTC");
    await db.execute(sql`update schedules set timezone = null where id = ${legacy.id}`);
    try {
      expect(await apply().then(() => "applied", (error: unknown) => String(error))).toContain("useagent.backend_time_zone");
      const [row] = await db.execute<{ timezone: string | null }>(sql`select timezone from schedules where id = ${legacy.id}`);
      expect(row?.timezone).toBeNull();
    } finally {
      await db.execute(sql`update schedules set timezone = 'UTC' where id = ${legacy.id}`);
      await disable(legacy.id);
      await scratch.end({ timeout: 5 });
      await applyZoneMigrationAs(OWN_ZONE);
    }
  });
});
