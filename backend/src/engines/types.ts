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
  /** Pinned-skill instructions for THIS run — the run's selected SKILL.md,
   *  already frame-wrapped as authoritative instructions ("" when no skill). A
   *  skill is per-RUN, so like {@link turnContext} it is injected on EVERY turn
   *  (fresh AND resumed) — this turn's selected skill, never re-derived from the
   *  resumed session's history. SEPARATE from the user's clean `prompt`. Compose
   *  via {@link composeTurnPrompt}. */
  skillContext?: string;
  /** Isolated working directory (already created) — the ONLY place an engine
   *  may touch the filesystem. Never the repo itself. */
  workdir: string;
  /** The conversation this run belongs to (== runId for a root run). Lets an
   *  adapter keep per-thread state — e.g. the daytona engine reuses one cloud
   *  sandbox across a thread's turns instead of provisioning per reply. */
  threadId?: string;
  /** The run's resolved organization + user (server-side identity from the run
   *  row). Used ONLY to mint the run-scoped tool-gateway token an adapter injects
   *  into the sandbox (knowledge tools) — never sent as prompt text. Null org →
   *  no identity → the adapter skips gateway wiring (fail closed). */
  orgId?: string | null;
  userId?: string | null;
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
 * First"). A FRESH native session gets the reconstructed prior-thread bootstrap;
 * a RESUMED session already holds the thread history natively, so it is dropped.
 * Both get the per-turn prefix — the run's pinned SKILL.md (instructions) then
 * fresh reference material (memory) — and finally the user's `prompt` verbatim.
 * Order: [prior-thread history] → [skill instructions] → [memory reference] →
 * [task]. The skill/memory are injected EVERY turn (per-run/per-turn), never
 * echoed into the stored `prompt`.
 *
 * Every adapter MUST use this instead of hand-concatenating, so a resumed turn
 * never silently drops freshly recalled memory or this turn's skill.
 */
/**
 * Global agent operating rules, injected once per FRESH native session (a resumed
 * session already holds them in its native history, exactly like bootstrapContext).
 * Born from a real eval failure: on a task needing PostHog (credential absent), the
 * agent sleep-and-retried the auth-gated API in a loop until the turn timeout, while
 * reference hit the SAME missing credential, skipped that sub-step, and still delivered.
 * This makes graceful degradation the default instead of retry-until-death.
 */
export const AGENT_OPERATING_RULES =
  "<operating_rules>\n" +
  "If a required tool, API, credential, or file is unavailable or repeatedly returns " +
  "auth/permission errors (401/403), not-found, or empty results, do NOT sleep-and-retry " +
  "it in a loop. Treat that dependency as unavailable: skip the sub-step it blocks, do " +
  "everything else the task allows, and finish. A partial result that explicitly names " +
  "what was skipped and why is far better than hanging until a timeout. Never block a " +
  "whole task on one missing dependency.\n" +
  "</operating_rules>\n\n";

export function composeTurnPrompt(
  ctx: Pick<
    EngineRunContext,
    "prompt" | "bootstrapContext" | "turnContext" | "skillContext"
  >,
  resumed: boolean,
): string {
  const perTurn = (ctx.skillContext ?? "") + ctx.turnContext;
  const prefix = resumed ? perTurn : AGENT_OPERATING_RULES + ctx.bootstrapContext + perTurn;
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
// The pure control types moved to `@skynet/agent-harness/control` so a future
// independent consumer can depend on the contract without importing product
// code. They are re-exported here so every existing `../engines/types` import
// keeps working unchanged.
// ---------------------------------------------------------------------------

export type {
  HarnessCapabilities,
  HarnessSessionHandle,
  HarnessCheckpoint,
  HarnessUnsupported,
  HarnessOperationResult,
  HarnessReconciliation,
  HarnessAdapter,
} from "@skynet/agent-harness/control";
