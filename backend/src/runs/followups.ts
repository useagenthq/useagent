/**
 * Follow-up suggestions (beautiful-ui answer grammar): after a run COMPLETES,
 * one cheap OpenRouter call turns the prompt + settled answer into 2-3 short
 * next questions, recorded as a durable `followups.suggested` useAgent frame on
 * the native lane (the same mechanism as the retrieval ledger, so it replays on
 * reload and streams live over the thread SSE). Strictly best-effort: no key, a
 * slow call, bad JSON, or a persist failure only logs - it never fails, delays,
 * or re-opens a settled run. Old clients parse the unknown eventType to null
 * and render nothing.
 */

import { recordProviderEvent } from "./provider-events";
import { resolveProviderCredentialForRun } from "../provider-gateway/credentials";

export const FOLLOWUPS_EVENT_TYPE = "followups.suggested";

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 120;
/** A summary shorter than this carries too little to suggest from. */
const MIN_SUMMARY_CHARS = 40;
const CALL_TIMEOUT_MS = 10_000;

/** Follow-ups are an explicit product opt-in, never an implicit house-key side effect. */
export function followupsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.FOLLOWUPS_ENABLED === "1";
}

/** The model follow-ups use: `FOLLOWUPS_MODEL` wins, else a cheap current slug. */
export function followupsModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.FOLLOWUPS_MODEL?.trim() || "anthropic/claude-haiku-4.5";
}

/**
 * Parse the model's reply into clean suggestions: a JSON string array (code
 * fences tolerated), each entry trimmed, deduped, non-empty, capped in count
 * and length. Anything unparseable yields [] - the caller records nothing.
 */
export function parseFollowupSuggestions(content: string): string[] {
  const unfenced = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, MAX_SUGGESTION_CHARS);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

async function generateSuggestions(
  prompt: string,
  summary: string,
  apiKey: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const baseUrl = env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/useagenthq/useagent",
      "X-Title": "useAgent Follow-ups",
    },
    body: JSON.stringify({
      model: followupsModel(env),
      temperature: 0,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You suggest what a user might ask next in an agent workspace, given " +
            "their task and the agent's final answer. Reply with ONLY a JSON array " +
            "of 2 or 3 short follow-up questions (each under 90 characters), no prose.",
        },
        {
          role: "user",
          content: `Task:\n${prompt.slice(0, 2000)}\n\nAgent's final answer:\n${summary.slice(0, 4000)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`openrouter ${res.status}: ${detail}`);
  }
  const body = (await res.json()) as ChatResponse;
  if (body.error) throw new Error(`openrouter error: ${body.error.message}`);
  return parseFollowupSuggestions(body.choices?.[0]?.message?.content ?? "");
}

/**
 * Generate + durably record follow-ups for a settled run. Never throws; call
 * fire-and-forget AFTER the finalize transaction commits (the run is already
 * settled - this only appends a frame the thread stream then delivers).
 */
export async function recordRunFollowups(run: {
  id: string;
  threadId: string;
  orgId: string;
  userId: string | null;
  prompt: string;
}, summary: string, deps: {
  env?: Record<string, string | undefined>;
  resolveCredential?: typeof resolveProviderCredentialForRun;
  fetch?: typeof fetch;
  recordEvent?: typeof recordProviderEvent;
} = {}): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    if (!followupsEnabled(env)) return;
    if (summary.trim().length < MIN_SUMMARY_CHARS) return;
    const resolveCredential = deps.resolveCredential ?? resolveProviderCredentialForRun;
    const credential = await resolveCredential({
      orgId: run.orgId,
      userId: run.userId,
      provider: "openrouter",
    });
    // Agent-run follow-ups must spend the run user's/org's credential. A shared
    // process key is never an acceptable fallback, even in development mode.
    if (!credential || credential.source === "backend_env") return;
    const suggestions = await generateSuggestions(
      run.prompt,
      summary,
      credential.value,
      env,
      deps.fetch ?? fetch,
    );
    if (suggestions.length === 0) return;
    await (deps.recordEvent ?? recordProviderEvent)({
      id: `folup_${run.id}`,
      runId: run.id,
      threadId: run.threadId,
      provider: "skynet",
      eventType: FOLLOWUPS_EVENT_TYPE,
      payload: { suggestions },
    });
  } catch (err) {
    console.warn(`[followups] suggestion generation failed for run ${run.id}:`, err);
  }
}
