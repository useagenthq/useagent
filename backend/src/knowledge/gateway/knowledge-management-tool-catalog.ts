import type { DocStatus } from "../wiki";

export const KNOWLEDGE_LIST_DEFAULT_LIMIT = 5;
export const KNOWLEDGE_LIST_MAX_LIMIT = 10;
export const KNOWLEDGE_DOC_STATUSES = [
  "draft",
  "published",
  "archived",
] as const satisfies readonly DocStatus[];

export const KNOWLEDGE_MANAGEMENT_TOOLS = [
  {
    name: "knowledge_draft_create",
    description:
      "Propose new organization knowledge as a draft document. This always creates a draft only; it is not searchable until knowledge_draft_publish is explicitly confirmed. Identity comes only from the gateway capability.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable draft title." },
        content: { type: "string", description: "Draft content to preserve as the first immutable revision." },
        collection: { type: "string", description: "Optional collection label; defaults to wiki." },
        slug: { type: "string", description: "Optional stable source slug." },
        source: { type: "string", description: "Optional source/provenance label for the revision." },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_draft_list",
    description:
      "List bounded organization knowledge drafts or suggestions. Defaults to draft status and never accepts org/user scope arguments.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["draft", "published", "archived", "all"],
          description: "Document status to list; defaults to draft.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: KNOWLEDGE_LIST_MAX_LIMIT,
          description: `Maximum documents to return (1-${KNOWLEDGE_LIST_MAX_LIMIT}, default ${KNOWLEDGE_LIST_DEFAULT_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_draft_get",
    description:
      "Read one bounded draft/suggestion document and its latest immutable revisions. Refuses ids outside the capability organization.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Draft/document id returned by knowledge_draft_create/list." },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_draft_update",
    description:
      "Update draft content by appending an immutable revision. Optional baseRevisionId provides optimistic conflict detection. Title/metadata edits are not supported by the current knowledge schema.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Draft id returned by knowledge_draft_create/list." },
        content: { type: "string", description: "Replacement draft content to store as a new immutable revision." },
        baseRevisionId: {
          type: "string",
          description: "Optional revision id the caller edited from; mismatches fail with conflict.",
        },
        source: { type: "string", description: "Optional source/provenance label for the revision." },
      },
      required: ["documentId", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_draft_publish",
    description:
      "Publish a draft so it becomes searchable organization knowledge. Requires confirmPublish=true or confirmationToken='publish:<documentId>' plus a live gateway capability.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Draft/document id to publish." },
        revisionId: { type: "string", description: "Optional exact revision id to publish; defaults to latest revision." },
        baseRevisionId: {
          type: "string",
          description: "Optional current revision guard; mismatches fail with conflict before publishing.",
        },
        confirmPublish: {
          type: "boolean",
          description: "Must be true after an explicit user confirmation to publish.",
        },
        confirmationToken: {
          type: "string",
          description: "Alternative explicit confirmation token: publish:<documentId>.",
        },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_draft_archive",
    description:
      "Archive a draft or published knowledge document. This is non-destructive: history is preserved and published records are removed from retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Draft/document id to archive." },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
] as const;

export const KNOWLEDGE_MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  KNOWLEDGE_MANAGEMENT_TOOLS.map((tool) => tool.name),
);
