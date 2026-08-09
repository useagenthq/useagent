import type { EngineId, MemoryScope } from "../db/schema";

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
    /** GitHub repos to work in, validated against GET /api/repos; empty = a bare
     *  workdir. Each entry is "owner/name" for the default branch, OR
     *  "owner/name:branch" when a branch was chosen - the optional ":branch"
     *  suffix is how a per-repo branch rides through the string[] without a schema
     *  change (see github/repo-ref.ts; ":" is invalid in both a repo ref and a git
     *  ref name, so the split is unambiguous). Part of the run's identity, branch
     *  included: a different branch is a different intent (see fingerprint.ts). */
    readonly repos: string[];
    /** Team-memory pool for the run — resolved at the boundary (explicit choice,
     *  parent inheritance, or the "org" default). Never taken from the sandbox. */
    readonly memoryScope: MemoryScope;
    /** Pinned skill revision reference for this run, or null. Part of the run's
     *  identity (the same prompt WITH a skill is a different turn). The content
     *  hash is stored for provenance but derives from (skillId, version). */
    readonly skillId: string | null;
    readonly skillVersion: number | null;
    readonly skillContentHash: string | null;
    /** Set ONLY for a VALIDATED native provider command turn (Phase 3): the command name,
     *  checked against the active session catalog at acceptance. Non-null => the prompt is the
     *  exact `/name args` bytes, delivered verbatim with no injected context. Part of the run's
     *  identity (a command turn differs from the same text as a normal prompt). */
    readonly commandName: string | null;
    /** The ACCEPTED command identity persisted with the run (fail-closed authorization): the
     *  provider, native session, and catalog snapshot revision it was authorized against. Null
     *  for a non-command run. Not part of the run fingerprint - identity is provenance, not intent
     *  (commandName already distinguishes a command turn). */
    readonly commandProvider: string | null;
    readonly commandSessionId: string | null;
    readonly commandCatalogRevision: number | null;
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
