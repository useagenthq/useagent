import { isUniqueViolation } from "../db/pg-errors";
import { runIntentFingerprint, runIntentFromAcceptedRun } from "./fingerprint";
import { findCommandByKey, insertCommandWithRun } from "./repo";
import type { CommandRecord } from "./repo";
import { getLatestThreadRun } from "../runs/repo";
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
import { modelOfferedToUser } from "../provider-gateway/provider-accounts";
import { dispatchReadyForUser } from "../engines/sandbox-login";
import { withThreadLifecycleLock } from "../runs/thread-lifecycle-lock";
import { assertRunAdmissionOpen } from "./admission";
import { assertSpendAllowance, SpendAllowanceExceededError } from "../runs/spend";
import { assertSandboxMinutes, SandboxMinutesExceededError } from "../runs/sandbox-minutes";
import { assertRunPromptLimit } from "./prompt-policy";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { commands, runs } from "../db/schema";
import { db, type Executor } from "../db/client";
import {
  ExpectedSandboxMismatchError,
  type ExpectedSandboxBinding,
} from "../sandboxes/expected-binding";

export { ExpectedSandboxMismatchError };

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

/** The bounded audit copy every accepted run command stores. Always valid JSON:
 * an oversized request drops the duplicate intent prompt first, then keeps only
 * identifiers plus the prompt's size and hash. */
export function serializeRunCommandPayload(
  input: RunCommandInput,
  intent: RunCommandIntent,
  fingerprint: string,
  source: ConnectorRunSource | null,
): string {
  const auditIntent = { ...intent, expectedSandbox: undefined };
  const full = {
    source,
    botHandoff: input.botHandoff ?? null,
    prompt: input.run.prompt,
    model: input.run.model,
    reasoningEffort: input.run.reasoningEffort ?? null,
    engine: input.run.engine,
    parentRunId: input.run.parentRunId,
    threadId: input.run.threadId,
    repos: input.run.repos,
    resolvedResources: input.run.resolvedResources ?? [],
    attachmentIds: input.run.attachmentIds ?? [],
    memoryScope: input.run.memoryScope,
    permissionMode: input.run.permissionMode ?? null,
    runLocation: input.run.runLocation ?? null,
    skillId: input.run.skillId,
    skillVersion: input.run.skillVersion,
    commandName: input.run.commandName,
    commandProvider: input.run.commandProvider,
    commandSessionId: input.run.commandSessionId,
    commandCatalogRevision: input.run.commandCatalogRevision,
    intent: auditIntent,
  };
  const serialized = JSON.stringify(full);
  if (payloadBytes(serialized) <= PAYLOAD_CAP) return serialized;

  const withoutDuplicatePrompt = JSON.stringify({
    ...full,
    intent: { ...auditIntent, prompt: undefined },
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

function sameExpectedSandbox(
  left: ExpectedSandboxBinding | null | undefined,
  right: ExpectedSandboxBinding | null | undefined,
): boolean {
  if (!left || !right) return left == null && right == null;
  return left.version === right.version &&
    left.sandboxId === right.sandboxId &&
    left.provider === right.provider &&
    left.credential === right.credential &&
    left.ownerOrgId === right.ownerOrgId &&
    left.ownerUserId === right.ownerUserId &&
    left.credentialGeneration === right.credentialGeneration;
}

async function assertExpectedSandboxMapping(
  input: RunCommandInput,
  expected: ExpectedSandboxBinding,
  tx: Executor,
): Promise<void> {
  if (expected.ownerOrgId !== input.orgId || !input.run.parentRunId) {
    throw new ExpectedSandboxMismatchError();
  }
  const [parent] = await tx.select({ id: runs.id, origin: runs.origin }).from(runs).where(and(
    eq(runs.id, input.run.parentRunId),
    eq(runs.orgId, input.orgId),
    eq(runs.threadId, input.run.threadId),
  )).limit(1);
  if (!parent || !isInternalRunOrigin(parent.origin)) {
    throw new ExpectedSandboxMismatchError();
  }

  const [mapping] = await tx.select({
    sandboxId: runs.sandboxId,
    sandboxProvider: runs.sandboxProvider,
    sandboxCredential: runs.sandboxCredential,
    expectedSandbox: runs.expectedSandbox,
  }).from(runs).where(and(
    eq(runs.orgId, input.orgId),
    eq(runs.threadId, input.run.threadId),
    isNotNull(runs.sandboxId),
  )).orderBy(desc(runs.threadSeq), desc(runs.createdAt), desc(runs.id)).limit(1);
  if (
    !mapping ||
    mapping.sandboxId !== expected.sandboxId ||
    mapping.sandboxProvider !== expected.provider ||
    mapping.sandboxCredential !== expected.credential ||
    (mapping.expectedSandbox && !sameExpectedSandbox(mapping.expectedSandbox, expected))
  ) {
    throw new ExpectedSandboxMismatchError();
  }

  if (expected.credential === "user") {
    const [owner] = await tx.select({ userId: runs.userId }).from(runs).where(and(
      eq(runs.orgId, input.orgId),
      eq(runs.sandboxId, expected.sandboxId),
      eq(runs.sandboxProvider, expected.provider),
      eq(runs.sandboxCredential, expected.credential),
    )).orderBy(asc(runs.createdAt), asc(runs.id)).limit(1);
    if (owner?.userId !== expected.ownerUserId) {
      throw new ExpectedSandboxMismatchError();
    }
  }
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
  const expectedSandbox = input.expectedSandbox ?? null;
  const intent = input.intent ?? {
    ...runIntentFromAcceptedRun(input.run),
    ...(expectedSandbox ? { expectedSandbox } : {}),
  };
  if (!sameExpectedSandbox(intent.expectedSandbox, expectedSandbox)) {
    throw new ExpectedSandboxMismatchError();
  }
  const fingerprint = acceptedFingerprint(intent, input.threadRelationship);
  const payload = serializeRunCommandPayload(input, intent, fingerprint, source);
  const commandId = crypto.randomUUID();
  // Read before the thread lock: a pool read made while a transaction holds its
  // connection can starve the pool. False only for a provider PROVIDER_ACCOUNTS
  // withholds from this actor, which is then refused like any unknown model.
  const modelOffered = await modelOfferedToUser(input.run.engine, input.run.model, input.actorId);

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
          )).orderBy(desc(runs.threadSeq), desc(runs.createdAt), desc(runs.id)).limit(1);
          if (head?.id !== input.expectedThreadHeadRunId) throw new StaleThreadHeadError();
        }
        if (expectedSandbox) await assertExpectedSandboxMapping(input, expectedSandbox, tx);

        // Shared transaction lock closes the preflight-vs-insert race: a deploy
        // close waits for already-accepting transactions, then every later new
        // acceptance observes the durable closed state.
        await assertRunAdmissionOpen(tx);
        // The spend cap is checked here, on NEW work only (a keyed replay above
        // still returns its original run), as a lock-free read of the committed
        // figure so this transaction takes no lock that could close a cycle.
        await assertSpendAllowance(input.orgId, input.actorId, tx);
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
        if (!modelAllowed || !modelOffered) {
          throw new Error(
            `model ${input.run.model} is not allowed for engine ${input.run.engine}`,
          );
        }
        // Where the thread runs: a root run's choice, or the thread's for a reply
        // that carries none, resolved once here for the login readiness below and
        // for the row itself.
        const runLocation = input.run.runLocation ?? (input.run.parentRunId
          ? (await getLatestThreadRun(input.orgId, input.run.threadId, tx))?.runLocation ?? null
          : null);
        // Sandbox minutes are checked here, on NEW work only (a keyed replay
        // above still returns its original run), as a lock-free read of the
        // committed ledger, once it is known where the turn runs. A chat turn
        // holds no sandbox and passes.
        if (input.run.engine !== "chat") {
          await assertSandboxMinutes(input.orgId, input.actorId, tx, { threadId: input.run.threadId, runLocation });
        }
        const dispatchReady = await dispatchReadyForUser(
          { orgId: input.orgId, userId: input.actorId, runLocation },
          input.run.engine,
          input.run.model,
          persistedPolicy ? "persisted" : "accepted",
        );
        if (!dispatchReady) {
          throw new Error(
            `engine/model not ready: ${input.run.engine}/${input.run.model}`,
          );
        }

        await insertCommandWithRun(
          {
            commandId,
            botHandoff: input.botHandoff,
            idempotencyKey: input.idempotencyKey,
            orgId: input.orgId,
            actorId: input.actorId,
            payloadFingerprint: fingerprint,
            payload,
            run: { ...input.run, runLocation },
            expectedSandbox,
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
    // winner only AFTER withThreadLifecycleLock rolls it back. The same applies
    // to a spend or minutes refusal: a keyed retry that read the fast path
    // before its winner committed, then met a cap, still replays the committed winner.
    if (
      input.idempotencyKey &&
      (isUniqueViolation(err) || err instanceof SpendAllowanceExceededError || err instanceof SandboxMinutesExceededError)
    ) {
      const replay = await replayCommittedWinner(input.orgId, input.idempotencyKey, fingerprint, origin, source);
      if (replay) return replay;
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

/** After a lost race or a refusal: the committed keyed winner, if any, still
 *  answers for this submission exactly as the fast path would have. */
export async function replayCommittedWinner(
  orgId: string,
  idempotencyKey: string,
  fingerprint: string,
  origin: TrustedRunOrigin | null,
  source: ConnectorRunSource | null,
): Promise<RunCommandOutcome | null> {
  const existing = await findCommandByKey(orgId, idempotencyKey);
  return existing ? classifyReplay(existing, fingerprint, origin, source) : null;
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
