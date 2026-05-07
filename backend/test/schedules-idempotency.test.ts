import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, runs, scheduleFirings } from "../src/db/schema";
import { cronMatches } from "../src/schedules/cron";
import { fireSchedule, firingKey } from "../src/schedules/fire";
import { getScheduleForOrg } from "../src/schedules/repo";
import { createOrgSession, json } from "./helpers";

/** Create a disabled schedule and return its raw DB record (fireSchedule input). */
async function makeScheduleRecord(label: string) {
  const s = await createOrgSession(label);
  const created = await json<{ id: string }>("/api/schedules", {
    method: "POST",
    cookies: s.cookies,
    body: { name: label, cron: "0 2 * * *", prompt: `prompt ${label}`, engine: "mock" },
  });
  expect(created.status).toBe(201);
  const rec = await getScheduleForOrg(s.orgId, created.body.id);
  if (!rec) throw new Error("schedule record not found");
  return { session: s, rec };
}

describe("firingKey — deterministic per occurrence", () => {
  test("cron buckets to the minute; manual keys on the ms", () => {
    const occ = new Date("2026-01-15T14:30:45.000Z");
    const bucket = Math.floor(occ.getTime() / 60_000) * 60_000;
    expect(firingKey("s1", "cron", occ)).toBe(`schedule:s1:${bucket}`);
    // Any instant in the SAME minute yields the SAME cron key (the safety net
    // behind the scheduler's sameMinute guard).
    expect(firingKey("s1", "cron", new Date(occ.getTime() + 14_000))).toBe(
      `schedule:s1:${bucket}`,
    );
    // Manual firings are distinct per press.
    expect(firingKey("s1", "manual", occ)).toBe(`schedule:s1:manual:${occ.getTime()}`);
  });
});

describe("schedule firing idempotency", () => {
  test("double-fire of the SAME occurrence produces exactly ONE run + ONE firing", async () => {
    const { rec } = await makeScheduleRecord("idem-double");
    const occurrence = new Date("2026-03-01T02:00:00.000Z");
    const key = firingKey(rec.id, "cron", occurrence);

    const first = await fireSchedule(rec, "cron", occurrence);
    const second = await fireSchedule(rec, "cron", occurrence);

    // Same accepted run id — the second fire replayed the original.
    expect(second).toBe(first);

    // The command lane accepted exactly one run for this occurrence.
    const cmds = await db
      .select()
      .from(commands)
      .where(eq(commands.idempotencyKey, key));
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.runId).toBe(first);

    // Exactly one run row, and exactly one firing row.
    const runRows = await db.select().from(runs).where(eq(runs.id, first));
    expect(runRows.length).toBe(1);
    const firings = await db
      .select()
      .from(scheduleFirings)
      .where(eq(scheduleFirings.idempotencyKey, key));
    expect(firings.length).toBe(1);
    expect(firings[0]!.runId).toBe(first);
  });

  test("crash between fire and record: retry recovers the firing without a duplicate run", async () => {
    const { rec } = await makeScheduleRecord("idem-crash");
    const occurrence = new Date("2026-03-02T02:00:00.000Z");
    const key = firingKey(rec.id, "cron", occurrence);

    const runId = await fireSchedule(rec, "cron", occurrence);

    // Simulate a crash AFTER command acceptance but BEFORE the firing committed:
    // wipe the firing row, leaving the accepted command + run in place.
    await db.delete(scheduleFirings).where(eq(scheduleFirings.idempotencyKey, key));

    // The retry sees the keyed command, REPLAYS the original run (no new work),
    // and re-records the firing.
    const retry = await fireSchedule(rec, "cron", occurrence);
    expect(retry).toBe(runId);

    // Still exactly one accepted command / run for the occurrence.
    const cmds = await db
      .select()
      .from(commands)
      .where(eq(commands.idempotencyKey, key));
    expect(cmds.length).toBe(1);
    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    expect(runRows.length).toBe(1);

    // The firing is back — recovered, not duplicated.
    const firings = await db
      .select()
      .from(scheduleFirings)
      .where(eq(scheduleFirings.idempotencyKey, key));
    expect(firings.length).toBe(1);
    expect(firings[0]!.runId).toBe(runId);
  });
});

describe("timezone-aware cron evaluation", () => {
  test("the same instant matches in one zone and not another", () => {
    // 14:30Z is 09:30 in New York (EST, UTC-5) and 06:30 in Los Angeles (PST).
    const instant = new Date("2026-01-15T14:30:00.000Z");
    expect(cronMatches("30 9 * * *", instant, "America/New_York")).toBe(true);
    expect(cronMatches("30 9 * * *", instant, "America/Los_Angeles")).toBe(false);
    expect(cronMatches("30 6 * * *", instant, "America/Los_Angeles")).toBe(true);
  });

  test("an unknown timezone falls back to server local time, never throws", () => {
    const instant = new Date("2026-01-15T14:30:00.000Z");
    // Should not throw; result equals the no-timezone (server-local) evaluation.
    const bad = cronMatches("* * * * *", instant, "Not/AZone");
    const local = cronMatches("* * * * *", instant);
    expect(bad).toBe(local);
  });
});

describe("timezone on the schedules API", () => {
  test("create + patch round-trip a valid IANA zone; invalid is rejected", async () => {
    const s = await createOrgSession("tz-api");

    const created = await json<any>("/api/schedules", {
      method: "POST",
      cookies: s.cookies,
      body: {
        name: "TZ schedule",
        cron: "0 9 * * *",
        prompt: "morning digest",
        engine: "mock",
        timezone: "America/New_York",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.timezone).toBe("America/New_York");

    // Invalid zone → 400.
    const bad = await json("/api/schedules", {
      method: "POST",
      cookies: s.cookies,
      body: { name: "bad", cron: "0 9 * * *", prompt: "x", timezone: "Mars/Olympus" },
    });
    expect(bad.status).toBe(400);

    // No timezone → null (server local).
    const noneTz = await json<any>("/api/schedules", {
      method: "POST",
      cookies: s.cookies,
      body: { name: "no tz", cron: "0 9 * * *", prompt: "x" },
    });
    expect(noneTz.status).toBe(201);
    expect(noneTz.body.timezone).toBeNull();

    // PATCH can change and clear the zone.
    const patched = await json<any>(`/api/schedules/${created.body.id}`, {
      method: "PATCH",
      cookies: s.cookies,
      body: { timezone: "Europe/London" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.timezone).toBe("Europe/London");

    const cleared = await json<any>(`/api/schedules/${created.body.id}`, {
      method: "PATCH",
      cookies: s.cookies,
      body: { timezone: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.timezone).toBeNull();
  });
});
