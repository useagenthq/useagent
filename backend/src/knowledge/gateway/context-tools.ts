import {
  isContextKind,
  searchContext,
  getContextBySourceRef,
  CONTEXT_KINDS,
  type ContextKind,
} from "../../context/store";
import { parseCodeRef } from "../../context/code/projector";
import { readFileAtCommit } from "../../wiki-gen/clone";
import { resolveGithubRepositoryAccess } from "../../github/auth";
import { formatSkillMarkdown } from "../../skills/format";
import { resolveSkillSelection } from "../../skills/repo";
import { getScheduleForOrg } from "../../schedules/repo";
import { embeddingsEnabled, embedOne } from "../embed";
import { getRecord } from "../store";
import type { ToolCallResult } from "./descriptor";
import { executeGithubBackedOperation } from "./github-operation-bridge";
import type { ToolTokenClaims } from "./token";

export type { ToolCallResult } from "./descriptor";

// ---------------------------------------------------------------------------
// Unified Context Index gateway tools (Phase 1). READ-ONLY. One keyword search
// and one typed read over the context_index projection, scoped to the run's org
// (identity is resolved from the token; a tool arg NEVER carries a tenant id).
// The four physical stores stay separate and authoritative — these tools search
// the projection and dispatch a read back to the real store by source_ref kind.
//
// Bounded by construction: search top-K is hard-capped and snippets/read bodies
// are clamped, so a call can never return an unbounded dump.
// ---------------------------------------------------------------------------

const SNIPPET_MAX = 400; // chars per search-result snippet
const READ_MAX = 8_000; // chars for a single context_read body
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export const CONTEXT_TOOLS = [
  {
    name: "context_search",
    description:
      "Search this organization's UNIFIED context index across knowledge, skills, " +
      "playbooks, blueprints, automations, and repository CODE (docs, config, domains, " +
      "symbols, manifests) in ONE call. Returns bounded, typed results (kind, title, " +
      "snippet, source_ref, version) ranked by relevance. Use this first when you need " +
      "org-specific context and are not sure which store holds it - including terms that " +
      "live only in code; pass a source_ref to context_read for the full content or the " +
      "cited source excerpt.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...CONTEXT_KINDS] },
          description:
            "Optional filter to a subset of kinds (knowledge, skill, playbook, " +
            "blueprint, automation, memory, code). Omit to search every kind.",
        },
        repo: {
          type: "string",
          description:
            'Optional repository filter ("owner/name") that narrows results to CODE ' +
            "rows from that one repository. Ignored for non-code kinds.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Max results (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "context_read",
    description:
      "Resolve a source_ref from context_search to its FULL authoritative content " +
      "from the real store (skill/playbook body, knowledge document, automation " +
      "prompt) or, for a code: ref, the cited source excerpt fetched from the repo " +
      "at that commit. Org-scoped: it never returns another organization's row. " +
      "Refuses an unresolvable ref and names the remedy.",
    inputSchema: {
      type: "object",
      properties: {
        source_ref: {
          type: "string",
          description:
            'Stable typed pointer from a context_search result, e.g. "skill:<id>@<version>", ' +
            '"knowledge:<recordId>", "automation:<scheduleId>", ' +
            '"code:<owner/name>@<sha>:<file>#L<line>".',
        },
      },
      required: ["source_ref"],
      additionalProperties: false,
    },
  },
] as const;

export const CONTEXT_TOOL_NAMES: ReadonlySet<string> = new Set(CONTEXT_TOOLS.map((t) => t.name));

function clamp(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function error(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

function parseKinds(value: unknown): ContextKind[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const kinds = value.filter(
    (v): v is ContextKind => typeof v === "string" && isContextKind(v),
  );
  return kinds.length ? [...new Set(kinds)] : undefined;
}

async function doSearch(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return error("context_search requires a non-empty `query`.");
  }
  const rawLimit = typeof args.limit === "number" ? Math.floor(args.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MAX_LIMIT));
  const kinds = parseKinds(args.kinds);
  // `repo` narrows to CODE rows from that repo (filters on the code: source_ref).
  const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;

  // Bring our own query vector when embeddings are available; else keyword-only.
  let queryEmbedding: number[] | null = null;
  if (embeddingsEnabled()) {
    queryEmbedding = await embedOne(query).catch(() => null);
  }

  const hits = await searchContext({
    orgId: claims.orgId,
    query,
    kinds,
    repo,
    k: limit,
    queryEmbedding,
  });

  const results = hits.map((h) => ({
    kind: h.kind,
    title: h.title,
    snippet: clamp(h.snippet, SNIPPET_MAX),
    source_ref: h.source_ref,
    version: h.version,
  }));

  const text =
    results.length === 0
      ? `No context found for "${query}".`
      : results
          .map(
            (r) =>
              `[${r.kind}] ${r.title}${r.version != null ? ` (v${r.version})` : ""}\n${r.snippet}\nsource_ref: ${r.source_ref}`,
          )
          .join("\n\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      mode: queryEmbedding ? "hybrid" : "keyword",
      results,
    },
  };
}

/** Parse a source_ref into its kind family + raw id (+ optional version). Returns
 *  null for a malformed ref. Prefix families: "skill" (skill/playbook/blueprint,
 *  all resolved through the skills store), "knowledge", "automation", "memory". */
function parseSourceRef(
  ref: string,
): { prefix: string; id: string; version: number | null } | null {
  const colon = ref.indexOf(":");
  if (colon <= 0) return null;
  const prefix = ref.slice(0, colon);
  const rest = ref.slice(colon + 1);
  if (!rest) return null;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    const version = Number(rest.slice(at + 1));
    if (Number.isInteger(version) && version > 0) {
      return { prefix, id: rest.slice(0, at), version };
    }
  }
  return { prefix, id: rest, version: null };
}

async function readSkill(
  claims: ToolTokenClaims,
  id: string,
  version: number | null,
): Promise<ToolCallResult> {
  const pinned = await resolveSkillSelection(claims.orgId, {
    id,
    version: version ?? undefined,
  }).catch(() => null);
  if (!pinned) {
    return error(
      "That skill/playbook is not available to your organization (or the version is unknown). Run context_search again to get a current source_ref.",
    );
  }
  const body = clamp(formatSkillMarkdown(pinned.content), READ_MAX);
  return {
    content: [{ type: "text", text: body }],
    structuredContent: {
      kind: pinned.kind,
      source_ref: `skill:${pinned.skillId}@${pinned.version}`,
      version: pinned.version,
      contentHash: pinned.contentHash,
      body,
    },
  };
}

async function readKnowledge(claims: ToolTokenClaims, id: string): Promise<ToolCallResult> {
  const row = await getRecord(claims.orgId, id).catch(() => null);
  if (!row) {
    return error(
      "No knowledge item with that source_ref is available to your organization. Run context_search again to get a current source_ref.",
    );
  }
  const body = clamp(row.body, READ_MAX);
  return {
    content: [{ type: "text", text: `# ${row.title}\n\n${body}` }],
    structuredContent: {
      kind: "knowledge",
      source_ref: `knowledge:${row.id}`,
      title: row.title,
      body,
      refs: row.refs,
    },
  };
}

async function readAutomation(claims: ToolTokenClaims, id: string): Promise<ToolCallResult> {
  const schedule = await getScheduleForOrg(claims.orgId, id).catch(() => null);
  if (!schedule) {
    return error(
      "No automation with that source_ref is available to your organization. Run context_search again to get a current source_ref.",
    );
  }
  const body = clamp(schedule.prompt, READ_MAX);
  return {
    content: [
      {
        type: "text",
        text: `# ${schedule.name}\n\ncron: ${schedule.cron}\nenabled: ${schedule.enabled}\n\n${body}`,
      },
    ],
    structuredContent: {
      kind: "automation",
      source_ref: `automation:${schedule.id}`,
      title: schedule.name,
      cron: schedule.cron,
      enabled: schedule.enabled,
      body,
    },
  };
}

/** Lines of surrounding context returned around the cited line for a code: read. */
const CODE_CONTEXT_LINES = 20;

/** How a code: ref's file bytes are fetched at the pinned commit. Overridable for
 *  tests (production always fetches from the repo over git). */
type CodeFileReader = (
  repo: string,
  commitSha: string,
  file: string,
) => Promise<string | null>;
let codeFileReader: CodeFileReader | null = null;

/** Test-only seam: production always reads the excerpt from the repo at the sha. */
export function setCodeFileReaderForTest(reader: CodeFileReader | null): void {
  codeFileReader = reader;
}

/** Read a code: ref -> the cited file excerpt at that commit. ORG-SCOPED: the ref
 *  must resolve to a code row in THIS org's projection first (fail closed, no
 *  cross-tenant repo oracle), then the excerpt is fetched from the repo at the
 *  pinned commit. Bounded to a window around the cited line. */
async function readCode(claims: ToolTokenClaims, ref: string): Promise<ToolCallResult> {
  // Gate on the org's projection: a code row this org never indexed is not
  // readable through here (a valid ref for another org resolves to null).
  const projected = await getContextBySourceRef(claims.orgId, ref).catch(() => null);
  if (!projected || projected.kind !== "code") {
    return error(
      "That code source_ref is not available to your organization. Run context_search again to get a current source_ref.",
    );
  }
  const parsed = parseCodeRef(ref);
  if (!parsed) {
    return error(
      'That code source_ref is malformed. Use a value returned by context_search, e.g. "code:<owner/name>@<sha>:<file>#L<line>".',
    );
  }
  const text = await (async () => {
    if (codeFileReader) {
      return codeFileReader(parsed.repo, parsed.commitSha, parsed.file);
    }
    const access = await resolveGithubRepositoryAccess(claims.orgId);
    return readFileAtCommit(parsed.repo, parsed.commitSha, parsed.file, access);
  })().catch(() => null);
  if (text === null) {
    return error(
      `The cited file is no longer readable at that commit (${parsed.repo}@${parsed.commitSha.slice(0, 8)}:${parsed.file}). Run context_search again to get a current source_ref.`,
    );
  }
  const lines = text.split("\n");
  const start = Math.max(0, parsed.line - 1 - CODE_CONTEXT_LINES);
  const end = Math.min(lines.length, parsed.line + CODE_CONTEXT_LINES);
  const excerpt = lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join("\n");
  const body = clamp(excerpt, READ_MAX);
  const provenance = `${parsed.repo}@${parsed.commitSha}:${parsed.file}#L${parsed.line}`;
  return {
    content: [{ type: "text", text: `# ${parsed.file} (line ${parsed.line})\n${provenance}\n\n${body}` }],
    structuredContent: {
      kind: "code",
      source_ref: ref,
      repo: parsed.repo,
      commit: parsed.commitSha,
      file: parsed.file,
      line: parsed.line,
      body,
    },
  };
}

async function doRead(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const ref = typeof args.source_ref === "string" ? args.source_ref.trim() : "";
  if (!ref) {
    return error("context_read requires a `source_ref` from a context_search result.");
  }
  // A code: ref carries colons in its file path, so it can't go through the
  // colon-split parseSourceRef; dispatch it up front.
  if (ref.startsWith("code:")) {
    return readCode(claims, ref);
  }
  const parsed = parseSourceRef(ref);
  if (!parsed) {
    return error(
      'That source_ref is malformed. Use a value returned by context_search, e.g. "knowledge:<recordId>".',
    );
  }
  switch (parsed.prefix) {
    case "skill":
      return readSkill(claims, parsed.id, parsed.version);
    case "knowledge":
      return readKnowledge(claims, parsed.id);
    case "automation":
      return readAutomation(claims, parsed.id);
    case "memory":
      // Memory is projected into the index but resolves through the external
      // memory service, not a local content row; name the remedy tool.
      return error(
        "Memory items are read through the memory tools, not context_read. Use memory_search / the memory recall tools to retrieve this item.",
      );
    default:
      return error(
        `Unknown source_ref kind "${parsed.prefix}". Run context_search again to get a current source_ref.`,
      );
  }
}

/** Dispatch a validated tools/call. Identity is resolved from the token; this
 *  NEVER reads a tenant id from `args`. Unknown tool -> error result. */
export async function executeContextToolLocal(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  switch (name) {
    case "context_search":
      return doSearch(claims, args);
    case "context_read":
      return doRead(claims, args);
    default:
      return error(`Unknown tool: ${name}`);
  }
}

export async function executeContextTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const sourceRef = typeof args.source_ref === "string" ? args.source_ref.trim() : "";
  if (name !== "context_read" || !sourceRef.startsWith("code:")) {
    return executeContextToolLocal(claims, name, args);
  }
  return executeGithubBackedOperation(
    claims,
    "context",
    name,
    args,
    () => executeContextToolLocal(claims, name, args),
  );
}
