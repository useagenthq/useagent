// Fleet dispatch: fan monotonous tasks out to a hosted org from a LOCAL machine and
// collect verified results. The legacy lane remains a thin layer over POST /api/runs;
// the opt-in durable lane accepts one server-owned batch through /api/fleet/batches.
// Every result still reads the normal thread endpoint and every QC check is itself a
// normal reply run recorded in the SAME ledger thread. Runtime-neutral
// (inject fetch, or default to the ambient global) so it runs in a CLI, a worker, or a
// browser without pulling in Node, provider, or product code.

import {
  AgentClientError,
  createAgentClient,
  type FetchLike,
  type ResponseLike,
  type RunHandle,
  type RunSummary,
} from "./api";
import type { ApiRunSummary, RunStatus } from "./wire";

/** QC outcome parsed from a verifier run's required `VERDICT: PASS|FAIL` line. */
export type Verdict = "pass" | "fail" | "unknown";

/** A settled run either reached a terminal status or timed out while we polled. */
export type SettledStatus = RunStatus | "timeout";

export interface FleetClientConfig {
  /** Origin of the hosted org. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Org API key. Sent verbatim as `Authorization: Bearer <apiKey>` on every request. */
  apiKey: string;
  /** Injected fetch (tests / non-standard runtimes). Defaults to the ambient global. */
  fetch?: FetchLike;
}

/** One unit of work to dispatch as a run. Mirrors the accepted POST /api/runs body. */
export interface FleetTask {
  prompt: string;
  engine?: string;
  model?: string;
  repos?: readonly string[];
  /** Makes a lost-response retry safe (backend dedupes on this key). */
  idempotencyKey?: string;
}

/** A run accepted by the backend, with its web session URL for a human to open. */
export interface DispatchedRun {
  readonly runId: string;
  readonly status: string;
  readonly url: string;
}

/** Per-task result of a fan-out: never throws, so one bad task cannot sink the batch. */
export type DispatchOutcome =
  | { readonly ok: true; readonly task: FleetTask; readonly run: DispatchedRun }
  | { readonly ok: false; readonly task: FleetTask; readonly error: string };

export interface DispatchManyOptions {
  /** Max in-flight dispatches (default 4). Clamped to >= 1. */
  concurrency?: number;
  /** When set, a task with no explicit key gets `${idempotencyPrefix}-${index}`. */
  idempotencyPrefix?: string;
}

export interface DispatchBatchOptions {
  /** Required batch-level key. Retrying the same request with this key is safe. */
  idempotencyKey: string;
}

export interface FleetBatchQueue {
  readonly state: string | null;
  readonly reason: string | null;
}

export interface FleetBatchRun {
  readonly ordinal: number;
  readonly runId: string;
  readonly status: string;
  readonly queue: FleetBatchQueue;
  readonly url: string;
}

export interface FleetBatch {
  readonly batchId: string;
  readonly status: string;
  readonly createdAt: string;
  /** True only when POST returned a previously accepted idempotent request. */
  readonly replayed: boolean;
  /** Child runs in caller-request order. */
  readonly runs: readonly FleetBatchRun[];
}

export interface AwaitSettledOptions {
  /** Give up after this long and return status "timeout" (default 15 min). */
  timeoutMs?: number;
  /** Delay between thread polls (default 3s). */
  pollMs?: number;
  /** Clock seam (defaults to Date.now) - injected so tests stay deterministic. */
  now?: () => number;
  /** Sleep seam (defaults to setTimeout) - injected so tests stay deterministic. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once per poll with the current run row (null until it first appears).
   *  Lets a caller stream status transitions (e.g. `useagent run --watch`). */
  onPoll?: (run: RunSummary | null) => void;
}

export interface SettledRun {
  readonly runId: string;
  readonly status: SettledStatus;
  /** The final run row, or null if the run never appeared before the timeout. */
  readonly run: RunSummary | null;
  /** The run's final answer text (its `summary`), or "" when none was recorded. */
  readonly answer: string;
  readonly url: string;
}

/** A one-shot snapshot of a run's CURRENT state (no waiting). `status` is "unknown"
 *  when no run with that id is visible in the thread. */
export interface RunSnapshot {
  readonly runId: string;
  readonly status: RunStatus | "unknown";
  readonly run: RunSummary | null;
  readonly answer: string;
  readonly url: string;
}

export interface VerifyResult {
  readonly verdict: Verdict;
  /** The verifier run's final text - the evidence the verdict was parsed from. */
  readonly evidence: string;
  /** The verifier run's id (a reply in the ORIGINAL thread; see verify() docs). */
  readonly runId: string;
  readonly status: SettledStatus;
  readonly url: string;
}

export interface FleetClient {
  readonly baseUrl: string;
  /** Submit one task as a run (POST /api/runs). Throws AgentClientError on failure. */
  dispatch(task: FleetTask): Promise<DispatchedRun>;
  /** Fan tasks out with bounded concurrency. Resolves per-task; never rejects wholesale. */
  dispatchMany(tasks: readonly FleetTask[], options?: DispatchManyOptions): Promise<DispatchOutcome[]>;
  /** Atomically accept 1-20 tasks as one durable server-owned batch. */
  dispatchBatch(tasks: readonly FleetTask[], options: DispatchBatchOptions): Promise<FleetBatch>;
  /** Read the durable batch and its ordered child queue state. */
  getBatch(batchId: string): Promise<FleetBatch>;
  /** One thread read: the run's current status + answer, without waiting. */
  getRun(runId: string): Promise<RunSnapshot>;
  /** Poll the thread endpoint until the run is completed/failed (or times out). */
  awaitSettled(runId: string, options?: AwaitSettledOptions): Promise<SettledRun>;
  /** Post a QC reply run asking `verifierPrompt`, settle it, and parse its verdict. */
  verify(runId: string, verifierPrompt: string, options?: AwaitSettledOptions): Promise<VerifyResult>;
  /** Recent run summaries (newest first) for the authenticated org. */
  listRecent(limit?: number): Promise<readonly ApiRunSummary[]>;
  /** The web session URL for a run id. */
  urlFor(runId: string): string;
}

/** The hosted org origin used when no baseUrl / USEAGENT_BASE_URL is given. The ONE
 *  place this domain is written - the CLI, the MCP server, and the README all resolve
 *  through here, so moving the product domain is a single-line change. */
export const DEFAULT_BASE_URL = "https://app.useagent.org";
export const DEFAULT_CONCURRENCY = 4;
export const MAX_FLEET_CONCURRENCY = 20;
export const MAX_FLEET_TASKS = 100;
export const MAX_DURABLE_BATCH_TASKS = 20;
export const DEFAULT_SETTLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_MS = 3 * 1000;

export function validateFleetConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_FLEET_CONCURRENCY) {
    throw new RangeError(`concurrency must be an integer between 1 and ${MAX_FLEET_CONCURRENCY}`);
  }
  return value;
}

/** The run's web session URL: `<baseUrl>/session/<runId>` (a root run threads under its
 *  own id, so runId == threadId). Pure; mirrors the backend `sessionUrl` shape. */
export function fleetRunUrl(baseUrl: string, runId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/session/${runId}`;
}

/**
 * Parse a QC verdict from a verifier run's final text. The verifier prompt REQUIRES a
 * line `VERDICT: PASS` or `VERDICT: FAIL`; we read the LAST such marker (so an agent
 * that restates the instruction earlier does not fool us) and fall back to "unknown"
 * when none is present. Tolerant of surrounding markdown/whitespace, case-insensitive.
 */
export function parseVerdict(text: string): Verdict {
  const re = /VERDICT:\s*(PASS|FAIL)\b/gi;
  let last: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1]!.toUpperCase();
  if (last === "PASS") return "pass";
  if (last === "FAIL") return "fail";
  return "unknown";
}

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init) as Promise<ResponseLike>;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` over `items` with at most `concurrency` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  const size = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function batchTaskBody(task: FleetTask): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: task.prompt };
  if (task.engine) body.engine = task.engine;
  if (task.model) body.model = task.model;
  if (task.repos) body.repos = task.repos;
  return body;
}

function decodeFleetBatch(
  value: unknown,
  urlFor: (runId: string) => string,
): FleetBatch | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.batch_id !== "string" ||
    typeof row.status !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.replayed !== "boolean" ||
    !Array.isArray(row.runs)
  ) return null;
  const runs: FleetBatchRun[] = [];
  for (const raw of row.runs) {
    if (!raw || typeof raw !== "object") return null;
    const run = raw as Record<string, unknown>;
    if (
      !Number.isInteger(run.ordinal) ||
      (run.ordinal as number) < 0 ||
      typeof run.run_id !== "string" ||
      typeof run.status !== "string"
    ) return null;
    const rawQueue = run.queue;
    if (rawQueue !== null && (!rawQueue || typeof rawQueue !== "object")) return null;
    const queue = rawQueue as Record<string, unknown> | null;
    if (
      (queue && typeof queue.state !== "string") ||
      (queue &&
        queue.reason !== null &&
        queue.reason !== undefined &&
        typeof queue.reason !== "string")
    ) return null;
    runs.push({
      ordinal: run.ordinal as number,
      runId: run.run_id,
      status: run.status,
      queue: {
        state: queue && typeof queue.state === "string" ? queue.state : null,
        reason: queue && typeof queue.reason === "string" ? queue.reason : null,
      },
      url: urlFor(run.run_id),
    });
  }
  runs.sort((a, b) => a.ordinal - b.ordinal);
  if (runs.some((run, ordinal) => run.ordinal !== ordinal)) return null;
  return {
    batchId: row.batch_id,
    status: row.status,
    createdAt: row.created_at,
    replayed: row.replayed,
    runs,
  };
}

/**
 * Build a fleet client bound to one hosted org + API key. The key is attached as a
 * plain `Authorization: Bearer <key>` header on every request (the contract the
 * sibling org-api-keys work serves server-side); nothing else about auth is assumed.
 */
export function createFleetClient(config: FleetClientConfig): FleetClient {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetcher = config.fetch ?? defaultFetch;
  const agent = createAgentClient({
    fetch: fetcher,
    baseUrl,
    headers: () => ({ Authorization: `Bearer ${config.apiKey}` }),
  });

  const urlFor = (runId: string): string => fleetRunUrl(baseUrl, runId);

  const toDispatched = (handle: RunHandle): DispatchedRun => ({
    runId: handle.runId,
    status: handle.status,
    url: urlFor(handle.runId),
  });

  async function dispatch(task: FleetTask): Promise<DispatchedRun> {
    const handle = await agent.createRun({
      prompt: task.prompt,
      engine: task.engine,
      model: task.model,
      repos: task.repos,
      idempotencyKey: task.idempotencyKey,
    });
    return toDispatched(handle);
  }

  async function dispatchMany(
    tasks: readonly FleetTask[],
    options: DispatchManyOptions = {},
  ): Promise<DispatchOutcome[]> {
    if (tasks.length > MAX_FLEET_TASKS) {
      throw new RangeError(`a fleet batch may contain at most ${MAX_FLEET_TASKS} tasks`);
    }
    const concurrency = validateFleetConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
    const prefix = options.idempotencyPrefix;
    return mapWithConcurrency(tasks, concurrency, async (task, index) => {
      const keyed: FleetTask =
        prefix !== undefined && task.idempotencyKey === undefined
          ? { ...task, idempotencyKey: `${prefix}-${index}` }
          : task;
      try {
        return { ok: true, task: keyed, run: await dispatch(keyed) } as const;
      } catch (e) {
        return { ok: false, task: keyed, error: errorMessage(e) } as const;
      }
    });
  }

  async function batchRequest(
    path: string,
    init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<FleetBatch> {
    const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotencyKey !== undefined) headers["Idempotency-Key"] = init.idempotencyKey;
    let response: ResponseLike;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      throw new AgentClientError(
        "network_error",
        `request to ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!response.ok) {
      throw new AgentClientError(
        "http_error",
        `${init.method ?? "GET"} ${path} -> HTTP ${response.status}`,
        response.status,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (e) {
      throw new AgentClientError(
        "decode_error",
        `${path} returned an undecodable body: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const decoded = decodeFleetBatch(json, urlFor);
    if (!decoded) throw new AgentClientError("decode_error", `${path} returned an invalid fleet batch`);
    return decoded;
  }

  async function dispatchBatch(
    tasks: readonly FleetTask[],
    options: DispatchBatchOptions,
  ): Promise<FleetBatch> {
    if (tasks.length < 1 || tasks.length > MAX_DURABLE_BATCH_TASKS) {
      throw new RangeError(`a durable fleet batch must contain between 1 and ${MAX_DURABLE_BATCH_TASKS} tasks`);
    }
    if (!options.idempotencyKey.trim()) {
      throw new RangeError("a durable fleet batch needs an idempotency key");
    }
    return batchRequest("/api/fleet/batches", {
      method: "POST",
      body: { tasks: tasks.map(batchTaskBody) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  const getBatch = (batchId: string): Promise<FleetBatch> =>
    batchRequest(`/api/fleet/batches/${encodeURIComponent(batchId)}`);

  async function getRun(runId: string): Promise<RunSnapshot> {
    const snapshot = await agent.getThread(runId);
    const run = snapshot.runs.find((r) => r.id === runId) ?? null;
    return {
      runId,
      status: run ? run.status : "unknown",
      run,
      answer: run?.summary ?? "",
      url: urlFor(runId),
    };
  }

  async function awaitSettled(
    runId: string,
    options: AwaitSettledOptions = {},
  ): Promise<SettledRun> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? defaultSleep;
    const deadline = now() + timeoutMs;
    let last: RunSummary | null = null;
    for (;;) {
      const snap = await getRun(runId);
      if (snap.run) last = snap.run;
      options.onPoll?.(snap.run);
      if (snap.status === "completed" || snap.status === "failed") {
        return { runId, status: snap.status, run: snap.run, answer: snap.answer, url: snap.url };
      }
      if (now() >= deadline) {
        return { runId, status: "timeout", run: last, answer: last?.summary ?? "", url: urlFor(runId) };
      }
      await sleep(pollMs);
    }
  }

  async function verify(
    runId: string,
    verifierPrompt: string,
    options: AwaitSettledOptions = {},
  ): Promise<VerifyResult> {
    // QC is honest: it is a REAL reply run in the same thread (parent_run_id = runId),
    // so the check itself is recorded in the event ledger next to the work it judges.
    const reply = await agent.reply(runId, { prompt: verifierPrompt });
    const settled = await awaitSettled(reply.runId, options);
    return {
      verdict: parseVerdict(settled.answer),
      evidence: settled.answer,
      runId: reply.runId,
      status: settled.status,
      url: settled.url,
    };
  }

  const listRecent = (limit = 20): Promise<readonly ApiRunSummary[]> =>
    agent.listRuns({ limit });

  return {
    baseUrl,
    dispatch,
    dispatchMany,
    dispatchBatch,
    getBatch,
    getRun,
    awaitSettled,
    verify,
    listRecent,
    urlFor,
  };
}
