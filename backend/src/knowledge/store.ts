import postgres from "postgres";
import { env, EMBED_DIMS } from "./env";
import { toVectorLiteral } from "./embed";

/**
 * Postgres store — the retrieval layer, replacing acme's Weaviate adapter.
 * Same idea (hybrid keyword + dense vector, RRF-fused; idempotent upsert keyed
 * by external identity), realized on Postgres + pgvector: a tsvector GIN index
 * for BM25-style keyword rank and an HNSW cosine index for dense vector rank.
 *
 * We own our schema: plain SQL `CREATE ... IF NOT EXISTS` run once at init via
 * the `postgres` client — deliberately NOT touching the other agent's Drizzle
 * setup or SQLite runs/steps tables.
 */

export const sql = postgres(env.databaseUrl, { max: 8, onnotice: () => {} });

/** JSON-serializable value — what we hand to `sql.json()` for jsonb columns. */
export type Json = null | string | number | boolean | Json[] | { [k: string]: Json };

/** A stored knowledge row as returned to callers. */
export interface KnowledgeRow {
  id: string;
  org_id: string;
  user_id: string | null;
  kind: string;
  title: string;
  body: string;
  refs: string[];
  meta: Record<string, unknown>;
  external_id: string;
  connector_instance_id: string;
  content_hash: string;
  distillation_key: string;
  worth_saving: boolean;
  pinned: boolean;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface SearchHit {
  rank: number;
  text: string;
  citation: string;
  id: string;
  kind: string;
  title: string;
}

// -------------------------------------------------------------------------
// Migrations (run once, lazily, at first use)
// -------------------------------------------------------------------------

let migrated: Promise<void> | null = null;

/** Ensure the extension, table, and indexes exist. Idempotent; awaited by every op. */
export function ready(): Promise<void> {
  if (!migrated) migrated = migrate();
  return migrated;
}

async function migrate(): Promise<void> {
  // pgvector must be enabled before the vector column is created. Enabling an
  // extension needs privilege; surface a clear, actionable preflight error
  // rather than a raw driver message if the role can't (or pgvector is absent).
  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (e) {
    throw new Error(
      "[knowledge] could not enable the pgvector extension (CREATE EXTENSION vector). " +
        "Install pgvector and grant the DB role privilege, or have a superuser run " +
        "`CREATE EXTENSION vector;` in this database first. " +
        `Underlying error: ${(e as Error).message}`,
    );
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS knowledge_records (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id                 text NOT NULL,
      user_id                text,
      kind                   text NOT NULL,
      title                  text NOT NULL,
      body                   text NOT NULL,
      refs                   jsonb NOT NULL DEFAULT '[]',
      meta                   jsonb NOT NULL DEFAULT '{}',
      external_id            text NOT NULL,
      connector_instance_id  text NOT NULL,
      content_hash           text NOT NULL,
      distillation_key       text NOT NULL,
      worth_saving           boolean NOT NULL DEFAULT true,
      pinned                 boolean NOT NULL DEFAULT false,
      visibility             text NOT NULL DEFAULT 'internal',
      embedding              vector(${EMBED_DIMS}),
      tsv                    tsvector GENERATED ALWAYS AS (
                               to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
                             ) STORED,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, connector_instance_id, external_id)
    )
  `);

  // Fail-closed access boundary. Added idempotently so tables created before
  // this column gain it too (default 'internal' — never world-visible).
  await sql.unsafe(
    `ALTER TABLE knowledge_records ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'internal'`,
  );

  await sql.unsafe(`CREATE INDEX IF NOT EXISTS knowledge_tsv_gin ON knowledge_records USING GIN (tsv)`);
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS knowledge_org_list ON knowledge_records (org_id, pinned DESC, created_at DESC)`,
  );

  // Dense-vector index. HNSW (pgvector >= 0.5) needs no training data; fall back
  // to ivfflat, then to no ANN index (exact scan still works) — never fatal.
  try {
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS knowledge_embedding_hnsw ON knowledge_records USING hnsw (embedding vector_cosine_ops)`,
    );
  } catch {
    try {
      await sql.unsafe(
        `CREATE INDEX IF NOT EXISTS knowledge_embedding_ivfflat ON knowledge_records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
      );
    } catch (e) {
      console.warn("[knowledge] no vector ANN index (exact scan will be used):", (e as Error).message);
    }
  }
}

// -------------------------------------------------------------------------
// Writes
// -------------------------------------------------------------------------

export interface UpsertInput {
  orgId: string;
  userId: string | null;
  kind: string;
  title: string;
  body: string;
  refs: string[];
  meta: Record<string, Json>;
  externalId: string;
  connectorInstanceId: string;
  contentHash: string;
  distillationKey: string;
  worthSaving: boolean;
  embedding: number[] | null;
}

/**
 * Idempotent upsert keyed by (org_id, connector_instance_id, external_id).
 * Re-ingest of the same identity REPLACES in place. `pinned` is intentionally
 * NOT overwritten on conflict, so a user's pin survives re-distillation.
 */
export async function upsertRecord(input: UpsertInput): Promise<string> {
  await ready();
  const emb = input.embedding ? toVectorLiteral(input.embedding) : null;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO knowledge_records
      (org_id, user_id, kind, title, body, refs, meta, external_id,
       connector_instance_id, content_hash, distillation_key, worth_saving, embedding, updated_at)
    VALUES
      (${input.orgId}, ${input.userId}, ${input.kind}, ${input.title}, ${input.body},
       ${sql.json(input.refs)}, ${sql.json(input.meta)}, ${input.externalId},
       ${input.connectorInstanceId}, ${input.contentHash}, ${input.distillationKey},
       ${input.worthSaving}, ${emb}::vector, now())
    ON CONFLICT (org_id, connector_instance_id, external_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      kind = EXCLUDED.kind,
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      refs = EXCLUDED.refs,
      meta = EXCLUDED.meta,
      content_hash = EXCLUDED.content_hash,
      distillation_key = EXCLUDED.distillation_key,
      worth_saving = EXCLUDED.worth_saving,
      embedding = EXCLUDED.embedding,
      updated_at = now()
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Look up the stored identity (idempotency check + kind for the skip path). */
export async function findExisting(
  orgId: string,
  connectorInstanceId: string,
  externalId: string,
): Promise<{ id: string; distillation_key: string; kind: string } | null> {
  await ready();
  const rows = await sql<{ id: string; distillation_key: string; kind: string }[]>`
    SELECT id, distillation_key, kind FROM knowledge_records
    WHERE org_id = ${orgId} AND connector_instance_id = ${connectorInstanceId} AND external_id = ${externalId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// -------------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------------

const ROW_COLS = sql`
  id, org_id, user_id, kind, title, body, refs, meta, external_id,
  connector_instance_id, content_hash, distillation_key, worth_saving, pinned,
  visibility, created_at, updated_at
`;

/** List org records, newest first, pinned first; optional tsvector keyword filter. */
export async function listRecords(opts: { orgId: string; q?: string; limit?: number }): Promise<KnowledgeRow[]> {
  await ready();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const q = opts.q?.trim();
  return sql<KnowledgeRow[]>`
    SELECT ${ROW_COLS} FROM knowledge_records
    WHERE org_id = ${opts.orgId}
    ${q ? sql`AND tsv @@ ${tsQuery(q)}` : sql``}
    ORDER BY pinned DESC, created_at DESC
    LIMIT ${limit}
  `;
}

export async function getRecord(orgId: string, id: string): Promise<KnowledgeRow | null> {
  await ready();
  const rows = await sql<KnowledgeRow[]>`
    SELECT ${ROW_COLS} FROM knowledge_records WHERE org_id = ${orgId} AND id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function countRecords(orgId: string): Promise<number> {
  await ready();
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM knowledge_records WHERE org_id = ${orgId}`;
  return rows[0]?.n ?? 0;
}

export async function setPinned(orgId: string, id: string, pinned: boolean): Promise<KnowledgeRow | null> {
  await ready();
  const rows = await sql<KnowledgeRow[]>`
    UPDATE knowledge_records SET pinned = ${pinned}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${id}
    RETURNING ${ROW_COLS}
  `;
  return rows[0] ?? null;
}

export async function deleteRecord(orgId: string, id: string): Promise<boolean> {
  await ready();
  const rows = await sql<{ id: string }[]>`
    DELETE FROM knowledge_records WHERE org_id = ${orgId} AND id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

// -------------------------------------------------------------------------
// Hybrid search (tsvector rank + vector cosine, RRF-fused)
// -------------------------------------------------------------------------

interface Candidate {
  id: string;
  kind: string;
  title: string;
  body: string;
  meta: Record<string, unknown>;
  external_id: string;
  connector_instance_id: string;
}

const RRF_K = 60; // standard RRF damping constant

/**
 * OR-combined keyword query fragment. plainto_tsquery ANDs every lexeme, which
 * is too strict for a search box (one absent term → zero hits). We let
 * plainto_tsquery sanitize + lex the raw input, then swap its `&` for `|` so
 * any term can match — recall like BM25, with ts_rank_cd still ranking the
 * best (most/closest matches) first.
 */
function tsQuery(q: string) {
  return sql`(replace(plainto_tsquery('english', ${q})::text, '&', '|'))::tsquery`;
}

function citationFor(c: Candidate): string {
  const url = typeof c.meta?.source_url === "string" ? c.meta.source_url : null;
  return url || `${c.connector_instance_id}#${c.external_id}`;
}

/**
 * Hybrid search. Runs the keyword query always and the vector query when
 * embeddings exist, then fuses the two ranked lists with Reciprocal Rank Fusion
 * (like the reference's Weaviate hybrid). Keyword-only when no query vector.
 */
export async function searchRecords(opts: {
  orgId: string;
  query: string;
  k?: number;
  queryEmbedding: number[] | null;
  /**
   * Optional per-caller visibility policy hook. When provided, only records
   * whose `visibility` is in the list are returned (e.g. ['internal','public']
   * for an org member, ['public'] for an external caller). Omit for no filter.
   */
  visibility?: string[];
}): Promise<SearchHit[]> {
  await ready();
  const k = Math.max(1, Math.min(opts.k ?? 8, 50));
  const candN = Math.min(100, Math.max(k * 4, 20));
  const visFilter =
    opts.visibility && opts.visibility.length
      ? sql`AND visibility = ANY(${opts.visibility})`
      : sql``;

  const keyword = await sql<Candidate[]>`
    SELECT id, kind, title, body, meta, external_id, connector_instance_id
    FROM knowledge_records
    WHERE org_id = ${opts.orgId} AND tsv @@ ${tsQuery(opts.query)} ${visFilter}
    ORDER BY ts_rank_cd(tsv, ${tsQuery(opts.query)}) DESC, created_at DESC
    LIMIT ${candN}
  `;

  let vector: Candidate[] = [];
  if (opts.queryEmbedding) {
    const qvec = toVectorLiteral(opts.queryEmbedding);
    vector = await sql<Candidate[]>`
      SELECT id, kind, title, body, meta, external_id, connector_instance_id
      FROM knowledge_records
      WHERE org_id = ${opts.orgId} AND embedding IS NOT NULL ${visFilter}
      ORDER BY embedding <=> ${qvec}::vector ASC
      LIMIT ${candN}
    `;
  }

  // RRF: fused score = Σ 1/(RRF_K + rank) across the lists a doc appears in.
  const scores = new Map<string, number>();
  const rows = new Map<string, Candidate>();
  const fuse = (list: Candidate[]): void => {
    list.forEach((c, i) => {
      rows.set(c.id, c);
      scores.set(c.id, (scores.get(c.id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  };
  fuse(keyword);
  fuse(vector);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id], i) => {
      const c = rows.get(id)!;
      return { rank: i + 1, text: c.body, citation: citationFor(c), id: c.id, kind: c.kind, title: c.title };
    });
}
