import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { commands, type CommandState } from "../db/schema";
import { createRun } from "../runs/repo";
import type { RunCommandInput } from "./types";

// ---------------------------------------------------------------------------
// Command persistence — pure data access, no decisions. The service layer
// (service.ts) owns fingerprinting and conflict classification; this module
// only reads and writes rows.
// ---------------------------------------------------------------------------

/** The command's product kind. `run.create` enqueues a turn; `run.cancel` is the
 *  durable record of a user stop request (see commands/cancel.ts). */
export const RUN_CREATE = "run.create" as const;
export const RUN_CANCEL = "run.cancel" as const;

export type CommandRecord = typeof commands.$inferSelect;

/** Values needed to persist one accepted `run.create` command + its run. */
export interface NewRunCommand {
  readonly commandId: string;
  readonly idempotencyKey: string | null;
  readonly orgId: string;
  readonly actorId: string | null;
  readonly payloadFingerprint: string;
  readonly payload: string;
  readonly run: RunCommandInput["run"];
}

/** Look up a prior command by its per-tenant idempotency key. */
export async function findCommandByKey(
  orgId: string,
  key: string,
): Promise<CommandRecord | null> {
  const [row] = await db
    .select()
    .from(commands)
    .where(and(eq(commands.orgId, orgId), eq(commands.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

/**
 * Persist the command + its run in ONE transaction. North star "Transaction
 * Boundaries": command acceptance and canonical state mutation commit together,
 * and nothing is published before they commit (the worker is spawned by the
 * caller only after this resolves). The run is inserted first so the command's
 * `run_id` FK is satisfiable in-transaction. Throws on a unique-key violation —
 * the caller decides what a conflict means.
 */
export async function insertCommandWithRun(cmd: NewRunCommand): Promise<void> {
  await db.transaction(async (tx) => {
    await createRun(
      {
        id: cmd.run.id,
        prompt: cmd.run.prompt,
        model: cmd.run.model,
        engine: cmd.run.engine,
        orgId: cmd.orgId,
        userId: cmd.actorId,
        parentRunId: cmd.run.parentRunId,
        threadId: cmd.run.threadId,
        repos: cmd.run.repos,
        memoryScope: cmd.run.memoryScope,
        skillId: cmd.run.skillId,
        skillVersion: cmd.run.skillVersion,
        skillContentHash: cmd.run.skillContentHash,
        commandName: cmd.run.commandName,
      },
      tx,
    );
    await tx.insert(commands).values({
      id: cmd.commandId,
      idempotencyKey: cmd.idempotencyKey,
      orgId: cmd.orgId,
      actorId: cmd.actorId,
      kind: RUN_CREATE,
      runId: cmd.run.id,
      threadId: cmd.run.threadId,
      payloadFingerprint: cmd.payloadFingerprint,
      payload: cmd.payload,
      state: "queued" satisfies CommandState,
      attemptCount: 0,
    });
  });
}
