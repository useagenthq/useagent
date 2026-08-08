// Pure selectors over an AgentTranscript (the canonical thread store's snapshot).
// A sample UI derives its view entirely from these - it never parses provider frames
// or branches on engine name. All selectors are total + side-effect free.

import type { AgentTranscript } from "./thread-store";
import type { CanonicalThreadEvent } from "./thread-events";

/** Assistant text for a thread, concatenated in delivery order. `message.completed`
 *  carries the authoritative final text when present; otherwise the streamed
 *  `message.delta` chunks are joined (per messageId, first-seen order). */
export function selectAssistantText(t: AgentTranscript): string {
  const deltas = new Map<string, string>();
  const completed = new Map<string, string>();
  const order: string[] = [];
  for (const e of t.events) {
    if (e.kind === "message.delta") {
      if (!deltas.has(e.messageId)) order.push(e.messageId);
      deltas.set(e.messageId, (deltas.get(e.messageId) ?? "") + e.text);
    } else if (e.kind === "message.completed") {
      if (!deltas.has(e.messageId) && !completed.has(e.messageId)) order.push(e.messageId);
      if (typeof e.text === "string") completed.set(e.messageId, e.text);
    }
  }
  return order.map((id) => completed.get(id) ?? deltas.get(id) ?? "").join("");
}

export interface ToolCallView {
  readonly toolCallId: string;
  readonly name: string;
  readonly title?: string;
  readonly status: "running" | "ok" | "error";
  readonly preview?: string;
  readonly error?: string;
}

/** Tool calls in delivery order, folding tool.started -> tool.completed by toolCallId. */
export function selectToolCalls(t: AgentTranscript): ToolCallView[] {
  const byId = new Map<string, ToolCallView>();
  const order: string[] = [];
  for (const e of t.events) {
    if (e.kind === "tool.started") {
      if (!byId.has(e.toolCallId)) order.push(e.toolCallId);
      byId.set(e.toolCallId, { toolCallId: e.toolCallId, name: e.name, title: e.title, status: "running" });
    } else if (e.kind === "tool.completed") {
      const prev = byId.get(e.toolCallId);
      if (!prev) order.push(e.toolCallId);
      byId.set(e.toolCallId, {
        toolCallId: e.toolCallId,
        name: prev?.name ?? "tool",
        title: prev?.title,
        status: e.status,
        preview: e.preview,
        error: e.error,
      });
    }
  }
  return order.map((id) => byId.get(id)!);
}

export interface UsageView {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

/** The most recent usage.updated in the thread, or null if none. */
export function selectLatestUsage(t: AgentTranscript): UsageView | null {
  let latest: UsageView | null = null;
  for (const e of t.events) {
    if (e.kind === "usage.updated") {
      latest = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd };
    }
  }
  return latest;
}

export interface ContextMarkerView {
  readonly markerType: string;
  readonly title: string;
  readonly detail?: string;
}

/** Skynet context markers (memory / knowledge / skill / playbook / rule / reconciling),
 *  in delivery order. These originate in Skynet's lane and render for every engine. */
export function selectContextMarkers(t: AgentTranscript): ContextMarkerView[] {
  const out: ContextMarkerView[] = [];
  for (const e of t.events) {
    if (e.kind === "context.marker") out.push({ markerType: e.markerType, title: e.title, detail: e.detail });
  }
  return out;
}

/** Distinct run ids present in the transcript, in first-seen delivery order. */
export function selectRunIds(t: AgentTranscript): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of t.events as readonly CanonicalThreadEvent[]) {
    if (!seen.has(e.runId)) {
      seen.add(e.runId);
      out.push(e.runId);
    }
  }
  return out;
}
