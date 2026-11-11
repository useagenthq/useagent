/**
 * The compact run listing behind `GET /api/runs?view=summary`: the thread list
 * (one row per thread root, ordered by the thread's latest turn) or, with
 * `all`, every run. Pages are keyset pages: the cursor carries the last row's
 * full sort key, so a thread that gets a new turn while someone is paging moves
 * to the front instead of shifting every later page.
 */
import type { ApiRunSummary, RunConnector } from "@useagent/agent-client/wire";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import type { EngineId, RunStatus } from "../db/schema";
import { parseRepoRef } from "../github/repo-ref";
import { executionGraphEnabled } from "./execution-graph-switch";
import { sidebarNativeChildren } from "./native-children-projection";

/** The sort key of the last row on a page. Timestamps keep Postgres' own text
 * form, microseconds included: a JavaScript Date would round them to
 * milliseconds and repeat or skip rows that share a millisecond. */
export type RunSummaryCursor =
  | {
      readonly view: "threads";
      readonly latestUpdatedAt: string;
      readonly latestCreatedAt: string;
      readonly latestRunId: string;
      readonly createdAt: string;
      readonly id: string;
    }
  | {
      readonly view: "runs";
      readonly createdAt: string;
      readonly id: string;
    };

export interface RunSummaryPage {
  readonly runs: ApiRunSummary[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

const MAX_CURSOR_LENGTH = 1_024;
const POSTGRES_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/;
const CURSOR_KEYS = {
  threads: ["v", "view", "latest_updated_at", "latest_created_at", "latest_run_id", "created_at", "id"],
  runs: ["v", "view", "created_at", "id"],
} as const;
const CURSOR_TIMESTAMP_KEYS = new Set(["latest_updated_at", "latest_created_at", "created_at"]);

export class InvalidRunSummaryCursorError extends Error {
  constructor() {
    super("cursor is invalid");
    this.name = "InvalidRunSummaryCursorError";
  }
}

export function encodeRunSummaryCursor(cursor: RunSummaryCursor): string {
  const wire =
    cursor.view === "threads"
      ? {
          v: 1,
          view: cursor.view,
          latest_updated_at: cursor.latestUpdatedAt,
          latest_created_at: cursor.latestCreatedAt,
          latest_run_id: cursor.latestRunId,
          created_at: cursor.createdAt,
          id: cursor.id,
        }
      : { v: 1, view: cursor.view, created_at: cursor.createdAt, id: cursor.id };
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

/** Decode a cursor from `encodeRunSummaryCursor`. Throws
 * `InvalidRunSummaryCursorError` for anything else, including a cursor from the
 * other view (`all=1` and the thread list sort by different keys). */
export function parseRunSummaryCursor(value: string, view: RunSummaryCursor["view"]): RunSummaryCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidRunSummaryCursorError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new InvalidRunSummaryCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new InvalidRunSummaryCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidRunSummaryCursorError();
  }
  const wire = parsed as Record<string, unknown>;
  const expected: readonly string[] = CURSOR_KEYS[view];
  const keys = Object.keys(wire);
  if (
    wire.v !== 1 ||
    wire.view !== view ||
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key))
  ) {
    throw new InvalidRunSummaryCursorError();
  }
  for (const key of expected) {
    if (key === "v" || key === "view") continue;
    const field = wire[key];
    if (typeof field !== "string" || field.length === 0) throw new InvalidRunSummaryCursorError();
    if (
      CURSOR_TIMESTAMP_KEYS.has(key) &&
      (!POSTGRES_TIMESTAMP_RE.test(field) || !Number.isFinite(Date.parse(field)))
    ) {
      throw new InvalidRunSummaryCursorError();
    }
  }
  const field = (key: string) => wire[key] as string;
  return view === "threads"
    ? {
        view,
        latestUpdatedAt: field("latest_updated_at"),
        latestCreatedAt: field("latest_created_at"),
        latestRunId: field("latest_run_id"),
        createdAt: field("created_at"),
        id: field("id"),
      }
    : { view, createdAt: field("created_at"), id: field("id") };
}

/** Compact projection for navigation/dashboard surfaces. Heavy steps,
 * uploads, resources, and provider session state stay off this wire.
 *
 * With `includeActive`, the first page also carries up to `limit` queued or
 * running rows that sort after it, and later pages leave exactly those rows
 * out, so paging with one `limit` returns every row once. */
export async function listRunSummaries(
  orgId: string,
  opts: {
    all?: boolean;
    limit?: number;
    includeActive?: boolean;
    includeNativeChildren?: boolean;
    cursor?: RunSummaryCursor | null;
  } = {},
): Promise<RunSummaryPage> {
  const limit = opts.limit ?? 100;
  const cursor = opts.cursor ?? null;
  const rootFilter = opts.all ? sql`` : sql`and root.parent_run_id is null`;
  const activeFilter = !opts.includeActive
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
  // Every key sorts descending, so "after the cursor" is a row-value less-than.
  const afterCursor = !cursor
    ? sql`true`
    : cursor.view === "threads"
      ? sql`(latest_updated_at, latest_created_at, latest_run_id, created_at, id)
          < (${cursor.latestUpdatedAt}::timestamptz, ${cursor.latestCreatedAt}::timestamptz,
            ${cursor.latestRunId}, ${cursor.createdAt}::timestamptz, ${cursor.id})`
      : sql`(created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`;
  // The first page already carried these active rows.
  const skipFirstPageActive = cursor && opts.includeActive
    ? sql`and id not in (select id from active_rows)`
    : sql``;
  const withActive = !cursor && opts.includeActive ? sql`true` : sql`false`;
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
    ), active_rows as (
      select id
      from summary_rows
      where ${activeFilter}
      order by list_rank
      limit ${limit}
    ), page_rows as (
      select id, row_number() over (order by list_rank) as page_rank
      from summary_rows
      where ${afterCursor}
        ${skipFirstPageActive}
      order by list_rank
      limit ${limit + 1}
    ), selected_rows as (
      select summary_rows.*, page_rows.page_rank
      from summary_rows
      left join page_rows on page_rows.id = summary_rows.id
      where page_rows.page_rank <= ${limit}
        or (${withActive} and summary_rows.id in (select id from active_rows))
    )
    select
      id, prompt, model, engine, status, summary, duration_ms, project_id,
      repo, repos, connector, created_at, updated_at,
      latest_run_id, latest_status, latest_cancelled, latest_created_at, latest_updated_at,
      page_rank,
      created_at::text as created_at_key,
      latest_created_at::text as latest_created_at_key,
      latest_updated_at::text as latest_updated_at_key,
      exists (select 1 from page_rows where page_rank > ${limit}) as has_more
    from selected_rows
    order by ${outputOrder}
  `);

  const last = rows.find((row) => Number(row.page_rank) === limit);
  const nextCursor = rows[0]?.has_more === true && last
    ? encodeRunSummaryCursor(
        opts.all
          ? { view: "runs", createdAt: last.created_at_key as string, id: last.id as string }
          : {
              view: "threads",
              latestUpdatedAt: last.latest_updated_at_key as string,
              latestCreatedAt: last.latest_created_at_key as string,
              latestRunId: last.latest_run_id as string,
              createdAt: last.created_at_key as string,
              id: last.id as string,
            },
      )
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
  ) return { runs: summaries, nextCursor };
  const childrenByThread = await sidebarNativeChildren(
    orgId,
    summaries.map((summary) => summary.id),
  );
  if (childrenByThread.size === 0) return { runs: summaries, nextCursor };
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
    nextCursor,
  };
}
