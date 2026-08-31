import { bodyLimit } from "hono/body-limit";
import {
  assertRunPromptLimit,
  RUN_PROMPT_MAX_BYTES,
  RUN_PROMPT_MAX_CHARS,
  RunPromptTooLargeError,
} from "../commands/prompt-policy";

export const RUN_CREATE_MAX_BODY_BYTES = 256 * 1024;
export { RUN_PROMPT_MAX_BYTES, RUN_PROMPT_MAX_CHARS };

export interface RunCreateBody {
  prompt?: unknown;
  model?: unknown;
  engine?: unknown;
  parent_run_id?: unknown;
  repo?: unknown;
  repos?: unknown;
  branches?: unknown;
  memory_scope?: unknown;
  skill?: unknown;
  command?: unknown;
  attachments?: unknown;
  resources?: unknown;
  origin?: unknown;
}

export function boundedRunPrompt(value: unknown):
  | { readonly ok: true; readonly prompt: string }
  | { readonly ok: false; readonly error: "prompt is required" | "prompt_too_large"; readonly status: 400 | 413 } {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (!prompt) return { ok: false, error: "prompt is required", status: 400 };
  try {
    assertRunPromptLimit(prompt);
  } catch (error) {
    if (error instanceof RunPromptTooLargeError) {
      return { ok: false, error: error.code, status: 413 };
    }
    throw error;
  }
  return { ok: true, prompt };
}

export const runCreateBodyLimit = bodyLimit({
  maxSize: RUN_CREATE_MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "request_too_large" }, 413),
});
