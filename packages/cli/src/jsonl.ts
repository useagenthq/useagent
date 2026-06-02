// Pure JSONL helpers for `useagent fan`: one task per line in, one result per line out.
// Parsing reports the offending line number so a malformed batch fails loudly, not
// silently. No IO here - the caller supplies the file bytes and writes the output.

import {
  MAX_FLEET_TASKS,
  type FleetTask,
  type Verdict,
} from "@useagent/agent-client/fleet";
import { CliError } from "./errors";
import { coerceTask } from "./task";

/** One result row written to the --out file (or stdout). Mirrors the task spec:
 *  {runId, status, verdict?, answer, url} plus the source prompt and any error. */
export interface FanResultLine {
  readonly prompt: string;
  readonly runId: string | null;
  readonly status: string;
  readonly verdict?: Verdict;
  readonly answer: string;
  readonly url: string | null;
  readonly error?: string;
}

/** Parse a JSONL task batch. Blank lines are skipped; every other line must be a JSON
 *  object with a non-empty `prompt`. Throws CliError (naming the line) on any bad line. */
export function parseTasksJsonl(text: string): FleetTask[] {
  const tasks: FleetTask[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CliError(`tasks file line ${i + 1}: not valid JSON`, 2);
    }
    const task = coerceTask(parsed);
    if (!task) {
      throw new CliError(`tasks file line ${i + 1}: each line needs a non-empty "prompt" string`, 2);
    }
    tasks.push(task);
    if (tasks.length > MAX_FLEET_TASKS) {
      throw new CliError(`tasks file may contain at most ${MAX_FLEET_TASKS} tasks`, 2);
    }
  }
  if (tasks.length === 0) throw new CliError("tasks file has no task lines", 2);
  return tasks;
}

/** Serialize one result as a single JSONL line (no trailing newline). */
export function serializeResultLine(result: FanResultLine): string {
  return JSON.stringify(result);
}

/** Serialize a whole batch as newline-terminated JSONL. */
export function serializeResults(results: readonly FanResultLine[]): string {
  return results.map(serializeResultLine).join("\n") + "\n";
}
