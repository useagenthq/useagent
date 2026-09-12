// Bounded, redacted evidence for ONE resident ACP turn. The relay stream carries
// every JSON-RPC frame between the backend and the agent (claude-agent-acp or
// codex-acp); when a turn stalls the only honest answer is which tool call was
// still open and what the last frame said, not "event stream ended". This module
// keeps a small ring of frame summaries (never payload text beyond a short title)
// and composes the operator-facing description. Pure and unit-tested; acp-server
// owns the transport.
import { truncate } from "./util";

export type AcpFrameDirection = "in" | "out";

export interface AcpFrameTraceEntry {
  readonly at: number;
  readonly direction: AcpFrameDirection;
  readonly summary: string;
}

export interface AcpFrameTrace {
  record(direction: AcpFrameDirection, msg: Record<string, unknown>): void;
  frames(): readonly AcpFrameTraceEntry[];
}

export interface AcpOpenToolCall {
  readonly id: string;
  readonly kind?: string;
  readonly title?: string;
  readonly startedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** Operator opt-in: echo every ACP frame summary to the backend log. */
export function acpFrameTraceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ACP_FRAME_TRACE === "1" || env.ACP_FRAME_TRACE === "true";
}

/** One bounded line per JSON-RPC frame: method, ids, statuses and a short title.
 *  Tool output, prompts and message text are deliberately never included. */
export function summarizeAcpFrame(msg: Record<string, unknown>, max = 220): string {
  const id = typeof msg.id === "number" || typeof msg.id === "string" ? ` #${msg.id}` : "";
  const method = str(msg.method);
  if (method) {
    const params = isRecord(msg.params) ? msg.params : {};
    if (method === "session/update") {
      const u = isRecord(params.update) ? params.update : {};
      const bits = [str(u.sessionUpdate) ?? "?"];
      const callId = str(u.toolCallId);
      if (callId) bits.push(`call=${callId}`);
      const status = str(u.status);
      if (status) bits.push(`status=${status}`);
      const kind = str(u.kind);
      if (kind) bits.push(`kind=${kind}`);
      const title = str(u.title);
      if (title) bits.push(`title=${JSON.stringify(truncate(title, 60))}`);
      return truncate(`session/update ${bits.join(" ")}`, max);
    }
    if (method === "session/request_permission") {
      const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
      const options = Array.isArray(params.options)
        ? params.options.map((o) => (isRecord(o) ? `${str(o.kind) ?? "?"}:${str(o.optionId) ?? "?"}` : "?"))
        : [];
      const call = str(toolCall.toolCallId);
      const kind = str(toolCall.kind);
      return truncate(
        `session/request_permission${id}${call ? ` call=${call}` : ""}${kind ? ` kind=${kind}` : ""} options=[${options.join(",")}]`,
        max,
      );
    }
    return truncate(`${method}${id}`, max);
  }
  if (msg.error !== undefined && msg.error !== null) {
    return truncate(`response${id} error=${JSON.stringify(msg.error)}`, max);
  }
  const result = isRecord(msg.result) ? msg.result : {};
  const bits: string[] = [];
  const stopReason = str(result.stopReason);
  if (stopReason) bits.push(`stopReason=${stopReason}`);
  const outcome = isRecord(result.outcome) ? result.outcome : null;
  if (outcome) {
    const selected = str(outcome.optionId);
    bits.push(`outcome=${str(outcome.outcome) ?? "?"}${selected ? `:${selected}` : ""}`);
  }
  if (bits.length === 0) bits.push(`result{${Object.keys(result).join(",")}}`);
  return truncate(`response${id} ${bits.join(" ")}`, max);
}

/** A ring of the last `limit` frame summaries. `redact` runs over every summary
 *  (titles can quote a command line); `echo` receives each line when tracing. */
export function createAcpFrameTrace(options: {
  limit?: number;
  redact?: (text: string) => string;
  echo?: (line: string) => void;
  now?: () => number;
} = {}): AcpFrameTrace {
  const limit = Math.max(1, options.limit ?? 40);
  const redact = options.redact ?? ((text: string) => text);
  const now = options.now ?? (() => Date.now());
  const ring: AcpFrameTraceEntry[] = [];
  return {
    record(direction, msg) {
      const entry = { at: now(), direction, summary: redact(summarizeAcpFrame(msg)) };
      ring.push(entry);
      if (ring.length > limit) ring.splice(0, ring.length - limit);
      options.echo?.(`${direction === "in" ? "<-" : "->"} ${entry.summary}`);
    },
    frames() {
      return ring;
    },
  };
}

export interface AcpTurnStallInput {
  readonly engine: string;
  /** Why the turn ended without a response, e.g. "exceeded its 360s budget". */
  readonly reason: string;
  readonly nowMs: number;
  readonly openToolCalls: readonly AcpOpenToolCall[];
  readonly frames: readonly AcpFrameTraceEntry[];
  /** Tail of the in-sandbox relay log (agent stderr), if it could be read. */
  readonly relayLog?: string;
  /** Tail of the agent's own log file, if it could be read. */
  readonly agentLog?: string;
}

export interface AcpTurnStallDescription {
  /** Fits the run summary (the worker keeps 180 chars after "error: "). */
  readonly summary: string;
  /** Multi-line operator detail for the backend log and the timeline. */
  readonly detail: string;
}

const ageOf = (nowMs: number, at: number): string => `${Math.max(0, Math.round((nowMs - at) / 1000))}s ago`;

function describeToolCall(call: AcpOpenToolCall, nowMs: number): string {
  const label = call.title ? JSON.stringify(truncate(call.title, 50)) : call.id;
  return `[${call.kind ?? "tool"}] ${label} (started ${ageOf(nowMs, call.startedAt)})`;
}

/** Turn the evidence of a stalled turn into an honest summary and detail. */
export function describeAcpTurnStall(input: AcpTurnStallInput): AcpTurnStallDescription {
  const open = input.openToolCalls;
  const last = input.frames.at(-1);
  const openText = open.length === 0
    ? "no tool call open"
    : `${open.length} tool call${open.length === 1 ? "" : "s"} still open: ${describeToolCall(open[0]!, input.nowMs)}${open.length > 1 ? ` and ${open.length - 1} more` : ""}`;
  const lastText = last
    ? `last ACP frame ${ageOf(input.nowMs, last.at)} (${last.direction}): ${last.summary}`
    : "no ACP frame was received";
  const summary = `${input.engine} turn ${input.reason} with ${openText}; ${lastText}`;
  const lines = [
    summary,
    ...open.slice(1).map((call) => `  also open: ${describeToolCall(call, input.nowMs)}`),
    ...input.frames.slice(-8).map((f) => `  ${ageOf(input.nowMs, f.at).padStart(9)} ${f.direction === "in" ? "<-" : "->"} ${f.summary}`),
  ];
  const relay = input.relayLog?.trim();
  if (relay) lines.push(`  relay log tail: ${truncate(relay.replace(/\s+/g, " "), 600)}`);
  const agent = input.agentLog?.trim();
  if (agent) lines.push(`  agent log tail: ${truncate(agent.replace(/\s+/g, " "), 600)}`);
  return { summary, detail: lines.join("\n") };
}
