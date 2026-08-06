import Anthropic from "@anthropic-ai/sdk";
import type { ToolTokenClaims } from "./token";

// ---------------------------------------------------------------------------
// Agent-callable WEB SEARCH tool, backed by Anthropic's first-party web_search
// server tool (web_search_20250305). opencode ships only `webfetch` (fetch a
// KNOWN url) and exposes no way to enable the model provider's native search, so
// the resident agent otherwise reinvents search with curl + Google-scraping that
// gets bot-blocked. This gives it a real search primitive through the SAME
// trusted MCP gateway (run-scoped token; identity from the token, never an
// argument). Billed on the backend's ANTHROPIC_API_KEY - no external key.
// ---------------------------------------------------------------------------

const MAX_RESULTS = 10;
const DEFAULT_MAX_USES = 5;
const REQUEST_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS) || 45_000;
// Per-run cap on web_search CALLS - a runaway agent can't spend unbounded search
// (each call is up to `max_uses` billed Anthropic searches). Best-effort in-memory
// (per backend process); a restart resets it, which is fine for a spend guard.
const PER_RUN_CALL_BUDGET = Number(process.env.WEB_SEARCH_RUN_BUDGET) || 40;
// Fast, cheap model for the search itself (quality is the web_search tool's, not
// the model's reasoning). Overridable; web_search is a server tool on current models.
const SEARCH_MODEL = process.env.WEB_SEARCH_MODEL ?? "claude-haiku-4-5-20251001";

const runCalls = new Map<string, number>();

export const WEB_SEARCH_TOOL_NAMES = new Set(["web_search"]);

export const WEB_SEARCH_TOOLS = [
  {
    name: "web_search",
    description:
      "Search the live web and get back current results with source URLs and a " +
      "concise, cited synthesis. Use this to FIND information online (news, " +
      "companies, prices, docs, people) instead of guessing a URL or scraping " +
      "search engines with curl. Returns titles + URLs you can pass to webfetch, " +
      "plus a short summary of what the sources say.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for (natural language)." },
        max_searches: {
          type: "integer",
          description: `How many searches the tool may run for this query (1-8, default ${DEFAULT_MAX_USES}).`,
          minimum: 1,
          maximum: 8,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
] as const;

interface TextContent {
  type: "text";
  text: string;
}
interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface ParsedWebSearch {
  /** Whether a live search actually ran (a server_tool_use / web_search_tool_result
   *  block was present). If false, the model answered from prior knowledge. */
  searched: boolean;
  sources: { title: string; url: string; age?: string }[];
  /** Structured search errors Anthropic returns INSIDE a 200 response. */
  errors: string[];
  text: string;
}

/** Pure: fold Anthropic response content blocks into sources + whether a search
 *  actually ran + any structured search errors + the synthesis text. Takes runtime
 *  blocks (heterogeneous union) and narrows by `type` - unit-tested with fixtures. */
export function parseWebSearchResponse(content: readonly unknown[]): ParsedWebSearch {
  const sources: ParsedWebSearch["sources"] = [];
  const errors: string[] = [];
  const textParts: string[] = [];
  let searched = false;
  for (const raw of content) {
    const b = raw as {
      type?: string;
      name?: string;
      text?: string;
      content?: unknown;
      error_code?: string;
    };
    if (b.type === "server_tool_use" && b.name === "web_search") searched = true;
    if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
    if (b.type === "web_search_tool_result") {
      searched = true;
      const c = b.content;
      if (c && !Array.isArray(c) && (c as { type?: string }).type === "web_search_tool_result_error") {
        errors.push(String((c as { error_code?: string }).error_code ?? "unknown_error"));
      } else if (Array.isArray(c)) {
        for (const r of c as { type?: string; url?: string; title?: string; page_age?: string }[]) {
          if (r?.type === "web_search_result" && r.url && sources.length < MAX_RESULTS) {
            sources.push({ title: r.title ?? r.url, url: r.url, age: r.page_age });
          }
        }
      }
    }
  }
  return { searched, sources, errors, text: textParts.join("\n").trim() };
}

function render(query: string, p: ParsedWebSearch): string {
  const sourceList = p.sources
    .map((s, i) => `${i + 1}. ${s.title}${s.age ? ` (${s.age})` : ""}\n   ${s.url}`)
    .join("\n");
  return (
    `Web search results for: ${query}\n\n` +
    (sourceList ? `Sources:\n${sourceList}\n\n` : "") +
    (p.text ? `Summary:\n${p.text}` : "")
  );
}

/** Run a query through Anthropic's native web_search and return the sources +
 *  synthesis as a bounded text block. Identity comes from the verified token; the
 *  query is the only caller-supplied value. */
export async function executeWebSearchTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name !== "web_search") return fail(`Unknown tool: ${name}`);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail("web_search is not configured (no ANTHROPIC_API_KEY on the server).");

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("web_search requires a non-empty `query`.");

  const spent = runCalls.get(claims.runId) ?? 0;
  if (spent >= PER_RUN_CALL_BUDGET) {
    return fail(`web_search call budget exhausted for this run (${PER_RUN_CALL_BUDGET}). Use the results already gathered.`);
  }
  runCalls.set(claims.runId, spent + 1);

  const maxUses = Math.min(8, Math.max(1, Number(args.max_searches) || DEFAULT_MAX_USES));
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create(
      {
        model: SEARCH_MODEL,
        max_tokens: 2048,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }],
        messages: [
          {
            role: "user",
            content:
              `Search the web for the most relevant, up-to-date information and answer the query. ` +
              `Be concise. Cite sources.\n\nQuery: ${query}`,
          },
        ],
      },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    const p = parseWebSearchResponse(resp.content);
    if (!p.searched) {
      return fail(
        `web_search did not run a live search for "${query}" (the model answered from prior knowledge). ` +
          `Rephrase to force a search, or use webfetch on a specific URL.`,
      );
    }
    if (p.sources.length === 0 && p.errors.length > 0) {
      return fail(`web_search error(s) for "${query}": ${p.errors.join(", ")}`);
    }
    if (p.sources.length === 0 && !p.text) {
      return fail(`web_search returned no usable results for "${query}".`);
    }
    return { content: [{ type: "text", text: render(query, p) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`web_search failed: ${msg}`);
  }
}
