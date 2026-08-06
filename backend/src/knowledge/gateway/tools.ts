import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { runs } from "../../db/schema";
import { recordProviderEvent } from "../../runs/provider-events";
import { embeddingsEnabled, embedOne } from "../embed";
import { getRecord, searchRecords, type SearchHit } from "../store";
import type { ToolTokenClaims } from "./token";

// ---------------------------------------------------------------------------
// Agent-callable knowledge tools (mem_op.md 0.2). READ-ONLY. The resident
// opencode agent reaches these ONLY through the MCP gateway, which has already
// resolved identity from the run-scoped token — so `identity.orgId` here is
// server-trusted and every query is scoped to it. A tool argument NEVER carries
// a tenant id; if a caller smuggles one, it is ignored (the schemas below do not
// declare one, and execution reads org solely from `identity`).
//
// Bounded by construction: snippet length, result count, and read size are all
// capped, so a tool call can never return an unbounded database dump.
// ---------------------------------------------------------------------------

const SNIPPET_MAX = 600; // chars per result snippet
const READ_MAX = 8_000; // chars for a single knowledge_read body
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** The event type for a knowledge retrieval frame on the native lane. Distinct
 *  from memory's `context.retrieved` so the "Context used" surface can label
 *  knowledge citations separately (mem_op.md 0.2: "Emit a canonical
 *  knowledge.retrieved event, or extend context.retrieved with source:knowledge"). */
export const KNOWLEDGE_RETRIEVED = "knowledge.retrieved";

/** MCP tool descriptors (tools/list). `inputSchema` is JSON Schema — note there
 *  is deliberately NO org/tenant field: identity is derived from the token. */
export const KNOWLEDGE_TOOLS = [
  {
    name: "knowledge_search",
    description:
      "Search the organization's knowledge base (published documents, distilled " +
      "records, runbooks) with hybrid keyword+semantic retrieval. Returns bounded, " +
      "cited snippets with stable ids you can pass to knowledge_read. Use this " +
      "whenever you need organization-specific facts you were not given.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        limit: {
          type: "integer",
          description: `Max results (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
          minimum: 1,
          maximum: MAX_LIMIT,
        },
        scope: {
          type: "string",
          description:
            "Optional retrieval scope hint (e.g. 'org'). Advisory only — results " +
            "are always confined to your organization; this cannot widen access.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_read",
    description:
      "Read the full bounded body of one knowledge item by its stable id (from " +
      "knowledge_search). Returns the item's title, body, and citation. Refuses " +
      "ids outside your organization.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Stable knowledge item id from a search result." },
        revisionId: {
          type: "string",
          description: "Optional specific revision id (defaults to the published/current revision).",
        },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
] as const;

export const KNOWLEDGE_TOOL_NAMES: ReadonlySet<string> = new Set(KNOWLEDGE_TOOLS.map((t) => t.name));

/** A single MCP text content block. */
interface TextContent {
  type: "text";
  text: string;
}
/** The MCP tools/call result shape (subset we use). */
export interface ToolCallResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function clamp(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// Retrieval ledger — every tool call becomes a durable `knowledge.retrieved`
// native frame (mem_op.md 0.2 / "Retrieval Ledger and UX"). Fire-and-forget so
// it can never fail the agent turn. Attributed to the thread's CURRENTLY-ACTIVE
// run (the one the agent is executing), falling back to the token's mint run.
// ---------------------------------------------------------------------------

/** Resolve the run a retrieval should be attributed to: the thread's running run
 *  (the agent's current turn), else the token's mint run. Both are within the
 *  token's org by construction, so this cannot cross tenants. */
async function resolveLedgerRun(claims: ToolTokenClaims): Promise<{ runId: string; threadId: string } | null> {
  const [running] = await db
    .select({ id: runs.id, threadId: runs.threadId })
    .from(runs)
    .where(and(eq(runs.threadId, claims.threadId), eq(runs.status, "running")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (running) return { runId: running.id, threadId: running.threadId };
  // Fallback: the mint run must still exist (FK target for the ledger frame).
  const [mint] = await db
    .select({ id: runs.id, threadId: runs.threadId })
    .from(runs)
    .where(eq(runs.id, claims.runId))
    .limit(1);
  return mint ? { runId: mint.id, threadId: mint.threadId } : null;
}

export interface LedgerItem {
  id: string;
  title: string;
  citation: string;
  score?: number;
}

/** Record one knowledge retrieval as a native frame. Never throws; callers void
 *  it on the hot path. Skips silently if no attributable run exists. */
export async function recordKnowledgeRetrieval(
  claims: ToolTokenClaims,
  tool: string,
  query: string,
  items: LedgerItem[],
  latencyMs: number,
): Promise<void> {
  const target = await resolveLedgerRun(claims).catch(() => null);
  if (!target) return;
  await recordProviderEvent({
    id: `kbret_${target.runId}_${randomBytes(5).toString("hex")}`,
    runId: target.runId,
    threadId: target.threadId,
    provider: "skynet-knowledge",
    eventType: KNOWLEDGE_RETRIEVED,
    payload: {
      source: "knowledge",
      tool,
      query,
      scope: {
        orgId: claims.orgId,
        actorUserId: claims.userId,
        threadId: claims.threadId,
        runId: target.runId,
      },
      itemCount: items.length,
      items,
      latencyMs,
    },
  });
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function doSearch(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { content: [{ type: "text", text: "knowledge_search requires a non-empty `query`." }], isError: true };
  }
  const rawLimit = typeof args.limit === "number" ? Math.floor(args.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MAX_LIMIT));

  const startedAt = Date.now();
  // Bring our own query vector when embeddings are available; else keyword-only.
  let queryEmbedding: number[] | null = null;
  if (embeddingsEnabled()) {
    queryEmbedding = await embedOne(query).catch(() => null);
  }
  // Org comes ONLY from the token. `internal`/`public` visibility are the org's
  // agent-visible knowledge; drafts (wiki) are never upserted into this store, so
  // they are excluded for free.
  const hits: SearchHit[] = await searchRecords({
    orgId: claims.orgId,
    query,
    k: limit,
    queryEmbedding,
    visibility: ["internal", "public"],
  });
  const latencyMs = Date.now() - startedAt;

  const results = hits.map((h) => ({
    id: h.id,
    title: h.title,
    kind: h.kind,
    snippet: clamp(h.text, SNIPPET_MAX),
    citation: h.citation,
    rank: h.rank,
  }));

  void recordKnowledgeRetrieval(
    claims,
    "knowledge_search",
    query,
    results.map((r) => ({ id: r.id, title: r.title, citation: r.citation, score: r.rank })),
    latencyMs,
  );

  const text =
    results.length === 0
      ? `No knowledge found for "${query}".`
      : results
          .map(
            (r) =>
              `[${r.id}] ${r.title}${r.kind ? ` (${r.kind})` : ""}\n${r.snippet}\nSource: ${r.citation}`,
          )
          .join("\n\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: { mode: queryEmbedding ? "hybrid" : "keyword", results },
  };
}

async function doRead(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const id = typeof args.documentId === "string" ? args.documentId.trim() : "";
  if (!id) {
    return { content: [{ type: "text", text: "knowledge_read requires a `documentId`." }], isError: true };
  }
  // Org-scoped fetch: getRecord filters by org, so a KNOWN id from another org
  // resolves to null — indistinguishable from missing (fail closed, no oracle).
  const row = await getRecord(claims.orgId, id).catch(() => null);
  if (!row) {
    return { content: [{ type: "text", text: `No knowledge item ${id} is available to your organization.` }], isError: true };
  }
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const citation =
    typeof meta.source_url === "string" && meta.source_url
      ? meta.source_url
      : `${row.connector_instance_id}#${row.external_id}`;
  const body = clamp(row.body, READ_MAX);

  void recordKnowledgeRetrieval(
    claims,
    "knowledge_read",
    id,
    [{ id: row.id, title: row.title, citation }],
    0,
  );

  return {
    content: [{ type: "text", text: `# ${row.title}\n\n${body}\n\nSource: ${citation}` }],
    structuredContent: {
      id: row.id,
      title: row.title,
      kind: row.kind,
      body,
      citation,
      refs: row.refs,
    },
  };
}

/** Dispatch a validated tools/call. Identity is already resolved from the token;
 *  this NEVER reads a tenant id from `args`. Unknown tool → error result. */
export async function executeKnowledgeTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  switch (name) {
    case "knowledge_search":
      return doSearch(claims, args);
    case "knowledge_read":
      return doRead(claims, args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
