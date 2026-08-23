// Gateway child sessions - runs the agent spawned via child_session_create: a
// deferred serial thread turn with `child_session === true` and `parent_run_id`
// set. Shared by the inline conversation fold (subagents-fold) and the Agents
// rail so both surfaces name the same children the same way. Pure and
// deterministic; no React, so it composes without an import cycle.

import type { ChildStatus } from "./native-events";
import { cleanPrompt, type EngineId, type RunStatus } from "./types";

/** One gateway child-session turn (its own run in the same thread). */
export interface GatewayChildSession {
  readonly id: string;
  readonly prompt: string;
  readonly engine: EngineId;
  readonly model: string;
  readonly status: RunStatus;
  readonly summary: string | null;
}

/** The minimal run/turn shape the derivation reads. `Turn` satisfies it
 *  structurally, so callers pass `Turn[]` without a cycle back to conversation. */
interface ChildTurnLike {
  readonly run: {
    readonly id: string;
    readonly prompt: string;
    readonly engine: EngineId;
    readonly model: string;
    readonly parent_run_id?: string | null;
    readonly child_session?: boolean;
  };
  readonly status: RunStatus;
  readonly summary: string | null;
}

/** RunStatus -> the shared child-status vocabulary (queued IS pending-in-line). */
export const RUN_CHILD_STATUS: Record<RunStatus, ChildStatus> = {
  queued: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export const firstLine = (text: string): string => text.split("\n", 1)[0]?.trim() ?? "";

/** Project one child run/turn into the shared gateway-child row shape. */
export function toGatewayChildSession(turn: ChildTurnLike): GatewayChildSession {
  return {
    id: turn.run.id,
    prompt: cleanPrompt(turn.run.prompt),
    engine: turn.run.engine,
    model: turn.run.model,
    status: turn.status,
    summary: turn.summary,
  };
}

/** Every gateway child in the thread (flat, spawn order). The rail is
 *  thread-level, so it lists all children regardless of which parent turn
 *  spawned them (the inline fold groups the same rows under each parent). */
export function deriveThreadGatewayChildren(
  turns: readonly ChildTurnLike[],
): GatewayChildSession[] {
  return turns
    .filter((turn) => turn.run.child_session === true && Boolean(turn.run.parent_run_id))
    .map(toGatewayChildSession);
}
