import { asRecord } from "./types";

export interface ChildUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

const OPTIONAL_USAGE_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "toolUses",
  "durationMs",
  "costUsd",
] as const satisfies readonly (keyof ChildUsage)[];

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalCount(
  key: (typeof OPTIONAL_USAGE_KEYS)[number],
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  const value = count(raw[key]);
  return value === undefined ? {} : { [key]: value };
}

/** Normalize provider-cumulative child usage. When a provider omits its total,
 * token parts are summed; cached input stays metadata because it is part of input. */
export function normalizeChildUsage(value: unknown): ChildUsage | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const tokenParts = [
    count(raw.inputTokens),
    count(raw.outputTokens),
    count(raw.reasoningOutputTokens),
  ];
  const inferredTotal = tokenParts.some((part) => part !== undefined)
    ? tokenParts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
    : undefined;
  const totalTokens = count(raw.totalTokens) ?? inferredTotal;
  if (totalTokens === undefined) return null;

  return {
    totalTokens,
    ...optionalCount("inputTokens", raw),
    ...optionalCount("cachedInputTokens", raw),
    ...optionalCount("outputTokens", raw),
    ...optionalCount("reasoningOutputTokens", raw),
    ...optionalCount("toolUses", raw),
    ...optionalCount("durationMs", raw),
    ...optionalCount("costUsd", raw),
  };
}

function optionalMax(
  key: (typeof OPTIONAL_USAGE_KEYS)[number],
  current: ChildUsage,
  incoming: ChildUsage,
): Readonly<Record<string, number>> {
  const currentValue = current[key];
  const incomingValue = incoming[key];
  if (currentValue === undefined)
    return incomingValue === undefined ? {} : { [key]: incomingValue };
  return {
    [key]: incomingValue === undefined ? currentValue : Math.max(currentValue, incomingValue),
  };
}

/** Max-merge cumulative snapshots so duplicate and late frames are idempotent. */
export function mergeChildUsage(
  current: ChildUsage | null,
  incoming: ChildUsage | null,
): ChildUsage | null {
  if (!incoming) return current;
  if (!current) return incoming;

  return {
    totalTokens: Math.max(current.totalTokens, incoming.totalTokens),
    ...optionalMax("inputTokens", current, incoming),
    ...optionalMax("cachedInputTokens", current, incoming),
    ...optionalMax("outputTokens", current, incoming),
    ...optionalMax("reasoningOutputTokens", current, incoming),
    ...optionalMax("toolUses", current, incoming),
    ...optionalMax("durationMs", current, incoming),
    ...optionalMax("costUsd", current, incoming),
  };
}
