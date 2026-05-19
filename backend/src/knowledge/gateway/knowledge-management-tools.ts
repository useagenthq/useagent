import {
  addRevision,
  archiveDocument,
  createDocument,
  getDocument,
  listDocuments,
  listRevisions,
  publishDocument,
  type DocStatus,
  type WikiDocument,
} from "../wiki";
import {
  KNOWLEDGE_DOC_STATUSES,
  KNOWLEDGE_LIST_DEFAULT_LIMIT,
  KNOWLEDGE_LIST_MAX_LIMIT,
} from "./knowledge-management-tool-catalog";
import type { ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";
import { errorResult, textResult } from "./tool-results";

const CONTENT_MAX = 8_000;
const SNIPPET_MAX = 600;
const REVISION_MAX = 20;

const FORBIDDEN_IDENTITY_ARGS = new Set([
  "orgId",
  "org_id",
  "organizationId",
  "organization_id",
  "tenantId",
  "tenant_id",
  "userId",
  "user_id",
  "actorUserId",
  "teamId",
  "team_id",
]);

export {
  KNOWLEDGE_MANAGEMENT_TOOL_NAMES,
  KNOWLEDGE_MANAGEMENT_TOOLS,
} from "./knowledge-management-tool-catalog";

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function bodyStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function limitArg(args: Record<string, unknown>): number {
  const raw =
    typeof args.limit === "number" ? Math.floor(args.limit) : KNOWLEDGE_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(raw, KNOWLEDGE_LIST_MAX_LIMIT));
}

function rejectIdentityArgs(args: Record<string, unknown>): ToolCallResult | null {
  const forbidden = Object.keys(args).filter((key) => FORBIDDEN_IDENTITY_ARGS.has(key));
  if (forbidden.length === 0) return null;
  return errorResult(
    `Knowledge management tools do not accept identity arguments (${forbidden.join(", ")}); org/user identity comes only from the signed gateway capability.`,
    { status: 400, forbidden },
  );
}

function boundedDocument(document: WikiDocument, includeContent: boolean): Record<string, unknown> {
  return {
    id: document.id,
    title: document.title,
    slug: document.slug,
    collection: document.collection,
    status: document.status,
    revisionId: document.revisionId,
    publishedRevisionId: document.publishedRevisionId,
    updatedAt: document.updatedAt,
    createdAt: document.createdAt,
    ...(includeContent
      ? { content: clamp(document.content, CONTENT_MAX) }
      : { contentSnippet: clamp(document.content, SNIPPET_MAX) }),
  };
}

async function getExistingDraft(
  orgId: string,
  documentId: string,
): Promise<WikiDocument | ToolCallResult> {
  const document = await getDocument(orgId, documentId).catch(() => null);
  if (!document) {
    return errorResult("Knowledge draft not found in your organization.", { status: 404 });
  }
  if (document.status !== "draft") {
    return errorResult(
      `Knowledge draft ${documentId} is ${document.status}; only draft documents can be updated through this tool.`,
      { status: 409, document: boundedDocument(document, false) },
    );
  }
  return document;
}

function conflictIfStale(document: WikiDocument, baseRevisionId: string | null): ToolCallResult | null {
  if (!baseRevisionId || baseRevisionId === document.revisionId) return null;
  return errorResult(
    `Knowledge draft has changed since revision ${baseRevisionId}; current revision is ${document.revisionId ?? "none"}.`,
    {
      status: 409,
      conflict: {
        expectedRevisionId: baseRevisionId,
        currentRevisionId: document.revisionId,
      },
    },
  );
}

function isToolCallResult(value: WikiDocument | ToolCallResult): value is ToolCallResult {
  return Array.isArray((value as ToolCallResult).content);
}

async function doCreate(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const title = stringArg(args, "title");
  const content = bodyStringArg(args, "content");
  if (!title) return errorResult("knowledge_draft_create requires `title`.", { status: 400 });
  if (!content.trim()) return errorResult("knowledge_draft_create requires non-empty `content`.", { status: 400 });

  const document = await createDocument({
    orgId: claims.orgId,
    userId: claims.userId || null,
    title,
    content,
    collection: optionalStringArg(args, "collection") ?? undefined,
    slug: optionalStringArg(args, "slug"),
    source: optionalStringArg(args, "source") ?? "gateway:draft",
    author: claims.userId || null,
  });

  return textResult(`Created draft ${document.id}: ${document.title}`, {
    document: boundedDocument(document, true),
  });
}

async function doList(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const rawStatus = stringArg(args, "status");
  const status = rawStatus === "" ? "draft" : rawStatus;
  if (status !== "all" && !KNOWLEDGE_DOC_STATUSES.includes(status as DocStatus)) {
    return errorResult("knowledge_draft_list status must be draft, published, archived, or all.", { status: 400 });
  }
  const limit = limitArg(args);
  const documents = await listDocuments(
    claims.orgId,
    status === "all" ? undefined : (status as DocStatus),
  );
  const bounded = documents.slice(0, limit).map((document) => boundedDocument(document, false));
  const text = bounded.length
    ? bounded.map((document) => `[${document.id}] ${document.title} (${document.status})`).join("\n")
    : `No ${status} knowledge drafts found.`;
  return textResult(text, {
    status,
    limit,
    documents: bounded,
    truncated: documents.length > bounded.length,
  });
}

async function doGet(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const documentId = stringArg(args, "documentId");
  if (!documentId) return errorResult("knowledge_draft_get requires `documentId`.", { status: 400 });

  const document = await getDocument(claims.orgId, documentId).catch(() => null);
  if (!document) return errorResult("Knowledge draft not found in your organization.", { status: 404 });

  const revisions = (await listRevisions(claims.orgId, document.id)).slice(0, REVISION_MAX).map((revision) => ({
    id: revision.id,
    source: revision.source,
    author: revision.author,
    createdAt: revision.created_at,
    content: clamp(revision.content, SNIPPET_MAX),
  }));

  return textResult(`# ${document.title}\n\n${clamp(document.content, CONTENT_MAX)}`, {
    document: boundedDocument(document, true),
    revisions,
  });
}

async function doUpdate(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const documentId = stringArg(args, "documentId");
  const content = bodyStringArg(args, "content");
  if (!documentId) return errorResult("knowledge_draft_update requires `documentId`.", { status: 400 });
  if (!content.trim()) return errorResult("knowledge_draft_update requires non-empty `content`.", { status: 400 });
  if (typeof args.title === "string" && args.title.trim()) {
    return errorResult(
      "Title updates are not supported by the current knowledge document schema; create a new draft or edit title through the human CRUD surface after schema support lands.",
      { status: 409, unsupported: "title_update" },
    );
  }

  const existing = await getExistingDraft(claims.orgId, documentId);
  if (isToolCallResult(existing)) return existing;
  const conflict = conflictIfStale(existing, optionalStringArg(args, "baseRevisionId"));
  if (conflict) return conflict;

  const revision = await addRevision(claims.orgId, documentId, {
    content,
    source: optionalStringArg(args, "source") ?? "gateway:draft_update",
    author: claims.userId || null,
  });
  if (!revision) return errorResult("Knowledge draft not found in your organization.", { status: 404 });
  const document = await getDocument(claims.orgId, documentId);
  return textResult(`Updated draft ${documentId} with revision ${revision.id}.`, {
    revisionId: revision.id,
    document: document ? boundedDocument(document, true) : null,
  });
}

async function doPublish(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const documentId = stringArg(args, "documentId");
  if (!documentId) return errorResult("knowledge_draft_publish requires `documentId`.", { status: 400 });
  const confirmed =
    args.confirmPublish === true ||
    (typeof args.confirmationToken === "string" && args.confirmationToken === `publish:${documentId}`);
  if (!confirmed) {
    return errorResult(
      "Publishing requires explicit confirmation: set confirmPublish=true or confirmationToken='publish:<documentId>' after the user confirms publication.",
      { status: 403, requiredConfirmationToken: `publish:${documentId}` },
    );
  }

  const document = await getDocument(claims.orgId, documentId).catch(() => null);
  if (!document) return errorResult("Knowledge draft not found in your organization.", { status: 404 });
  if (document.status === "archived") {
    return errorResult("Archived knowledge cannot be republished through the gateway; create a new draft instead.", {
      status: 409,
      document: boundedDocument(document, false),
    });
  }
  const conflict = conflictIfStale(document, optionalStringArg(args, "baseRevisionId"));
  if (conflict) return conflict;

  const revisionId = optionalStringArg(args, "revisionId") ?? undefined;
  const published = await publishDocument(claims.orgId, documentId, revisionId);
  if (!published) {
    return errorResult("Knowledge document or revision not found in your organization.", { status: 404 });
  }
  return textResult(`Published knowledge document ${published.id}: ${published.title}`, {
    document: boundedDocument(published, true),
  });
}

async function doArchive(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const documentId = stringArg(args, "documentId");
  if (!documentId) return errorResult("knowledge_draft_archive requires `documentId`.", { status: 400 });
  const document = await archiveDocument(claims.orgId, documentId);
  if (!document) return errorResult("Knowledge draft not found in your organization.", { status: 404 });
  return textResult(`Archived knowledge document ${document.id}: ${document.title}`, {
    document: boundedDocument(document, true),
  });
}

export async function executeKnowledgeManagementTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const identityError = rejectIdentityArgs(args);
  if (identityError) return identityError;

  switch (name) {
    case "knowledge_draft_create":
      return doCreate(claims, args);
    case "knowledge_draft_list":
      return doList(claims, args);
    case "knowledge_draft_get":
      return doGet(claims, args);
    case "knowledge_draft_update":
      return doUpdate(claims, args);
    case "knowledge_draft_publish":
      return doPublish(claims, args);
    case "knowledge_draft_archive":
      return doArchive(claims, args);
    default:
      return errorResult(`Unknown tool: ${name}`, { status: 400 });
  }
}
