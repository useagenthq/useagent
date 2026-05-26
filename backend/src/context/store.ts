import { isValidRepoRef } from "../wiki-gen/clone";
import { toVectorLiteral } from "../knowledge/embed";
import { sql, type StoreExec } from "../knowledge/store";

// ---------------------------------------------------------------------------
// Unified Context Index store (Phase 1). ONE searchable projection over the
// four authoritative stores (knowledge, skills/playbooks/blueprints,
// automations, memory). The physical stores stay separate and authoritative;
// this table is a PROJECTION keyed by a stable typed `source_ref` back to the
// real row. The DDL is journaled via drizzle migration 0048; this module owns
// the raw-SQL access so BOTH the privileged backend (the projector, writes) and
// the restricted sandbox gateway (context_search/context_read, SELECT-only) use
// the same code path via the GATEWAY_DATABASE_URL-aware `sql` client (reused
// from the knowledge store, which resolves the right role per process).
//
// Bounded by construction: search top-K is hard-capped and snippets are clamped
// at the tool boundary, so a projection query can never return an unbounded dump.
// ---------------------------------------------------------------------------

/** The projectable source kinds. `code` (Phase 3) projects repository
 *  identifiers/config/domains/docs; it needs no schema change (the enum column is
 *  plain text and the `code:` source_ref carries repo/commit/file/line). */
export const CONTEXT_KINDS = [
  "knowledge",
  "skill",
  "playbook",
  "blueprint",
  "automation",
  "memory",
  "code",
] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export function isContextKind(value: string): value is ContextKind {
  return (CONTEXT_KINDS as readonly string[]).includes(value);
}

/** One projected index row — a pointer to an authoritative row, never the row. */
export interface ContextIndexRow {
  id: string;
  org_id: string;
  kind: ContextKind;
  title: string;
  searchable_text: string;
  source_ref: string;
  source_kind_id: string;
  version: number | null;
  visibility: string;
  updated_at: string;
}

/** One ranked search hit returned to the tool layer. */
export interface ContextSearchHit {
  rank: number;
  kind: ContextKind;
  title: string;
  snippet: string;
  source_ref: string;
  source_kind_id: string;
  version: number | null;
  score: number;
}

/** The projected row a caller hands the store — an upsert payload. */
export interface ContextProjection {
  orgId: string;
  kind: ContextKind;
  title: string;
  searchableText: string;
  sourceRef: string;
  sourceKindId: string;
  version: number | null;
  visibility?: string;
  /** Phase 2 fills this; Phase 1 always passes null (no embed key path here). */
  embedding?: number[] | null;
}

// ---------------------------------------------------------------------------
// Migration (run once, lazily, at first use) — mirrors knowledge/store.ts. The
// journaled drizzle migration is the source of truth for a fresh clone; this
// lazy guard lets a throwaway test DB (or the restricted gateway role, which
// cannot CREATE) work without the migrator having run in-process.
// ---------------------------------------------------------------------------

let migrated: Promise<void> | null = null;

/** Ensure the table + indexes exist. Idempotent; awaited by every op. */
export function ready(): Promise<void> {
  if (!migrated) migrated = migrate();
  return migrated;
}

async function migrate(): Promise<void> {
  // The restricted gateway role holds SELECT but no CREATE; when the table is
  // already in place (the privileged backend boot ran the migrator) skip all
  // DDL instead of failing. Same pattern as knowledge/store.ts.
  try {
    await sql`SELECT 1 FROM context_index LIMIT 0`;
    return;
  } catch {
    // Table absent (or unreadable): fall through to the owner bootstrap path.
  }
  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch {
    // pgvector unavailable to this role: the nullable embedding column below
    // still needs the type, so surface the same actionable error the knowledge
    // store does rather than a raw driver message.
    throw new Error(
      "[context] could not enable the pgvector extension (CREATE EXTENSION vector). " +
        "Install pgvector and grant the DB role privilege, or have a superuser run " +
        "`CREATE EXTENSION vector;` in this database first.",
    );
  }
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS context_index (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id          text NOT NULL,
      kind            text NOT NULL,
      title           text NOT NULL,
      searchable_text text NOT NULL,
      source_ref      text NOT NULL,
      source_kind_id  text NOT NULL,
      version         integer,
      visibility      text NOT NULL DEFAULT 'org',
      embedding       vector(1024),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_context_index_source ON context_index (org_id, source_ref)`,
  );
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_context_index_org_kind ON context_index (org_id, kind)`,
  );
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_context_index_fts ON context_index USING GIN (to_tsvector('english', searchable_text))`,
  );
}

// ---------------------------------------------------------------------------
// Writes (privileged backend only — the projector). Source-keyed idempotent
// upsert by (org_id, source_ref): re-projecting the same authoritative row
// REPLACES its index row in place.
// ---------------------------------------------------------------------------

export async function upsertContextRow(
  input: ContextProjection,
  exec: StoreExec = sql,
): Promise<string> {
  await ready();
  const emb = input.embedding ? toVectorLiteral(input.embedding) : null;
  const rows = await exec<{ id: string }[]>`
    INSERT INTO context_index
      (org_id, kind, title, searchable_text, source_ref, source_kind_id, version, visibility, embedding, updated_at)
    VALUES
      (${input.orgId}, ${input.kind}, ${input.title}, ${input.searchableText},
       ${input.sourceRef}, ${input.sourceKindId}, ${input.version},
       ${input.visibility ?? "org"}, ${emb}::vector, now())
    ON CONFLICT (org_id, source_ref) DO UPDATE SET
      kind = EXCLUDED.kind,
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      source_kind_id = EXCLUDED.source_kind_id,
      version = EXCLUDED.version,
      visibility = EXCLUDED.visibility,
      embedding = EXCLUDED.embedding,
      updated_at = now()
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Remove an index row by its source_ref (org-scoped) — e.g. a wiki doc archive
 *  or an automation delete. Returns true when a row was removed. */
export async function deleteContextRow(
  orgId: string,
  sourceRef: string,
  exec: StoreExec = sql,
): Promise<boolean> {
  await ready();
  const rows = await exec<{ id: string }[]>`
    DELETE FROM context_index WHERE org_id = ${orgId} AND source_ref = ${sourceRef} RETURNING id
  `;
  return rows.length > 0;
}

export async function countContextRows(orgId: string): Promise<number> {
  await ready();
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM context_index WHERE org_id = ${orgId}
  `;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Read (org-scoped) — resolve a source_ref to its projected row. A cross-org (or
// missing) source_ref resolves to null (fail closed, no cross-tenant oracle).
// ---------------------------------------------------------------------------

export async function getContextBySourceRef(
  orgId: string,
  sourceRef: string,
): Promise<ContextIndexRow | null> {
  await ready();
  const rows = await sql<ContextIndexRow[]>`
    SELECT id, org_id, kind, title, searchable_text, source_ref, source_kind_id,
           version, visibility, updated_at
    FROM context_index
    WHERE org_id = ${orgId} AND source_ref = ${sourceRef}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Unified search — FTS ts_rank_cd always; when a query embedding is supplied AND
// projected rows carry one, blend the two ranked lists with Reciprocal Rank
// Fusion (the SAME hybrid pattern as knowledge/store.ts). Keyword-only works
// with no embed key. Org-scoped and bounded by construction.
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  kind: ContextKind;
  title: string;
  searchable_text: string;
  source_ref: string;
  source_kind_id: string;
  version: number | null;
}

const RRF_K = 60; // standard RRF damping constant

/** OR-combined keyword query fragment: plainto_tsquery ANDs every lexeme (too
 *  strict for a search box — one absent term zeroes the result), so we swap its
 *  `&` for `|`. ts_rank_cd still ranks the closest/most matches first. Identical
 *  to the knowledge store's tsQuery. */
function tsQuery(q: string) {
  return sql`(replace(plainto_tsquery('english', ${q})::text, '&', '|'))::tsquery`;
}

export async function searchContext(opts: {
  orgId: string;
  query: string;
  kinds?: ContextKind[];
  /** Narrow to `code` rows from one repo ("owner/name"). The projection carries
   *  no repo column, so this filters on the `code:<repo>@...` source_ref prefix. */
  repo?: string;
  k?: number;
  queryEmbedding?: number[] | null;
}): Promise<ContextSearchHit[]> {
  await ready();
  const k = Math.max(1, Math.min(opts.k ?? 8, 25));
  const candN = Math.min(100, Math.max(k * 4, 20));
  const kindFilter =
    opts.kinds && opts.kinds.length ? sql`AND kind = ANY(${opts.kinds})` : sql``;
  // A repo narrows to that repo's code rows: source_ref is "code:<repo>@<sha>:...".
  const repoFilter =
    opts.repo && isValidRepoRef(opts.repo)
      ? sql`AND source_ref LIKE ${`code:${opts.repo}@%`}`
      : sql``;

  const keyword = await sql<Candidate[]>`
    SELECT id, kind, title, searchable_text, source_ref, source_kind_id, version
    FROM context_index
    WHERE org_id = ${opts.orgId} AND to_tsvector('english', searchable_text) @@ ${tsQuery(opts.query)} ${kindFilter} ${repoFilter}
    ORDER BY ts_rank_cd(to_tsvector('english', searchable_text), ${tsQuery(opts.query)}) DESC, updated_at DESC
    LIMIT ${candN}
  `;

  let vector: Candidate[] = [];
  if (opts.queryEmbedding) {
    const qvec = toVectorLiteral(opts.queryEmbedding);
    vector = await sql<Candidate[]>`
      SELECT id, kind, title, searchable_text, source_ref, source_kind_id, version
      FROM context_index
      WHERE org_id = ${opts.orgId} AND embedding IS NOT NULL ${kindFilter} ${repoFilter}
      ORDER BY embedding <=> ${qvec}::vector ASC
      LIMIT ${candN}
    `;
  }

  // RRF: fused score = Σ 1/(RRF_K + rank) across the lists a row appears in.
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
      return {
        rank: i + 1,
        kind: c.kind,
        title: c.title,
        snippet: c.searchable_text,
        source_ref: c.source_ref,
        source_kind_id: c.source_kind_id,
        version: c.version,
        score: scores.get(id)!,
      };
    });
}
