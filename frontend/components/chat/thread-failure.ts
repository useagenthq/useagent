import type { Turn } from "./conversation";

/** The latest turn when it failed with a summary, else undefined: only the
 *  thread's current state raises the failure banner, never an older turn. */
export function latestTurnFailure(turns: readonly Turn[], running: boolean | undefined): Turn | undefined {
  if (running) return undefined;
  const latest = turns.at(-1);
  return latest?.status === "failed" && latest.summary ? latest : undefined;
}
