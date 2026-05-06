import type { EngineId } from "../db/schema";

// ---------------------------------------------------------------------------
// Boundary types for durable command acceptance (north star "Durable
// Commands"). Kept separate from persistence (repo.ts) and orchestration
// (service.ts) so the shapes a route/handler depends on carry no DB or Daytona
// coupling.
// ---------------------------------------------------------------------------

/** The product intent behind a `run.create` command — exactly the fields that
 *  make two submissions the "same" turn for idempotency, plus the pre-allocated
 *  run identity. */
export interface RunCommandInput {
  /** From the `Idempotency-Key` header; null for the un-keyed path. */
  readonly idempotencyKey: string | null;
  readonly orgId: string;
  readonly actorId: string | null;
  readonly run: {
    readonly id: string;
    readonly prompt: string;
    readonly model: string;
    readonly engine: EngineId;
    readonly parentRunId: string | null;
    readonly threadId: string;
    /** GitHub repo "owner/name" to work in (validated against GET /api/repos),
     *  or null for a bare workdir. Part of the run's identity for idempotency. */
    readonly repo: string | null;
  };
}

/** Why a keyed replay could not be honored as-is. Extend as new ambiguity modes
 *  appear; every consumer switches exhaustively. */
export type IdempotencyConflictReason = "payload_mismatch";

/** Outcome of accepting a `run.create` command — a discriminated union so every
 *  caller handles create / replay / conflict explicitly. */
export type RunCommandOutcome =
  /** New command + run committed; the caller dispatches the worker. */
  | { readonly status: "created"; readonly runId: string; readonly commandId: string }
  /** Same key + same payload — the ORIGINAL run id; the caller must NOT
   *  re-dispatch (its worker already ran / is running). */
  | { readonly status: "replayed"; readonly runId: string }
  /** Same key, a different request — refuse to guess which the client meant. */
  | { readonly status: "conflict"; readonly reason: IdempotencyConflictReason };
