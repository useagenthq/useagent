import { isUniqueViolation } from "../db/pg-errors";
import { runPayloadFingerprint } from "./fingerprint";
import { findCommandByKey, insertCommandWithRun } from "./repo";
import type { CommandRecord } from "./repo";
import type { RunCommandInput, RunCommandOutcome } from "./types";
import { publishThreadChange } from "../runs/thread-signals";

// ---------------------------------------------------------------------------
// Command acceptance orchestration (north star "Durable Commands"). Decides,
// idempotently, whether a submission is a fresh turn, a replay of an already-
// accepted one, or an ambiguous key reuse — and delegates all persistence to
// repo.ts.
// ---------------------------------------------------------------------------

/** Bounded audit copy of the accepted request. */
const PAYLOAD_CAP = 8_192;

/** Classify a keyed submission against an existing command: same fingerprint →
 *  idempotent replay of its run; different fingerprint → ambiguous reuse. */
function classifyReplay(existing: CommandRecord, fingerprint: string): RunCommandOutcome {
  if (existing.payloadFingerprint === fingerprint && existing.runId) {
    return { status: "replayed", runId: existing.runId };
  }
  return { status: "conflict", reason: "payload_mismatch" };
}

/**
 * Accept a `run.create` command. Idempotent by (org, idempotencyKey):
 *  - keyed replay with a matching payload → the ORIGINAL run id (no new work);
 *  - keyed replay with a different payload → conflict (never silently rerun);
 *  - otherwise commit command + run atomically and report `created`.
 *
 * A concurrent same-key race is resolved by the unique index: the loser's
 * transaction rolls back with a unique violation, which we re-read into the
 * winner's outcome rather than surfacing a raw DB error.
 */
export async function acceptRunCommand(input: RunCommandInput): Promise<RunCommandOutcome> {
  const fingerprint = runPayloadFingerprint(input.run);
  const payload = JSON.stringify({
    prompt: input.run.prompt,
    model: input.run.model,
    engine: input.run.engine,
    parentRunId: input.run.parentRunId,
    threadId: input.run.threadId,
    repos: input.run.repos,
    memoryScope: input.run.memoryScope,
    skillId: input.run.skillId,
    skillVersion: input.run.skillVersion,
    commandName: input.run.commandName,
  }).slice(0, PAYLOAD_CAP);
  const commandId = crypto.randomUUID();

  // Fast path: a keyed replay short-circuits before a doomed insert.
  if (input.idempotencyKey) {
    const existing = await findCommandByKey(input.orgId, input.idempotencyKey);
    if (existing) return classifyReplay(existing, fingerprint);
  }

  try {
    await insertCommandWithRun({
      commandId,
      idempotencyKey: input.idempotencyKey,
      orgId: input.orgId,
      actorId: input.actorId,
      payloadFingerprint: fingerprint,
      payload,
      run: input.run,
    });
  } catch (err) {
    // A concurrent request with the same key won the unique index; our run +
    // command rolled back together. Resolve against the winner.
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const existing = await findCommandByKey(input.orgId, input.idempotencyKey);
      if (existing) return classifyReplay(existing, fingerprint);
    }
    throw err;
  }

  // Post-commit thread signal (final_fix.md §4.5): the run + command committed, so
  // wake any connected thread stream to discover this newly accepted run WITHOUT
  // the five-second poll. This is the ONE central seam — web, Slack, schedules, and
  // Skills Run all accept here, so none grows its own UI notification code. Only
  // fired on a fresh `created`; an idempotent replay returns above and re-signals
  // nothing (no duplicate run signal). IDs only, never secrets/payloads.
  publishThreadChange(input.run.threadId, { runId: input.run.id, kind: "created" });

  return { status: "created", runId: input.run.id, commandId };
}
