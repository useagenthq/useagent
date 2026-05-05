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
  /** Thread context composed from prior turns in this run's conversation (empty
   *  for a root run). Adapters PREPEND this to their engine prompt; the stored
   *  `prompt` stays the user's raw text. */
  contextPreamble: string;
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
  /** The engine's native session id recorded by this thread's PREVIOUS turn on
   *  the same engine (from the DB). Present → resume that session explicitly and
   *  send only the new prompt; absent → fresh session with the preamble. */
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

export interface EngineAdapter {
  readonly id: Exclude<EngineId, "mock">;
  run(ctx: EngineRunContext): Promise<void>;
}
