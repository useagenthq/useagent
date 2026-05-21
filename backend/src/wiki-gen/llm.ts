/**
 * OpenRouter chat client for wiki generation. Plain-text (markdown/XML) output,
 * non-streaming. Follows the same OpenRouter convention as the knowledge
 * distiller (src/knowledge/distill/distill.ts): Bearer key, attribution headers,
 * a hard request deadline.
 *
 * The generator takes a `WikiLlm` function so tests can inject a deterministic
 * fake and never touch the network.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A text-in/text-out completion. Implementations resolve to the model's text. */
export type WikiLlm = (messages: ChatMessage[], opts?: { maxTokens?: number }) => Promise<string>;

export class WikiLlmError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.retryable = options.retryable ?? false;
  }
}

export function isRetryableWikiLlmError(error: unknown): boolean {
  return error instanceof WikiLlmError && error.retryable;
}

const TIMEOUT_MS = Number(process.env.WIKI_GEN_TIMEOUT_MS) || 150_000;

function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** True when the LLM is configured (an OpenRouter key is present). */
export function wikiLlmEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** The model wiki generation uses. Falls back to the distiller's model so a
 *  deployment that runs the knowledge pipeline needs no extra config. */
export function wikiModel(): string {
  return opt("WIKI_GEN_MODEL", opt("DISTILL_MODEL", "z-ai/glm-5.2"));
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  error?: { message?: string };
}

/**
 * The real OpenRouter-backed completion. Throws WikiLlmError when no key is
 * configured (the job surfaces this honestly) or the call fails.
 */
export const openRouterLlm: WikiLlm = async (messages, opts) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new WikiLlmError("OPENROUTER_API_KEY is not configured");

  const baseUrl = opt("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/skynet-saas/wiki-gen",
        "X-Title": "Skynet Wiki Generator",
      },
      body: JSON.stringify({
        model: wikiModel(),
        temperature: 0,
        max_tokens: opts?.maxTokens ?? 8000,
        messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WikiLlmError(`openrouter request failed: ${message}`, {
      retryable: true,
      cause: error,
    });
  }
  if (!res.ok) {
    const retryable =
      res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    const body = (await res.text()).slice(0, 200);
    throw new WikiLlmError(`openrouter ${res.status}: ${body}`, { retryable });
  }

  const body = (await res.json()) as ChatResponse;
  if (body.error) throw new WikiLlmError(`openrouter error: ${body.error.message}`);
  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new WikiLlmError("openrouter returned empty content");
  return content;
};
