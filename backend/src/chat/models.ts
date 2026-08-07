/**
 * Served chat-model catalog (#122 follow-up). The single source of truth for the
 * lightweight Chat model picker: the OpenRouter slugs our key actually serves
 * (older/other slugs 404). Honest by construction - the UI renders exactly this
 * list, so a picked option always maps to a real model the backend will call.
 *
 * `chatModel()` (from ./stream) owns the DEFAULT; this only enumerates the
 * choices. Keep the list in sync with what the OpenRouter key serves.
 */
import { chatModel } from "./stream";

export interface ChatModelInfo {
  /** OpenRouter slug sent as `model` on POST /api/chat. */
  value: string;
  /** Display name. */
  label: string;
  /** Honest one-line description. */
  description: string;
}

/** Curated to the slugs the key serves (verified against OpenRouter /models). */
const SERVED: ChatModelInfo[] = [
  { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", description: "Fast and strong - the default" },
  { value: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", description: "Highest quality, slower" },
  { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", description: "Cheapest and fastest" },
  { value: "z-ai/glm-5.2", label: "GLM 5.2", description: "Open-weight alternative" },
];

/**
 * The served models + the current default. If `CHAT_MODEL` points at a slug not
 * in the curated list, surface it too (first, marked as the configured default)
 * so the picker never hides the model actually in use.
 */
export function chatModelCatalog(): { models: ChatModelInfo[]; default: string } {
  const def = chatModel();
  const models = SERVED.some((m) => m.value === def)
    ? SERVED
    : [{ value: def, label: def, description: "Configured via CHAT_MODEL" }, ...SERVED];
  return { models, default: def };
}
