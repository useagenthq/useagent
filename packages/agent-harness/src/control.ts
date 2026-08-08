/**
 * Provider-neutral harness CONTROL seam (north star Phase 2 "HarnessAdapter
 * Contract", Stage-1 MINIMAL subset: capabilities / cancel / reconcile).
 *
 * These are pure domain types: they carry only string handles and MUST NOT
 * import a sandbox/provider SDK, a database, or any product runtime. Provider-
 * specific translation lives in the adapter. Unsupported behavior returns a typed
 * `unsupported_capability` result; it must never silently no-op or throw an
 * unclassified exception.
 *
 * Extracted from `backend/src/engines/types.ts` into `@skynet/agent-harness` so
 * both the backend and a future independent consumer can depend on the control
 * contract without importing Skynet product code. `types.ts` keeps the Skynet-
 * specific engine surface (EmitStep, EngineRunContext, EngineAdapter, prompt
 * composition) and re-exports these types for backward compatibility.
 */

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

/** Enough native identity to address one live session. No provider SDK types -
 *  the adapter resolves these strings to a concrete sandbox/server. */
export interface HarnessSessionHandle {
  provider: string;
  /** Native harness session id (opencode `ses_*`). */
  sessionId: string;
  /** Sandbox instance holding the resident harness. */
  sandboxId: string;
}

/** Optional watermark for reconcile - our last recorded activity (epoch ms), so
 *  the adapter only reports a completion strictly newer than what we have. */
export interface HarnessCheckpoint {
  sinceMs?: number;
}

/** Returned instead of throwing when a capability is not supported by this
 *  provider - the caller branches on it explicitly. */
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

/** Result of a reconcile probe - the provider-neutral projection of what the
 *  native session's history shows after an interruption. */
export type HarnessReconciliation =
  | { status: "completed"; summary: string }
  | { status: "in_progress" }
  | { status: "no_change" }
  | { status: "unreachable" }
  | HarnessUnsupported;

/** The Stage-1 minimal harness boundary. Fuller methods (createSession,
 *  submitTurn, subscribe, snapshot, resolveInteraction) are deferred - the
 *  existing EngineAdapter.run drives turns today; this seam adds the typed
 *  control/observability surface the product layer needs. */
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
