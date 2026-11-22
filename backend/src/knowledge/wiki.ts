import {
  removeFromContextIndex,
  syncKnowledgeToContextIndex,
} from "../context/projector";
import { contentHash } from "./distill";
import { embedOne, embeddingsEnabled } from "./embed";
import {
  deleteRecord,
  findExisting,
  ready,
  sql,
  upsertRecord,
} from "./store";
import { WIKI_EXCERPT_SOURCE_CHARS, wikiDocumentExcerpt } from "./wiki-excerpt";

// ---------------------------------------------------------------------------
// Wiki-over-Knowledge (mem_op.md 0.3). The human-facing document lifecycle over
// the same knowledge substrate — NOT a second store. A document has immutable
// revisions and a status; the Wiki page renders PUBLISHED documents. Publishing
// upserts the published revision INTO knowledge_records (the retrieval/chunk
// layer), so `knowledge_search` finds published docs and DRAFTS stay invisible
// to the agent (they are never upserted). Archiving removes the record.
//
// Tables live in store.ts's raw-SQL migrate(); this module owns the behavior.
// ---------------------------------------------------------------------------

export type DocStatus = "draft" | "published" | "archived";

/** The wire shape the Wiki/editor UIs read (content is the published revision,
 *  or the latest revision for a draft). */
export interface WikiDocument {
  id: string;
  title: string;
  slug: string | null;
  collection: string;
  status: DocStatus;
  content: string;
  revisionId: string | null;
  publishedRevisionId: string | null;
  updatedAt: string;
  createdAt: string;
}

interface DocRow {
  id: string;
  org_id: string;
  user_id: string | null;
  collection: string;
  title: string;
  slug: string | null;
  parent_id: string | null;
  status: DocStatus;
  published_revision_id: string | null;
  content: string | null;
  revision_id: string | null;
  created_at: string;
  updated_at: string;
}

function toApi(r: DocRow): WikiDocument {
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    collection: r.collection,
    status: r.status,
    content: r.content ?? "",
    revisionId: r.revision_id,
    publishedRevisionId: r.published_revision_id,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
  };
}

// The document row joined to its resolved content: the published revision when
// published, else the latest revision (so an editor sees a draft's newest text).
const DOC_SELECT = sql`
  SELECT d.id, d.org_id, d.user_id, d.collection, d.title, d.slug, d.parent_id,
         d.status, d.published_revision_id,
         COALESCE(pr.content, lr.content) AS content,
         COALESCE(pr.id, lr.id)          AS revision_id,
         d.created_at, d.updated_at
  FROM knowledge_documents d
  LEFT JOIN knowledge_revisions pr ON pr.id = d.published_revision_id
  LEFT JOIN LATERAL (
    SELECT id, content FROM knowledge_revisions r
    WHERE r.document_id = d.id ORDER BY created_at DESC LIMIT 1
  ) lr ON true
`;

/** List an org's documents (optionally filtered by status), newest-updated first. */
export async function listDocuments(orgId: string, status?: DocStatus): Promise<WikiDocument[]> {
  await ready();
  const rows = await sql<DocRow[]>`
    ${DOC_SELECT}
    WHERE d.org_id = ${orgId} ${status ? sql`AND d.status = ${status}` : sql``}
    ORDER BY d.updated_at DESC, d.created_at DESC
  `;
  return rows.map(toApi);
}

/** A wiki document as the paged list sends it: the document without its
 *  content, plus a short preview of it (see ./wiki-excerpt). */
export type WikiDocumentSummary = Omit<WikiDocument, "content"> & { excerpt: string };

/** Where a page of the document list stopped: the last row's full sort key,
 *  with update and creation times as whole microseconds since the epoch. */
export interface DocumentPageCursor {
  readonly updatedAtMicros: string;
  readonly createdAtMicros: string;
  readonly id: string;
}

export interface DocumentPage {
  readonly documents: WikiDocumentSummary[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: DocumentPageCursor | null;
}

export const DOCUMENT_PAGE_DEFAULT_LIMIT = 50;
export const DOCUMENT_PAGE_MAX_LIMIT = 200;

/** One page of an org's documents (optionally filtered by status), newest
 *  update first (creation time, then id, break ties), after `cursor` when
 *  given. Each carries an excerpt read from the start of its content, never
 *  the whole text. A document updated while someone pages moves ahead of
 *  their cursor: a fresh first page shows it, and no later page repeats it. */
export async function listDocumentPage(opts: {
  orgId: string;
  status?: DocStatus;
  limit?: number;
  cursor?: DocumentPageCursor | null;
}): Promise<DocumentPage> {
  await ready();
  const limit = Math.max(1, Math.min(opts.limit ?? DOCUMENT_PAGE_DEFAULT_LIMIT, DOCUMENT_PAGE_MAX_LIMIT));
  const cursor = opts.cursor ?? null;
  // Every key sorts descending, so "after the cursor" is a row-value less-than.
  const rows = await sql<
    (Omit<DocRow, "content"> & {
      content_head: string | null;
      cursor_updated_at_micros: string;
      cursor_created_at_micros: string;
    })[]
  >`
    SELECT d.id, d.org_id, d.user_id, d.collection, d.title, d.slug, d.parent_id,
           d.status, d.published_revision_id,
           left(COALESCE(pr.content, lr.content), ${WIKI_EXCERPT_SOURCE_CHARS}) AS content_head,
           COALESCE(pr.id, lr.id) AS revision_id,
           d.created_at, d.updated_at,
           ((extract(epoch from d.updated_at) * 1000000)::bigint)::text AS cursor_updated_at_micros,
           ((extract(epoch from d.created_at) * 1000000)::bigint)::text AS cursor_created_at_micros
    FROM knowledge_documents d
    LEFT JOIN knowledge_revisions pr ON pr.id = d.published_revision_id
    LEFT JOIN LATERAL (
      SELECT id, content FROM knowledge_revisions r
      WHERE r.document_id = d.id ORDER BY created_at DESC LIMIT 1
    ) lr ON true
    WHERE d.org_id = ${opts.orgId} ${opts.status ? sql`AND d.status = ${opts.status}` : sql``}
    ${cursor
      ? sql`AND (d.updated_at, d.created_at, d.id) < (
          'epoch'::timestamptz + ${cursor.updatedAtMicros}::bigint * interval '1 microsecond',
          'epoch'::timestamptz + ${cursor.createdAtMicros}::bigint * interval '1 microsecond',
          ${cursor.id}::uuid
        )`
      : sql``}
    ORDER BY d.updated_at DESC, d.created_at DESC, d.id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    documents: page.map((row) => {
      const { content: _content, ...document } = toApi({ ...row, content: null });
      return { ...document, excerpt: wikiDocumentExcerpt(row.content_head ?? "", row.title) };
    }),
    nextCursor:
      rows.length > limit && last
        ? {
            updatedAtMicros: last.cursor_updated_at_micros,
            createdAtMicros: last.cursor_created_at_micros,
            id: last.id,
          }
        : null,
  };
}

/** Fetch one document (org-scoped) with resolved content, or null. */
export async function getDocument(orgId: string, id: string): Promise<WikiDocument | null> {
  await ready();
  const rows = await sql<DocRow[]>`
    ${DOC_SELECT}
    WHERE d.org_id = ${orgId} AND d.id = ${id}
    LIMIT 1
  `;
  return rows[0] ? toApi(rows[0]) : null;
}

export interface WikiRevision {
  id: string;
  content: string;
  source: string | null;
  author: string | null;
  created_at: string;
}

/** Full immutable revision history for a document (org-scoped), newest first. */
export async function listRevisions(orgId: string, documentId: string): Promise<WikiRevision[]> {
  await ready();
  return sql<WikiRevision[]>`
    SELECT id, content, source, author, created_at
    FROM knowledge_revisions
    WHERE org_id = ${orgId} AND document_id = ${documentId}
    ORDER BY created_at DESC
  `;
}

/** Where a page of a document's revisions stopped: the last revision's
 *  creation time, in whole microseconds since the epoch, and id. */
export interface RevisionPageCursor {
  readonly createdAtMicros: string;
  readonly id: string;
}

export interface RevisionPage {
  readonly revisions: WikiRevision[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: RevisionPageCursor | null;
}

export const REVISION_PAGE_DEFAULT_LIMIT = 20;
export const REVISION_PAGE_MAX_LIMIT = 100;

/** One page of a document's immutable revisions (org-scoped), newest first (id
 *  breaks ties), after `cursor` when given. */
export async function listRevisionPage(opts: {
  orgId: string;
  documentId: string;
  limit?: number;
  cursor?: RevisionPageCursor | null;
}): Promise<RevisionPage> {
  await ready();
  const limit = Math.max(1, Math.min(opts.limit ?? REVISION_PAGE_DEFAULT_LIMIT, REVISION_PAGE_MAX_LIMIT));
  const cursor = opts.cursor ?? null;
  const rows = await sql<(WikiRevision & { cursor_created_at_micros: string })[]>`
    SELECT id, content, source, author, created_at,
      ((extract(epoch from created_at) * 1000000)::bigint)::text AS cursor_created_at_micros
    FROM knowledge_revisions
    WHERE org_id = ${opts.orgId} AND document_id = ${opts.documentId}
    ${cursor
      ? sql`AND (created_at, id) < (
          'epoch'::timestamptz + ${cursor.createdAtMicros}::bigint * interval '1 microsecond',
          ${cursor.id}::uuid
        )`
      : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    revisions: page.map(({ cursor_created_at_micros: _key, ...revision }) => revision),
    nextCursor:
      rows.length > limit && last
        ? { createdAtMicros: last.cursor_created_at_micros, id: last.id }
        : null,
  };
}

export interface CreateDocumentInput {
  orgId: string;
  userId: string | null;
  title: string;
  content: string;
  collection?: string;
  slug?: string | null;
  source?: string | null;
  author?: string | null;
}

/** Create a DRAFT document plus its first immutable revision (one transaction).
 *  A draft is never upserted into knowledge_records, so the agent cannot see it. */
export async function createDocument(input: CreateDocumentInput): Promise<WikiDocument> {
  await ready();
  const hash = contentHash(input.content);
  const docId = await sql.begin(async (tx) => {
    const [doc] = await tx<{ id: string }[]>`
      INSERT INTO knowledge_documents (org_id, user_id, collection, title, slug, status)
      VALUES (${input.orgId}, ${input.userId}, ${input.collection ?? "wiki"}, ${input.title},
              ${input.slug ?? null}, 'draft')
      RETURNING id
    `;
    await tx`
      INSERT INTO knowledge_revisions (document_id, org_id, content, source, content_hash, author)
      VALUES (${doc!.id}, ${input.orgId}, ${input.content}, ${input.source ?? null}, ${hash}, ${input.author ?? null})
    `;
    return doc!.id;
  });
  const created = await getDocument(input.orgId, docId);
  return created!;
}

/** Append a new IMMUTABLE revision to a document (edits never mutate history). */
export async function addRevision(
  orgId: string,
  documentId: string,
  input: { content: string; source?: string | null; author?: string | null },
): Promise<{ id: string } | null> {
  await ready();
  // Org-scope the document before writing a revision under it.
  const [doc] = await sql<{ id: string }[]>`
    SELECT id FROM knowledge_documents WHERE id = ${documentId} AND org_id = ${orgId} LIMIT 1
  `;
  if (!doc) return null;
  const hash = contentHash(input.content);
  const [rev] = await sql<{ id: string }[]>`
    INSERT INTO knowledge_revisions (document_id, org_id, content, source, content_hash, author)
    VALUES (${documentId}, ${orgId}, ${input.content}, ${input.source ?? null}, ${hash}, ${input.author ?? null})
    RETURNING id
  `;
  await sql`UPDATE knowledge_documents SET updated_at = now() WHERE id = ${documentId} AND org_id = ${orgId}`;
  return rev ?? null;
}

/**
 * Publish a document: set status=published, point published_revision_id at the
 * chosen (or latest) revision, and UPSERT that revision into knowledge_records
 * so it becomes agent-searchable. Idempotent — re-publishing replaces the record
 * in place (keyed by wiki:<docId>). Returns the published doc, or null if the
 * document/revision is not in this org.
 */
export async function publishDocument(
  orgId: string,
  documentId: string,
  revisionId?: string,
): Promise<WikiDocument | null> {
  await ready();
  const [doc] = await sql<{ id: string; title: string; slug: string | null; user_id: string | null }[]>`
    SELECT id, title, slug, user_id FROM knowledge_documents
    WHERE id = ${documentId} AND org_id = ${orgId} LIMIT 1
  `;
  if (!doc) return null;

  // Resolve the revision to publish (explicit id must belong to this doc/org).
  const [rev] = revisionId
    ? await sql<{ id: string; content: string; content_hash: string }[]>`
        SELECT id, content, content_hash FROM knowledge_revisions
        WHERE id = ${revisionId} AND document_id = ${documentId} AND org_id = ${orgId} LIMIT 1
      `
    : await sql<{ id: string; content: string; content_hash: string }[]>`
        SELECT id, content, content_hash FROM knowledge_revisions
        WHERE document_id = ${documentId} AND org_id = ${orgId}
        ORDER BY created_at DESC LIMIT 1
      `;
  if (!rev) return null;

  // The embedding (a network call) is computed OUTSIDE the transaction; then the
  // doc status flip AND the knowledge_records upsert commit together in ONE tx.
  // A partial failure can no longer leave a "published" doc missing from search
  // (or an unindexed doc marked published) — the two steps are atomic.
  const embedding = embeddingsEnabled() ? await embedOne(rev.content).catch(() => null) : null;
  const recordId = await sql.begin(async (tx) => {
    await tx`
      UPDATE knowledge_documents
      SET status = 'published', published_revision_id = ${rev.id}, updated_at = now()
      WHERE id = ${documentId} AND org_id = ${orgId}
    `;
    return upsertRecord(
      {
        orgId,
        userId: doc.user_id,
        kind: "wiki",
        title: doc.title,
        body: rev.content,
        refs: [],
        meta: {
          source_type: "wiki",
          source_url: doc.slug ?? null,
          document_id: documentId,
          revision_id: rev.id,
          status: "published",
        },
        externalId: `wiki:${documentId}`,
        connectorInstanceId: "wiki",
        contentHash: rev.content_hash,
        distillationKey: `wiki:${rev.content_hash}`,
        worthSaving: true,
        embedding,
      },
      tx,
    );
  });

  // Best-effort: project the now-searchable knowledge record into the unified
  // context index (source_ref keyed by the knowledge_records id). Non-fatal.
  await syncKnowledgeToContextIndex({
    recordId,
    orgId,
    title: doc.title,
    body: rev.content,
  });

  return getDocument(orgId, documentId);
}

/** Archive a document: status=archived + REMOVE its knowledge_records row so it
 *  is no longer agent-searchable. History (documents/revisions) is preserved. */
export async function archiveDocument(orgId: string, documentId: string): Promise<WikiDocument | null> {
  await ready();
  const [doc] = await sql<{ id: string }[]>`
    SELECT id FROM knowledge_documents WHERE id = ${documentId} AND org_id = ${orgId} LIMIT 1
  `;
  if (!doc) return null;
  // Status flip + record removal in ONE tx, so an archived doc is never left
  // still-searchable (nor a still-published doc left without its record).
  const removedRecordId = await sql.begin(async (tx) => {
    await tx`
      UPDATE knowledge_documents SET status = 'archived', published_revision_id = NULL, updated_at = now()
      WHERE id = ${documentId} AND org_id = ${orgId}
    `;
    const rec = await findExisting(orgId, "wiki", `wiki:${documentId}`, tx);
    if (rec) {
      await deleteRecord(orgId, rec.id, tx);
      return rec.id;
    }
    return null;
  });
  // Best-effort: drop the projection for the archived record. Non-fatal.
  if (removedRecordId) await removeFromContextIndex(orgId, `knowledge:${removedRecordId}`);
  return getDocument(orgId, documentId);
}
