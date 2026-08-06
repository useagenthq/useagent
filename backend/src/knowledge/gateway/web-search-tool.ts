import Anthropic from "@anthropic-ai/sdk";
import type { ToolTokenClaims } from "./token";

// ---------------------------------------------------------------------------
// Agent-callable WEB SEARCH tool, backed by Anthropic's first-party web_search
// server tool (web_search_20250305). opencode ships only `webfetch` (fetch a
// KNOWN url) and exposes no way to enable the model provider's native search, so
// the resident agent otherwise reinvents search with curl + Google-scraping
// scripts that get bot-blocked. This gives it a real search primitive through the
// SAME trusted MCP gateway (run-scoped token; identity from the token, never an
// argument). Billed on the backend's ANTHROPIC_API_KEY - no external key.
// ---------------------------------------------------------------------------

const MAX_RESULTS = 10;
const DEFAULT_MAX_USES = 5;
// Fast, cheap model for search itself (the search quality is the tool's, not the
// model's reasoning). Overridable; web_search is a server tool available on
// current Claude models.
const SEARCH_MODEL = process.env.WEB_SEARCH_MODEL ?? "claude-haiku-4-5-20251001";

export const WEB_SEARCH_TOOL_NAMES = new Set(["web_search"]);

export const WEB_SEARCH_TOOLS = [
  {
    name: "web_search",
    description:
      "Search the live web and get back current results with source URLs and a " +
      "concise synthesis. Use this to FIND information online (news, companies, " +
      "prices, docs, people) instead of guessing a URL or scraping search engines. " +
      "Returns titles + URLs you can pass to webfetch, plus a short summary of what " +
      "the sources say. Prefer this over curl/webfetch-to-a-search-engine.",
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

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Run a query through Anthropic's native web_search and return the sources +
 *  synthesis as a bounded text block. Identity comes from the verified token;
 *  the query is the only caller-supplied value. */
export async function executeWebSearchTool(
  _claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name !== "web_search") return fail(`Unknown tool: ${name}`);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail("web_search is not configured (no ANTHROPIC_API_KEY on the server).");

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("web_search requires a non-empty `query`.");
  const maxUses = Math.min(8, Math.max(1, Number(args.max_searches) || DEFAULT_MAX_USES));

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: SEARCH_MODEL,
      max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses } as never],
      messages: [
        {
          role: "user",
          content:
            `Search the web for the most relevant, up-to-date information and answer the query. ` +
            `Be concise. Cite sources.\n\nQuery: ${query}`,
        },
      ],
    });

    // Collect the actual search results (url + title) and the model's synthesis
    // text from the response content blocks.
    const sources: { title: string; url: string; age?: string }[] = [];
    const textParts: string[] = [];
    for (const block of resp.content as unknown[]) {
      const b = block as {
        type?: string;
        text?: string;
        content?: { type?: string; url?: string; title?: string; page_age?: string }[];
      };
      if (b.type === "text" && b.text) textParts.push(b.text);
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) {
          if (r.type === "web_search_result" && r.url && sources.length < MAX_RESULTS) {
            sources.push({ title: r.title ?? r.url, url: r.url, age: r.page_age });
          }
        }
      }
    }

    if (sources.length === 0 && textParts.length === 0) {
      return fail(`web_search returned no results for "${query}".`);
    }

    const synthesis = textParts.join("\n").trim();
    const sourceList = sources
      .map((s, i) => `${i + 1}. ${s.title}${s.age ? ` (${s.age})` : ""}\n   ${s.url}`)
      .join("\n");
    const text =
      `Web search results for: ${query}\n\n` +
      (sourceList ? `Sources:\n${sourceList}\n\n` : "") +
      (synthesis ? `Summary:\n${synthesis}` : "");
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return fail(`web_search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
