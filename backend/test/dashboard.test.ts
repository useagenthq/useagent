import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { createOrgSession, json, type OrgSession } from "./helpers";

const RUNS = 1_005;
let session: OrgSession;

beforeAll(async () => {
  session = await createOrgSession("dashboard-summary");
  for (let offset = 0; offset < RUNS; offset += 100) {
    const settledAt = new Date();
    await db.insert(runs).values(
      Array.from({ length: Math.min(100, RUNS - offset) }, () => {
        const id = crypto.randomUUID();
        return {
          id,
          orgId: session.orgId,
          prompt: "dashboard aggregate fixture",
          model: "mock",
          engine: "mock" as const,
          status: "completed" as const,
          threadId: id,
          settledAt,
        };
      }),
    );
  }
  const internalId = crypto.randomUUID();
  await db.insert(runs).values({
    id: internalId,
    orgId: session.orgId,
    prompt: "internal dashboard fixture",
    model: "mock",
    engine: "mock",
    status: "completed",
    threadId: internalId,
    origin: "internal:canary",
    settledAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(runs).where(eq(runs.orgId, session.orgId));
});

test("dashboard summary returns uncapped, UTC-stable organization aggregates", async () => {
  const result = await json<{
    stats: { total: number; completed: number; completed_today: number };
    counts: { skills: number; knowledge: number };
    daily: Array<{ key: string; label: string; completed: number }>;
    weekly: Array<{ key: string; label: string; runs: number }>;
    timezone: string;
  }>("/api/dashboard/summary", { cookies: session.cookies });

  expect(result.status).toBe(200);
  expect(result.body.stats.total).toBe(RUNS);
  expect(result.body.stats.completed).toBe(RUNS);
  expect(result.body.stats.completed_today).toBe(RUNS);
  expect(result.body.counts).toEqual({ skills: 0, knowledge: 0 });
  expect(result.body.daily).toHaveLength(14);
  expect(result.body.daily.at(-1)?.completed).toBe(RUNS);
  expect(result.body.weekly).toHaveLength(8);
  expect(result.body.weekly.at(-1)?.runs).toBe(RUNS);
  expect(result.body.timezone).toBe("UTC");

  await db
    .update(runs)
    .set({ updatedAt: new Date("2099-01-01T00:00:00.000Z") })
    .where(eq(runs.orgId, session.orgId));
  const afterMetadataUpdate = await json<typeof result.body>("/api/dashboard/summary", {
    cookies: session.cookies,
  });
  expect(afterMetadataUpdate.body.stats.completed_today).toBe(RUNS);
  expect(afterMetadataUpdate.body.daily.at(-1)?.completed).toBe(RUNS);
});
