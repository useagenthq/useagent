import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { embeddingsEnabled, embedOne } from "./embed";
import { ingestOne, IngestValidationError } from "./ingest";
import {
  deleteRecord,
  listRecords,
  searchRecords,
  setPinned,
  type KnowledgeRow,
} from "./store";
import {
  addRevision,
  archiveDocument,
  createDocument,
  getDocument,
  listDocuments,
  listRevisions,
  publishDocument,
  type DocStatus,
} from "./wiki";

/**
 * Knowledge API — mounted at /api/knowledge by the backend entrypoint.
 * Distillation-driven ingest + hybrid (tsvector + pgvector) search, org-scoped.
 * Tenancy is server-resolved by `orgScope` (session → active org, or the dev
 * fallback in dev mode) — callers can NEVER select an org via header or body.
 */
export const knowledgeRoutes = new Hono<AppEnv>();

knowledgeRoutes.use("*", orgScope);

/** Shape a stored row for the read API (flattens the useful distilled meta). */
function toApi(row: KnowledgeRow) {
  const m = row.meta ?? {};
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    refs: row.refs,
    pinned: row.pinned,
    worth_saving: row.worth_saving,
    visibility: row.visibility,
    connector_instance_id: row.connector_instance_id,
    external_id: row.external_id,
    source_type: m.source_type ?? null,
    source_url: m.source_url ?? null,
    domain: m.domain ?? null,
    summary: m.summary ?? null,
    question: m.question ?? null,
    status: m.status ?? null,
    confidence: m.confidence ?? null,
    entities: m.entities ?? [],
    verbatim_signals: m.verbatim_signals ?? [],
    grounding: m.grounding ?? null,
    stub: m.stub ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// POST /api/knowledge/ingest — the acme ingestion contract.
knowledgeRoutes.post("/ingest", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    // Tenancy is server-resolved: the acme contract (meta + text) is honored,
    // but org/user come ONLY from the request context, never the caller's body.
    const result = await ingestOne({
      meta: body.meta,
      text: body.text,
      org_id: c.get("orgId"),
      user_id: c.get("userId"),
    });
    return c.json(result);
  } catch (e) {
    if (e instanceof IngestValidationError) return c.json({ error: e.message }, 400);
    console.error("[knowledge] ingest error:", (e as Error).message);
    return c.json({ error: "ingest failed", detail: (e as Error).message }, 500);
  }
});

// GET /api/knowledge — org records, pinned first, newest first; optional ?q= keyword filter.
knowledgeRoutes.get("/", async (c) => {
  const q = c.req.query("q");
  try {
    const rows = await listRecords({ orgId: c.get("orgId"), q });
    return c.json({ records: rows.map(toApi), embeddings: embeddingsEnabled() });
  } catch (e) {
    console.error("[knowledge] list error:", (e as Error).message);
    return c.json({ error: "list failed" }, 500);
  }
});

// POST /api/knowledge/search — hybrid retrieval → {results:[{rank,text,citation,id,kind,title}]}.
knowledgeRoutes.post("/search", async (c) => {
  let body: { query?: unknown; k?: unknown };
  try {
    body = (await c.req.json()) as { query?: unknown; k?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return c.json({ error: "`query` is required" }, 400);
  const k = typeof body.k === "number" && body.k > 0 ? Math.floor(body.k) : 8;

  try {
    // Bring our own query vector when embeddings are available; else keyword-only.
    let queryEmbedding: number[] | null = null;
    if (embeddingsEnabled()) {
      try {
        queryEmbedding = await embedOne(query);
      } catch (e) {
        console.warn("[knowledge] query embed failed, keyword-only:", (e as Error).message);
      }
    }
    const results = await searchRecords({ orgId: c.get("orgId"), query, k, queryEmbedding });
    return c.json({ results, mode: queryEmbedding ? "hybrid" : "keyword" });
  } catch (e) {
    console.error("[knowledge] search error:", (e as Error).message);
    return c.json({ error: "search failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Wiki-over-Knowledge documents (mem_op.md 0.3). Session/org-scoped (orgScope),
// for humans/editors. The Wiki page reads GET /documents?status=published; the
// agent reaches published content through knowledge_search (via knowledge_records),
// not these routes. Registered BEFORE /:id so the literal `documents` segment wins.
// ---------------------------------------------------------------------------

const DOC_STATUSES: DocStatus[] = ["draft", "published", "archived"];

// GET /api/knowledge/documents?status=published|draft|archived|all — default
// PUBLISHED (the Wiki view). Content is the published (or latest) revision.
knowledgeRoutes.get("/documents", async (c) => {
  const raw = c.req.query("status");
  const status =
    raw === "all" ? undefined : DOC_STATUSES.includes(raw as DocStatus) ? (raw as DocStatus) : "published";
  try {
    const documents = await listDocuments(c.get("orgId"), status);
    return c.json({ documents });
  } catch (e) {
    console.error("[knowledge] documents list error:", (e as Error).message);
    return c.json({ error: "list failed" }, 500);
  }
});

// POST /api/knowledge/documents — create a DRAFT + first revision.
knowledgeRoutes.post("/documents", async (c) => {
  let body: { title?: unknown; content?: unknown; collection?: unknown; slug?: unknown; source?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!title) return c.json({ error: "`title` is required" }, 400);
  if (!content.trim()) return c.json({ error: "`content` is required" }, 400);
  try {
    const document = await createDocument({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      title,
      content,
      collection: typeof body.collection === "string" ? body.collection : undefined,
      slug: typeof body.slug === "string" ? body.slug : null,
      source: typeof body.source === "string" ? body.source : null,
    });
    return c.json({ document });
  } catch (e) {
    console.error("[knowledge] document create error:", (e as Error).message);
    return c.json({ error: "create failed" }, 500);
  }
});

// GET /api/knowledge/documents/:id — one document (+ its revisions).
knowledgeRoutes.get("/documents/:id", async (c) => {
  try {
    const document = await getDocument(c.get("orgId"), c.req.param("id"));
    if (!document) return c.json({ error: "document not found" }, 404);
    const revisions = await listRevisions(c.get("orgId"), document.id);
    return c.json({ document, revisions });
  } catch (e) {
    console.error("[knowledge] document get error:", (e as Error).message);
    return c.json({ error: "get failed" }, 500);
  }
});

// POST /api/knowledge/documents/:id/revisions — append an immutable revision.
knowledgeRoutes.post("/documents/:id/revisions", async (c) => {
  let body: { content?: unknown; source?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) return c.json({ error: "`content` is required" }, 400);
  try {
    const rev = await addRevision(c.get("orgId"), c.req.param("id"), {
      content,
      source: typeof body.source === "string" ? body.source : null,
    });
    if (!rev) return c.json({ error: "document not found" }, 404);
    return c.json({ revisionId: rev.id });
  } catch (e) {
    console.error("[knowledge] add revision error:", (e as Error).message);
    return c.json({ error: "revision failed" }, 500);
  }
});

// POST /api/knowledge/documents/:id/publish — publish {revisionId?} → searchable.
knowledgeRoutes.post("/documents/:id/publish", async (c) => {
  let body: { revisionId?: unknown } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  try {
    const document = await publishDocument(
      c.get("orgId"),
      c.req.param("id"),
      typeof body.revisionId === "string" ? body.revisionId : undefined,
    );
    if (!document) return c.json({ error: "document or revision not found" }, 404);
    return c.json({ document });
  } catch (e) {
    console.error("[knowledge] publish error:", (e as Error).message);
    return c.json({ error: "publish failed" }, 500);
  }
});

// POST /api/knowledge/documents/:id/archive — unpublish + drop from retrieval.
knowledgeRoutes.post("/documents/:id/archive", async (c) => {
  try {
    const document = await archiveDocument(c.get("orgId"), c.req.param("id"));
    if (!document) return c.json({ error: "document not found" }, 404);
    return c.json({ document });
  } catch (e) {
    console.error("[knowledge] archive error:", (e as Error).message);
    return c.json({ error: "archive failed" }, 500);
  }
});

// PATCH /api/knowledge/:id — pin / unpin.
knowledgeRoutes.patch("/:id", async (c) => {
  let body: { pinned?: unknown };
  try {
    body = (await c.req.json()) as { pinned?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.pinned !== "boolean") return c.json({ error: "`pinned` (boolean) is required" }, 400);
  try {
    const row = await setPinned(c.get("orgId"), c.req.param("id"), body.pinned);
    if (!row) return c.json({ error: "record not found" }, 404);
    return c.json({ record: toApi(row) });
  } catch (e) {
    console.error("[knowledge] patch error:", (e as Error).message);
    return c.json({ error: "patch failed" }, 500);
  }
});

// DELETE /api/knowledge/:id
knowledgeRoutes.delete("/:id", async (c) => {
  try {
    const ok = await deleteRecord(c.get("orgId"), c.req.param("id"));
    if (!ok) return c.json({ error: "record not found" }, 404);
    return c.json({ deleted: true });
  } catch (e) {
    console.error("[knowledge] delete error:", (e as Error).message);
    return c.json({ error: "delete failed" }, 500);
  }
});

export default knowledgeRoutes;
