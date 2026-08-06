import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { runs, type MemoryScope } from "../../db/schema";
import { recordProviderEvent } from "../../runs/provider-events";
import { resolveScopedMemory, type ScopedMemoryPlan } from "../../memory/scope";
import {
  addExplicitMemoryL0,
  deleteExplicitL0,
  deleteScopedMemory,
  recallScopedMemory,
  searchExplicitL0,
  updateScopedMemory,
} from "../../memory/team-memory";
import {
  EXPLICIT_MEMORY_KINDS,
  formatEnvelope,
  parseEnvelope,
  type ExplicitMemoryKind,
} from "../../memory/explicit-memory";
import type { ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";

// ---------------------------------------------------------------------------
// Agent-callable MEMORY tools on the SAME trusted gateway as knowledge
// (new_mem_prompt.md sections 5-7). Tencent is the memory authority; these tools
// are the ONLY way an engine mutates/reads it, and they resolve org/user/scope
// SERVER-SIDE from the run — never from a tool argument (section 5.1 trust
// boundary). Identity forbidden as an argument: orgId/userId/teamId/agentId/
// memoryScope/pool ids. A resumed thread may change its scope selector between
// turns, so we always load the run's CURRENT persisted memory_scope, not one
// baked into a warm token.
// ---------------------------------------------------------------------------

const SEARCH_DEFAULT_LIMIT = 6;
const SEARCH_MAX_LIMIT = 12;
const CONTENT_MAX = 2000;

/** Canonical memory event types (section 8 UI/replay). Reused by tests + UI. */
export const MEMORY_EVENTS = {
  searched: "memory.searched",
  l0Accepted: "memory.l0_accepted",
  l1Indexed: "memory.l1_indexed",
  updated: "memory.updated",
  deleted: "memory.deleted",
  failed: "memory.failed",
} as const;

export const MEMORY_TOOLS = [
  {
    name: "memory_remember",
    description:
      "Persist a durable fact about THIS user/organization into Skynet team memory " +
      "(backed by TencentDB Agent Memory). Use for stable preferences, where things " +
      "live, and gotchas worth recalling next session. Writes synchronously and only " +
      "reports success once the memory provider acknowledges it. Never store secrets, " +
      "tokens, or PII. Scope (personal vs organization) is decided by the run, not by you.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact to remember, one clear sentence." },
        kind: {
          type: "string",
          enum: [...EXPLICIT_MEMORY_KINDS],
          description: "preference | fact | note (defaults to note).",
        },
        key: {
          type: "string",
          description: "Optional stable key (e.g. 'favourite_color') so a later correction can supersede this.",
        },
        idempotencyKey: {
          type: "string",
          description: "Optional stable id to make a retried write not duplicate the memory.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description:
      "Search this user/organization's team memory (Tencent L0 ground evidence + L1 " +
      "distilled facts, merged) for relevant facts. Returns bounded, provider-cited " +
      "results with stable refs (tencent:l0:<id> / tencent:l1:<id>). Use whenever a " +
      "task references something you should already know about the user.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query." },
        limit: {
          type: "integer",
          description: `Max results (1-${SEARCH_MAX_LIMIT}, default ${SEARCH_DEFAULT_LIMIT}).`,
          minimum: 1,
          maximum: SEARCH_MAX_LIMIT,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_read",
    description:
      "Read one memory by its stable ref from a memory_search result " +
      "(tencent:l1:<id>). Returns the full bounded content. L0 results are already " +
      "returned in full by memory_search.",
    inputSchema: {
      type: "object",
      properties: {
        memoryRef: { type: "string", description: "A ref from memory_search (e.g. tencent:l1:<id>)." },
      },
      required: ["memoryRef"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_correct",
    description:
      "Correct a remembered fact identified by a ref from memory_search. Writes the " +
      "corrected content and supersedes the old record. Use when a stored memory is " +
      "wrong or out of date.",
    inputSchema: {
      type: "object",
      properties: {
        memoryRef: { type: "string", description: "A ref from memory_search (tencent:l0:<id> / tencent:l1:<id>)." },
        content: { type: "string", description: "The corrected fact, one clear sentence." },
        idempotencyKey: { type: "string", description: "Optional stable id so a retried correction does not duplicate." },
      },
      required: ["memoryRef", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    description:
      "Forget a remembered fact identified by a ref from memory_search. Reports " +
      "honestly whether the provider removed it. Use only when a memory should no " +
      "longer influence future sessions.",
    inputSchema: {
      type: "object",
      properties: {
        memoryRef: { type: "string", description: "A ref from memory_search (tencent:l0:<id> / tencent:l1:<id>)." },
        idempotencyKey: { type: "string", description: "Optional stable id so a retried forget is safe." },
      },
      required: ["memoryRef"],
      additionalProperties: false,
    },
  },
] as const;

export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(MEMORY_TOOLS.map((t) => t.name));

// ── identity + scope resolution (server-trusted) ─────────────────────────────

interface ActiveRun {
  id: string;
  threadId: string;
  orgId: string | null;
  userId: string | null;
  memoryScope: MemoryScope;
}

/**
 * Resolve the run a memory op acts for: the thread's CURRENTLY-running run (the
 * agent's live turn), else the token's mint run. The resolved run MUST stay
 * within the token's org + thread (section 5.1 step 4) — otherwise fail closed.
 * Its persisted memory_scope is authoritative, so a resumed thread that changed
 * scope between turns is honored (section 5.1: not the warm token's older scope).
 */
async function resolveActiveRun(claims: ToolTokenClaims): Promise<ActiveRun | null> {
  const cols = {
    id: runs.id,
    threadId: runs.threadId,
    orgId: runs.orgId,
    userId: runs.userId,
    memoryScope: runs.memoryScope,
  };
  const [running] = await db
    .select(cols)
    .from(runs)
    .where(and(eq(runs.threadId, claims.threadId), eq(runs.status, "running")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  const row = running ?? (await db.select(cols).from(runs).where(eq(runs.id, claims.runId)).limit(1))[0];
  if (!row) return null;
  // Trust boundary: never act outside the token's org/thread.
  if (row.orgId !== claims.orgId || row.threadId !== claims.threadId) return null;
  return row;
}

function textResult(text: string, structured?: Record<string, unknown>, isError = false): ToolCallResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError } : {}) };
}

/** Emit a truthful memory event on the run's native lane (section 8). Attributed
 *  to the resolved run; fire-and-forget so it never fails the tool. */
function recordMemoryEvent(
  run: ActiveRun,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  void recordProviderEvent({
    id: `mem_${run.id}_${randomUUID().slice(0, 8)}`,
    runId: run.id,
    threadId: run.threadId,
    provider: "skynet-memory",
    eventType,
    payload,
  }).catch(() => {});
}

// ── tool implementations ─────────────────────────────────────────────────────

function validKind(v: unknown): ExplicitMemoryKind | null {
  return typeof v === "string" && (EXPLICIT_MEMORY_KINDS as readonly string[]).includes(v)
    ? (v as ExplicitMemoryKind)
    : null;
}

async function doRemember(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const content = (typeof args.content === "string" ? args.content : "").trim().slice(0, CONTENT_MAX);
  if (!content) return textResult("memory_remember requires non-empty `content`.", undefined, true);

  const run = await resolveActiveRun(claims);
  if (!run) return textResult("Memory unavailable: no active run to scope this write.", undefined, true);
  const plan: ScopedMemoryPlan | null = resolveScopedMemory(run);
  if (!plan) return textResult("Memory is not configured for this deployment.", undefined, true);
  if (!plan.writePool) {
    // personal scope with no authenticated user → fail closed (section 3).
    recordMemoryEvent(run, MEMORY_EVENTS.failed, { op: "remember", reason: "fail_closed", scope: plan.scope });
    return textResult("Cannot remember: a personal memory needs an authenticated user.", undefined, true);
  }

  const kind = validKind(args.kind) ?? "note";
  const key = typeof args.key === "string" && args.key.trim() ? args.key.trim().slice(0, 120) : undefined;
  const operationId = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
    ? args.idempotencyKey.trim().slice(0, 120)
    : `op-${randomUUID()}`;
  const wp = plan.writePool;

  // Idempotency (section 6.1): if this operationId already landed, reconcile
  // instead of duplicating. Search L0 for the stable marker.
  const prior = await searchExplicitL0(operationId, wp.identity, { limit: 5 });
  const existing = prior.find((m) => parseEnvelope(m.content)?.operationId === operationId);
  let acceptedIds: string[];
  let reconciled = false;
  if (existing) {
    acceptedIds = [existing.id];
    reconciled = true;
  } else {
    const envelope = formatEnvelope({
      // A keyed memory shares a logical id across corrections; else a fresh one.
      logicalId: key ? `key:${wp.identity.userId}:${key}` : randomUUID(),
      operationId,
      version: 1,
      kind,
      ...(key ? { key } : {}),
      state: "active",
      content,
    });
    const receipt = await addExplicitMemoryL0(wp.identity, envelope);
    if (!receipt) {
      recordMemoryEvent(run, MEMORY_EVENTS.failed, { op: "remember", scope: plan.scope, operationId });
      return textResult(
        "Memory provider did not acknowledge the write - it was NOT saved. Try again shortly.",
        { saved: false, scope: plan.scope, operationId },
        true,
      );
    }
    acceptedIds = receipt.acceptedIds;
  }

  const refs = acceptedIds.map((id) => `tencent:l0:${id}`);
  recordMemoryEvent(run, MEMORY_EVENTS.l0Accepted, {
    op: "remember",
    scope: plan.scope,
    reconciled,
    operationId,
    refs,
    content,
  });
  const where = plan.scope === "org" ? "organization" : "personal";
  return textResult(
    `Remembered in ${where} memory${reconciled ? " (already recorded)" : ""}. Ref: ${refs[0]}. ` +
      "It is searchable now; a distilled version may take a few minutes to index.",
    { saved: true, scope: plan.scope, layer: "l0", refs, operationId, reconciled },
  );
}

async function doSearch(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const query = (typeof args.query === "string" ? args.query : "").trim();
  if (!query) return textResult("memory_search requires a non-empty `query`.", undefined, true);
  const rawLimit = typeof args.limit === "number" ? Math.floor(args.limit) : SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, SEARCH_MAX_LIMIT));

  const run = await resolveActiveRun(claims);
  if (!run) return textResult("Memory unavailable: no active run to scope this search.", undefined, true);
  const plan = resolveScopedMemory(run);
  if (!plan) return textResult("Memory is not configured for this deployment.", undefined, true);
  if (plan.readPools.length === 0) {
    return textResult("No personal memory is available without an authenticated user.", { items: [] });
  }

  const recall = await recallScopedMemory(query, plan.readPools, { limit });
  recordMemoryEvent(run, MEMORY_EVENTS.searched, {
    query,
    scope: plan.scope,
    itemCount: recall.items.length,
    latencyMs: recall.latencyMs,
    refs: recall.items.map((i) => i.citation.ref).filter(Boolean),
  });

  if (recall.items.length === 0) {
    return textResult(`No memory found for "${query}".`, { items: [] });
  }
  const text = recall.items
    .map((i) => `[${i.citation.ref}] (${i.sourceScope}/${i.citation.layer}) ${i.content}`)
    .join("\n");
  return textResult(text, {
    items: recall.items.map((i) => ({
      content: i.content,
      scope: i.sourceScope,
      layer: i.citation.layer,
      ref: i.citation.ref,
      score: i.citation.score,
    })),
  });
}

async function doRead(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const ref = (typeof args.memoryRef === "string" ? args.memoryRef : "").trim();
  const m = /^tencent:(l0|l1):(.+)$/.exec(ref);
  if (!m) return textResult("memory_read needs a ref like tencent:l1:<id> from memory_search.", undefined, true);
  const [, layer, id] = m as unknown as [string, "l0" | "l1", string];

  const run = await resolveActiveRun(claims);
  if (!run) return textResult("Memory unavailable: no active run to scope this read.", undefined, true);
  const plan = resolveScopedMemory(run);
  if (!plan || plan.readPools.length === 0) return textResult("Memory is not available for this run.", undefined, true);

  // L0 messages are already returned in full by memory_search; there is no
  // provider get-by-id for them on this build. L1 facts are looked up by scanning
  // the pool (bounded) for the id — read stays within the run's read pools.
  if (layer === "l0") {
    return textResult(
      "L0 memories are returned in full by memory_search; there is nothing extra to read for an L0 ref.",
      { ref, layer },
    );
  }
  // /v3/atomic/query rejects limit > 50 (400), so page-bound the browse lookup.
  const { browseScopedMemory } = await import("../../memory/team-memory");
  const browse = await browseScopedMemory(plan.readPools, { limit: 50 });
  const found = browse.items.find((i) => i.id === id);
  if (!found) {
    return textResult(`No memory ${ref} is available to this run.`, undefined, true);
  }
  return textResult(`${found.content}${found.background ? `\n(${found.background})` : ""}`, {
    ref,
    layer,
    scope: found.sourceScope,
    content: found.content,
  });
}

function isOrgPool(userId: string): boolean {
  return userId.startsWith("org:");
}
function scopeWord(scope: MemoryScope): string {
  return scope === "org" ? "organization" : "personal";
}
function optKey(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined;
}
function parseRef(ref: string): { layer: "l0" | "l1"; id: string } | null {
  const m = /^tencent:(l0|l1):(.+)$/.exec(ref.trim());
  return m ? { layer: m[1] as "l0" | "l1", id: m[2]! } : null;
}

async function doCorrect(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const parsed = parseRef(typeof args.memoryRef === "string" ? args.memoryRef : "");
  const content = (typeof args.content === "string" ? args.content : "").trim().slice(0, CONTENT_MAX);
  if (!parsed || !content) return textResult("memory_correct needs a memoryRef and corrected `content`.", undefined, true);

  const run = await resolveActiveRun(claims);
  if (!run) return textResult("Memory unavailable: no active run to scope this correction.", undefined, true);
  const plan = resolveScopedMemory(run);
  if (!plan?.writePool) return textResult("Cannot correct memory: no writable pool for this run.", undefined, true);
  const wp = plan.writePool;
  const operationId = optKey(args.idempotencyKey) ?? `op-${randomUUID()}`;

  // Personal L1 refs correct cleanly via atomic/update. Org L1 refs 403 on
  // atomic/update (upstream ownership-check inconsistency for colon-namespaced
  // pools), and L0 refs have no update endpoint - both take the 6.3
  // replace-then-delete path (write the corrected fact, best-effort remove the old).
  if (parsed.layer === "l1" && !isOrgPool(wp.identity.userId)) {
    const ok = await updateScopedMemory(wp.identity, parsed.id, content);
    recordMemoryEvent(run, ok ? MEMORY_EVENTS.updated : MEMORY_EVENTS.failed, {
      op: "correct", ref: `tencent:l1:${parsed.id}`, scope: plan.scope,
    });
    return ok
      ? textResult(`Corrected in ${scopeWord(plan.scope)} memory.`, { ref: `tencent:l1:${parsed.id}`, scope: plan.scope })
      : textResult("The memory provider did not accept the correction.", { saved: false }, true);
  }

  const envelope = formatEnvelope({ logicalId: randomUUID(), operationId, version: 1, kind: "fact", state: "active", content });
  const receipt = await addExplicitMemoryL0(wp.identity, envelope);
  if (!receipt) {
    recordMemoryEvent(run, MEMORY_EVENTS.failed, { op: "correct", ref: `tencent:${parsed.layer}:${parsed.id}`, scope: plan.scope });
    return textResult("The memory provider did not accept the correction - nothing changed.", { saved: false }, true);
  }
  const removed = parsed.layer === "l1"
    ? await deleteScopedMemory(wp.identity, [parsed.id])
    : await deleteExplicitL0(wp.identity, [parsed.id]);
  const newRef = `tencent:l0:${receipt.acceptedIds[0]}`;
  recordMemoryEvent(run, MEMORY_EVENTS.updated, {
    op: "correct", oldRef: `tencent:${parsed.layer}:${parsed.id}`, newRef, removed, scope: plan.scope,
  });
  const note = removed > 0
    ? "The prior record was removed."
    : "The prior record could not be hard-removed on this provider build and is superseded by the new one.";
  return textResult(`Corrected in ${scopeWord(plan.scope)} memory. New ref: ${newRef}. ${note}`, {
    ref: newRef, oldRef: `tencent:${parsed.layer}:${parsed.id}`, removed, scope: plan.scope,
  });
}

async function doForget(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const parsed = parseRef(typeof args.memoryRef === "string" ? args.memoryRef : "");
  if (!parsed) return textResult("memory_forget needs a memoryRef from memory_search.", undefined, true);

  const run = await resolveActiveRun(claims);
  if (!run) return textResult("Memory unavailable: no active run to scope this.", undefined, true);
  const plan = resolveScopedMemory(run);
  if (!plan?.writePool) return textResult("Cannot forget memory: no writable pool for this run.", undefined, true);
  const wp = plan.writePool;

  const removed = parsed.layer === "l1"
    ? await deleteScopedMemory(wp.identity, [parsed.id])
    : await deleteExplicitL0(wp.identity, [parsed.id]);
  if (removed > 0) {
    recordMemoryEvent(run, MEMORY_EVENTS.deleted, { op: "forget", ref: `tencent:${parsed.layer}:${parsed.id}`, removed, scope: plan.scope });
    return textResult(`Forgot the memory from ${scopeWord(plan.scope)} memory.`, { ref: `tencent:${parsed.layer}:${parsed.id}`, removed, scope: plan.scope });
  }
  // Honest partial: nothing removed. Never claim a clean deletion.
  recordMemoryEvent(run, MEMORY_EVENTS.failed, { op: "forget", ref: `tencent:${parsed.layer}:${parsed.id}`, removed: 0, scope: plan.scope });
  const why = parsed.layer === "l0"
    ? "L0 explicit memories cannot be hard-deleted on this provider build; use memory_correct to supersede it instead."
    : "No matching memory was found in your scope to forget.";
  return textResult(why, { removed: 0 }, true);
}

/** Dispatch a validated memory tools/call. Identity/scope resolved server-side;
 *  NEVER reads a tenant id from `args`. Unknown tool → error result. */
export async function executeMemoryTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  switch (name) {
    case "memory_remember":
      return doRemember(claims, args);
    case "memory_search":
      return doSearch(claims, args);
    case "memory_read":
      return doRead(claims, args);
    case "memory_correct":
      return doCorrect(claims, args);
    case "memory_forget":
      return doForget(claims, args);
    default:
      return textResult(`Unknown memory tool: ${name}`, undefined, true);
  }
}
