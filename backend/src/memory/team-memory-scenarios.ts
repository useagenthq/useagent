const MAX_L3_CHARS = 700;

export function stringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return undefined;
}

export function boundedL3(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  return normalized.length > MAX_L3_CHARS ? `${normalized.slice(0, MAX_L3_CHARS)}...` : normalized;
}

export function scenarioPath(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return stringField(value, ["path"]);
}

export function scenarioContent(value: unknown): string | undefined {
  return stringField(value, ["content", "summary", "text"]);
}

export function coreContent(value: unknown): string | undefined {
  return stringField(value, ["persona", "profile", "summary", "content", "text", "description"]);
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function rankScenarioEntries(
  query: string,
  entries: readonly unknown[],
  limit: number,
): unknown[] {
  const tokens = queryTokens(query);
  return entries
    .map((entry, index) => {
      const haystack = [scenarioPath(entry), stringField(entry, ["summary", "content", "text"])]
        .filter((value): value is string => value !== undefined)
        .join(" ")
        .toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { entry, index, score };
    })
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
