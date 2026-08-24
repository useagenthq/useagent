import type { FleetTask } from "@useagent/agent-client/fleet";

/**
 * Coerce an untrusted record (a JSONL line or an MCP tool argument) into a FleetTask,
 * or null when it lacks a non-empty `prompt`. The ONE place a raw task is validated,
 * so the JSONL reader and the MCP server cannot drift. Unknown fields are ignored;
 * `engine`/`model` must be strings and `repos` an array of strings to be carried.
 */
export function coerceTask(raw: unknown): FleetTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.prompt !== "string" || !record.prompt.trim()) return null;
  const task: FleetTask = { prompt: record.prompt };
  if (typeof record.engine === "string") task.engine = record.engine;
  if (typeof record.model === "string") task.model = record.model;
  if (Array.isArray(record.repos) && record.repos.every((r) => typeof r === "string")) {
    task.repos = record.repos as string[];
  }
  return task;
}
