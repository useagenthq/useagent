import { type StoredCanonicalEvent, validateCanonicalEvent } from "./canonical-timeline";

export type ExecutionGraphClientMode = "off" | "shadow" | "read";

export const EXECUTION_GRAPH_CLIENT_MODE: ExecutionGraphClientMode =
  process.env.NEXT_PUBLIC_EXECUTION_GRAPH_ROLLOUT === "read"
    ? "read"
    : process.env.NEXT_PUBLIC_EXECUTION_GRAPH_ROLLOUT === "shadow"
      ? "shadow"
      : "off";

export interface ExecutionGraphRow {
  readonly id: string;
  readonly mode: string;
  readonly provider: string;
  readonly native_session_id: string | null;
  readonly native_parent_session_id?: string | null;
  readonly status?: string;
  readonly started_at?: string | null;
  readonly settled_at?: string | null;
  readonly created_at?: string;
}

export interface ExecutionGraphEdge {
  readonly id: string;
  readonly parent_execution_id: string | null;
  readonly child_execution_id: string | null;
  readonly native_target_session_id: string | null;
  readonly observed_delivery_seq: number;
}

export interface ExecutionGraphResponse {
  readonly graphCursor?: number;
  readonly executions: readonly ExecutionGraphRow[];
  readonly delegationEdges?: readonly ExecutionGraphEdge[];
  readonly hasMore?: boolean;
  readonly nextCursor?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXECUTION_GRAPH_CACHE_LIMIT = 32;

interface ExecutionGraphCacheEntry {
  readonly executionsById: Map<string, ExecutionGraphRow>;
  readonly executionsByNativeSession: Map<string, ExecutionGraphRow>;
  readonly delegationEdgesById: Map<string, ExecutionGraphEdge>;
  graphCursor: number;
  initialized: boolean;
  nextCursor: string | null;
  initialInFlight: Promise<void> | null;
  refreshInFlight: Promise<void> | null;
  authoritativeInFlight: Promise<void> | null;
}

const executionGraphCache = new Map<string, ExecutionGraphCacheEntry>();
let executionGraphCacheEpoch = 0;

function newGraphCacheEntry(): ExecutionGraphCacheEntry {
  return {
    executionsById: new Map(),
    executionsByNativeSession: new Map(),
    delegationEdgesById: new Map(),
    graphCursor: 0,
    initialized: false,
    nextCursor: null,
    initialInFlight: null,
    refreshInFlight: null,
    authoritativeInFlight: null,
  };
}

function graphCacheEntry(runId: string): ExecutionGraphCacheEntry {
  const existing = executionGraphCache.get(runId);
  if (existing) {
    executionGraphCache.delete(runId);
    executionGraphCache.set(runId, existing);
    return existing;
  }
  const entry = newGraphCacheEntry();
  executionGraphCache.set(runId, entry);
  while (executionGraphCache.size > EXECUTION_GRAPH_CACHE_LIMIT) {
    const oldest = executionGraphCache.keys().next().value;
    if (typeof oldest !== "string") break;
    executionGraphCache.delete(oldest);
  }
  return entry;
}

/** Test-only lifecycle hook; production entries are bounded by the LRU cap. */
export function resetExecutionGraphCache(): void {
  executionGraphCacheEpoch += 1;
  executionGraphCache.clear();
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function resolveExecutionId(
  graph: ExecutionGraphResponse,
  nativeSessionId: string,
): string | null {
  return (
    graph.executions.find(
      (execution) =>
        execution.mode === "native_child" && execution.native_session_id === nativeSessionId,
    )?.id ?? null
  );
}

export function executionHistoryKey(runId: string, cardId: string): string {
  return `${runId}:${cardId}`;
}

export function mergeExecutionTranscript(
  history: readonly unknown[],
  live: readonly unknown[],
): StoredCanonicalEvent[] {
  const latest = new Map<string, StoredCanonicalEvent>();
  for (const raw of [...history, ...live]) {
    const threadId = isRecord(raw) ? raw.threadId : null;
    const event = validateCanonicalEvent(raw, threadId);
    if (!event) continue;
    const previous = latest.get(event.eventId);
    if (
      !previous ||
      event.revision > previous.revision ||
      (event.revision === previous.revision && event.deliverySeq > previous.deliverySeq)
    ) {
      latest.set(event.eventId, event);
    }
  }
  return [...latest.values()].toSorted((a, b) => a.deliverySeq - b.deliverySeq);
}

function decodeGraph(value: unknown): ExecutionGraphResponse | null {
  if (!isRecord(value) || !Array.isArray(value.executions)) return null;
  const executions = value.executions.flatMap((raw): ExecutionGraphRow[] => {
    if (!isRecord(raw)) return [];
    if (
      typeof raw.id !== "string" ||
      typeof raw.mode !== "string" ||
      typeof raw.provider !== "string" ||
      (raw.native_session_id !== null && typeof raw.native_session_id !== "string") ||
      (raw.native_parent_session_id !== undefined && raw.native_parent_session_id !== null &&
        typeof raw.native_parent_session_id !== "string") ||
      (raw.status !== undefined && typeof raw.status !== "string") ||
      (raw.started_at !== undefined && raw.started_at !== null && typeof raw.started_at !== "string") ||
      (raw.settled_at !== undefined && raw.settled_at !== null && typeof raw.settled_at !== "string") ||
      (raw.created_at !== undefined && typeof raw.created_at !== "string")
    )
      return [];
    return [
      {
        id: raw.id,
        mode: raw.mode,
        provider: raw.provider,
        native_session_id: raw.native_session_id,
        native_parent_session_id: raw.native_parent_session_id,
        status: raw.status,
        started_at: raw.started_at,
        settled_at: raw.settled_at,
        created_at: raw.created_at,
      },
    ];
  });
  if (value.delegation_edges !== undefined && !Array.isArray(value.delegation_edges)) return null;
  const delegationEdges = (value.delegation_edges ?? []).flatMap((raw): ExecutionGraphEdge[] => {
    if (!isRecord(raw)) return [];
    if (
      typeof raw.id !== "string" ||
      (raw.parent_execution_id !== null && typeof raw.parent_execution_id !== "string") ||
      (raw.child_execution_id !== null && typeof raw.child_execution_id !== "string") ||
      (raw.native_target_session_id !== null &&
        typeof raw.native_target_session_id !== "string") ||
      typeof raw.observed_delivery_seq !== "number" ||
      !Number.isSafeInteger(raw.observed_delivery_seq) ||
      raw.observed_delivery_seq < 0
    ) return [];
    return [{
      id: raw.id,
      parent_execution_id: raw.parent_execution_id,
      child_execution_id: raw.child_execution_id,
      native_target_session_id: raw.native_target_session_id,
      observed_delivery_seq: raw.observed_delivery_seq,
    }];
  });
  const hasMore = value.has_more;
  const nextCursor = value.next_cursor;
  const graphCursor = value.graph_cursor;
  if (
    graphCursor !== undefined &&
    (typeof graphCursor !== "number" || !Number.isSafeInteger(graphCursor) || graphCursor < 0)
  ) return null;
  if (hasMore !== undefined && typeof hasMore !== "boolean") return null;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    return null;
  }
  return {
    graphCursor: graphCursor ?? 0,
    executions,
    delegationEdges,
    hasMore: hasMore ?? false,
    nextCursor: nextCursor ?? null,
  };
}

function mergeGraphPage(entry: ExecutionGraphCacheEntry, graph: ExecutionGraphResponse): void {
  for (const execution of graph.executions) {
    entry.executionsById.set(execution.id, execution);
    if (execution.native_session_id) {
      entry.executionsByNativeSession.set(execution.native_session_id, execution);
    }
  }
  for (const edge of graph.delegationEdges ?? []) entry.delegationEdgesById.set(edge.id, edge);
  entry.graphCursor = Math.max(entry.graphCursor, graph.graphCursor ?? 0);
  entry.nextCursor = graph.nextCursor ?? null;
}

function graphSnapshot(entry: ExecutionGraphCacheEntry): ExecutionGraphResponse {
  return {
    graphCursor: entry.graphCursor,
    executions: [...entry.executionsById.values()].toSorted((a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id)),
    delegationEdges: [...entry.delegationEdgesById.values()].toSorted((a, b) =>
      a.observed_delivery_seq - b.observed_delivery_seq || a.id.localeCompare(b.id)),
    hasMore: false,
    nextCursor: entry.nextCursor,
  };
}

/** Load the durable graph used by the child-workspace tree. Pages and replayed
 * rows merge by stable ids, so repeated reads produce the same projection. */
export async function fetchExecutionGraph(
  runId: string,
  signal: AbortSignal,
): Promise<ExecutionGraphResponse | null> {
  if (signal.aborted) throw abortError();
  const entry = graphCacheEntry(runId);
  try {
    if (entry.initialized) await refreshAuthoritativeGraph(runId, entry, signal);
    else await ensureInitialGraph(runId, entry, signal);
    return graphSnapshot(entry);
  } catch (error) {
    if (error instanceof Error && error.message === "execution graph not found") return null;
    throw error;
  }
}

async function fetchGraphPages(
  runId: string,
  entry: ExecutionGraphCacheEntry,
  startCursor: string | null,
  epoch: number,
): Promise<void> {
  let cursor = startCursor;
  for (;;) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== null) query.set("cursor", cursor);
    const response = await fetch(
      `/api/runs/${encodeURIComponent(runId)}/executions?${query.toString()}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.status === 404) throw new Error("execution graph not found");
    if (!response.ok) throw new Error("execution graph unavailable");
    const graph = decodeGraph(await response.json());
    if (!graph) throw new Error("invalid execution graph response");
    if (epoch !== executionGraphCacheEpoch) return;
    mergeGraphPage(entry, graph);
    if (!graph.hasMore) return;
    if (!graph.nextCursor || graph.nextCursor === cursor) {
      throw new Error("execution graph cursor did not advance");
    }
    cursor = graph.nextCursor;
  }
}

async function fetchAuthoritativeGraph(
  runId: string,
  epoch: number,
): Promise<ExecutionGraphCacheEntry> {
  const snapshot = newGraphCacheEntry();
  await fetchGraphPages(runId, snapshot, null, epoch);
  snapshot.initialized = true;
  return snapshot;
}

async function ensureInitialGraph(
  runId: string,
  entry: ExecutionGraphCacheEntry,
  signal: AbortSignal,
): Promise<void> {
  if (entry.initialized) return;
  if (!entry.initialInFlight) {
    const epoch = executionGraphCacheEpoch;
    entry.initialInFlight = fetchGraphPages(runId, entry, null, epoch)
      .then(() => {
        if (epoch === executionGraphCacheEpoch) entry.initialized = true;
      })
      .catch((error: unknown) => {
        if (epoch === executionGraphCacheEpoch) executionGraphCache.delete(runId);
        throw error;
      })
      .finally(() => {
        entry.initialInFlight = null;
      });
  }
  await waitWithSignal(entry.initialInFlight, signal);
}

async function refreshGraph(
  runId: string,
  entry: ExecutionGraphCacheEntry,
  signal: AbortSignal,
): Promise<void> {
  if (!entry.refreshInFlight) {
    const epoch = executionGraphCacheEpoch;
    entry.refreshInFlight = fetchGraphPages(runId, entry, entry.nextCursor, epoch).finally(() => {
      entry.refreshInFlight = null;
    });
  }
  await waitWithSignal(entry.refreshInFlight, signal);
}

/** Refresh an existing graph from an authoritative first page. The API cursor is
 * creation-ordered, so an incremental cursor can discover new executions but
 * cannot observe a status/revision update on an existing execution. */
async function refreshAuthoritativeGraph(
  runId: string,
  entry: ExecutionGraphCacheEntry,
  signal: AbortSignal,
): Promise<void> {
  if (!entry.authoritativeInFlight) {
    const epoch = executionGraphCacheEpoch;
    entry.authoritativeInFlight = fetchAuthoritativeGraph(runId, epoch)
      .then((snapshot) => {
        if (epoch !== executionGraphCacheEpoch || snapshot.graphCursor < entry.graphCursor) return;
        entry.executionsById.clear();
        entry.executionsByNativeSession.clear();
        entry.delegationEdgesById.clear();
        for (const execution of snapshot.executionsById.values()) {
          entry.executionsById.set(execution.id, execution);
          if (execution.native_session_id) {
            entry.executionsByNativeSession.set(execution.native_session_id, execution);
          }
        }
        for (const edge of snapshot.delegationEdgesById.values()) {
          entry.delegationEdgesById.set(edge.id, edge);
        }
        entry.graphCursor = snapshot.graphCursor;
        entry.nextCursor = snapshot.nextCursor;
      })
      .finally(() => {
        entry.authoritativeInFlight = null;
      });
  }
  await waitWithSignal(entry.authoritativeInFlight, signal);
}

function cachedExecutionId(
  entry: ExecutionGraphCacheEntry,
  nativeSessionId: string,
): string | null {
  const execution = entry.executionsByNativeSession.get(nativeSessionId);
  return execution?.mode === "native_child" ? execution.id : null;
}

function decodeTranscript(value: unknown): {
  readonly events: StoredCanonicalEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: number;
} | null {
  const nextCursor = isRecord(value) ? value.next_cursor : null;
  if (
    !isRecord(value) ||
    !Array.isArray(value.events) ||
    typeof value.has_more !== "boolean" ||
    typeof nextCursor !== "number" ||
    !Number.isSafeInteger(nextCursor) ||
    nextCursor < 0
  )
    return null;
  const events: StoredCanonicalEvent[] = [];
  for (const raw of value.events) {
    const threadId = isRecord(raw) ? raw.threadId : null;
    const event = validateCanonicalEvent(raw, threadId);
    if (event) events.push(event);
  }
  return { events, hasMore: value.has_more, nextCursor };
}

export async function fetchExecutionTranscript(
  runId: string,
  nativeSessionId: string,
  signal: AbortSignal,
  onPage?: (events: readonly StoredCanonicalEvent[]) => void,
): Promise<StoredCanonicalEvent[] | null> {
  if (signal.aborted) throw abortError();
  const entry = graphCacheEntry(runId);
  try {
    await ensureInitialGraph(runId, entry, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "execution graph not found") return null;
    throw error;
  }
  let executionId = cachedExecutionId(entry, nativeSessionId);
  if (!executionId) {
    try {
      await refreshGraph(runId, entry, signal);
    } catch (error) {
      if (error instanceof Error && error.message === "execution graph not found") return null;
      throw error;
    }
    executionId = cachedExecutionId(entry, nativeSessionId);
  }
  if (!executionId) return null;

  return fetchExecutionTranscriptById(runId, executionId, signal, onPage);
}

/** Exact transcript read for a selected durable execution. Sidebar/detail
 * navigation must use this path because native provider session ids can repeat. */
export async function fetchExecutionTranscriptById(
  runId: string,
  executionId: string,
  signal: AbortSignal,
  onPage?: (events: readonly StoredCanonicalEvent[]) => void,
): Promise<StoredCanonicalEvent[] | null> {
  if (signal.aborted) throw abortError();
  let cursor = 0;
  let events: StoredCanonicalEvent[] = [];
  for (;;) {
    const transcriptResponse = await fetch(
      `/api/runs/${encodeURIComponent(runId)}/executions/${encodeURIComponent(executionId)}/events?limit=200&cursor=${cursor}`,
      { cache: "no-store", credentials: "same-origin", signal },
    );
    if (transcriptResponse.status === 404) return null;
    if (!transcriptResponse.ok) throw new Error("execution transcript unavailable");
    const page = decodeTranscript(await transcriptResponse.json());
    if (!page) throw new Error("invalid execution transcript response");
    events = mergeExecutionTranscript(events, page.events);
    onPage?.(events);
    if (!page.hasMore) return events;
    if (page.nextCursor <= cursor) throw new Error("execution transcript cursor did not advance");
    cursor = page.nextCursor;
  }
}
