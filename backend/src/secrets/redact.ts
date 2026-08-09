const REDACTED = "<redacted>";
const SIGNED_CAPABILITY_RE = /\bv1\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

export interface SecretRedactor {
  text(value: string): string;
  unknown<T>(value: T): T;
}

/** Build a per-run redactor from the values injected into that sandbox. Values
 * are held only in memory and never included in a durable marker. Longer values
 * run first so an overlapping short value cannot expose a secret suffix. */
export function createSecretRedactor(values: readonly string[]): SecretRedactor {
  const exact = [...new Set(values.filter((value) => value.length >= 4))]
    .toSorted((a, b) => b.length - a.length);

  const text = (value: string): string => {
    let safe = value;
    for (const secret of exact) safe = safe.replaceAll(secret, REDACTED);
    return safe.replace(SIGNED_CAPABILITY_RE, REDACTED).replace(JWT_RE, REDACTED);
  };

  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, visit(entry)]),
      );
    }
    return value;
  };

  return {
    text,
    unknown: <T>(value: T): T => visit(value) as T,
  };
}
