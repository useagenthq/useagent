import type { CanonicalChildState } from "./canonical";

const MAX_PREVIEW_CHARS = 240;

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value)?.trim();
    if (text) return text;
  }
  return null;
}

export function boundedPreview(...values: unknown[]): string | undefined {
  const text = firstString(...values)?.replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS - 1)}…`
    : text;
}

function childUsage(value: unknown): Readonly<Record<string, number>> | undefined {
  const raw = recordValue(value);
  if (!raw) return undefined;
  const usage = Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
    ),
  );
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Typed usage counters carried by an opencode `part.step-finish` payload
 *  (`tokens.{input,output,reasoning}`, `tokens.cache.read`, `cost`). Key names
 *  match the runtime lane's typed usage so ONE consumer serves both lanes.
 *  Returns undefined when the payload carries no usable counter - a synthesized
 *  or empty step-finish never fabricates usage. */
export function stepFinishUsage(
  payload: Record<string, unknown> | null,
): Record<string, number> | undefined {
  if (!payload) return undefined;
  const tokens = recordValue(payload.tokens);
  const cache = recordValue(tokens?.cache);
  const usage: Record<string, number> = {};
  const put = (key: string, value: unknown): void => {
    const n = numberValue(value);
    if (n !== null && n >= 0) usage[key] = n;
  };
  put("inputTokens", tokens?.input);
  put("outputTokens", tokens?.output);
  put("reasoningOutputTokens", tokens?.reasoning);
  put("cachedInputTokens", cache?.read);
  put("costUsd", payload.cost);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function canonicalChildState(
  payload: Record<string, unknown> | null,
  fallback: { summary?: string; lastToolName?: string } = {},
): CanonicalChildState | undefined {
  if (!payload) return undefined;
  const input = recordValue(payload.input);
  const status = firstString(payload.status) ?? undefined;
  const prompt = firstString(payload.prompt, input?.prompt) ?? undefined;
  const summary = firstString(payload.summary, payload.detail, fallback.summary) ?? undefined;
  const lastToolName = firstString(payload.lastToolName, fallback.lastToolName) ?? undefined;
  const usage = childUsage(payload.typedUsage ?? payload.usage);
  const model = firstString(payload.model) ?? undefined;
  const role = firstString(payload.role) ?? undefined;
  const resumable = typeof payload.resumable === "boolean" ? payload.resumable : undefined;
  if (!status && !prompt && !summary && !lastToolName && !usage && !model && !role && resumable === undefined) {
    return undefined;
  }
  return {
    ...(status ? { status } : {}),
    ...(prompt ? { prompt } : {}),
    ...(summary ? { summary } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
    ...(role ? { role } : {}),
    ...(resumable !== undefined ? { resumable } : {}),
  };
}
