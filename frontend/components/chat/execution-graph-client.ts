import { type StoredCanonicalEvent, validateCanonicalEvent } from "./canonical-timeline";

export type ExecutionGraphClientMode = "off" | "shadow" | "read";

export const EXECUTION_GRAPH_CLIENT_MODE: ExecutionGraphClientMode =
  process.env.NEXT_PUBLIC_EXECUTION_GRAPH_ROLLOUT === "read"
    ? "read"
    : process.env.NEXT_PUBLIC_EXECUTION_GRAPH_ROLLOUT === "shadow"
      ? "shadow"
      : "off";

interface ExecutionGraphRow {
  readonly id: string;
  readonly mode: string;
  readonly provider: string;
  readonly native_session_id: string | null;
}

interface ExecutionGraphResponse {
  readonly executions: readonly ExecutionGraphRow[];
  readonly hasMore?: boolean;
  readonly nextCursor?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXECUTION_GRAPH_CACHE_LIMIT = 32;

interface ExecutionGraphCacheEntry {
  readonly executionsByNativeSession: Map<string, ExecutionGraphRow>;
  initialized: boolean;
  nextCursor: string | null;
  initialInFlight: Promise<void> | null;
  refreshInFlight: Promise<void> | null;
}

const executionGraphCache = new Map<string, ExecutionGraphCacheEntry>();
let executionGraphCacheEpoch = 0;

function newGraphCacheEntry(): ExecutionGraphCacheEntry {
  return {
    executionsByNativeSession: new Map(),
    initialized: false,
    nextCursor: null,
    initialInFlight: null,
    refreshInFlight: null,
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
      (raw.native_session_id !== null && typeof raw.native_session_id !== "string")
    )
      return [];
    return [
      {
        id: raw.id,
        mode: raw.mode,
        provider: raw.provider,
        native_session_id: raw.native_session_id,
      },
    ];
  });
  const hasMore = value.has_more;
  const nextCursor = value.next_cursor;
  if (hasMore !== undefined && typeof hasMore !== "boolean") return null;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    return null;
  }
  return {
    executions,
    hasMore: hasMore ?? false,
    nextCursor: nextCursor ?? null,
  };
}

function mergeGraphPage(entry: ExecutionGraphCacheEntry, graph: ExecutionGraphResponse): void {
  for (const execution of graph.executions) {
    if (execution.native_session_id) {
      entry.executionsByNativeSession.set(execution.native_session_id, execution);
    }
  }
  entry.nextCursor = graph.nextCursor ?? null;
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
