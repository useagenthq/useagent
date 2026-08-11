import { daytonaApiConfig } from "./provider";

// ---------------------------------------------------------------------------
// Daytona warm pools (perf plan Phase 3, OpenCode only).
//
// A warm pool keeps N fully initialized sandboxes ready so a new-thread create
// CLAIMS a running machine instead of constructing one - the gate is "sandbox
// usable p95 <1.5s", of which the pool is one implementation. Claiming is
// invisible to the caller: an eligible `daytona.create` (snapshot + default OS
// user + NO custom env/volumes/secrets) is served from the pool automatically,
// so the adapter needs no pool-aware code. This module only PROVISIONS and
// reports the pool.
//
// Config-gated by DAYTONA_WARM_POOL_SIZE: unset (or non-positive/invalid) means
// disabled, and no warm-pool API call is ever made. Lives in the sandboxes/
// seam and reaches Daytona through the port's `daytonaApiConfig`, so all Daytona
// endpoint/auth resolution stays in one place. Warm pools are absent from the
// SandboxProvider surface (they are a substrate-specific optimization, not part
// of create/get/list); a different substrate would replace this whole module.
// ---------------------------------------------------------------------------

const WARM_POOL_SIZE_ENV = "DAYTONA_WARM_POOL_SIZE";

/** Configured warm-pool size, or null when the feature is disabled. Unset,
 *  empty, or a non-positive / non-integer value all mean "disabled" so no pool
 *  call is ever made. */
export function warmPoolSize(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  const raw = env[WARM_POOL_SIZE_ENV]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Desired-vs-ready diagnostics for one pool (ready-count only - no cost or
 *  generation fields, amendment 12 trim). */
export interface WarmPoolReport {
  snapshot: string;
  target: string;
  desired: number;
  ready: number;
  errorReason: string | null;
}

/** The subset of Daytona's WarmPool wire model this module reads. */
interface WarmPoolRow {
  id: string;
  snapshot: string;
  target: string;
  pool: number;
  currentSize: number;
  errorReason?: string | null;
}

export interface WarmPoolResponse {
  status: number;
  data: unknown;
}

/** The HTTP transport for the Daytona warm-pool REST endpoints. Swappable for
 *  tests so the reconcile logic runs with no network. */
export type WarmPoolTransport = (req: {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}) => Promise<WarmPoolResponse>;

let transportOverride: WarmPoolTransport | null = null;

/** TEST ONLY: swap the HTTP transport so no live Daytona endpoint is needed. */
export function setWarmPoolTransportForTest(fn: WarmPoolTransport | null): void {
  transportOverride = fn;
}

function requireApiKey(): string {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("warm pools need DAYTONA_API_KEY in the backend env");
  return apiKey;
}

/** The real transport: Bearer-authenticated fetch against the same Daytona API
 *  base URL the SDK client uses (resolved through the port). */
const daytonaTransport: WarmPoolTransport = async ({ method, path, body }) => {
  const { apiKey, apiUrl } = daytonaApiConfig(requireApiKey());
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? safeJsonParse(text) : null };
};

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function transport(): WarmPoolTransport {
  return transportOverride ?? daytonaTransport;
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

async function listWarmPools(): Promise<WarmPoolRow[]> {
  const { status, data } = await transport()({ method: "GET", path: "/warm-pools" });
  if (!ok(status)) throw new Error(`warm-pool list failed: HTTP ${status}`);
  return Array.isArray(data) ? (data as WarmPoolRow[]) : [];
}

function toReport(row: WarmPoolRow): WarmPoolReport {
  return {
    snapshot: row.snapshot,
    target: row.target,
    desired: row.pool ?? 0,
    ready: row.currentSize ?? 0,
    errorReason: row.errorReason ?? null,
  };
}

/**
 * Ensure a warm pool of `size` ready sandboxes exists for `snapshot` in the
 * configured region. Idempotent and convergent: reuses an existing pool for the
 * same (snapshot, target) - resizing it in place only when the desired size
 * changed - and creates one otherwise. Safe to call on every boot.
 */
export async function ensureWarmPool(snapshot: string, size: number): Promise<WarmPoolReport> {
  const { target } = daytonaApiConfig(requireApiKey());
  const existing = (await listWarmPools()).find(
    (p) => p.snapshot === snapshot && p.target === target,
  );
  if (existing) {
    if (existing.pool === size) return toReport(existing);
    const { status, data } = await transport()({
      method: "PATCH",
      path: `/warm-pools/${encodeURIComponent(existing.id)}`,
      body: { pool: size },
    });
    if (!ok(status)) throw new Error(`warm-pool resize failed: HTTP ${status}`);
    return toReport((data as WarmPoolRow | null) ?? { ...existing, pool: size });
  }
  const { status, data } = await transport()({
    method: "POST",
    path: "/warm-pools",
    body: { snapshot, pool: size, target },
  });
  if (!ok(status)) throw new Error(`warm-pool create failed: HTTP ${status}`);
  return toReport(data as WarmPoolRow);
}

/**
 * Diagnostics for the org's warm pools: desired vs ready count per pool. Read
 * only; callers gate on `warmPoolSize()` when the feature must stay dormant.
 */
export async function warmPoolStatus(): Promise<WarmPoolReport[]> {
  return (await listWarmPools()).map(toReport);
}
