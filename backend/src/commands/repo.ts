import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { commands, type EngineId } from "../db/schema";
import { createRun } from "../runs/repo";

// ---------------------------------------------------------------------------
// Durable command acceptance (north star "Durable Commands"). Stage-1 scope:
// the `run.create` command behind POST /api/runs. A run is created ONLY through
// this path so that a lost HTTP response, retried with the same Idempotency-Key,
// observes the original command instead of starting duplicate work.
// ---------------------------------------------------------------------------

const PAYLOAD_CAP = 8_192; // bounded audit copy of the accepted request

/** Bounded run-creation payload. Only the fields that make two requests the
 *  "same" turn — the raw prompt/model/engine/parent — feed the fingerprint. */
type RunPayload = {
  prompt: string;
  model: string;
  engine: EngineId;
  parentRunId: string | null;
  threadId: string;
};

/** Stable content hash of the semantic request fields. A replay whose payload
 *  matches is idempotent; a mismatch under the same key is an ambiguous reuse. */
function fingerprint(p: RunPayload): string {
  const canonical = JSON.stringify([p.prompt, p.model, p.engine, p.parentRunId]);
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}

/** postgres-js surfaces a unique-constraint violation as SQLSTATE 23505. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export type RunCommandInput = {
  /** From the `Idempotency-Key` header; null for the un-keyed path. */
  idempotencyKey: string | null;
  orgId: string;
  actorId: string | null;
  run: {
    id: string;
    prompt: string;
    model: string;
    engine: EngineId;
    parentRunId: string | null;
    threadId: string;
  };
};

export type RunCommandResult =
  /** New command + run committed; caller spawns the worker. */
  | { kind: "created"; runId: string; commandId: string }
  /** Same key + same payload — return the ORIGINAL run id, do NOT re-dispatch. */
  | { kind: "replayed"; runId: string }
  /** Same key, DIFFERENT payload — refuse to guess which the client meant. */
  | { kind: "conflict" };

async function findByKey(orgId: string, key: string) {
  const [row] = await db
    .select()
    .from(commands)
    .where(and(eq(commands.orgId, orgId), eq(commands.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

/** Accept a `run.create` command: persist the command + its run in ONE
 *  transaction, then hand the run id back so the caller can spawn + mark
 *  dispatched. Idempotent by (org, idempotencyKey). */
export async function acceptRunCommand(
  input: RunCommandInput,
): Promise<RunCommandResult> {
  const payload: RunPayload = {
    prompt: input.run.prompt,
    model: input.run.model,
    engine: input.run.engine,
    parentRunId: input.run.parentRunId,
    threadId: input.run.threadId,
  };
  const fp = fingerprint(payload);
  const payloadJson = JSON.stringify(payload).slice(0, PAYLOAD_CAP);
  const commandId = crypto.randomUUID();

  // Fast path: a keyed replay short-circuits before a doomed insert.
  if (input.idempotencyKey) {
    const existing = await findByKey(input.orgId, input.idempotencyKey);
    if (existing) {
      return existing.payloadFingerprint === fp
        ? { kind: "replayed", runId: existing.runId! }
        : { kind: "conflict" };
    }
  }

  try {
    await db.transaction(async (tx) => {
      // Run first so the command's run_id FK is satisfiable in-transaction.
      await createRun(
        {
          id: input.run.id,
          prompt: input.run.prompt,
          model: input.run.model,
          engine: input.run.engine,
          orgId: input.orgId,
          userId: input.actorId,
          parentRunId: input.run.parentRunId,
          threadId: input.run.threadId,
        },
        tx,
      );
      await tx.insert(commands).values({
        id: commandId,
        idempotencyKey: input.idempotencyKey,
        orgId: input.orgId,
        actorId: input.actorId,
        kind: "run.create",
        runId: input.run.id,
        threadId: input.run.threadId,
        payloadFingerprint: fp,
        payload: payloadJson,
        state: "queued",
        attemptCount: 0,
      });
    });
  } catch (err) {
    // A concurrent request with the same key won the unique index — the run we
    // tried to insert rolled back with the command. Return the winner's run id.
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const existing = await findByKey(input.orgId, input.idempotencyKey);
      if (existing) {
        return existing.payloadFingerprint === fp
          ? { kind: "replayed", runId: existing.runId! }
          : { kind: "conflict" };
      }
    }
    throw err;
  }

  return { kind: "created", runId: input.run.id, commandId };
}

/** Record that the run's worker was spawned. Best-effort audit metadata — the
 *  worker already owns the run; a failure here never blocks the response. */
export async function markCommandDispatched(commandId: string): Promise<void> {
  await db
    .update(commands)
    .set({ state: "dispatched", attemptCount: 1, updatedAt: new Date() })
    .where(eq(commands.id, commandId));
}
