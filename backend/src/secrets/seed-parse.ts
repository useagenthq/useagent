import type { SecretKind } from "../db/schema";

// ---------------------------------------------------------------------------
// Pure parsing + kind classification for the seed script (scripts/seed-secrets.ts).
// Kept side-effect-free (no fs, no db) so it is unit-testable. A VALUE is never
// logged here - callers must uphold the same rule.
// ---------------------------------------------------------------------------

export interface ParsedEntry {
  /** The name AFTER normalization to an env-var identifier. */
  name: string;
  /** The raw key as it appeared in the source (a KEY, never a value). */
  rawKey: string;
  value: string;
  /** True when the source shape forces file-kind (a JSON object/array value). */
  forceFile: boolean;
}

export interface ParseResult {
  entries: ParsedEntry[];
  /** 1-based line numbers of malformed lines (env-format only). */
  malformed: number[];
  format: "env" | "json";
}

/** Uppercase + replace any non-identifier char with `_`. A leading digit or an
 *  empty result stays invalid (caught by isValidSecretName) and is reported. */
export function normalizeName(rawKey: string): string {
  return rawKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** Decide env vs file from the value SHAPE (never inspects the value's meaning). */
export function classifyKind(value: string, forceFile: boolean): SecretKind {
  if (forceFile) return "file";
  const t = value.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return "file"; // a JSON blob (service-account etc.)
    } catch {
      /* not JSON — fall through */
    }
  }
  if (t.includes("-----BEGIN")) return "file"; // PEM key / cert
  // A long, whitespace-free base64 blob (e.g. *_B64 service accounts).
  if (t.length >= 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(t)) return "file";
  return "env";
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse an env-format file body (KEY=VALUE lines; `export ` and quotes handled). */
export function parseEnv(text: string): ParseResult {
  const entries: ParsedEntry[] = [];
  const malformed: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return; // blank / comment
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      malformed.push(i + 1);
      return;
    }
    const rawKey = body.slice(0, eq).trim();
    const value = stripQuotes(body.slice(eq + 1));
    entries.push({ name: normalizeName(rawKey), rawKey, value, forceFile: false });
  });
  return { entries, malformed, format: "env" };
}

/** Parse a JSON file body: a name->value object, or one with `application_secrets`.
 *  Object/array values become file-kind (stringified); scalars become env-kind. */
export function parseJson(text: string): ParseResult {
  const root = JSON.parse(text) as Record<string, unknown>;
  const obj =
    root &&
    typeof root === "object" &&
    root.application_secrets &&
    typeof root.application_secrets === "object"
      ? (root.application_secrets as Record<string, unknown>)
      : root;
  const entries: ParsedEntry[] = [];
  for (const [rawKey, raw] of Object.entries(obj)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string") {
      entries.push({ name: normalizeName(rawKey), rawKey, value: raw, forceFile: false });
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      entries.push({ name: normalizeName(rawKey), rawKey, value: String(raw), forceFile: false });
    } else {
      // An object/array value → a file-shaped credential (stringified JSON).
      entries.push({ name: normalizeName(rawKey), rawKey, value: JSON.stringify(raw), forceFile: true });
    }
  }
  return { entries, malformed: [], format: "json" };
}

/** Pick a parser from the text shape (a `.json` name or a leading `{`). */
export function parseText(text: string, isJsonHint: boolean): ParseResult {
  if (isJsonHint || text.trimStart().startsWith("{")) {
    try {
      return parseJson(text);
    } catch {
      // A .json that doesn't parse → fall back to env-format (best effort).
    }
  }
  return parseEnv(text);
}
