import {
  sandboxProvider,
  sandboxProviderApiKey,
  sandboxProviderKind,
} from "../sandboxes/provider";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";

// ---------------------------------------------------------------------------
// Fleet limits — the REAL numbers behind the /agent/workspace "Limits" card.
// Everything here is derived from live data (the runs + provider_events log and
// the Daytona control plane); nothing is fabricated. Two concerns:
//   1. Model burn — per-model token/cost/run aggregates for TODAY, read from the
//      opencode `part.step-finish` provider events that carry real usage.
//   2. Machine — the org's live Daytona sandbox footprint + the snapshot env.
// ---------------------------------------------------------------------------

// ── Model burn ──────────────────────────────────────────────────────────────

/** One model's real usage today (org-scoped). `tokens`/`cost` are 0 for models
 *  whose engine doesn't emit usage (only opencode's step-finish carries it) —
 *  honest zero, never invented. */
export interface ModelBurn {
  model: string;
  runs: number;
  completed: number;
  avgMs: number | null;
  tokens: number;
  cost: number;
}

export interface ModelBurnSummary {
  models: ModelBurn[];
  totalTokens: number;
  totalCost: number;
  totalRuns: number;
}

/**
 * Per-model aggregates for runs created TODAY in this org. Run counts / status /
 * duration come from the `runs` table; real token + cost come from the opencode
 * `part.step-finish` provider events (payload `tokens.total` + `cost`). A model
 * with runs but no usage capture shows real run stats and zero tokens (honest),
 * never a made-up figure. Sorted by real burn, then run volume.
 */
export async function getModelBurn(orgId: string): Promise<ModelBurnSummary> {
  const rows = (await db.execute(sql`
    with runs_today as (
      select id, model, status, duration_ms
      from runs
      where org_id = ${orgId} and created_at >= date_trunc('day', now())
    ),
    tok as (
      select run_id,
        sum((payload::jsonb -> 'tokens' ->> 'total')::bigint) as tokens,
        sum((payload::jsonb ->> 'cost')::numeric) as cost
      from provider_events
      where event_type = 'part.step-finish' and run_id in (select id from runs_today)
      group by run_id
    )
    select rt.model,
      count(*)::int as runs,
      count(*) filter (where rt.status = 'completed')::int as completed,
      round(avg(rt.duration_ms))::int as avg_ms,
      coalesce(sum(t.tokens), 0)::bigint as tokens,
      coalesce(sum(t.cost), 0)::numeric as cost
    from runs_today rt
    left join tok t on t.run_id = rt.id
    group by rt.model
    order by tokens desc, runs desc
  `)) as unknown as Array<{
    model: string;
    runs: number;
    completed: number;
    avg_ms: number | null;
    tokens: string;
    cost: string;
  }>;

  const models: ModelBurn[] = rows.map((r) => ({
    model: r.model,
    runs: Number(r.runs),
    completed: Number(r.completed),
    avgMs: r.avg_ms == null ? null : Number(r.avg_ms),
    tokens: Number(r.tokens),
    cost: Number(r.cost),
  }));

  return {
    models,
    totalTokens: models.reduce((s, m) => s + m.tokens, 0),
    totalCost: models.reduce((s, m) => s + m.cost, 0),
    totalRuns: models.reduce((s, m) => s + m.runs, 0),
  };
}

// ── Machine (sandbox-provider footprint) ────────────────────────────────────

/** Real machine snapshot for the Limits card. `sandboxes` is null when the provider
 *  is unconfigured or its inventory hasn't been fetched yet — the frontend shows
 *  the snapshot alone rather than an invented meter. */
export interface MachineStats {
  snapshot: string;
  sandboxes: { active: number; idle: number; liveThreads: number } | null;
}

interface SandboxRow {
  runId: string;
  state: string;
}

/**
 * Cached raw provider inventory (skynet-labeled boxes only; org-independent — the
 * org filter is applied per-request against the runs table). Provider listing is
 * slow and latency-variable (seconds to minutes), so it is NEVER awaited on the
 * request path: a stale entry is served immediately while a single background
 * refresh runs. The very first request (cold cache) reports `sandboxes: null`
 * until the first refresh lands — a graceful, honest "measuring" state.
 */
let inventoryCache: { at: number; boxes: SandboxRow[] } | null = null;
let refreshing: Promise<void> | null = null;
const INVENTORY_TTL_MS = 30_000;

async function refreshInventory(): Promise<void> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) return;
  const provider = sandboxProvider(apiKey);
  const boxes: SandboxRow[] = [];
  for await (const sb of provider.list()) {
    const labels = (sb as { labels?: Record<string, string> }).labels ?? {};
    const runId = labels["skynet-run"];
    if (!runId) continue; // only sandboxes this platform provisioned
    boxes.push({ runId, state: String((sb as { state?: string }).state ?? "unknown") });
  }
  inventoryCache = { at: Date.now(), boxes };
}

/** Kick a background refresh if the cache is missing or stale. Non-blocking:
 *  at most one refresh is in flight; failures are logged, never surfaced. */
function ensureInventory(): void {
  const stale = !inventoryCache || Date.now() - inventoryCache.at > INVENTORY_TTL_MS;
  if (stale && !refreshing) {
    refreshing = refreshInventory()
      .catch((err) =>
        console.warn("[fleet] sandbox inventory refresh failed:", err instanceof Error ? err.message : err),
      )
      .finally(() => {
        refreshing = null;
      });
  }
}

const STOPPED_STATES = new Set(["stopped", "archived", "paused"]);

/**
 * The org's live sandbox footprint: how many of its sandboxes are running
 * (`active`) vs idle-but-retained (`idle`), and how many distinct conversation
 * threads are backed by a running box. Org scope is enforced by joining each
 * sandbox's `skynet-run` label (a runId) to this org's runs — a box whose run
 * isn't ours is invisible here.
 */
export async function getMachineStats(orgId: string): Promise<MachineStats> {
  const snapshot = sandboxProviderKind() === "cube"
    ? process.env.CUBE_TEMPLATE_ID ?? "unconfigured"
    : process.env.DAYTONA_SNAPSHOT ?? "skynet-agent-v17";
  if (sandboxProviderApiKey() === undefined) return { snapshot, sandboxes: null };

  ensureInventory();
  const inv = inventoryCache;
  if (!inv) return { snapshot, sandboxes: null }; // cold cache — first refresh pending

  const runIds = [...new Set(inv.boxes.map((b) => b.runId))];
  if (runIds.length === 0) return { snapshot, sandboxes: { active: 0, idle: 0, liveThreads: 0 } };

  const rows = await db
    .select({ id: runs.id, threadId: runs.threadId })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), inArray(runs.id, runIds)));
  const threadByRun = new Map(rows.map((r) => [r.id, r.threadId]));

  let active = 0;
  let idle = 0;
  const liveThreads = new Set<string>();
  for (const b of inv.boxes) {
    const thread = threadByRun.get(b.runId);
    if (!thread) continue; // not this org's sandbox
    if (b.state === "started") {
      active += 1;
      liveThreads.add(thread);
    } else if (STOPPED_STATES.has(b.state)) {
      idle += 1;
    }
  }
  return { snapshot, sandboxes: { active, idle, liveThreads: liveThreads.size } };
}
