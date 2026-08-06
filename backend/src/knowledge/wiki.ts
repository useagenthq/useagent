import { contentHash } from "./distill";
import { embedOne, embeddingsEnabled } from "./embed";
import {
  deleteRecord,
  findExisting,
  ready,
  sql,
  upsertRecord,
} from "./store";

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

/** Full immutable revision history for a document (org-scoped), newest first. */
export async function listRevisions(
  orgId: string,
  documentId: string,
): Promise<{ id: string; content: string; source: string | null; author: string | null; created_at: string }[]> {
  await ready();
  return sql`
    SELECT id, content, source, author, created_at
    FROM knowledge_revisions
    WHERE org_id = ${orgId} AND document_id = ${documentId}
    ORDER BY created_at DESC
  ` as Promise<{ id: string; content: string; source: string | null; author: string | null; created_at: string }[]>;
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
  await sql.begin(async (tx) => {
    await tx`
      UPDATE knowledge_documents
      SET status = 'published', published_revision_id = ${rev.id}, updated_at = now()
      WHERE id = ${documentId} AND org_id = ${orgId}
    `;
    await upsertRecord(
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
  await sql.begin(async (tx) => {
    await tx`
      UPDATE knowledge_documents SET status = 'archived', published_revision_id = NULL, updated_at = now()
      WHERE id = ${documentId} AND org_id = ${orgId}
    `;
    const rec = await findExisting(orgId, "wiki", `wiki:${documentId}`, tx);
    if (rec) await deleteRecord(orgId, rec.id, tx);
  });
  return getDocument(orgId, documentId);
}
