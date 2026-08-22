import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { commands, runs, type CommandState } from "../db/schema";
import { createRun } from "../runs/repo";
import type { RunCommandInput } from "./types";
import { claimUploadsForRun, UploadClaimError } from "../uploads/repo";

// ---------------------------------------------------------------------------
// Command persistence — pure data access, no decisions. The service layer
// (service.ts) owns fingerprinting and conflict classification; this module
// only reads and writes rows.
// ---------------------------------------------------------------------------

/** The command's product kind. `run.create` enqueues a turn; `run.cancel` is the
 *  durable record of a user stop request (see commands/cancel.ts). */
export const RUN_CREATE = "run.create" as const;
export const RUN_CANCEL = "run.cancel" as const;

export type CommandRecord = typeof commands.$inferSelect & {
  readonly runOrigin: string | null;
};

/** Values needed to persist one accepted `run.create` command + its run. */
export interface NewRunCommand {
  readonly commandId: string;
  readonly idempotencyKey: string | null;
  readonly orgId: string;
  readonly actorId: string | null;
  readonly payloadFingerprint: string;
  readonly payload: string;
  readonly run: RunCommandInput["run"];
  /** Exact server-owned internal origin (src/runs/origin.ts); null for a product
   *  run. Persisted so downstream policy reads the accepted authority and never
   *  derives trust from identifiers. */
  readonly origin: string | null;
}

/** Look up a prior command by its per-tenant idempotency key. */
export async function findCommandByKey(
  orgId: string,
  key: string,
  exec: Executor = db,
): Promise<CommandRecord | null> {
  const [row] = await exec
    .select({ command: commands, runOrigin: runs.origin })
    .from(commands)
    .innerJoin(runs, eq(commands.runId, runs.id))
    .where(and(eq(commands.orgId, orgId), eq(commands.idempotencyKey, key)))
    .limit(1);
  return row ? { ...row.command, runOrigin: row.runOrigin } : null;
}

/**
 * Persist the command + its run in ONE transaction. North star "Transaction
 * Boundaries": command acceptance and canonical state mutation commit together,
 * and nothing is published before they commit (the worker is spawned by the
 * caller only after this resolves). The run is inserted first so the command's
 * `run_id` FK is satisfiable in-transaction. Throws on a unique-key violation —
 * the caller decides what a conflict means.
 */
export async function insertCommandWithRun(
  cmd: NewRunCommand,
  exec: Executor = db,
): Promise<void> {
  const insert = async (tx: Executor): Promise<void> => {
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
        resolvedResources: cmd.run.resolvedResources,
        memoryScope: cmd.run.memoryScope,
        skillId: cmd.run.skillId,
        skillVersion: cmd.run.skillVersion,
        skillContentHash: cmd.run.skillContentHash,
        commandName: cmd.run.commandName,
        commandProvider: cmd.run.commandProvider,
        commandSessionId: cmd.run.commandSessionId,
        commandCatalogRevision: cmd.run.commandCatalogRevision,
        origin: cmd.origin,
      },
      tx,
    );
    const attachmentIds = cmd.run.attachmentIds ?? [];
    if (attachmentIds.length > 0) {
      if (!cmd.actorId) throw new UploadClaimError();
      await claimUploadsForRun(
        {
          ids: attachmentIds,
          orgId: cmd.orgId,
          userId: cmd.actorId,
          runId: cmd.run.id,
        },
        tx,
      );
    }
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
  };
  if (exec === db) await db.transaction(insert);
  else await insert(exec);
}
