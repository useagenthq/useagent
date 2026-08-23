import { count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/client";
import { runs, skills } from "../db/schema";
import type { AppEnv } from "../http";
import { countRecords } from "../knowledge/store";
import { orgScope } from "../middleware/org";

interface DailyRow {
  key: string;
  label: string;
  total: number;
  completed: number;
  failed: number;
}

interface WeeklyRow {
  key: string;
  label: string;
  runs: number;
}

export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use("*", orgScope);

dashboardRoutes.get("/summary", async (c) => {
  const orgId = c.get("orgId");
  const [totalsRows, skillRows, knowledgeCount, dailyRows, weeklyRows] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        running: sql<number>`count(*) filter (where ${runs.status} = 'running')::int`,
        queued: sql<number>`count(*) filter (where ${runs.status} = 'queued')::int`,
        completed: sql<number>`count(*) filter (where ${runs.status} = 'completed')::int`,
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
        completedToday: sql<number>`count(*) filter (
          where ${runs.status} = 'completed'
          and ${runs.updatedAt} >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
        )::int`,
      })
      .from(runs)
      .where(eq(runs.orgId, orgId)),
    db.select({ count: count() }).from(skills).where(eq(skills.orgId, orgId)),
    countRecords(orgId),
    db.execute(sql`
      with days as (
        select generate_series(
          (now() at time zone 'UTC')::date - 13,
          (now() at time zone 'UTC')::date,
          interval '1 day'
        )::date as day
      ), settled as (
        select
          (${runs.updatedAt} at time zone 'UTC')::date as day,
          count(*) filter (where ${runs.status} = 'completed')::int as completed,
          count(*) filter (where ${runs.status} = 'failed')::int as failed
        from ${runs}
        where ${runs.orgId} = ${orgId}
          and ${runs.status} in ('completed', 'failed')
          and ${runs.updatedAt} >= (
            ((now() at time zone 'UTC')::date - 13)::timestamp at time zone 'UTC'
          )
        group by 1
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as key,
        to_char(days.day, 'Mon FMDD') as label,
        (coalesce(settled.completed, 0) + coalesce(settled.failed, 0))::int as total,
        coalesce(settled.completed, 0)::int as completed,
        coalesce(settled.failed, 0)::int as failed
      from days left join settled using (day)
      order by days.day
    `) as unknown as Promise<DailyRow[]>,
    db.execute(sql`
      with weeks as (
        select generate_series(
          date_trunc('week', now() at time zone 'UTC')::date - 49,
          date_trunc('week', now() at time zone 'UTC')::date,
          interval '1 week'
        )::date as week_start
      ), created as (
        select
          date_trunc('week', ${runs.createdAt} at time zone 'UTC')::date as week_start,
          count(*)::int as runs
        from ${runs}
        where ${runs.orgId} = ${orgId}
          and ${runs.createdAt} >= (
            (date_trunc('week', now() at time zone 'UTC') - interval '49 days') at time zone 'UTC'
          )
        group by 1
      )
      select
        to_char(weeks.week_start, 'YYYY-MM-DD') as key,
        to_char(weeks.week_start, 'Mon FMDD') as label,
        coalesce(created.runs, 0)::int as runs
      from weeks left join created using (week_start)
      order by weeks.week_start
    `) as unknown as Promise<WeeklyRow[]>,
  ]);

  const totals = totalsRows[0];
  return c.json({
    stats: {
      total: totals?.total ?? 0,
      running: totals?.running ?? 0,
      queued: totals?.queued ?? 0,
      completed: totals?.completed ?? 0,
      failed: totals?.failed ?? 0,
      completed_today: totals?.completedToday ?? 0,
    },
    counts: {
      skills: skillRows[0]?.count ?? 0,
      knowledge: knowledgeCount,
    },
    daily: dailyRows,
    weekly: weeklyRows,
    timezone: "UTC",
  });
});
