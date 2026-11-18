/** The first prompt of a forked thread: the source thread's history up to the
 * fork point, then the person's new request. The engine reads the whole prompt;
 * the UI reads `parseForkPrompt` to show only the request plus a link back.
 * Import-free so `cleanPrompt` can strip it without a module cycle. */

const HEADER = "[Forked thread]";
const CONTEXT_OPEN = /^<forked-context chars="(\d+)">\n/;
const CONTEXT_CLOSE = "\n</forked-context>\n\nNew request:\n";
const TRIMMED_NOTE = "> Earlier history was trimmed to fit.\n\n";

// Mirrors backend/src/commands/prompt-policy.ts: a prompt over either limit is refused.
const PROMPT_MAX_CHARS = 64_000;
const PROMPT_MAX_BYTES = 128 * 1024;

export interface ForkSource {
  /** The source thread's id, which is also its root run id (`/session/<id>`). */
  readonly threadId: string;
  /** 1-based turn the fork was cut after, inclusive. */
  readonly turn: number;
}

export interface ParsedForkPrompt {
  readonly source: ForkSource;
  readonly context: string;
  readonly request: string;
}

function preamble(source: ForkSource): string {
  return [
    HEADER,
    `Source: /session/${source.threadId}`,
    `Through turn: ${source.turn}`,
    "This conversation continues from the source thread above. Its history up to the fork point is below, followed by the new request.",
  ].join("\n");
}

function compose(source: ForkSource, context: string, request: string): string {
  return `${preamble(source)}\n\n<forked-context chars="${context.length}">\n${context}${CONTEXT_CLOSE}${request}`;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The newest part of `context` that keeps the whole prompt inside the backend's
 * limits. The fork point sits at the end, so the oldest history is what goes. */
function fitContext(source: ForkSource, context: string, request: string): string {
  const fits = (candidate: string) => {
    const prompt = compose(source, candidate, request);
    return prompt.length <= PROMPT_MAX_CHARS && utf8Bytes(prompt) <= PROMPT_MAX_BYTES;
  };
  if (fits(context)) return context;
  // Binary search the longest suffix that still fits once the note is added.
  let lo = 0;
  let hi = context.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(TRIMMED_NOTE + context.slice(context.length - mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? TRIMMED_NOTE + context.slice(context.length - lo) : "";
}

export function composeForkPrompt(source: ForkSource, context: string, request: string): string {
  const text = request.trim();
  return compose(source, fitContext(source, context.trim(), text), text);
}

export function parseForkPrompt(prompt: string): ParsedForkPrompt | null {
  if (!prompt.startsWith(`${HEADER}\n`)) return null;
  const head = /^\[Forked thread\]\nSource: \/session\/([^\s/]+)\nThrough turn: (\d+)\n[^\n]*\n\n/.exec(
    prompt,
  );
  if (!head) return null;
  const rest = prompt.slice(head[0].length);
  const open = CONTEXT_OPEN.exec(rest);
  if (!open) return null;
  const start = open[0].length;
  const end = start + Number(open[1]);
  if (rest.slice(end, end + CONTEXT_CLOSE.length) !== CONTEXT_CLOSE) return null;
  return {
    source: { threadId: head[1], turn: Number(head[2]) },
    context: rest.slice(start, end),
    request: rest.slice(end + CONTEXT_CLOSE.length),
  };
}

/** What the person typed, with the forked history removed. */
export function stripForkWrapper(prompt: string): string {
  return parseForkPrompt(prompt)?.request ?? prompt;
}
