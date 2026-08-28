/**
 * Canonical useAgent agent-event vocabulary.
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

const TOOL_SERVER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "skynet-knowledge": "useAgent",
};

/** Keep transport server ids stable while removing internal ids from UI labels. */
export function toolServerDisplayName(value: string): string {
  return TOOL_SERVER_DISPLAY_NAMES[value] ?? value;
}

/** Stable provider tag. Not an enum - a future harness adds a string, no code
 *  change here. Known today: opencode, claude-acp, codex-acp, claude-managed. */
export type ProviderId = string;

/** Where a session's native ids come from. Kept generic so React can show a Raw
 *  Trace / correlate without understanding any provider's private schema. */
export interface CanonicalIdentity {
  provider: ProviderId;
  /** Native session id (opencode `ses_*`, ACP session id, managed session id). */
  nativeSessionId?: string;
  /** Native parent session id for child-owned events; absent on parent-owned control. */
  nativeParentSessionId?: string;
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

/** Envelope carried by EVERY canonical event. `seq` is useAgent's own monotonic
 *  cursor for the thread (the browser resumes from it); `eventId` is stable per
 *  (run, native event) so revisions are idempotent. `ts` is assigned/validated
 *  by useAgent, never trusted from the provider. */
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

/** Bounded provider-reported usage for one child. Known counters stay named while
 *  future numeric counters remain losslessly available to newer consumers. */
export type CanonicalChildUsage = Readonly<Record<string, number>>;

export type CanonicalDelegationControlKind = "wait" | "send" | "resume" | "close" | "gather";

/** Optional provider snapshot carried alongside the legacy child lifecycle fields.
 *  Values are additive so readers of schema v1 rows can ignore this object, while
 *  richer consumers do not have to infer lifecycle state from display summaries. */
export interface CanonicalChildState {
  status?: string;
  prompt?: string;
  summary?: string;
  lastToolName?: string;
  usage?: CanonicalChildUsage;
  model?: string;
  role?: string;
  resumable?: boolean;
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

export interface CanonicalQuestionOption {
  label: string;
  description?: string;
}

export interface CanonicalQuestion {
  header?: string;
  prompt: string;
  options: readonly CanonicalQuestionOption[];
  multiple: boolean;
  custom: boolean;
}

/** Versioned, provider-neutral truth about the execution facilities attached
 * to one session. This is separate from feature booleans: availability can
 * degrade independently while the negotiated protocol surface stays stable. */
export const EXECUTION_CAPABILITY_VERSION = 1 as const;

export type ExecutionAvailability = "ready" | "on_demand" | "degraded" | "unsupported";
export type ExecutionFacilityAccess =
  | { kind: "native" }
  | { kind: "useagent_gateway"; discovery: "direct"; operations: readonly string[] }
  | {
      kind: "useagent_gateway";
      discovery: "compact";
      search: "gateway_tools_search";
      describe: "gateway_tool_describe";
      call: "gateway_tool_call";
      operations: readonly string[];
    }
  | { kind: "user_surface_only" }
  | { kind: "none" };

export interface ExecutionFacility {
  availability: ExecutionAvailability;
  access: ExecutionFacilityAccess;
  reasonCode?: string;
}

export interface ExecutionFacilities {
  files: ExecutionFacility;
  shell: ExecutionFacility;
  terminal: ExecutionFacility;
  desktop: ExecutionFacility;
  browser: ExecutionFacility;
  /** Registered gateway providers surface here without a schema change. An
   * empty operations list means the runtime discovers the current catalog. */
  tools: ExecutionFacility;
}

export interface ExecutionCapabilitySnapshot {
  version: typeof EXECUTION_CAPABILITY_VERSION;
  runtime: "sandbox" | "managed";
  workspaceRoot?: string;
  facilities: ExecutionFacilities;
}

/** useAgent-generated context markers (memory/knowledge/skill/playbook/rule) that
 *  render identically for every engine because they originate in useAgent's lane,
 *  not the provider's. */
export type ContextMarkerKind = "memory" | "knowledge" | "skill" | "playbook" | "rule" | "reconciling";

/**
 * The versioned, provider-neutral event union. Discriminated on `kind`; every
 * variant intersects {@link CanonicalEventBase}. Optional product surfaces
 * (reasoning, plans, usage, children, terminal) simply never emit for a harness
 * that lacks the capability - React shows them only when real events arrive.
 */
export type CanonicalEventBody =
  | {
      kind: "session.started";
      capabilities: NegotiatedCapabilities;
      /** Optional for backward compatibility with persisted pre-v1 frames. */
      executionCapabilities?: ExecutionCapabilitySnapshot;
      source?: string;
    }
  | { kind: "session.metadata"; metadata: Record<string, unknown> }
  | { kind: "turn.started" }
  | { kind: "turn.completed"; stopReason?: string }
  | { kind: "message.started"; messageId: string }
  | { kind: "message.delta"; messageId: string; text: string }
  | { kind: "message.completed"; messageId: string; text?: string }
  | { kind: "reasoning.delta"; messageId: string; text: string }
  | { kind: "reasoning.completed"; messageId: string }
  | { kind: "plan.updated"; entries: readonly CanonicalPlanEntry[] }
  | {
      kind: "tool.started";
      toolCallId: string;
      name: string;
      title?: string;
      server?: string;
      input?: unknown;
      nativeStatus?: string;
      durationMs?: number;
    }
  | {
      kind: "tool.progress";
      toolCallId: string;
      preview?: string;
      nativeStatus?: string;
      durationMs?: number;
    }
  | {
      kind: "tool.completed";
      toolCallId: string;
      status: "ok" | "error";
      preview?: string;
      artifact?: ArtifactRef;
      error?: string;
      nativeStatus?: string;
      durationMs?: number;
    }
  | {
      kind: "file.changed";
      path: string;
      changeType: "create" | "edit" | "delete";
      diff?: ArtifactRef;
    }
  | { kind: "artifact.created"; artifact: ArtifactRef; name: string }
  | {
      kind: "artifact.delivered";
      artifact: ArtifactRef;
      name: string;
      destination: string;
    }
  | { kind: "terminal.output"; terminalId?: string; chunk: string }
  | {
      kind: "child.started";
      childId: string;
      parentChildId?: string;
      launchToolCallId?: string;
      title?: string;
      state?: CanonicalChildState;
    }
  | { kind: "child.updated"; childId: string; status: string; state?: CanonicalChildState }
  | {
      kind: "child.completed";
      childId: string;
      status: "ok" | "error";
      result?: string;
      state?: CanonicalChildState;
    }
  | {
      kind: "delegation.control";
      delegationKind: CanonicalDelegationControlKind;
      toolCallId: string;
      targetChildIds: readonly string[];
      status: "ok" | "error";
    }
  | { kind: "approval.requested"; approvalId: string; operation: string; options: readonly string[] }
  | { kind: "approval.resolved"; approvalId: string; decision: string }
  | {
      kind: "question.requested";
      questionId: string;
      /** Backward-compatible first prompt/options for simple consumers. */
      prompt: string;
      options?: readonly string[];
      /** Full provider-neutral multi-question request for interactive clients. */
      questions?: readonly CanonicalQuestion[];
    }
  | {
      kind: "question.resolved";
      questionId: string;
      answer: string;
      answers?: readonly (readonly string[])[];
      status?: "answered" | "rejected";
    }
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
      /** The originating useAgent lane frame (eventType + payload), carried verbatim so the
       *  frontend reconstructs the FULL typed TimelineMarker with the SAME parser the
       *  legacy native lane uses - no fabrication, no drift, deep-equal markers (H3). The
       *  useAgent lane is non-provider metadata the browser already receives natively. */
      sourceEventType: string;
      sourcePayload?: Record<string, unknown>;
    }
  | { kind: "harness.warning"; message: string; rawEventType?: string; rawPayload?: unknown }
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
  /** Engine-NATIVE child/subagent projection (task fan-out translated from native frames into
   *  child.started/updated/completed). Real only where the provider actually emits child
   *  sessions (OpenCode protocol, canonical runtime adapter). */
  nativeChildProjection: boolean;
  /** The useAgent gateway `child_session_*` tools. These spawn DEFERRED serial thread turns
   *  through the product command lane - engine-independent, so ACP claude/codex sessions are
   *  granted them too (they never require a native child-session emitter). */
  gatewayChildSessions: boolean;
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
  /** The provider actually loaded the useAgent knowledge MCP for this session. */
  knowledgeTools: boolean;
}

/** The execution runtime a session is bound to. Managed Agents and future remote
 *  runtimes are NOT sandboxes, so this is a union - `sandboxId` is no longer a
 *  mandatory provider-domain field required by the canonical interface. */
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
  /** Model-facing runtime truth for this session. Optional only so persisted
   * pre-v1 sessions remain readable; current adapters must supply it. */
  executionCapabilities?: ExecutionCapabilitySnapshot;
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
  "streamingText", "reasoning", "plans", "toolProgress", "fileDiffs", "nativeChildProjection",
  "gatewayChildSessions", "approvals",
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
  // Legacy persisted frames (pre-split) carried one `childSessions` bit covering both the
  // native projection and the gateway tools; honor it so replayed old runs keep their truth.
  if (rec.childSessions === true) {
    if (rec.nativeChildProjection === undefined) out.nativeChildProjection = true;
    if (rec.gatewayChildSessions === undefined) out.gatewayChildSessions = true;
  }
  return out as NegotiatedCapabilities;
}

const EXECUTION_AVAILABILITY = new Set<ExecutionAvailability>([
  "ready",
  "on_demand",
  "degraded",
  "unsupported",
]);
const EXECUTION_FACILITIES: readonly (keyof ExecutionFacilities)[] = [
  "files", "shell", "terminal", "desktop", "browser", "tools",
];
const MAX_EXECUTION_OPERATIONS = 64;
const MAX_EXECUTION_TOKEN_LENGTH = 128;
const MAX_WORKSPACE_ROOT_LENGTH = 4_096;

function executionAvailability(raw: unknown): ExecutionAvailability {
  return typeof raw === "string" && EXECUTION_AVAILABILITY.has(raw as ExecutionAvailability)
    ? (raw as ExecutionAvailability)
    : "unsupported";
}

function boundedString(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value && value.length <= maxLength ? value : undefined;
}

function boundedToken(raw: unknown): string | undefined {
  const value = boundedString(raw, MAX_EXECUTION_TOKEN_LENGTH);
  return value && /^[A-Za-z0-9._:/-]+$/.test(value) ? value : undefined;
}

function executionOperations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const operations: string[] = [];
  for (const item of raw) {
    const operation = boundedToken(item);
    if (!operation || seen.has(operation)) continue;
    seen.add(operation);
    operations.push(operation);
    if (operations.length === MAX_EXECUTION_OPERATIONS) break;
  }
  return operations;
}

function executionAccess(raw: unknown): ExecutionFacilityAccess {
  if (!raw || typeof raw !== "object") return { kind: "none" };
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "native") return { kind: "native" };
  if (rec.kind === "user_surface_only") return { kind: "user_surface_only" };
  if (rec.kind === "none") return { kind: "none" };
  if (rec.kind !== "useagent_gateway") return { kind: "none" };
  const operations = executionOperations(rec.operations);
  if (rec.discovery === "direct") {
    return { kind: "useagent_gateway", discovery: "direct", operations };
  }
  if (
    rec.discovery === "compact" &&
    rec.search === "gateway_tools_search" &&
    rec.describe === "gateway_tool_describe" &&
    rec.call === "gateway_tool_call"
  ) {
    return {
      kind: "useagent_gateway",
      discovery: "compact",
      search: "gateway_tools_search",
      describe: "gateway_tool_describe",
      call: "gateway_tool_call",
      operations,
    };
  }
  return { kind: "none" };
}

function executionFacility(raw: unknown): ExecutionFacility {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const reasonCode = boundedToken(rec.reasonCode);
  const access = executionAccess(rec.access);
  let availability = executionAvailability(rec.availability);
  if (
    (availability === "ready" || availability === "on_demand") &&
    (access.kind === "none" ||
      (availability === "on_demand" && access.kind === "user_surface_only"))
  ) {
    availability = "unsupported";
  }
  if (availability === "unsupported") {
    return {
      availability,
      access: { kind: "none" },
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  return {
    availability,
    access,
    ...(reasonCode ? { reasonCode } : {}),
  };
}

/** Normalize a v1 execution snapshot through bounded enums. Unknown versions
 * are not guessed; malformed v1 fields fail closed to unsupported/no access. */
export function normalizeExecutionCapabilitySnapshot(
  raw: unknown,
): ExecutionCapabilitySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== EXECUTION_CAPABILITY_VERSION) return null;
  if (rec.runtime !== "sandbox" && rec.runtime !== "managed") return null;
  const rawFacilities =
    rec.facilities && typeof rec.facilities === "object"
      ? (rec.facilities as Record<string, unknown>)
      : {};
  const facilities = {} as Record<keyof ExecutionFacilities, ExecutionFacility>;
  for (const name of EXECUTION_FACILITIES) facilities[name] = executionFacility(rawFacilities[name]);
  const workspaceRoot = boundedString(rec.workspaceRoot, MAX_WORKSPACE_ROOT_LENGTH);
  return {
    version: EXECUTION_CAPABILITY_VERSION,
    runtime: rec.runtime,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    facilities,
  };
}

/** Parse a {@link SESSION_STARTED_EVENT_TYPE} provider-event payload into the negotiated
 *  capability map + source, or null when it carries no capabilities object. */
export function parseSessionStartedFrame(payload: unknown): {
  capabilities: NegotiatedCapabilities;
  executionCapabilities?: ExecutionCapabilitySnapshot;
  source?: string;
} | null {
  const rec = payload as {
    capabilities?: unknown;
    executionCapabilities?: unknown;
    source?: unknown;
  } | null;
  if (!rec || typeof rec !== "object" || rec.capabilities == null) return null;
  const executionCapabilities = normalizeExecutionCapabilitySnapshot(rec.executionCapabilities);
  return {
    capabilities: normalizeNegotiatedCapabilities(rec.capabilities),
    ...(executionCapabilities ? { executionCapabilities } : {}),
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
