/**
 * Sidebar native-children projection: bounded, newest-first ENGINE-NATIVE child
 * executions per thread, read from the EXISTING execution graph
 * (`agent_executions` mode='native_child') - no separate identity table. These
 * are inspect-only projections of provider subagents: they have no runs of
 * their own and are never messageable. Display titles resolve from the
 * canonical `child.started` events (latest revision wins).
 */
import type {
  ApiNativeChildSummary,
  NativeChildSummaryStatus,
} from "@useagent/agent-client/wire";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { canonicalEvents } from "../db/schema";

/** Newest-first cap on the per-thread native-children sidebar projection. */
export const SIDEBAR_NATIVE_CHILDREN_LIMIT = 5;

export async function sidebarNativeChildren(
  orgId: string,
  threadIds: readonly string[],
): Promise<Map<string, { children: ApiNativeChildSummary[]; total: number }>> {
  if (threadIds.length === 0) return new Map();
  const idList = sql.join(
    threadIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute(sql`
    select id, run_id, thread_id, provider, native_session_id, status,
      started_at, created_at, child_total
    from (
      select e.id, e.run_id, r.thread_id, e.provider, e.native_session_id,
        e.status, e.started_at, e.created_at,
        row_number() over (
          partition by r.thread_id
          order by coalesce(e.started_at, e.created_at) desc, e.id desc
        ) as child_rank,
        count(*) over (partition by r.thread_id) as child_total
      from agent_executions e
      inner join runs r on r.id = e.run_id and r.org_id = e.org_id
      where e.org_id = ${orgId}
        and e.mode = 'native_child'
        and r.origin is null
        and r.thread_id in (${idList})
    ) ranked
    where child_rank <= ${SIDEBAR_NATIVE_CHILDREN_LIMIT}
    order by thread_id, child_rank
  `);
  if (rows.length === 0) return new Map();

  const titles = await nativeChildTitles(rows.map((row) => ({
    runId: row.run_id as string,
    nativeSessionId: row.native_session_id as string,
  })));
  const byThread = new Map<string, { children: ApiNativeChildSummary[]; total: number }>();
  for (const row of rows) {
    const threadId = row.thread_id as string;
    const entry = byThread.get(threadId) ?? { children: [], total: 0 };
    const runId = row.run_id as string;
    const nativeSessionId = row.native_session_id as string;
    entry.children.push({
      execution_id: row.id as string,
      run_id: runId,
      provider: row.provider as string,
      native_session_id: nativeSessionId,
      title: titles.get(`${runId}:${nativeSessionId}`) ?? null,
      status: row.status as NativeChildSummaryStatus,
      started_at: row.started_at
        ? new Date(row.started_at as string | Date).toISOString()
        : null,
    });
    entry.total = Number(row.child_total);
    byThread.set(threadId, entry);
  }
  return byThread;
}

/** Latest-revision spawn titles from canonical `child.started` events, keyed
 *  `${runId}:${childId}` (childId is the provider's native child session id). */
async function nativeChildTitles(
  children: readonly { runId: string; nativeSessionId: string }[],
): Promise<Map<string, string>> {
  if (children.length === 0) return new Map();
  const runIds = [...new Set(children.map((child) => child.runId))];
  const childIds = [...new Set(children.map((child) => child.nativeSessionId))];
  const rows = await db
    .select({
      runId: canonicalEvents.runId,
      childId: sql<string | null>`${canonicalEvents.body}->>'childId'`,
      title: sql<string | null>`${canonicalEvents.body}->>'title'`,
    })
    .from(canonicalEvents)
    .where(
      and(
        inArray(canonicalEvents.runId, [...runIds]),
        eq(canonicalEvents.kind, "child.started"),
        inArray(sql<string>`${canonicalEvents.body}->>'childId'`, childIds),
      ),
    )
    .orderBy(asc(canonicalEvents.revision));
  const titles = new Map<string, string>();
  for (const row of rows) {
    // Later revisions overwrite earlier ones (rows arrive revision-ascending).
    if (row.childId && row.title) titles.set(`${row.runId}:${row.childId}`, row.title);
  }
  return titles;
}
