/**
 * Canonical Skynet agent-event vocabulary (final_harness.md, Phase 1 keystone).
 *
 * ONE provider-neutral wire grammar that every harness (OpenCode, Claude ACP,
 * Codex ACP, Anthropic Managed Agents, future) is translated INTO by a backend
 * translator. The existing thread SSE + React components consume only this, plus
 * capability flags - never a provider's private schema. Provider-native events
 * stay as a bounded raw sidecar (`provider_events` / NativeFrame) for debugging.
 *
 * This module is intentionally PURE TYPES + tiny helpers: no provider SDK, no
 * sandbox code, no behavior. It is additive - OpenCode keeps emitting its current
 * events until a translator produces these alongside them and golden fixtures
 * prove equivalence (Phase 0 -> Phase 1). Nothing branches on provider names here.
 */

/** Bump only with a migration: readers must tolerate older rows. */
export const CANONICAL_SCHEMA_VERSION = 1 as const;

/** Stable provider tag. Not an enum - a future harness adds a string, no code
 *  change here. Known today: opencode, claude-acp, codex-acp, claude-managed. */
export type ProviderId = string;

/** Where a session's native ids come from. Kept generic so React can show a Raw
 *  Trace / correlate without understanding any provider's private schema. */
export interface CanonicalIdentity {
  provider: ProviderId;
  /** Native session id (opencode `ses_*`, ACP session id, managed session id). */
  nativeSessionId?: string;
  /** Native event id, when the provider assigns one (for dedup/correlation). */
  nativeEventId?: string;
  /** Native monotonic sequence, when the provider assigns one. */
  nativeSeq?: number;
  /** Native message id (opencode `msg_*`) - lets a view reducer anchor per-message
   *  ordering + correlate parts to their message without provider knowledge. */
  nativeMessageId?: string;
  /** Native part id (opencode `prt_*`) - correlates a step/tool to its message. */
  nativePartId?: string;
}

/** Envelope carried by EVERY canonical event. `seq` is Skynet's own monotonic
 *  cursor for the thread (the browser resumes from it); `eventId` is stable per
 *  (run, native event) so revisions are idempotent. `ts` is assigned/validated
 *  by Skynet, never trusted from the provider. */
export interface CanonicalEventBase {
  schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  eventId: string;
  seq: number;
  runId: string;
  threadId: string;
  turnId?: string;
  ts: number;
  identity: CanonicalIdentity;
}

/** A large payload (tool output, diff, file) stored out-of-band; the timeline row
 *  keeps a bounded preview and fetches the full artifact lazily. */
export interface ArtifactRef {
  artifactId: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface CanonicalPlanEntry {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

/** One native slash command advertised by the selected provider at runtime
 *  (ACP `available_commands_update`, or OpenCode's `/command`). Provider-neutral:
 *  a command is invoked by sending `/name arguments` as an ordinary prompt. */
export interface CanonicalCommand {
  name: string;
  description?: string;
  /** argument/input hint, when the provider supplies one. */
  input?: string;
}

/** Skynet-generated context markers (memory/knowledge/skill/playbook/rule) that
 *  render identically for every engine because they originate in Skynet's lane,
 *  not the provider's. */
export type ContextMarkerKind = "memory" | "knowledge" | "skill" | "playbook" | "rule" | "reconciling";

/**
 * The versioned, provider-neutral event union. Discriminated on `kind`; every
 * variant intersects {@link CanonicalEventBase}. Optional product surfaces
 * (reasoning, plans, usage, children, terminal) simply never emit for a harness
 * that lacks the capability - React shows them only when real events arrive.
 */
export type CanonicalEventBody =
  | { kind: "session.started"; capabilities: NegotiatedCapabilities; source?: string }
  | { kind: "session.metadata"; metadata: Record<string, unknown> }
  | { kind: "turn.started" }
  | { kind: "turn.completed"; stopReason?: string }
  | { kind: "message.started"; messageId: string }
  | { kind: "message.delta"; messageId: string; text: string }
  | { kind: "message.completed"; messageId: string; text?: string }
  | { kind: "reasoning.delta"; messageId: string; text: string }
  | { kind: "reasoning.completed"; messageId: string }
  | { kind: "plan.updated"; entries: readonly CanonicalPlanEntry[] }
  | { kind: "tool.started"; toolCallId: string; name: string; title?: string; input?: unknown }
  | { kind: "tool.progress"; toolCallId: string; preview?: string }
  | {
      kind: "tool.completed";
      toolCallId: string;
      status: "ok" | "error";
      preview?: string;
      artifact?: ArtifactRef;
      error?: string;
    }
  | {
      kind: "file.changed";
      path: string;
      changeType: "create" | "edit" | "delete";
      diff?: ArtifactRef;
    }
  | { kind: "terminal.output"; terminalId?: string; chunk: string }
  | {
      kind: "child.started";
      childId: string;
      parentChildId?: string;
      launchToolCallId?: string;
      title?: string;
    }
  | { kind: "child.updated"; childId: string; status: string }
  | { kind: "child.completed"; childId: string; status: "ok" | "error"; result?: string }
  | { kind: "approval.requested"; approvalId: string; operation: string; options: readonly string[] }
  | { kind: "approval.resolved"; approvalId: string; decision: string }
  | { kind: "question.requested"; questionId: string; prompt: string; options?: readonly string[] }
  | { kind: "question.resolved"; questionId: string; answer: string }
  | {
      kind: "commands.updated";
      commands: readonly string[];
      catalog?: readonly CanonicalCommand[];
      /** Provider/engine that advertised this catalog (UI source label). */
      source?: string;
      /** Resident relay child generation the catalog was captured from, so a stale
       *  pre-restart catalog is distinguishable from the live one. */
      generation?: number;
    }
  | { kind: "mode.updated"; mode?: string; model?: string }
  | { kind: "usage.updated"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | {
      kind: "context.marker";
      markerType: ContextMarkerKind;
      title: string;
      detail?: string;
      /** The originating skynet-lane frame (eventType + payload), carried verbatim so the
       *  frontend reconstructs the FULL typed TimelineMarker with the SAME parser the
       *  legacy native lane uses - no fabrication, no drift, deep-equal markers (H3). The
       *  skynet lane is non-provider metadata the browser already receives natively. */
      sourceEventType: string;
      sourcePayload?: Record<string, unknown>;
    }
  | { kind: "harness.warning"; message: string; rawEventType?: string }
  | { kind: "harness.error"; message: string; fatal: boolean };

export type CanonicalAgentEvent = CanonicalEventBase & CanonicalEventBody;

/** Discriminant literals, for exhaustive handling + tests. */
export type CanonicalEventKind = CanonicalEventBody["kind"];

/**
 * Capabilities NEGOTIATED at connect/initialize time (ACP negotiates these; the
 * others report a static manifest). Persisted per session so the UI shows only
 * what THIS connection actually supports, and drives capability-based visibility
 * instead of `engine === "..."` branches.
 */
export interface NegotiatedCapabilities {
  streamingText: boolean;
  reasoning: boolean;
  plans: boolean;
  toolProgress: boolean;
  fileDiffs: boolean;
  childSessions: boolean;
  approvals: boolean;
  questions: boolean;
  usage: boolean;
  /** The engine lets the user choose the model per turn (opencode any-model sandbox); false for
   *  engines that run a fixed provider model (ACP claude/codex) - the model picker is hidden. */
  modelSelection: boolean;
  commands: boolean;
  directTerminal: boolean;
  /** ACP session/resume (reconnect live) and session/load (rebuild after restart). */
  resume: boolean;
  load: boolean;
  close: boolean;
  // UI-surface RESOURCES (Phase 6) - runtime resources, not pure protocol negotiation, but part
  // of the ONE capability map every surface gates on (so React never checks a provider name). A
  // resource that is absent reads false and the surface is simply omitted/disabled honestly.
  /** Native stop/cancel is actually wired (OpenCode abort / ACP session/cancel). */
  stop: boolean;
  /** Post-interruption reconciliation is supported. */
  reconcile: boolean;
  /** A usable VNC/desktop resource is provisioned for the session's sandbox. */
  desktop: boolean;
  /** An engine-native web/embed panel exists (e.g. OpenCode Live). */
  nativeEmbed: boolean;
  /** The provider actually loaded the Skynet knowledge MCP for this session. */
  knowledgeTools: boolean;
}

/** The execution runtime a session is bound to. Managed Agents and future remote
 *  runtimes are NOT sandboxes, so this is a union - `sandboxId` is no longer a
 *  mandatory provider-domain field (final_harness.md "Required interfaces"). */
export type HarnessRuntime =
  | { kind: "sandbox"; id: string }
  | { kind: "managed"; id: string };

/** Durable, restart-surviving session state. Persisted (see the `harness_sessions`
 *  table in the doc's data model) - never a process-local map as source of truth.
 *  `generation` guards against sending a gen-N session id to a gen-N+1 process. */
export interface HarnessSession {
  provider: ProviderId;
  nativeSessionId: string;
  runtime: HarnessRuntime;
  protocolVersion: string;
  capabilities: NegotiatedCapabilities;
  generation: number;
}

/** Where a translator emits canonical events; the backend persists them before
 *  publishing to the browser SSE (replay + live use the SAME canonical rows). */
export interface CanonicalEventSink {
  emit(event: CanonicalAgentEvent): void;
}

/** Compile-time exhaustiveness guard for switches over `kind`. Reaching it at
 *  runtime means an unhandled canonical kind - a bug, not silent drop. */
export function assertNeverEvent(x: never): never {
  throw new Error(`unhandled canonical event kind: ${JSON.stringify(x)}`);
}

/** Pull a `{name, description?, input?}` command out of a loosely-typed record,
 *  or null if it has no usable name. `input` accepts a bare string OR `{hint}`. */
function toCanonicalCommand(item: unknown): CanonicalCommand | null {
  const rec = item as { name?: unknown; description?: unknown; input?: unknown } | null;
  const name = typeof rec?.name === "string" ? rec.name.trim() : "";
  if (!name) return null;
  const cmd: CanonicalCommand = { name };
  if (typeof rec?.description === "string" && rec.description) cmd.description = rec.description;
  const input = rec?.input;
  const hint = typeof input === "string" ? input : (input as { hint?: unknown } | null)?.hint;
  if (typeof hint === "string" && hint) cmd.input = hint;
  return cmd;
}

/** Dedupe by name (first wins), preserving order. */
function dedupeCommands(list: CanonicalCommand[]): CanonicalCommand[] {
  const seen = new Set<string>();
  const out: CanonicalCommand[] = [];
  for (const c of list) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

/**
 * Parse an ACP `available_commands_update` session/update into a REPLACEMENT command
 * snapshot for that session. ACP v1 shape:
 *   { sessionUpdate: "available_commands_update", availableCommands: [{ name, description?, input? }] }
 * Nameless entries and duplicates drop; a non-array yields an empty snapshot (which the
 * caller treats as "provider advertises no commands right now", not "keep the old list").
 */
export function parseAcpAvailableCommands(update: Record<string, unknown>): CanonicalCommand[] {
  const list = (update.availableCommands ?? update.commands) as unknown;
  if (!Array.isArray(list)) return [];
  return dedupeCommands(list.map(toCanonicalCommand).filter((c): c is CanonicalCommand => c !== null));
}

/** Normalize OpenCode's `/command` body (a bare `{name, description}[]`) into the SAME
 *  provider-neutral `CanonicalCommand[]` shape, so one product command surface serves
 *  every engine. */
export function normalizeOpencodeCommands(raw: unknown): CanonicalCommand[] {
  if (!Array.isArray(raw)) return [];
  return dedupeCommands(raw.map(toCanonicalCommand).filter((c): c is CanonicalCommand => c !== null));
}

/** The provider-event `eventType` under which an ACP session's command-catalog REPLACEMENT
 *  is captured in the ordered, durable provider-events lane - so it is sealed by the same
 *  drain barrier and counted by the same canonicalization watermark as every other native
 *  frame (canonicalization cannot complete until the run's command snapshot is durable).
 *  One row per native session (id `<sessionId>:commands`, upserted so the LATEST replacement
 *  wins and duplicates are idempotent). */
export const ACP_COMMANDS_EVENT_TYPE = "acp.commands";

/** The durable payload persisted with an {@link ACP_COMMANDS_EVENT_TYPE} provider event.
 *  Carries the snapshot plus provenance sufficient to reject a stale catalog after a
 *  native-session change or an adapter upgrade. */
export interface AcpCommandsFramePayload {
  /** Provider/engine id that advertised the catalog (claude|codex). */
  readonly source: string;
  /** The pinned ACP adapter package(s)+version that produced the snapshot. */
  readonly adapter?: string;
  /** The resident relay child generation the snapshot came from. */
  readonly generation?: number;
  /** Capture wall-clock (ms) - order/recency is authoritative from the frame `seq`. */
  readonly ts?: number;
  readonly commands: readonly CanonicalCommand[];
}

/** The provider-event `eventType` under which a real session's negotiated capabilities are
 *  captured durably (parallel to {@link ACP_COMMANDS_EVENT_TYPE}); the translator emits the
 *  canonical `session.started` from it. */
export const SESSION_STARTED_EVENT_TYPE = "session.started";

const CAP_KEYS: readonly (keyof NegotiatedCapabilities)[] = [
  "streamingText", "reasoning", "plans", "toolProgress", "fileDiffs", "childSessions", "approvals",
  "questions", "usage", "modelSelection", "commands", "directTerminal", "resume", "load", "close",
  "stop", "reconcile", "desktop", "nativeEmbed", "knowledgeTools",
];

/** Coerce a loosely-typed record into a complete {@link NegotiatedCapabilities} (missing/non-bool
 *  keys default to false), so a producer or a forward-compat frame is always safe to render. This
 *  is the ONE capability model - there is no second framework. */
export function normalizeNegotiatedCapabilities(raw: unknown): NegotiatedCapabilities {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const out = {} as Record<keyof NegotiatedCapabilities, boolean>;
  for (const k of CAP_KEYS) out[k] = rec[k] === true;
  return out as NegotiatedCapabilities;
}

/** Parse a {@link SESSION_STARTED_EVENT_TYPE} provider-event payload into the negotiated
 *  capability map + source, or null when it carries no capabilities object. */
export function parseSessionStartedFrame(payload: unknown): { capabilities: NegotiatedCapabilities; source?: string } | null {
  const rec = payload as { capabilities?: unknown; source?: unknown } | null;
  if (!rec || typeof rec !== "object" || rec.capabilities == null) return null;
  return {
    capabilities: normalizeNegotiatedCapabilities(rec.capabilities),
    ...(typeof rec.source === "string" && rec.source ? { source: rec.source } : {}),
  };
}

/** Parse an {@link ACP_COMMANDS_EVENT_TYPE} provider-event payload back into a normalized
 *  catalog + provenance, re-normalized through the SAME command normalization as capture so
 *  the translator stays total + safe. Returns null when the payload carries no command array
 *  (an EMPTY array is a valid empty replacement, NOT null). */
export function parseAcpCommandsFrame(
  payload: unknown,
): { catalog: CanonicalCommand[]; source?: string; generation?: number } | null {
  const rec = payload as { commands?: unknown; source?: unknown; generation?: unknown } | null;
  if (!rec || !Array.isArray(rec.commands)) return null;
  const catalog = dedupeCommands(rec.commands.map(toCanonicalCommand).filter((c): c is CanonicalCommand => c !== null));
  return {
    catalog,
    ...(typeof rec.source === "string" && rec.source ? { source: rec.source } : {}),
    ...(typeof rec.generation === "number" ? { generation: rec.generation } : {}),
  };
}
