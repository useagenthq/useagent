import { isUniqueViolation } from "../db/pg-errors";
import { runIntentFingerprint, runIntentFromAcceptedRun } from "./fingerprint";
import { findCommandByKey, insertCommandWithRun } from "./repo";
import type { CommandRecord } from "./repo";
import type { RunCommandInput, RunCommandIntent, RunCommandOutcome } from "./types";
import { publishRunLifecycleChange } from "../runs/org-signals";
import {
  assertInternalRunOrigin,
  type InternalRunOrigin,
} from "../runs/origin";
import { isModelAllowedForEngine } from "../runs/model-policy";
import { engineModelReadyForDispatch } from "../runs/engine-readiness";
import { withThreadLifecycleLock } from "../runs/thread-lifecycle-lock";
import { assertRunAdmissionOpen } from "./admission";

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
function classifyReplay(
  existing: CommandRecord,
  fingerprint: string,
  origin: InternalRunOrigin | null,
): RunCommandOutcome {
  if (existing.runOrigin !== origin) {
    return { status: "conflict", reason: "origin_mismatch" };
  }
  if (existing.payloadFingerprint === fingerprint && existing.runId) {
    return { status: "replayed", runId: existing.runId };
  }
  return { status: "conflict", reason: "payload_mismatch" };
}

/**
 * Read a previously accepted keyed decision before any external preflight.
 * Missing/unkeyed submissions return null and must continue through normal
 * authorization. This helper never reserves a key or accepts new work.
 */
async function preflightRunCommandReplayWithOrigin(input: {
  readonly orgId: string;
  readonly idempotencyKey: string | null;
  readonly intent: RunCommandIntent;
  readonly origin: InternalRunOrigin | null;
}): Promise<RunCommandOutcome | null> {
  if (input.idempotencyKey) {
    const existing = await findCommandByKey(input.orgId, input.idempotencyKey);
    if (existing) {
      return classifyReplay(existing, runIntentFingerprint(input.intent), input.origin);
    }
  }
  await assertRunAdmissionOpen();
  return null;
}

export function preflightRunCommandReplay(input: {
  readonly orgId: string;
  readonly idempotencyKey: string | null;
  readonly intent: RunCommandIntent;
}): Promise<RunCommandOutcome | null> {
  return preflightRunCommandReplayWithOrigin({ ...input, origin: null });
}

export function preflightInternalRunCommandReplay(input: {
  readonly orgId: string;
  readonly idempotencyKey: string | null;
  readonly intent: RunCommandIntent;
  readonly origin: InternalRunOrigin;
}): Promise<RunCommandOutcome | null> {
  assertInternalRunOrigin(input.origin);
  return preflightRunCommandReplayWithOrigin(input);
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
async function acceptRunCommandWithOrigin(
  input: RunCommandInput,
  origin: InternalRunOrigin | null,
): Promise<RunCommandOutcome> {
  const intent = input.intent ?? runIntentFromAcceptedRun(input.run);
  const fingerprint = runIntentFingerprint(intent);
  const payload = JSON.stringify({
    prompt: input.run.prompt,
    model: input.run.model,
    engine: input.run.engine,
    parentRunId: input.run.parentRunId,
    threadId: input.run.threadId,
    repos: input.run.repos,
    resolvedResources: input.run.resolvedResources ?? [],
    attachmentIds: input.run.attachmentIds ?? [],
    memoryScope: input.run.memoryScope,
    skillId: input.run.skillId,
    skillVersion: input.run.skillVersion,
    commandName: input.run.commandName,
    commandProvider: input.run.commandProvider,
    commandSessionId: input.run.commandSessionId,
    commandCatalogRevision: input.run.commandCatalogRevision,
    intent,
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
          if (existing) return classifyReplay(existing, fingerprint, origin);
        }

        // Shared transaction lock closes the preflight-vs-insert race: a deploy
        // close waits for already-accepting transactions, then every later new
        // acceptance observes the durable closed state.
        await assertRunAdmissionOpen(tx);

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
            origin,
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
      if (existing) return classifyReplay(existing, fingerprint, origin);
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

/** Public product acceptance. Origin is always null and is not caller-settable. */
export function acceptRunCommand(input: RunCommandInput): Promise<RunCommandOutcome> {
  return acceptRunCommandWithOrigin(input, null);
}

/** Server-only acceptance for trusted canaries and inherited internal children. */
export function acceptInternalRunCommand(
  input: RunCommandInput & { readonly origin: InternalRunOrigin },
): Promise<RunCommandOutcome> {
  assertInternalRunOrigin(input.origin);
  return acceptRunCommandWithOrigin(input, input.origin);
}
