import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { runs } from "../../db/schema";
import { providerGatewayConfig, PROVIDER_GATEWAY_PATH } from "../../provider-gateway/config";
import { providerForEngine, type ProviderId } from "../../provider-gateway/provider";
import type { GatewayRun } from "../../provider-gateway/run-authorization";
import { mintProviderToken } from "../../provider-gateway/token";
import type { ToolTokenClaims } from "./token";

// ---------------------------------------------------------------------------
// Agent-callable WEB SEARCH tool. Paid provider traffic must cross the provider
// gateway: the gateway resolves the tenant credential, enforces the durable run's
// model and budgets, and writes the audit record. The knowledge gateway never
// reads a host provider key or sends one to the sandbox.
// ---------------------------------------------------------------------------

const MAX_RESULTS = 10;
const DEFAULT_MAX_USES = 5;
const REQUEST_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS) || 45_000;
// Per-run cap on web_search CALLS - a runaway agent can't spend unbounded search
// (each call is up to `max_uses` billed Anthropic searches). Best-effort in-memory
// (per backend process); a restart resets it, which is fine for a spend guard.
const PER_RUN_CALL_BUDGET = Number(process.env.WEB_SEARCH_RUN_BUDGET) || 40;
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

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebSearchToolDeps {
  readonly findRun?: (claims: ToolTokenClaims) => Promise<GatewayRun | null>;
  readonly providerConfig?: typeof providerGatewayConfig;
  readonly mintToken?: typeof mintProviderToken;
  readonly fetchGateway?: FetchLike;
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

/** Fold a Responses API result into the same provider-neutral shape used by the
 * Anthropic adapter. URL citations are the durable source links rendered to the
 * agent; the web_search_call item proves a live search actually ran. */
export function parseOpenAIWebSearchResponse(response: unknown): ParsedWebSearch {
  const root = response as { output?: unknown[] };
  const sources: ParsedWebSearch["sources"] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const textParts: string[] = [];
  let searched = false;

  for (const rawItem of Array.isArray(root?.output) ? root.output : []) {
    const item = rawItem as {
      type?: string;
      status?: string;
      error?: { code?: string; message?: string };
      content?: unknown[];
    };
    if (item.type === "web_search_call") {
      searched = true;
      if (item.status === "failed") {
        errors.push(item.error?.code ?? item.error?.message ?? "web_search_failed");
      }
    }
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const rawContent of item.content) {
      const content = rawContent as {
        type?: string;
        text?: string;
        annotations?: unknown[];
      };
      if (content.type !== "output_text") continue;
      if (typeof content.text === "string" && content.text.trim()) {
        textParts.push(content.text.trim());
      }
      for (const rawAnnotation of Array.isArray(content.annotations)
        ? content.annotations
        : []) {
        const annotation = rawAnnotation as { type?: string; url?: string; title?: string };
        if (annotation.type !== "url_citation" || !annotation.url || seen.has(annotation.url)) {
          continue;
        }
        seen.add(annotation.url);
        if (sources.length < MAX_RESULTS) {
          sources.push({ title: annotation.title ?? annotation.url, url: annotation.url });
        }
      }
    }
  }

  return { searched, sources, errors, text: textParts.join("\n").trim() };
}

/** Fold OpenRouter's model-agnostic web plugin response into the common search
 * shape. OpenRouter attaches standardized `url_citation` annotations to the
 * assistant message even when the selected model has no native search tool. */
export function parseOpenRouterWebSearchResponse(response: unknown): ParsedWebSearch {
  const root = response as { choices?: unknown[] };
  const sources: ParsedWebSearch["sources"] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];

  for (const rawChoice of Array.isArray(root?.choices) ? root.choices : []) {
    const choice = rawChoice as {
      message?: { content?: unknown; annotations?: unknown[] };
    };
    const message = choice.message;
    if (typeof message?.content === "string" && message.content.trim()) {
      textParts.push(message.content.trim());
    }
    for (const rawAnnotation of Array.isArray(message?.annotations)
      ? message.annotations
      : []) {
      const annotation = rawAnnotation as {
        type?: string;
        url_citation?: { url?: string; title?: string };
      };
      const citation = annotation.url_citation;
      if (
        annotation.type !== "url_citation" ||
        !citation?.url ||
        seen.has(citation.url)
      ) {
        continue;
      }
      seen.add(citation.url);
      if (sources.length < MAX_RESULTS) {
        sources.push({ title: citation.title ?? citation.url, url: citation.url });
      }
    }
  }

  return {
    searched: sources.length > 0,
    sources,
    errors: [],
    text: textParts.join("\n").trim(),
  };
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

export async function findRunningWebSearchRun(
  claims: ToolTokenClaims,
): Promise<GatewayRun | null> {
  const [row] = await db
    .select({
      id: runs.id,
      orgId: runs.orgId,
      userId: runs.userId,
      threadId: runs.threadId,
      engine: runs.engine,
      model: runs.model,
      status: runs.status,
    })
    .from(runs)
    .where(
      and(
        eq(runs.id, claims.runId),
        eq(runs.orgId, claims.orgId),
        eq(runs.threadId, claims.threadId),
        eq(runs.status, "running"),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.status !== "running" ||
    (row.userId ?? "") !== claims.userId
  ) {
    return null;
  }
  return { ...row, status: "running" };
}

function gatewayRequest(
  provider: ProviderId,
  run: GatewayRun,
  query: string,
  maxUses: number,
): { path: string; body: Record<string, unknown> } | null {
  const input =
    "Search the live web for the most relevant, up-to-date information. " +
    `Be concise and preserve source citations.\n\nQuery: ${query}`;
  if (provider === "openai") {
    return {
      path: `${PROVIDER_GATEWAY_PATH}/openai/v1/responses`,
      body: {
        model: run.model,
        max_output_tokens: 2_048,
        tools: [{ type: "web_search" }],
        input,
      },
    };
  }
  if (provider === "anthropic") {
    return {
      path: `${PROVIDER_GATEWAY_PATH}/anthropic/v1/messages`,
      body: {
        model: run.model,
        max_tokens: 2_048,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }],
        messages: [{ role: "user", content: input }],
      },
    };
  }
  if (provider === "openrouter") {
    return {
      path: `${PROVIDER_GATEWAY_PATH}/openrouter/v1/chat/completions`,
      body: {
        model: run.model,
        max_tokens: 2_048,
        messages: [{ role: "user", content: input }],
        plugins: [{ id: "web", max_results: Math.min(MAX_RESULTS, maxUses) }],
      },
    };
  }
  return null;
}

/** Run a query through the active run's provider-native search tool and return
 * sources plus a bounded synthesis. Identity comes only from the verified tool
 * token; the query is the only caller-supplied value. */
export async function executeWebSearchTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
  deps: WebSearchToolDeps = {},
): Promise<ToolResult> {
  if (name !== "web_search") return fail(`Unknown tool: ${name}`);

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("web_search requires a non-empty `query`.");

  const spent = runCalls.get(claims.runId) ?? 0;
  if (spent >= PER_RUN_CALL_BUDGET) {
    return fail(`web_search call budget exhausted for this run (${PER_RUN_CALL_BUDGET}). Use the results already gathered.`);
  }
  runCalls.set(claims.runId, spent + 1);

  const maxUses = Math.min(8, Math.max(1, Number(args.max_searches) || DEFAULT_MAX_USES));
  const config = (deps.providerConfig ?? providerGatewayConfig)();
  if (!config) return fail("web_search provider gateway is not configured.");

  try {
    const run = await (deps.findRun ?? findRunningWebSearchRun)(claims);
    if (!run) return fail("web_search capability is no longer attached to a running turn.");
    const provider = providerForEngine(run.engine, run.model);
    const request = provider ? gatewayRequest(provider, run, query, maxUses) : null;
    if (!provider || !request) {
      return fail(`web_search is not supported by the active provider (${provider ?? "none"}).`);
    }
    const token = (deps.mintToken ?? mintProviderToken)(
      {
        orgId: claims.orgId,
        userId: claims.userId,
        threadId: claims.threadId,
        issuedRunId: run.id,
        engine: run.engine,
        provider,
      },
      config.tokenTtlMs,
    );
    const response = await (deps.fetchGateway ?? fetch)(`${config.publicUrl}${request.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail = payload && typeof payload === "object"
        ? JSON.stringify(payload)
        : `HTTP ${response.status}`;
      return fail(`web_search gateway failed (${response.status}): ${detail}`);
    }

    const p = provider === "openai"
      ? parseOpenAIWebSearchResponse(payload)
      : provider === "openrouter"
        ? parseOpenRouterWebSearchResponse(payload)
        : parseWebSearchResponse(
          Array.isArray((payload as { content?: unknown[] } | null)?.content)
            ? (payload as { content: unknown[] }).content
            : [],
        );
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
