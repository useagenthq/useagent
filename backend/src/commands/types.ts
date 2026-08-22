import type { EngineId, MemoryScope } from "../db/schema";
import type { RunResource } from "../resources/types";

// ---------------------------------------------------------------------------
// Boundary types for durable command acceptance (north star "Durable
// Commands"). Kept separate from persistence (repo.ts) and orchestration
// (service.ts) so the shapes a route/handler depends on carry no DB or Daytona
// coupling.
// ---------------------------------------------------------------------------

/** Stable, pre-resolution identity of a requested run. Provider lookups may add
 * checkout refs, revisions, capabilities, or provenance to the accepted run,
 * but none of that derived state changes what the user submitted. */
export interface RunCommandIntent {
  readonly prompt: string;
  /** Normalized caller-supplied selectors. Null means the caller delegated to
   * the server/parent default; later config changes must not alter a replay. */
  readonly model: string | null;
  readonly engine: EngineId | null;
  readonly parentRunId: string | null;
  /** Only repositories explicitly selected by the caller. Inherited and
   * resource-discovered repositories are derived acceptance state. */
  readonly requestedRepos: readonly string[];
  /** Stable identities from the ingress (upload IDs for HTTP, Slack file IDs
   * for Slack), not provider-generated staging metadata. */
  readonly attachmentIds: readonly string[];
  readonly memoryScope: MemoryScope | null;
  /** The requested skill pin. A null version means "current" was requested;
   * the resolved immutable version is persisted on the run separately. */
  readonly skillId: string | null;
  readonly skillVersion: number | null;
  readonly commandName: string | null;
  readonly commandProvider: string | null;
  readonly commandSessionId: string | null;
  readonly commandCatalogRevision: number | null;
}

/** The product intent behind a `run.create` command — exactly the fields that
 *  make two submissions the "same" turn for idempotency, plus the pre-allocated
 *  run identity. */
export interface RunCommandInput {
  /** From the `Idempotency-Key` header; null for the un-keyed path. */
  readonly idempotencyKey: string | null;
  readonly orgId: string;
  readonly actorId: string | null;
  /** Supplied by product ingresses so a keyed retry can be classified before
   * external resource resolution. Legacy/internal callers may omit it and use
   * the accepted run fields as their intent. */
  readonly intent?: RunCommandIntent;
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
     *  ref name, so the split is unambiguous). Product ingresses fingerprint
     *  the explicit pre-resolution selection separately; legacy/internal
     *  callers use this accepted list as their intent (see fingerprint.ts). */
    readonly repos: string[];
    /** Typed, authorized resources resolved before command acceptance. Omitted
     * by legacy callers and persisted as an empty list. */
    readonly resolvedResources?: readonly RunResource[];
    /** Pre-uploaded tenant/user-owned files atomically claimed by this run.
     * IDs, not browser-provided paths or bytes, participate in intent. */
    readonly attachmentIds?: readonly string[];
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
     *  provider, native session, and catalog snapshot revision it was authorized against. Null for
     *  a non-command run. PART of the idempotency fingerprint (D5) - two commands that differ only
     *  in provider/session/revision are distinct authorizations, so a keyed replay must not reuse
     *  the other run. */
    readonly commandProvider: string | null;
    readonly commandSessionId: string | null;
    readonly commandCatalogRevision: number | null;
  };
}

/** Why a keyed replay could not be honored as-is. Extend as new ambiguity modes
 *  appear; every consumer switches exhaustively. */
export type IdempotencyConflictReason = "payload_mismatch" | "origin_mismatch";

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
