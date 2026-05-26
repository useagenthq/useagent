// ---------------------------------------------------------------------------
// Honest turn-failure classification.
//
// A deploy that restarts the backend UNDER a live run drops the provider
// stream mid-turn (the sandbox-side WebSocket to the in-process relay closes,
// surfacing as "The provider stream closed before the turn settled"). That is a
// TRANSIENT infrastructure interruption, not a provider error: the model did
// nothing wrong and the turn is safe to resume. Reporting it as a bare "engine
// error" strands the user with an unactionable failure.
//
// This module distinguishes a transient stream drop (backend restarted / stream
// dropped) from a real provider/engine error, and composes a resumable failure
// summary that says so. It is PURE + deterministic so the classification is
// unit-tested in isolation.
//
// FOLLOW-UP (relay reconnect): the codex subscription relay capability is
// single-use by design (issued per turn, `consumed` on accept, deleted on
// open in src/provider-connections/codex-subscription-relay.ts), so a true
// mid-turn reconnect needs a RE-ISSUED capability bound to the same
// org/user/thread/run. That is deferred; this change implements the honest
// classification + resumable-summary half so an interrupted turn is at least
// reported truthfully and can be re-dispatched on the thread.
// ---------------------------------------------------------------------------

/** Substrings that mark a dropped provider stream (transient infrastructure
 *  interruption, e.g. the backend restarting under a live turn) rather than a
 *  real provider/engine error. Sourced from the runtime thread stream
 *  (src/engines/runtime-event-stream.ts), which raises these when the sandbox's
 *  WebSocket to the relay closes before the turn settled. */
const TRANSIENT_STREAM_MARKERS = [
  "The provider stream closed before the turn settled",
  "The provider stream connection failed",
  "The provider thread subscription failed",
] as const;

export type TurnFailureKind = "transient" | "provider";

export interface TurnFailureClassification {
  readonly kind: TurnFailureKind;
  /** True when the run can be safely re-dispatched on its thread. */
  readonly resumable: boolean;
  /** User-visible failure summary (no em dashes; truncated for storage). */
  readonly summary: string;
}

function errorMessage(error: unknown): string {
  // An Error's own message wins (even empty, so a message-less throw stays a
  // bare "engine error" rather than the string "Error"); non-Error throws
  // stringify.
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

/** True when the error is a dropped provider stream (transient), NOT a real
 *  provider error. Cancellation + timeout are resolved BEFORE this by the
 *  worker; this only classifies the remaining engine errors. */
export function isTransientStreamDrop(error: unknown): boolean {
  const message = errorMessage(error);
  return TRANSIENT_STREAM_MARKERS.some((marker) => message.includes(marker));
}

/** Classify a non-cancelled, non-timed-out engine turn error into a transient
 *  stream drop (resumable) or a real provider error, and compose its resumable
 *  failure summary. The provider-error branch mirrors the worker's existing
 *  `error: <message>` shape so no honest failure loses its detail. */
export function classifyTurnFailure(error: unknown): TurnFailureClassification {
  if (isTransientStreamDrop(error)) {
    return {
      kind: "transient",
      resumable: true,
      summary:
        "interrupted: the backend restarted or the provider stream dropped " +
        "before the turn settled. This is transient, not a provider error - " +
        "resend the message to resume.",
    };
  }
  const message = errorMessage(error);
  return {
    kind: "provider",
    resumable: false,
    summary: message
      ? `error: ${message.replace(/\s+/g, " ").slice(0, 180)}`
      : "engine error",
  };
}
