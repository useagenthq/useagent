import {
  validateCanonicalEvent,
  type StoredCanonicalEvent,
} from "./canonical-timeline";

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
}

interface ExecutionTranscriptResponse {
  readonly events: readonly unknown[];
  readonly has_more: boolean;
  readonly next_cursor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveExecutionId(
  graph: ExecutionGraphResponse,
  nativeSessionId: string,
): string | null {
  return graph.executions.find(
    (execution) =>
      execution.mode === "native_child" && execution.native_session_id === nativeSessionId,
  )?.id ?? null;
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
    ) return [];
    return [{
      id: raw.id,
      mode: raw.mode,
      provider: raw.provider,
      native_session_id: raw.native_session_id,
    }];
  });
  return { executions };
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
  ) return null;
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
  const graphResponse = await fetch(`/api/runs/${encodeURIComponent(runId)}/executions`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (graphResponse.status === 404) return null;
  if (!graphResponse.ok) throw new Error("execution graph unavailable");
  const graph = decodeGraph(await graphResponse.json());
  if (!graph) throw new Error("invalid execution graph response");
  const executionId = resolveExecutionId(graph, nativeSessionId);
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
