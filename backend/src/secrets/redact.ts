const REDACTED = "<redacted>";
const SIGNED_CAPABILITY_RE = /\bv1\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

// Pattern scrub for INLINE credentials that are not registered org secrets -
// procedure traces now record command lines and file paths (the value could be
// a literal in the command), so exact-value redaction alone is insufficient.
// Each pattern keeps the identifying prefix and redacts the secret token.
const INLINE_CREDENTIAL_RES: readonly [RegExp, string][] = [
  // Authorization: Bearer <token> / Basic <token>
  [/\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // Bare provider key shapes (OpenAI sk-, GitHub gh?_, Slack xox?-, AWS AKIA)
  [/\b(sk|rk)-[A-Za-z0-9]{16,}\b/gi, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gi, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // key=value / password=value / token=value / secret=value (shell + query)
  [/\b((?:api[_-]?key|password|passwd|pgpassword|secret|token|access[_-]?token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"'&]{4,})/gi, `$1${REDACTED}`],
  // -p<value> / --password <value> CLI shapes
  [/(\s-p)[^\s]{4,}/g, `$1${REDACTED}`],
  [/(\s--password(?:=|\s+))[^\s]{4,}/g, `$1${REDACTED}`],
];

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
    safe = safe.replace(SIGNED_CAPABILITY_RE, REDACTED).replace(JWT_RE, REDACTED);
    for (const [pattern, replacement] of INLINE_CREDENTIAL_RES) {
      safe = safe.replace(pattern, replacement);
    }
    return safe;
  };

  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          text(key),
          visit(entry),
        ]),
      );
    }
    return value;
  };

  return {
    text,
    unknown: <T>(value: T): T => visit(value) as T,
  };
}
