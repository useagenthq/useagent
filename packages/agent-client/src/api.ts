// Typed useAgent thread API client - runtime-neutral (inject fetch / EventSource /
// timers / base URL / auth headers; no globals, React, Next, or product aliases). It
// mirrors the EXISTING routes (POST /api/runs, POST /api/runs/:id/cancel,
// GET /api/runs/:id?thread=1, SSE /api/runs/:id/thread-events) - it does NOT define a
// new wire protocol. HTTP + stream failures come back as a classified AgentClientError,
// never a raw throw or an unbounded provider payload.

import { createThreadConnection, type EventSourceLike, type ThreadConnection, type TimerHost } from "./connection";
import {
  decodeArtifactList,
  decodeArtifactResult,
  decodeWorkpieceResult,
  type ArtifactDescriptor,
  type ArtifactWorkpieceResult,
  type ArtifactWorkpieceState,
} from "./artifacts";
import { decodeFrame, THREAD_FRAME_TYPES, type DecodedFrame } from "./thread-events";
import { decodeApiRun, decodeApiRunSummary, type ApiRun, type ApiRunSummary } from "./wire";

/** Minimal injected fetch/response surface (works with the browser fetch, a Node/Bun
 *  fetch, or a test stub). Kept structural so the package needs no DOM lib. */
export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<ResponseLike>;

/** Stable classified failure (subset of the shared Section-13 union relevant to the
 *  client). Never carries credentials or unbounded response bodies. */
export type AgentClientErrorCode =
  | "http_error"
  | "network_error"
  | "decode_error"
  | "stream_error";

export class AgentClientError extends Error {
  constructor(
    readonly code: AgentClientErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

export interface AgentClientConfig {
  fetch: FetchLike;
  /** Prepended to every path (default ""). e.g. "https://app.example.com". */
  baseUrl?: string;
  /** Auth/other headers, resolved per request (so a rotating token is always current). */
  headers?: () => Record<string, string>;
}

export interface CreateRunInput {
  prompt: string;
  engine?: string;
  model?: string;
  repos?: readonly string[];
  memoryScope?: string;
  /** Reply target: the run whose thread this run continues (a root run has none). */
  parentRunId?: string;
  /** Makes a lost-response retry safe (backend dedupes on this key). */
  idempotencyKey?: string;
}

export interface RunHandle {
  readonly runId: string;
  readonly status: string;
}

/** One validated full run row from `GET /api/runs/:id?thread=1`. */
export type RunSummary = ApiRun;
export interface ThreadSnapshot {
  readonly runs: readonly RunSummary[];
}

/** Options for the compact run listing (`GET /api/runs?view=summary`). */
export interface ListRunsInput {
  /** Cap the number of rows returned (backend clamps its own maximum). */
  readonly limit?: number;
  /** Include every run in every thread, not just thread roots. */
  readonly all?: boolean;
}

export interface OperationResult {
  readonly ok: boolean;
  readonly status: string;
}

export interface ArtifactListInput {
  readonly runId?: string;
  readonly threadId?: string;
}

export interface ConnectThreadDeps {
  createEventSource: (url: string) => EventSourceLike;
  timers: TimerHost;
  /** One fallback-poll tick when the SSE is unhealthy (fetch the thread + reconcile).
   *  Injected so the package never decides product fetch/merge semantics. */
  poll: () => void;
  maxAttempts?: number;
  healthyMs?: number;
  pollMs?: number;
}

export interface AgentClient {
  createRun(input: CreateRunInput): Promise<RunHandle>;
  reply(parentRunId: string, input: Omit<CreateRunInput, "parentRunId">): Promise<RunHandle>;
  cancel(runId: string): Promise<OperationResult>;
  getThread(rootRunId: string): Promise<ThreadSnapshot>;
  /** Recent run summaries (newest first), scoped to the authenticated org. */
  listRuns(input?: ListRunsInput): Promise<readonly ApiRunSummary[]>;
  listArtifacts(input?: ArtifactListInput): Promise<readonly ArtifactDescriptor[]>;
  getArtifact(artifactId: string): Promise<ArtifactDescriptor>;
  getArtifactWorkpiece(artifactId: string): Promise<ArtifactWorkpieceResult>;
  updateArtifactWorkpiece(
    artifactId: string,
    expectedRevision: number,
    state: ArtifactWorkpieceState,
  ): Promise<ArtifactWorkpieceResult>;
  /** Open ONE SSE to the thread, decoding each frame to a typed {@link DecodedFrame}
   *  before handing it to the sink. Returns the connection controller (start/stop). */
  connectThread(rootRunId: string, sink: (frame: DecodedFrame) => void, deps: ConnectThreadDeps): ThreadConnection;
}

export function createAgentClient(config: AgentClientConfig): AgentClient {
  const base = (config.baseUrl ?? "").replace(/\/+$/, "");
  const url = (path: string): string => `${base}${path}`;

  async function send(path: string, init: { method?: string; body?: unknown; extraHeaders?: Record<string, string> }): Promise<unknown> {
    const headers: Record<string, string> = { ...(config.headers?.() ?? {}), ...(init.extraHeaders ?? {}) };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: ResponseLike;
    try {
      res = await config.fetch(url(path), {
        method: init.method ?? "GET",
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      throw new AgentClientError("network_error", `request to ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new AgentClientError("http_error", `${init.method ?? "GET"} ${path} -> HTTP ${res.status}`, res.status);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new AgentClientError("decode_error", `${path} returned an undecodable body: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function submitRun(input: CreateRunInput): Promise<RunHandle> {
    const body: Record<string, unknown> = { prompt: input.prompt };
    if (input.engine) body.engine = input.engine;
    if (input.model) body.model = input.model;
    if (input.repos) body.repos = input.repos;
    if (input.memoryScope) body.memory_scope = input.memoryScope;
    if (input.parentRunId) body.parent_run_id = input.parentRunId;
    const extraHeaders = input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined;
    const json = (await send("/api/runs", { method: "POST", body, extraHeaders })) as Record<string, unknown>;
    const runId = typeof json.id === "string" ? json.id : "";
    if (!runId) throw new AgentClientError("decode_error", "POST /api/runs returned no run id");
    return { runId, status: typeof json.status === "string" ? json.status : "queued" };
  }

  return {
    createRun: (input) => submitRun(input),
    reply: (parentRunId, input) => submitRun({ ...input, parentRunId }),

    async cancel(runId) {
      const json = (await send(`/api/runs/${runId}/cancel`, { method: "POST", body: {} })) as Record<string, unknown>;
      return { ok: true, status: typeof json.status === "string" ? json.status : "cancelling" };
    },

    async getThread(rootRunId) {
      const json = (await send(`/api/runs/${rootRunId}?thread=1`, {})) as Record<string, unknown>;
      const rawRuns = Array.isArray(json.thread) ? json.thread : Array.isArray(json.runs) ? json.runs : [];
      const runs = rawRuns.map(decodeApiRun).filter((run): run is ApiRun => run !== null);
      return { runs };
    },

    async listRuns(input = {}) {
      const query = ["view=summary"];
      if (input.all) query.push("all=1");
      if (input.limit !== undefined) query.push(`limit=${encodeURIComponent(String(input.limit))}`);
      const json = (await send(`/api/runs?${query.join("&")}`, {})) as Record<string, unknown>;
      const rawRuns = Array.isArray(json.runs) ? json.runs : [];
      return rawRuns
        .map(decodeApiRunSummary)
        .filter((run): run is ApiRunSummary => run !== null);
    },

    async listArtifacts(input = {}) {
      const query: string[] = [];
      if (input.runId) query.push(`run_id=${encodeURIComponent(input.runId)}`);
      if (input.threadId) query.push(`thread_id=${encodeURIComponent(input.threadId)}`);
      const json = await send(`/api/artifacts${query.length > 0 ? `?${query.join("&")}` : ""}`, {});
      const artifacts = decodeArtifactList(json);
      if (!artifacts) {
        throw new AgentClientError("decode_error", "GET /api/artifacts returned invalid artifact metadata");
      }
      return artifacts;
    },

    async getArtifact(artifactId) {
      const path = `/api/artifacts/${encodeURIComponent(artifactId)}`;
      const json = await send(path, {});
      const result = decodeArtifactResult(json);
      if (!result) throw new AgentClientError("decode_error", `${path} returned invalid artifact metadata`);
      return result.artifact;
    },

    async getArtifactWorkpiece(artifactId) {
      const path = `/api/artifacts/${encodeURIComponent(artifactId)}/workpiece`;
      const result = decodeWorkpieceResult(await send(path, {}));
      if (!result) throw new AgentClientError("decode_error", `${path} returned invalid workpiece state`);
      return result;
    },

    async updateArtifactWorkpiece(artifactId, expectedRevision, state) {
      const path = `/api/artifacts/${encodeURIComponent(artifactId)}/workpiece`;
      const result = decodeWorkpieceResult(
        await send(path, {
          method: "PATCH",
          body: { expected_revision: expectedRevision, state },
        }),
      );
      if (!result) throw new AgentClientError("decode_error", `${path} returned invalid workpiece state`);
      return result;
    },

    connectThread(rootRunId, sink, deps) {
      return createThreadConnection({
        url: url(`/api/runs/${rootRunId}/thread-events`),
        frameTypes: THREAD_FRAME_TYPES,
        healthFrame: "snapshot",
        createEventSource: deps.createEventSource,
        onFrame: (event, data) => sink(decodeFrame(event, data)),
        poll: deps.poll,
        timers: deps.timers,
        maxAttempts: deps.maxAttempts,
        healthyMs: deps.healthyMs,
        pollMs: deps.pollMs,
      });
    },
  };
}
