/**
 * TTFT model-route benchmark (Perf Phase 4.4, task #194) - OPT-IN, run by hand.
 *
 * Measures streaming latency of the curated model routes so we can see, per route
 * and per prompt class, how long the first token takes and how fast tokens flow.
 * It is NOT part of the test suite: the filename does not match bun's test glob
 * (*.test.ts / *.spec.ts), so `bun test` never picks it up. Invoke explicitly:
 *
 *   cd backend && bun test/perf/ttft-bench.ts [--samples N] [--route <substr>]
 *
 * It talks straight to the providers over HTTP - no database, no backend boot, no
 * sandbox. Keys are read from the environment (bun auto-loads backend/.env). We
 * NEVER print keys, prompts, or response bodies: only timings, model ids, and
 * coarse error classes.
 *
 * Routes (curated ids come from src/runs/model-policy.ts):
 *   - OpenCode default: Kimi K3 via OpenRouter (DEFAULT_OPENCODE_MODEL)
 *   - claude-opus-5 / claude-sonnet-5 via OpenRouter (anthropic/ prefixed slugs)
 *   - claude-opus-5 / claude-sonnet-5 direct on Anthropic (only if ANTHROPIC_API_KEY set)
 *
 * Graceful degradation: a route whose key is absent is SKIPPED; an OpenRouter 403
 * "Key limit exceeded" (daily cap) or 429 is marked SKIP, not a failure; every
 * request has a 60s timeout; one route failing never aborts the whole run.
 */
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENCODE_MODEL,
  KIMI_K3_MODEL,
} from "../../src/runs/model-policy";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 256;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** The single shared tool schema (a browser_navigate-like tool). Identical across
 *  every route and every prompt class - only the user prompt changes. */
const TOOL_NAME = "browser_navigate";
const TOOL_DESCRIPTION = "Navigate the active browser tab to an absolute URL.";
const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    url: { type: "string", description: "The absolute URL to open, e.g. https://example.com" },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

type PromptClass = "simple" | "tool";

const PROMPTS: Record<PromptClass, string> = {
  // No tool use expected: a plain one-liner.
  simple: "In one short sentence, explain what a web browser is. Do not use any tools.",
  // Tool use instructed: the model should call browser_navigate, not answer in prose.
  tool: `Call the ${TOOL_NAME} tool to open https://example.com. Respond only with the tool call; do not write a text answer.`,
};

type RouteKind = "openrouter" | "anthropic";

interface Route {
  id: string; // display id
  kind: RouteKind;
  model: string; // slug sent on the wire
  keyName: "OPENROUTER_API_KEY" | "ANTHROPIC_API_KEY";
}

/** Curated routes. OpenRouter needs the `anthropic/` vendor prefix on claude slugs
 *  (see src/chat/stream.ts); direct Anthropic uses the bare model-policy ids. */
function buildRoutes(): Route[] {
  const routes: Route[] = [
    {
      id: `opencode-default (${DEFAULT_OPENCODE_MODEL})`,
      kind: "openrouter",
      model: KIMI_K3_MODEL,
      keyName: "OPENROUTER_API_KEY",
    },
    { id: "openrouter/claude-opus-5", kind: "openrouter", model: "anthropic/claude-opus-5", keyName: "OPENROUTER_API_KEY" },
    { id: "openrouter/claude-sonnet-5", kind: "openrouter", model: "anthropic/claude-sonnet-5", keyName: "OPENROUTER_API_KEY" },
    // Direct Anthropic (bare model-policy slugs). DEFAULT_CLAUDE_MODEL === claude-opus-5.
    { id: `anthropic-direct/${DEFAULT_CLAUDE_MODEL}`, kind: "anthropic", model: DEFAULT_CLAUDE_MODEL, keyName: "ANTHROPIC_API_KEY" },
    { id: "anthropic-direct/claude-sonnet-5", kind: "anthropic", model: "claude-sonnet-5", keyName: "ANTHROPIC_API_KEY" },
  ];
  return routes;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

interface SampleResult {
  ok: boolean;
  errorClass?: string; // "no-key" | "limit" | "timeout" | "http-4xx" | "http-5xx" | "network" | "empty-stream"
  ttftMs?: number; // request start -> first delta of any kind (content, thinking, or tool-call args)
  firstTextMs?: number | null; // request start -> first VISIBLE text delta (distinct from thinking)
  firstThinkingMs?: number | null; // request start -> first thinking/reasoning delta (null if none seen)
  totalMs?: number; // request start -> stream end
  outputTokens?: number | null; // from provider usage (null when not reported)
  tokensPerSec?: number | null;
  toolAttempted?: boolean; // did the model emit a tool call?
}

interface ClassResult {
  promptClass: PromptClass;
  samples: SampleResult[];
}

interface RouteResult {
  id: string;
  kind: RouteKind;
  model: string;
  status: "ok" | "skipped";
  skipReason?: string;
  classes: Record<PromptClass, ClassResult>;
}

// ---------------------------------------------------------------------------
// Streaming clients (return the raw per-sample metrics)
// ---------------------------------------------------------------------------

/** Classify a non-ok HTTP response without reading anything sensitive from the body. */
function classifyHttp(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 403 || status === 429 || lower.includes("limit exceeded") || lower.includes("rate limit")) {
    return "limit";
  }
  if (status === 401) return "auth"; // key rejected by this provider endpoint
  if (status >= 500) return "http-5xx";
  return "http-4xx";
}

/** Iterate complete `data:` SSE lines from a response body stream. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface StreamOutcome {
  ttftMs: number | null;
  firstTextMs: number | null;
  firstThinkingMs: number | null;
  totalMs: number;
  outputTokens: number | null;
  toolAttempted: boolean;
}

/** Stream one OpenRouter (OpenAI-shaped) chat completion and collect metrics. */
async function streamOpenRouter(route: Route, prompt: string, apiKey: string, signal: AbortSignal): Promise<StreamOutcome> {
  const start = performance.now();
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/skynet-saas/ttft-bench",
      "X-Title": "Skynet TTFT Bench",
    },
    body: JSON.stringify({
      model: route.model,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "function", function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS } }],
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new RouteError(classifyHttp(res.status, body));
  }

  let ttftMs: number | null = null;
  let firstTextMs: number | null = null;
  let firstThinkingMs: number | null = null;
  let outputTokens: number | null = null;
  let toolAttempted = false;

  for await (const data of sseLines(res.body)) {
    if (data === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue; // keep-alive / partial line
    }
    if (chunk?.error) throw new RouteError("http-4xx");
    if (chunk?.usage?.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) continue;
    const now = performance.now() - start;
    const reasoning = typeof delta.reasoning === "string" ? delta.reasoning : undefined;
    const content = typeof delta.content === "string" ? delta.content : undefined;
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined;
    if (reasoning && reasoning.length > 0) {
      if (firstThinkingMs === null) firstThinkingMs = now;
      if (ttftMs === null) ttftMs = now;
    }
    if (toolCalls && toolCalls.length > 0) {
      toolAttempted = true;
      if (ttftMs === null) ttftMs = now;
    }
    if (content && content.length > 0) {
      if (firstTextMs === null) firstTextMs = now;
      if (ttftMs === null) ttftMs = now;
    }
  }

  const totalMs = performance.now() - start;
  if (ttftMs === null) throw new RouteError("empty-stream");
  return { ttftMs, firstTextMs, firstThinkingMs, totalMs, outputTokens, toolAttempted };
}

/** Stream one Anthropic Messages API completion and collect metrics. */
async function streamAnthropic(route: Route, prompt: string, apiKey: string, signal: AbortSignal): Promise<StreamOutcome> {
  const start = performance.now();
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: route.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: TOOL_PARAMETERS }],
      stream: true,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new RouteError(classifyHttp(res.status, body));
  }

  let ttftMs: number | null = null;
  let firstTextMs: number | null = null;
  let firstThinkingMs: number | null = null;
  let outputTokens: number | null = null;
  let toolAttempted = false;

  for await (const data of sseLines(res.body)) {
    let evt: any;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (evt?.type === "error") throw new RouteError("http-4xx");
    const now = performance.now() - start;
    if (evt?.type === "content_block_start") {
      const block = evt.content_block;
      if (block?.type === "tool_use") {
        toolAttempted = true;
        if (ttftMs === null) ttftMs = now;
      }
    } else if (evt?.type === "content_block_delta") {
      const d = evt.delta;
      if (d?.type === "thinking_delta" || d?.type === "redacted_thinking") {
        if (firstThinkingMs === null) firstThinkingMs = now;
        if (ttftMs === null) ttftMs = now;
      } else if (d?.type === "text_delta") {
        if (firstTextMs === null) firstTextMs = now;
        if (ttftMs === null) ttftMs = now;
      } else if (d?.type === "input_json_delta") {
        // tool-call arguments streaming in
        if (ttftMs === null) ttftMs = now;
      }
    } else if (evt?.type === "message_delta") {
      if (evt.usage?.output_tokens != null) outputTokens = evt.usage.output_tokens;
    } else if (evt?.type === "message_stop") {
      break;
    }
  }

  const totalMs = performance.now() - start;
  if (ttftMs === null) throw new RouteError("empty-stream");
  return { ttftMs, firstTextMs, firstThinkingMs, totalMs, outputTokens, toolAttempted };
}

class RouteError extends Error {
  constructor(public errorClass: string) {
    super(errorClass);
  }
}

/** Run a single sample with a 60s timeout, returning a normalized SampleResult. */
async function runSample(route: Route, promptClass: PromptClass, apiKey: string): Promise<SampleResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const prompt = PROMPTS[promptClass];
    const outcome =
      route.kind === "openrouter"
        ? await streamOpenRouter(route, prompt, apiKey, controller.signal)
        : await streamAnthropic(route, prompt, apiKey, controller.signal);
    const tokensPerSec =
      outcome.outputTokens != null && outcome.totalMs > 0
        ? (outcome.outputTokens / outcome.totalMs) * 1000
        : null;
    return {
      ok: true,
      ttftMs: outcome.ttftMs ?? undefined,
      firstTextMs: outcome.firstTextMs,
      firstThinkingMs: outcome.firstThinkingMs,
      totalMs: outcome.totalMs,
      outputTokens: outcome.outputTokens,
      tokensPerSec,
      toolAttempted: outcome.toolAttempted,
    };
  } catch (err) {
    if (err instanceof RouteError) return { ok: false, errorClass: err.errorClass };
    if (controller.signal.aborted) return { ok: false, errorClass: "timeout" };
    return { ok: false, errorClass: "network" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Aggregation + reporting
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over a numeric sample set. */
function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length, Math.max(1, rank)) - 1];
}

function pick(samples: SampleResult[], field: (s: SampleResult) => number | null | undefined): number[] {
  return samples
    .filter((s) => s.ok)
    .map(field)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function fmtMs(v: number | null): string {
  return v === null ? "-" : `${Math.round(v)}`;
}

function fmtRate(v: number | null): string {
  return v === null ? "-" : v.toFixed(1);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padL(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

interface TableRow {
  route: string;
  cls: string;
  n: string;
  ttft: string;
  firstText: string;
  total: string;
  toks: string;
  tool: string;
  note: string;
}

function classRow(routeId: string, cls: ClassResult): TableRow {
  const okCount = cls.samples.filter((s) => s.ok).length;
  const total = cls.samples.length;
  const ttft = pick(cls.samples, (s) => s.ttftMs);
  const ftext = pick(cls.samples, (s) => s.firstTextMs ?? null);
  const dur = pick(cls.samples, (s) => s.totalMs);
  const rate = pick(cls.samples, (s) => s.tokensPerSec ?? null);
  const toolAttempts = cls.samples.filter((s) => s.ok && s.toolAttempted).length;
  const toolPct = okCount > 0 ? Math.round((toolAttempts / okCount) * 100) : 0;
  // Note: dominant error class among failures, if any.
  const errs = cls.samples.filter((s) => !s.ok).map((s) => s.errorClass ?? "err");
  const note = errs.length > 0 ? errs[0] : "";
  return {
    route: routeId,
    cls: cls.promptClass,
    n: `${okCount}/${total}`,
    ttft: `${fmtMs(percentile(ttft, 50))}/${fmtMs(percentile(ttft, 95))}`,
    firstText: `${fmtMs(percentile(ftext, 50))}/${fmtMs(percentile(ftext, 95))}`,
    total: `${fmtMs(percentile(dur, 50))}/${fmtMs(percentile(dur, 95))}`,
    toks: `${fmtRate(percentile(rate, 50))}/${fmtRate(percentile(rate, 95))}`,
    tool: `${toolPct}%`,
    note,
  };
}

function printTable(results: RouteResult[]): void {
  const rows: TableRow[] = [];
  for (const r of results) {
    if (r.status === "skipped") {
      rows.push({
        route: r.id,
        cls: "-",
        n: "SKIP",
        ttft: "-",
        firstText: "-",
        total: "-",
        toks: "-",
        tool: "-",
        note: r.skipReason ?? "skipped",
      });
      continue;
    }
    rows.push(classRow(r.id, r.classes.simple));
    rows.push(classRow(r.id, r.classes.tool));
  }

  const headers: TableRow = {
    route: "route",
    cls: "class",
    n: "ok/n",
    ttft: "ttft p50/p95",
    firstText: "firstText p50/p95",
    total: "total p50/p95",
    toks: "tok/s p50/p95",
    tool: "tool%",
    note: "note",
  };
  const all = [headers, ...rows];
  const w = {
    route: Math.max(...all.map((r) => r.route.length)),
    cls: Math.max(...all.map((r) => r.cls.length)),
    n: Math.max(...all.map((r) => r.n.length)),
    ttft: Math.max(...all.map((r) => r.ttft.length)),
    firstText: Math.max(...all.map((r) => r.firstText.length)),
    total: Math.max(...all.map((r) => r.total.length)),
    toks: Math.max(...all.map((r) => r.toks.length)),
    tool: Math.max(...all.map((r) => r.tool.length)),
    note: Math.max(...all.map((r) => r.note.length)),
  };
  const line = (r: TableRow) =>
    [
      pad(r.route, w.route),
      pad(r.cls, w.cls),
      padL(r.n, w.n),
      padL(r.ttft, w.ttft),
      padL(r.firstText, w.firstText),
      padL(r.total, w.total),
      padL(r.toks, w.toks),
      padL(r.tool, w.tool),
      pad(r.note, w.note),
    ].join("  ");

  const sep = "-".repeat(line(headers).length);
  console.log(line(headers));
  console.log(sep);
  for (const r of rows) console.log(line(r));
  console.log("\n(times in ms. ttft = first delta of any kind; firstText = first visible text delta.");
  console.log(" firstText '-' means no visible text arrived - e.g. a pure tool-call turn.)");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { samples: number; routeFilter: string | null } {
  let samples = 5;
  let routeFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--samples") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) samples = n;
    } else if (a === "--route") {
      routeFilter = argv[++i] ?? null;
    }
  }
  return { samples, routeFilter };
}

async function main(): Promise<void> {
  const { samples, routeFilter } = parseArgs(process.argv.slice(2));
  let routes = buildRoutes();
  if (routeFilter) routes = routes.filter((r) => r.id.includes(routeFilter));

  console.log(`TTFT model-route benchmark  |  samples=${samples}/route/class  |  timeout=${REQUEST_TIMEOUT_MS / 1000}s`);
  console.log(
    `keys: OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ? "set" : "absent"}  ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "set" : "absent"}\n`,
  );

  const results: RouteResult[] = [];

  for (const route of routes) {
    const apiKey = process.env[route.keyName];
    const base: RouteResult = {
      id: route.id,
      kind: route.kind,
      model: route.model,
      status: "ok",
      classes: {
        simple: { promptClass: "simple", samples: [] },
        tool: { promptClass: "tool", samples: [] },
      },
    };

    if (!apiKey) {
      results.push({ ...base, status: "skipped", skipReason: `no ${route.keyName}` });
      console.log(`- ${route.id}: SKIP (no ${route.keyName})`);
      continue;
    }

    let limited = false;
    for (const promptClass of ["simple", "tool"] as PromptClass[]) {
      for (let i = 0; i < samples; i++) {
        const sample = await runSample(route, promptClass, apiKey);
        base.classes[promptClass].samples.push(sample);
        if (!sample.ok && sample.errorClass === "limit") {
          limited = true;
          break;
        }
      }
      if (limited) break;
    }

    if (limited) {
      base.status = "skipped";
      base.skipReason = "key limit exceeded (daily cap)";
      console.log(`- ${route.id}: SKIP (key limit exceeded)`);
    } else {
      const okS = base.classes.simple.samples.filter((s) => s.ok).length;
      const okT = base.classes.tool.samples.filter((s) => s.ok).length;
      console.log(`- ${route.id}: done (simple ${okS}/${samples} ok, tool ${okT}/${samples} ok)`);
    }
    results.push(base);
  }

  console.log("");
  printTable(results);

  // Persist raw JSON (timings + model ids + error classes only - no bodies/keys).
  const nowUnix = Math.floor(Date.now() / 1000);
  const outDir = new URL("./results/", import.meta.url);
  await Bun.write(
    new URL(`ttft-${nowUnix}.json`, outDir),
    JSON.stringify(
      {
        generatedAtUnix: nowUnix,
        samplesPerClass: samples,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        routes: results,
      },
      null,
      2,
    ),
  );
  console.log(`\nRaw results -> backend/test/perf/results/ttft-${nowUnix}.json`);
}

await main();
