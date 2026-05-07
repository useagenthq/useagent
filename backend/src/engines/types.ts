import type { EngineId, StepKind } from "../db/schema";

// ---------------------------------------------------------------------------
// The pluggable engine layer. Every harness (Claude Agent SDK, Codex CLI,
// OpenCode) implements `EngineAdapter` and maps its own native event stream
// onto the SAME step/summary contract the scripted `mock` worker emits — so the
// frontend renders all engines identically from the durable event log.
// ---------------------------------------------------------------------------

/** A single trace step an engine emits. Mirrors the persisted step wire shape
 *  minus the server-assigned fields (id, idx, created_at). `code_json` is any
 *  JSON payload — the worker serializes it. */
export interface EmitStep {
  kind: StepKind; // 'command' | 'file' | 'task' | 'done'
  label: string;
  chip?: string | null;
  code_json?: unknown;
}

/** Everything an adapter needs to execute one run and stream it into the log. */
export interface EngineRunContext {
  runId: string;
  /** The run's prompt, verbatim — adapters must pass ANY prompt through. */
  prompt: string;
  /** Reconstructed prior-thread context, injected ONLY into a FRESH native
   *  session — a resumed session already holds this history natively. Empty for a
   *  root run. Compose via {@link composeTurnPrompt}, never by hand. */
  bootstrapContext: string;
  /** Fresh per-turn reference material (team memory today, knowledge later),
   *  already framed as reference-only (never instructions). Injected on EVERY
   *  turn — fresh AND resumed — so a continuing conversation still sees newly
   *  recalled memory. Never echoed as the user's text; the stored `prompt` stays
   *  the user's raw words. Compose via {@link composeTurnPrompt}. */
  turnContext: string;
  /** Isolated working directory (already created) — the ONLY place an engine
   *  may touch the filesystem. Never the repo itself. */
  workdir: string;
  /** The conversation this run belongs to (== runId for a root run). Lets an
   *  adapter keep per-thread state — e.g. the daytona engine reuses one cloud
   *  sandbox across a thread's turns instead of provisioning per reply. */
  threadId?: string;
  /** The run's requested model id (bare Anthropic-style, e.g. "claude-opus-5").
   *  Adapters map it to their provider format and fall back to their own
   *  default when absent/unsupported. */
  model?: string;
  /** The GitHub repos this thread works in (each "owner/name"); [] for a bare
   *  workdir. Set on EVERY run in the thread (inherited from the root run) so an
   *  adapter can ensure each clone exists in the workspace before the turn —
   *  idempotently (per repo dir), so a resumed thread keeps its existing clones. */
  repos?: string[];
  /** The engine's native session id recorded by this thread's PREVIOUS turn on
   *  the same engine (from the DB). Present → resume that session explicitly (only
   *  turnContext accompanies the prompt); absent → fresh session (bootstrap +
   *  turnContext). See {@link composeTurnPrompt}. */
  engineSessionId?: string;
  /** Persist the engine session id this run created/used, so the next turn can
   *  resume it. Fire-and-forget durable write; adapters call it as soon as the
   *  engine reveals its session id. */
  saveEngineSessionId?(sessionId: string): void;
  /** Aborted when the run exceeds its timeout; adapters must wire this to their
   *  subprocess / SDK call so a runaway engine is actually killed. */
  signal: AbortSignal;
  /** Append a step to the durable log + push it to SSE subscribers. Resolves to
   *  the persisted step id (undefined if the run vanished mid-flight). */
  emit(step: EmitStep): Promise<string | undefined>;
  /** Replace a previously emitted step's code_json and re-push it to SSE
   *  subscribers (same idx → the UI upserts in place). Lets an adapter surface a
   *  tool call the moment it's invoked and attach its output when it finishes —
   *  reference bot's tool_call → tool_result contract on an append-only log. */
  updateStep?(stepId: string, code: unknown): Promise<void>;
  /** Publish a live assistant-text delta to the run's turn-stream. In-memory and
   *  synchronous (no DB round-trip) so live-typing narration reaches the SSE
   *  before the persisted step does. Optional — adapters with no token stream
   *  simply omit it; the durable step log stays the source of truth. */
  publishDelta?(delta: string): void;
  /** Record the run's final assistant text + wall-clock duration. */
  setSummary(summary: string, durationMs: number): void;
}

/**
 * Compose the text an engine receives for one turn — the SINGLE source of truth
 * for the fresh-vs-resumed context rule (north star "Fix the Current Context Bug
 * First"). A FRESH native session gets the reconstructed prior-thread bootstrap
 * plus fresh per-turn context; a RESUMED session already holds the thread
 * history natively, so it gets ONLY the fresh per-turn context. The user's
 * `prompt` is always appended verbatim last.
 *
 * Every adapter MUST use this instead of hand-concatenating, so a resumed turn
 * never silently drops freshly recalled memory (the bug this replaces).
 */
export function composeTurnPrompt(
  ctx: Pick<EngineRunContext, "prompt" | "bootstrapContext" | "turnContext">,
  resumed: boolean,
): string {
  const prefix = resumed ? ctx.turnContext : ctx.bootstrapContext + ctx.turnContext;
  return prefix + ctx.prompt;
}

export interface EngineAdapter {
  readonly id: Exclude<EngineId, "mock">;
  run(ctx: EngineRunContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Typed harness seam (north star Phase 2 "HarnessAdapter Contract"), Stage-1
// MINIMAL subset: capabilities / cancel / reconcile. This is a provider-neutral
// boundary the product layer can call WITHOUT knowing it is talking to opencode.
// Its existence does NOT mean the agent loop moved out of the sandbox — the
// OpenCode implementation is a thin client over the resident `opencode serve`.
//
// These are pure domain types: they carry only string handles and MUST NOT
// import a sandbox/provider SDK. Provider-specific translation lives in the
// adapter. Unsupported behavior returns a typed `unsupported_capability` result;
// it must never silently no-op or throw an unclassified exception.
// ---------------------------------------------------------------------------

/** Provider-native capability detection (a subset is meaningful in Stage 1;
 *  fields describe what the HARNESS supports natively, not what Skynet already
 *  projects). */
export interface HarnessCapabilities {
  resume: boolean;
  cancel: boolean;
  streaming: "none" | "text" | "parts";
  authoritativeHistory: boolean;
  childSessions: boolean;
  approvals: boolean;
  questions: boolean;
  reasoning: boolean;
  todos: boolean;
  patches: boolean;
  usage: boolean;
}

/** Enough native identity to address one live session. No provider SDK types —
 *  the adapter resolves these strings to a concrete sandbox/server. */
export interface HarnessSessionHandle {
  provider: string;
  /** Native harness session id (opencode `ses_*`). */
  sessionId: string;
  /** Sandbox instance holding the resident harness. */
  sandboxId: string;
}

/** Optional watermark for reconcile — our last recorded activity (epoch ms), so
 *  the adapter only reports a completion strictly newer than what we have. */
export interface HarnessCheckpoint {
  sinceMs?: number;
}

/** Returned instead of throwing when a capability is not supported by this
 *  provider — the caller branches on it explicitly. */
export interface HarnessUnsupported {
  status: "unsupported_capability";
  provider: string;
  capability: string;
}

/** Result of a control operation (e.g. cancel). Classified, never a bare throw. */
export type HarnessOperationResult =
  | { status: "ok" }
  | { status: "error"; code: string; message: string }
  | HarnessUnsupported;

/** Result of a reconcile probe — the provider-neutral projection of what the
 *  native session's history shows after an interruption. */
export type HarnessReconciliation =
  | { status: "completed"; summary: string }
  | { status: "in_progress" }
  | { status: "no_change" }
  | { status: "unreachable" }
  | HarnessUnsupported;

/** The Stage-1 minimal harness boundary. Fuller methods (createSession,
 *  submitTurn, subscribe, snapshot, resolveInteraction) are deferred — the
 *  existing {@link EngineAdapter}.run drives turns today; this seam adds the
 *  typed control/observability surface the product layer needs. */
export interface HarnessAdapter {
  readonly provider: string;
  /** Static provider capability detection. */
  capabilities(): HarnessCapabilities;
  /** Ask the native session to abort. Records product intent at the caller. */
  cancel(
    handle: HarnessSessionHandle,
    reason: string,
  ): Promise<HarnessOperationResult>;
  /** Probe native history after an interruption (see north star Crash Recovery).
   *  Bounded and non-throwing; unreachable is a normal outcome, not an error. */
  reconcile(
    handle: HarnessSessionHandle,
    checkpoint?: HarnessCheckpoint,
  ): Promise<HarnessReconciliation>;
}
