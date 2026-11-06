import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, runs, scheduleFirings } from "../src/db/schema";
import { subscribeOrg, type OrgChange } from "../src/runs/org-signals";
import { cronMatches, nextOccurrence } from "../src/schedules/cron";
import { fireSchedule, firingKey } from "../src/schedules/fire";
import { getScheduleForOrg } from "../src/schedules/repo";
import { fireScheduleForOrg } from "../src/schedules/service";
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
  test("publishes one invalidation for sequential and concurrent occurrence replays", async () => {
    const { session, rec } = await makeScheduleRecord("idem-publication");
    const changes: OrgChange[] = [];
    const unsubscribe = subscribeOrg(session.orgId, (change) => {
      if (change.type === "automation" && change.action === "fired") changes.push(change);
    });

    try {
      const occurrence = new Date("2026-03-01T02:00:05.000Z");
      const first = await fireScheduleForOrg(rec, "cron", occurrence);
      const replay = await fireScheduleForOrg(
        rec,
        "cron",
        new Date("2026-03-01T02:00:55.000Z"),
      );

      expect(replay).toBe(first);
      expect(changes).toHaveLength(1);

      const concurrentOccurrence = new Date("2026-03-01T02:01:00.000Z");
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () =>
          fireScheduleForOrg(rec, "cron", concurrentOccurrence),
        ),
      );
      const concurrentRunId = concurrent[0];
      if (!concurrentRunId) throw new Error("expected a concurrent schedule run");

      expect(new Set(concurrent)).toEqual(new Set([concurrentRunId]));
      expect(changes).toHaveLength(2);
      expect(changes.map((change) => change.runId)).toEqual([first, concurrentRunId]);
    } finally {
      unsubscribe();
    }
  });

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
    const { session, rec } = await makeScheduleRecord("idem-crash");
    const occurrence = new Date("2026-03-02T02:00:00.000Z");
    const key = firingKey(rec.id, "cron", occurrence);

    const runId = await fireScheduleForOrg(rec, "cron", occurrence);

    // Simulate a crash AFTER command acceptance but BEFORE the firing committed:
    // wipe the firing row, leaving the accepted command + run in place.
    await db.delete(scheduleFirings).where(eq(scheduleFirings.idempotencyKey, key));

    // The retry sees the keyed command, REPLAYS the original run (no new work),
    // and re-records the firing.
    const changes: OrgChange[] = [];
    const unsubscribe = subscribeOrg(session.orgId, (change) => {
      if (change.type === "automation" && change.action === "fired") changes.push(change);
    });
    try {
      const retry = await fireScheduleForOrg(rec, "cron", occurrence);
      expect(retry).toBe(runId);
      expect(changes).toEqual([
        {
          type: "automation",
          action: "fired",
          automationId: rec.id,
          runId,
        },
      ]);
    } finally {
      unsubscribe();
    }

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

  test("a zone the scheduler cannot read matches nothing and names no run, never the server's clock", () => {
    const instant = new Date("2026-01-15T14:30:00.000Z");
    expect(cronMatches("* * * * *", instant, "Not/AZone")).toBe(false);
    expect(nextOccurrence("* * * * *", "Not/AZone", instant)).toBeNull();
  });
});

describe("timezone on the schedules API", () => {
  test("create + patch round-trip a valid IANA zone; a schedule saved without one runs in UTC; a patch without one keeps it; invalid is rejected", async () => {
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

    // No timezone (an API client, an agent's tool call): UTC, stored and shown,
    // never the server's own clock.
    for (const timezone of [undefined, null, ""]) {
      const noneTz = await json<any>("/api/schedules", {
        method: "POST",
        cookies: s.cookies,
        body: { name: "no tz", cron: "0 9 * * *", prompt: "x", timezone },
      });
      expect(noneTz.status).toBe(201);
      expect(noneTz.body.timezone).toBe("UTC");
    }

    // PATCH changes the zone. None (null or "": a client still holding the
    // schedule from before every schedule named one) leaves it as it is.
    const patched = await json<any>(`/api/schedules/${created.body.id}`, {
      method: "PATCH",
      cookies: s.cookies,
      body: { timezone: "Europe/London" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.timezone).toBe("Europe/London");

    for (const timezone of [null, ""]) {
      const kept = await json<any>(`/api/schedules/${created.body.id}`, {
        method: "PATCH",
        cookies: s.cookies,
        body: { timezone, prompt: "evening digest" },
      });
      expect(kept.status).toBe(200);
      expect(kept.body.timezone).toBe("Europe/London");
      expect(kept.body.prompt).toBe("evening digest");
    }
    const invalid = await json<any>(`/api/schedules/${created.body.id}`, {
      method: "PATCH",
      cookies: s.cookies,
      body: { timezone: "Mars/Olympus" },
    });
    expect(invalid.status).toBe(400);
    expect((await getScheduleForOrg(s.orgId, created.body.id))?.timezone).toBe("Europe/London");
  });
});
