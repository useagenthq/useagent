import { openCodeZenModelId, type ProviderId } from "./provider";
import type { GatewayRun } from "./run-authorization";

export type OutputLimitField = "max_tokens" | "max_output_tokens" | null;

export type ProviderBodyPolicyResult =
  | { readonly ok: false; readonly error: "invalid_json" | "request_too_deep" | "model_not_allowed" | "request_not_allowed" }
  | { readonly ok: false; readonly error: "output_limit_exceeded"; readonly requested: unknown }
  | { readonly ok: true; readonly body: string; readonly requestedOutputTokens: number };

/** How deep a request body may nest. Engine requests reach 12 (tool schemas);
 *  serializing or walking 100,000 levels overflows the stack. */
const MAX_REQUEST_DEPTH = 64;

/** Whether a JSON text nests deeper than MAX_REQUEST_DEPTH, read in one pass
 *  over its characters (strings skipped), before anything parses or walks it. */
function nestsTooDeep(body: string): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index += 1; // a backslash escapes the next character
      else if (char === 0x22) inString = false;
    } else if (char === 0x22) {
      inString = true;
    } else if (char === 0x7b || char === 0x5b) {
      depth += 1;
      if (depth > MAX_REQUEST_DEPTH) return true;
    } else if (char === 0x7d || char === 0x5d) {
      depth -= 1;
    }
  }
  return false;
}

/** The chat-completion fields an OpenRouter request may carry through the
 * gateway: the run's model, the conversation, sampling, streaming, function
 * tools and endpoint routing for that same model. Everything else is refused,
 * because OpenRouter also sells extras on the same endpoint (a fallback model
 * list, web search plugins, advisor server tools) that would be billed to the
 * key the gateway holds, even beside a ":free" model. */
const OPENROUTER_REQUEST_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens",
  "temperature", "top_p", "top_k", "min_p", "top_a", "frequency_penalty", "presence_penalty",
  "repetition_penalty", "seed", "stop", "n", "logit_bias", "logprobs", "top_logprobs",
  "response_format", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "reasoning_effort",
  "usage", "user", "provider", "transforms", "prediction", "verbosity", "metadata",
]);

/** Message parts a model reads itself. A file part (a PDF) makes OpenRouter
 * run a paid document parser when the model cannot read it natively, billed
 * beside a ":free" model, so it is refused. */
const OPENROUTER_CONTENT_PARTS = new Set(["text", "image_url", "input_audio"]);

function openRouterMessagesAllowed(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
      if (typeof type !== "string" || !OPENROUTER_CONTENT_PARTS.has(type)) return false;
    }
  }
  return true;
}

function openRouterRequestAllowed(body: Record<string, unknown>): boolean {
  for (const field of Object.keys(body)) {
    if (!OPENROUTER_REQUEST_FIELDS.has(field)) return false;
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return false;
    for (const tool of body.tools) {
      const type = tool && typeof tool === "object" ? (tool as { type?: unknown }).type : undefined;
      if (type !== "function") return false;
    }
  }
  return body.messages === undefined || openRouterMessagesAllowed(body.messages);
}

function requestModelMatchesRun(run: GatewayRun, requested: unknown): boolean {
  if (requested === run.model) return true;
  return (run.engine === "opencode" || run.engine === "pi") &&
    ((run.model.startsWith("openai/") && requested === run.model.slice("openai/".length)) ||
      (run.engine === "opencode" &&
        run.model.startsWith("cerebras/") &&
        requested === run.model.slice("cerebras/".length)) ||
      (run.engine === "opencode" &&
        run.model.startsWith("opencode/") &&
        requested === openCodeZenModelId(run.model)));
}

/**
 * Validate the paid request against the durable run and add a ceiling when the
 * provider endpoint supports one. The sandbox cannot select a second model or
 * silently remove the output cap.
 */
export function applyProviderBodyPolicy(
  run: GatewayRun,
  rawBody: string,
  outputLimitField: OutputLimitField,
  maxOutputTokens: number,
  provider: ProviderId | null = null,
): ProviderBodyPolicyResult {
  if (nestsTooDeep(rawBody)) return { ok: false, error: "request_too_deep" };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "invalid_json" };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  if (!requestModelMatchesRun(run, body.model)) {
    return { ok: false, error: "model_not_allowed" };
  }
  // A fallback list or a routing mode would let the provider swap in another
  // model, and bill for it, when the run's model fails; the run has one model.
  if ("models" in body || "route" in body) {
    return { ok: false, error: "model_not_allowed" };
  }
  if (provider === "openrouter" && !openRouterRequestAllowed(body)) {
    return { ok: false, error: "request_not_allowed" };
  }

  let requestedOutputTokens = 0;
  if (outputLimitField) {
    const requested = body[outputLimitField];
    if (requested === undefined) {
      body[outputLimitField] = maxOutputTokens;
    } else if (
      typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > maxOutputTokens
    ) {
      return { ok: false, error: "output_limit_exceeded", requested };
    }
    requestedOutputTokens = body[outputLimitField] as number;
  }

  return { ok: true, body: JSON.stringify(body), requestedOutputTokens };
}
