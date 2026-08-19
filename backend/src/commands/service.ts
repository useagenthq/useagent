import { isUniqueViolation } from "../db/pg-errors";
import { runPayloadFingerprint } from "./fingerprint";
import { findCommandByKey, insertCommandWithRun } from "./repo";
import type { CommandRecord } from "./repo";
import type { RunCommandInput, RunCommandOutcome } from "./types";
import { publishRunLifecycleChange } from "../runs/org-signals";
import { deriveRunOrigin } from "../runs/origin";
import { isModelAllowedForEngine } from "../runs/model-policy";
import { engineModelReadyForDispatch } from "../runs/engine-readiness";
import { withThreadLifecycleLock } from "../runs/thread-lifecycle-lock";

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
    attachmentIds: input.run.attachmentIds ?? [],
    memoryScope: input.run.memoryScope,
    skillId: input.run.skillId,
    skillVersion: input.run.skillVersion,
    commandName: input.run.commandName,
    commandProvider: input.run.commandProvider,
    commandSessionId: input.run.commandSessionId,
    commandCatalogRevision: input.run.commandCatalogRevision,
  }).slice(0, PAYLOAD_CAP);
  const commandId = crypto.randomUUID();

  let outcome: RunCommandOutcome | null;
  try {
    outcome = await withThreadLifecycleLock(
      input.orgId,
      input.run.threadId,
      async (tx) => {
        // Fast path: a keyed replay short-circuits before a doomed insert.
        if (input.idempotencyKey) {
          const existing = await findCommandByKey(input.orgId, input.idempotencyKey, tx);
          if (existing) return classifyReplay(existing, fingerprint);
        }

        // Readiness applies only when accepting NEW work. A matching keyed
        // replay is a read of an already-durable decision and must keep
        // returning the original run even if policy or provider health later
        // changes.
        if (!isModelAllowedForEngine(input.run.engine, input.run.model)) {
          throw new Error(
            `model ${input.run.model} is not allowed for engine ${input.run.engine}`,
          );
        }
        if (!engineModelReadyForDispatch(input.run.engine, input.run.model)) {
          throw new Error(
            `engine/model not ready: ${input.run.engine}/${input.run.model}`,
          );
        }

        await insertCommandWithRun(
          {
            commandId,
            idempotencyKey: input.idempotencyKey,
            orgId: input.orgId,
            actorId: input.actorId,
            payloadFingerprint: fingerprint,
            payload,
            run: input.run,
            // Internal-run marker (parity canaries / e2e harnesses), derived from
            // the explicit identifiers those tools stamp — never the prompt. Null
            // for every product run; internal runs skip org-memory capture.
            origin: deriveRunOrigin(input.idempotencyKey, input.run.id),
          },
          tx,
        );
        return null;
      },
    );
  } catch (err) {
    // A concurrent request with the same org/key but a different root thread can
    // win the unique index. The losing transaction is aborted, so resolve the
    // winner only AFTER withThreadLifecycleLock rolls it back.
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const existing = await findCommandByKey(input.orgId, input.idempotencyKey);
      if (existing) return classifyReplay(existing, fingerprint);
    }
    throw err;
  }
  if (outcome) return outcome;

  // Post-commit thread signal (final_fix.md §4.5): the run + command committed, so
  // wake any connected thread stream to discover this newly accepted run WITHOUT
  // the five-second poll. This is the ONE central seam — web, Slack, schedules, and
  // Skills Run all accept here, so none grows its own UI notification code. Only
  // fired on a fresh `created`; an idempotent replay returns above and re-signals
  // nothing (no duplicate run signal). IDs only, never secrets/payloads.
  publishRunLifecycleChange({
    orgId: input.orgId,
    threadId: input.run.threadId,
    runId: input.run.id,
    kind: "created",
  });

  return { status: "created", runId: input.run.id, commandId };
}
