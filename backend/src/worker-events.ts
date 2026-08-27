import { EventEmitter } from "node:events";
import type { RunStatus } from "./db/schema.js";
import type { ApiStep } from "./runs/repo.js";

export type BusEvent =
  | { type: "step"; step: ApiStep }
  | { type: "end"; status: RunStatus };

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function channel(runId: string): string {
  return `run:${runId}`;
}

// Global lifecycle signal: fired once per run the instant its actor is spawned,
// before any step/end event.
export const RUN_SPAWNED = "run:spawned";
