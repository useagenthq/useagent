// The command step a run's failure cut short. Repo preparation emits its
// "Cloning <repo>" command step before the clone script runs and, when the
// script is refused or fails, throws without writing anything back onto that
// step: the failure lands only on the run (the done step "Engine error" plus
// run.summary). Left alone, a step with no error flag and no exit code settles
// as completed, so the row shows a green check directly above the error that
// ended the run.

import { type ApiStep, asRecord, parseStepCode, type RunStatus } from "./types";

const ENGINE_ERROR = "Engine error";

/** Payload keys a step's own completion writes: an output, an exit code, or the
 *  error flag. A step carrying any of them settled on its own evidence. */
const OUTCOME_KEYS = ["output", "stdout", "exit_code", "exitCode", "error"];

function recordedOutcome(step: ApiStep): boolean {
  const code = asRecord(parseStepCode(step));
  return code !== null && OUTCOME_KEYS.some((key) => key in code);
}

/**
 * The command step that failed with the run: the run ended in failure (its done
 * step says "Engine error", or its status is failed) while this command was the
 * last thing it did, and the step never recorded an outcome of its own. Null when
 * the run succeeded, when the run kept going after the command, or when the step
 * carries its own verdict.
 */
export function commandFailedWithRun(steps: readonly ApiStep[], status: RunStatus): ApiStep | null {
  const done = steps.findLast((step) => step.kind === "done");
  if (status !== "failed" && done?.label !== ENGINE_ERROR) return null;
  const last = steps.findLast((step) => step.kind !== "done");
  if (last?.kind !== "command" || recordedOutcome(last)) return null;
  return last;
}
