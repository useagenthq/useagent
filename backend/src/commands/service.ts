import { isUniqueViolation } from "../db/pg-errors";
import { runIntentFingerprint, runIntentFromAcceptedRun } from "./fingerprint";
import { findCommandByKey, insertCommandWithRun } from "./repo";
import type { CommandRecord } from "./repo";
import type { RunCommandInput, RunCommandIntent, RunCommandOutcome } from "./types";
import { publishRunLifecycleChange } from "../runs/org-signals";
import {
  assertInternalRunOrigin,
  assertUnattendedRunOrigin,
  isInternalRunOrigin,
  type InternalRunOrigin,
  type TrustedRunOrigin,
  type UnattendedRunOrigin,
} from "../runs/origin";
import { isModelAllowedForEngine, isPersistedModelAllowedForEngine } from "../runs/model-policy";
import { engineModelReadyForDispatch, persistedEngineModelReadyForDispatch } from "../runs/engine-readiness";
import { withThreadLifecycleLock } from "../runs/thread-lifecycle-lock";
import { assertRunAdmissionOpen } from "./admission";
import { assertRunPromptLimit } from "./prompt-policy";
import { and, desc, eq } from "drizzle-orm";
import { commands, runs } from "../db/schema";
import { db, type Executor } from "../db/client";

// ---------------------------------------------------------------------------
// Command acceptance orchestration (north star "Durable Commands"). Decides,
// idempotently, whether a submission is a fresh turn, a replay of an already-
// accepted one, or an ambiguous key reuse — and delegates all persistence to
// repo.ts.
// ---------------------------------------------------------------------------

/** Bounded audit copy of the accepted request. */
const PAYLOAD_CAP = 8_192;
const textEncoder = new TextEncoder();
type ConnectorRunSource = "slack";

function payloadBytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function serializeRunCommandPayload(
  input: RunCommandInput,
  intent: RunCommandIntent,
  fingerprint: string,
  source: ConnectorRunSource | null,
): string {
  const full = {
    source,
    botHandoff: input.botHandoff ?? null,
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
  };
  const serialized = JSON.stringify(full);
  if (payloadBytes(serialized) <= PAYLOAD_CAP) return serialized;

  const withoutDuplicatePrompt = JSON.stringify({
    ...full,
    intent: { ...intent, prompt: undefined },
    _audit: { omitted: ["intent.prompt"] },
  });
  if (payloadBytes(withoutDuplicatePrompt) <= PAYLOAD_CAP) return withoutDuplicatePrompt;

  const promptBytes = payloadBytes(input.run.prompt);
  return JSON.stringify({
    source,
    botHandoff: input.botHandoff ?? null,
    model: input.run.model,
    engine: input.run.engine,
    parentRunId: input.run.parentRunId,
    threadId: input.run.threadId,
    _audit: {
      omitted: ["prompt", "intent", "repos", "resolvedResources", "attachmentIds"],
      promptChars: input.run.prompt.length,
      promptBytes,
      promptSha256: new Bun.CryptoHasher("sha256").update(input.run.prompt).digest("hex"),
      intentFingerprint: fingerprint,
    },
  });
}

export class StaleThreadHeadError extends Error {
  readonly code = "stale_thread_head" as const;
}

/** Classify a keyed submission against an existing command: same fingerprint →
 *  idempotent replay of its run; different fingerprint → ambiguous reuse. */
function connectorSourceFromKey(key: string | null): ConnectorRunSource | null {
  return key?.startsWith("slack-event:") ? "slack" : null;
}

function storedCommandSource(existing: CommandRecord): ConnectorRunSource | null {
  try {
    const parsed = existing.payload
      ? JSON.parse(existing.payload) as { source?: unknown }
      : null;
    return parsed?.source === "slack" ? "slack" : null;
  } catch {
    return null;
  }
}

function classifyReplay(
  existing: CommandRecord,
  fingerprint: string,
  origin: TrustedRunOrigin | null,
  source: ConnectorRunSource | null,
): RunCommandOutcome {
  if (existing.runOrigin !== origin) {
    return { status: "conflict", reason: "origin_mismatch" };
  }
  if (existing.payloadFingerprint !== fingerprint || !existing.runId) {
    return { status: "conflict", reason: "payload_mismatch" };
  }
  const storedSource = storedCommandSource(existing);
  if (storedSource !== source) {
    // Historical source-null rows cannot be attributed safely: the old public
    // key collision path could mint the same Slack receipts. Leave them intact
    // and require a fresh Slack message instead of upgrading their authority.
    return { status: "conflict", reason: "source_mismatch" };
  }
  return { status: "replayed", runId: existing.runId };
}

function acceptedFingerprint(
  intent: RunCommandIntent,
  threadRelationship?: RunCommandInput["threadRelationship"],
): string {
  const base = runIntentFingerprint(intent);
  if (!threadRelationship) return base;
  return new Bun.CryptoHasher("sha256").update(JSON.stringify([
    base,
    threadRelationship.parentThreadId,
    threadRelationship.familyThreadId,
    threadRelationship.kind,
    threadRelationship.title,
    threadRelationship.sourceRunId,
    threadRelationship.sourceExecutionId ?? null,
  ])).digest("hex");
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
  readonly origin: TrustedRunOrigin | null;
  readonly source: ConnectorRunSource | null;
  readonly threadRelationship?: RunCommandInput["threadRelationship"];
}): Promise<RunCommandOutcome | null> {
  if (input.idempotencyKey) {
    const existing = await findCommandByKey(input.orgId, input.idempotencyKey);
    if (existing) {
      return classifyReplay(
        existing,
        acceptedFingerprint(input.intent, input.threadRelationship),
        input.origin,
        input.source,
      );
    }
  }
  await assertRunAdmissionOpen();
  return null;
}

export function preflightRunCommandReplay(input: {
  readonly orgId: string;
  readonly idempotencyKey: string | null;
  readonly intent: RunCommandIntent;
  readonly threadRelationship?: RunCommandInput["threadRelationship"];
}): Promise<RunCommandOutcome | null> {
  if (connectorSourceFromKey(input.idempotencyKey)) {
    return Promise.resolve({ status: "conflict", reason: "source_mismatch" });
  }
  return preflightRunCommandReplayWithOrigin({ ...input, origin: null, source: null });
}

export function preflightConnectorRunCommandReplay(
  input: Parameters<typeof preflightRunCommandReplay>[0] & { readonly source: ConnectorRunSource },
): Promise<RunCommandOutcome | null> {
  return preflightRunCommandReplayWithOrigin({ ...input, origin: null });
}

export function preflightInternalRunCommandReplay(input: {
  readonly orgId: string;
  readonly idempotencyKey: string | null;
  readonly intent: RunCommandIntent;
  readonly origin: InternalRunOrigin;
  readonly threadRelationship?: RunCommandInput["threadRelationship"];
}): Promise<RunCommandOutcome | null> {
  assertInternalRunOrigin(input.origin);
  return preflightRunCommandReplayWithOrigin({ ...input, source: null });
}

export function preflightUnattendedRunCommandReplay(input: {
  readonly orgId: string;
  readonly idempotencyKey: string | null;
  readonly intent: RunCommandIntent;
  readonly origin: UnattendedRunOrigin;
  readonly threadRelationship?: RunCommandInput["threadRelationship"];
}): Promise<RunCommandOutcome | null> {
  assertUnattendedRunOrigin(input.origin);
  return preflightRunCommandReplayWithOrigin({ ...input, source: null });
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
  origin: TrustedRunOrigin | null,
  priority = 0,
  source: ConnectorRunSource | null = null,
): Promise<RunCommandOutcome> {
  const intent = input.intent ?? runIntentFromAcceptedRun(input.run);
  const fingerprint = acceptedFingerprint(intent, input.threadRelationship);
  const payload = serializeRunCommandPayload(input, intent, fingerprint, source);
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
          if (existing) return classifyReplay(existing, fingerprint, origin, source);
        }
        if (input.expectedThreadHeadRunId) {
          const [head] = await tx.select({ id: runs.id }).from(runs).where(and(
            eq(runs.orgId, input.orgId),
            eq(runs.threadId, input.run.threadId),
          )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
          if (head?.id !== input.expectedThreadHeadRunId) throw new StaleThreadHeadError();
        }

        // Shared transaction lock closes the preflight-vs-insert race: a deploy
        // close waits for already-accepting transactions, then every later new
        // acceptance observes the durable closed state.
        await assertRunAdmissionOpen(tx);
        assertRunPromptLimit(intent.prompt);
        assertRunPromptLimit(input.run.prompt);

        // Readiness applies only when accepting NEW work. A matching keyed
        // replay is a read of an already-durable decision and must keep
        // returning the original run even if policy or provider health later
        // changes.
        const persistedPolicy = input.acceptedModelPolicy === "persisted";
        const modelAllowed = persistedPolicy
          ? isPersistedModelAllowedForEngine(input.run.engine, input.run.model)
          : isModelAllowedForEngine(input.run.engine, input.run.model);
        if (!modelAllowed) {
          throw new Error(
            `model ${input.run.model} is not allowed for engine ${input.run.engine}`,
          );
        }
        const dispatchReady = persistedPolicy
          ? persistedEngineModelReadyForDispatch(input.run.engine, input.run.model)
          : engineModelReadyForDispatch(input.run.engine, input.run.model);
        if (!dispatchReady) {
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
            priority,
            threadRelationship: input.threadRelationship,
            botHome: input.botHome,
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
      if (existing) return classifyReplay(existing, fingerprint, origin, source);
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
  if (!isInternalRunOrigin(origin)) {
    publishRunLifecycleChange({
      orgId: input.orgId,
      threadId: input.run.threadId,
      runId: input.run.id,
      kind: "created",
    });
  }

  return { status: "created", runId: input.run.id, commandId };
}

/** Public product acceptance. Origin is always null and is not caller-settable. */
export function acceptRunCommand(input: RunCommandInput): Promise<RunCommandOutcome> {
  if (connectorSourceFromKey(input.idempotencyKey)) {
    return Promise.resolve({ status: "conflict", reason: "source_mismatch" });
  }
  return acceptRunCommandWithOrigin(input, null, 0);
}

export function acceptConnectorRunCommand(
  input: RunCommandInput & { readonly source: ConnectorRunSource },
): Promise<RunCommandOutcome> {
  const { source, ...command } = input;
  if (connectorSourceFromKey(command.idempotencyKey) !== source) {
    return Promise.resolve({ status: "conflict", reason: "source_mismatch" });
  }
  return acceptRunCommandWithOrigin(command, null, 0, source);
}

/** Server-only acceptance for trusted canaries and inherited internal children. */
export function acceptInternalRunCommand(
  input: RunCommandInput & {
    readonly origin: InternalRunOrigin;
    readonly priority?: number;
  },
): Promise<RunCommandOutcome> {
  assertInternalRunOrigin(input.origin);
  return acceptRunCommandWithOrigin(input, input.origin, input.priority ?? 0);
}

/** Server-only product acceptance for unattended automations and bot work. */
export function acceptUnattendedRunCommand(
  input: RunCommandInput & {
    readonly origin: UnattendedRunOrigin;
  },
): Promise<RunCommandOutcome> {
  assertUnattendedRunOrigin(input.origin);
  return acceptRunCommandWithOrigin(input, input.origin, 0);
}
