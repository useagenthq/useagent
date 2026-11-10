/**
 * The compact run listing behind `GET /api/runs?view=summary`: one row per
 * thread (or per run with `all`), newest activity first, paged by a cursor on
 * the list's own sort key. Feeds All threads, the sidebar, Cmd-K and the
 * dashboard without loading steps.
 */
import type { ApiRunSummary, RunConnector } from "@useagent/agent-client/wire";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import type { EngineId, RunStatus } from "../db/schema";
import { parseRepoRef } from "../github/repo-ref";
import { executionGraphEnabled } from "./execution-graph-switch";
import { sidebarNativeChildren } from "./native-children-projection";

/** Where the next page of run summaries starts: the sort key of the last row
 * on the previous page. Timestamps travel as microseconds since the epoch, the
 * precision Postgres stores, so a row whose time a JS Date would round is
 * neither repeated nor skipped. The thread view orders by all five keys; the
 * `all` view by the run's own `createdAtMicros` and `id`. */
export interface RunSummaryCursor {
  readonly latestUpdatedAtMicros: string;
  readonly latestCreatedAtMicros: string;
  readonly latestRunId: string;
  readonly createdAtMicros: string;
  readonly id: string;
}

export interface RunSummaryPage {
  readonly runs: ApiRunSummary[];
  readonly hasMore: boolean;
  /** Pass back as `after` for the next page; null on the last page. */
  readonly next: RunSummaryCursor | null;
}

/** A timestamp column as whole microseconds since the epoch (bigint). */
function epochMicros(column: SQL): SQL {
  return sql`((extract(epoch from ${column}) * 1000000)::bigint)`;
}

/** Compact projection for navigation/dashboard surfaces. Heavy steps,
 * uploads, resources, and provider session state stay off this wire.
 *
 * Pages through the list in its own order: `after` starts a page right after
 * the cursor a previous page returned, so following the cursors reaches every
 * row once. `includeActive` only widens the FIRST page (no `after`) with active
 * threads past `limit`; such a row comes again on the page where its place in
 * the order falls, and the caller keeps one copy. */
export async function listRunSummaries(
  orgId: string,
  opts: {
    all?: boolean;
    limit?: number;
    includeActive?: boolean;
    includeNativeChildren?: boolean;
    after?: RunSummaryCursor | null;
  } = {},
): Promise<RunSummaryPage> {
  const limit = opts.limit ?? 100;
  const rootFilter = opts.all ? sql`` : sql`and root.parent_run_id is null`;
  const after = opts.after ?? null;
  const afterFilter = !after
    ? sql``
    : opts.all
      ? sql`and (${epochMicros(sql`root.created_at`)}, root.id)
          < (${after.createdAtMicros}::bigint, ${after.id}::text)`
      : sql`and (
          ${epochMicros(sql`latest.updated_at`)}, ${epochMicros(sql`latest.created_at`)}, latest.id,
          ${epochMicros(sql`root.created_at`)}, root.id
        ) < (
          ${after.latestUpdatedAtMicros}::bigint, ${after.latestCreatedAtMicros}::bigint,
          ${after.latestRunId}::text, ${after.createdAtMicros}::bigint, ${after.id}::text
        )`;
  const activeFilter = !opts.includeActive || after
    ? sql`false`
    : opts.all
      ? sql`status in ('queued', 'running')`
      : sql`latest_status in ('queued', 'running')`;
  const listOrder = opts.all
    ? sql`root.created_at desc, root.id desc`
    : sql`latest.updated_at desc, latest.created_at desc, latest.id desc,
        root.created_at desc, root.id desc`;
  const outputOrder = opts.all
    ? sql`created_at desc, id desc`
    : sql`latest_updated_at desc, latest_created_at desc, latest_run_id desc,
        created_at desc, id desc`;
  const rows = await db.execute(sql`
    with latest_thread_runs as (
      select
        candidate.id,
        candidate.org_id,
        candidate.thread_id,
        candidate.status,
        exists (
          select 1 from commands cancel_command
          where cancel_command.run_id = candidate.id
            and cancel_command.org_id = candidate.org_id
            and cancel_command.kind = 'run.cancel'
        ) as cancelled,
        candidate.created_at,
        candidate.updated_at,
        row_number() over (
          partition by candidate.org_id, candidate.thread_id
          order by candidate.created_at desc, candidate.id desc
        ) as thread_rank
      from runs candidate
      where candidate.org_id = ${orgId}
        and candidate.origin is null
    ), summary_rows as (
      select
        root.id,
        root.prompt,
        root.model,
        root.engine,
        root.status,
        root.summary,
        root.duration_ms,
        root.project_id,
        root.repo,
        root.repos,
        root.connector,
        root.created_at,
        root.updated_at,
        latest.id as latest_run_id,
        latest.status as latest_status,
        latest.cancelled as latest_cancelled,
        latest.created_at as latest_created_at,
        latest.updated_at as latest_updated_at,
        row_number() over (
          order by ${listOrder}
        ) as list_rank
      from runs root
      inner join latest_thread_runs latest
        on latest.org_id = root.org_id
        and latest.thread_id = root.thread_id
        and latest.thread_rank = 1
      where root.org_id = ${orgId}
        and root.origin is null
        ${rootFilter}
        ${afterFilter}
    ), bounded_rows as (
      select *
      from summary_rows
      where list_rank <= ${limit}
    ), active_rows as (
      select *
      from summary_rows
      where ${activeFilter}
      order by list_rank
      limit ${limit}
    ), selected_rows as (
      select * from bounded_rows
      union
      select * from active_rows
    )
    select
      id, prompt, model, engine, status, summary, duration_ms, project_id,
      repo, repos, connector, created_at, updated_at,
      latest_run_id, latest_status, latest_cancelled, latest_created_at, latest_updated_at,
      list_rank,
      ${epochMicros(sql`created_at`)}::text as cursor_created_at,
      ${epochMicros(sql`latest_created_at`)}::text as cursor_latest_created_at,
      ${epochMicros(sql`latest_updated_at`)}::text as cursor_latest_updated_at,
      exists (select 1 from summary_rows where list_rank > ${limit}) as has_more
    from selected_rows
    order by ${outputOrder}
  `);

  // The page ends at the row ranked `limit`; active rows past it ride along on
  // the first page but never move the cursor.
  const hasMore = rows[0]?.has_more === true;
  const last = hasMore ? rows.find((row) => Number(row.list_rank) === limit) : undefined;
  const next: RunSummaryCursor | null = last
    ? {
        latestUpdatedAtMicros: last.cursor_latest_updated_at as string,
        latestCreatedAtMicros: last.cursor_latest_created_at as string,
        latestRunId: last.latest_run_id as string,
        createdAtMicros: last.cursor_created_at as string,
        id: last.id as string,
      }
    : null;

  const summaries = rows.map((row) => {
    const repoRefs = row.repos as string[];
    const specs = repoRefs.map(parseRepoRef);
    return {
      id: row.id as string,
      prompt: row.prompt as string,
      model: row.model as string,
      engine: row.engine as EngineId,
      status: row.status as RunStatus,
      summary: row.summary as string | null,
      duration_ms: row.duration_ms as number | null,
      project_id: row.project_id as string | null,
      repo: row.repo ? parseRepoRef(row.repo as string).repo : null,
      repos: specs.map((spec) => spec.repo),
      repo_specs: specs,
      connector: (row.connector as RunConnector | null) ?? null,
      created_at: new Date(row.created_at as string | Date).toISOString(),
      updated_at: new Date(row.updated_at as string | Date).toISOString(),
      latest_run_id: row.latest_run_id as string,
      latest_status: row.latest_status as RunStatus,
      latest_cancelled: row.latest_cancelled as boolean,
      latest_created_at: new Date(row.latest_created_at as string | Date).toISOString(),
      latest_updated_at: new Date(row.latest_updated_at as string | Date).toISOString(),
    } satisfies ApiRunSummary;
  });
  // Native-children projection only decorates the THREAD view (each row is a
  // root whose id IS its thread id); the `all` flat view keeps its shape.
  if (
    opts.all ||
    !opts.includeNativeChildren ||
    !executionGraphEnabled() ||
    summaries.length === 0
  ) return { runs: summaries, hasMore, next };
  const childrenByThread = await sidebarNativeChildren(
    orgId,
    summaries.map((summary) => summary.id),
  );
  if (childrenByThread.size === 0) return { runs: summaries, hasMore, next };
  return {
    runs: summaries.map((summary) => {
      const projection = childrenByThread.get(summary.id);
      if (!projection) return summary;
      return {
        ...summary,
        native_children: projection.children,
        native_children_total: projection.total,
      };
    }),
    hasMore,
    next,
  };
}
