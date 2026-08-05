import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { DEV_ORG_ID } from "../seed";
import { embeddingsEnabled, embedOne } from "./embed";
import { ingestOne, IngestValidationError } from "./ingest";
import {
  deleteRecord,
  listRecords,
  searchRecords,
  setPinned,
  type KnowledgeRow,
} from "./store";
import { seedIfEmpty } from "./seed";

/**
 * Knowledge API — mounted at /api/knowledge by the backend entrypoint.
 * Distillation-driven ingest + hybrid (tsvector + pgvector) search, org-scoped.
 * Tenancy is server-resolved by `orgScope` (session → active org, or the dev
 * fallback in dev mode) — callers can NEVER select an org via header or body.
 */
export const knowledgeRoutes = new Hono<AppEnv>();

knowledgeRoutes.use("*", orgScope);

// Kick off first-boot seeding when this module loads (non-blocking, guarded).
// Seed into the SAME org the dev fallback resolves to, so the unauthenticated
// dev path (frontend :3200/knowledge) sees the seeded corpus.
void seedIfEmpty(DEV_ORG_ID);

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
