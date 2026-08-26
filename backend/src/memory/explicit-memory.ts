/**
 * The explicit-memory ENVELOPE (new_mem_prompt.md section 6).
 *
 * Tencent v3 has no direct L1-create endpoint, so an explicit "remember X" is
 * written as a structured L0 conversation message and Tencent distills L1/L2/L3
 * from it asynchronously. This module owns the ONE envelope syntax — a
 * machine-parseable, human-readable block embedded as the L0 message content — so
 * retries, versions and corrections reconcile against Tencent WITHOUT a second
 * fact store in Postgres. Pure + dependency-free so it unit-tests standalone.
 *
 *   [skynet-explicit-memory]
 *   logical_id: <stable uuid across versions/corrections>
 *   operation_id: <stable idempotency id for THIS write>
 *   version: 1
 *   kind: preference
 *   key: favourite_color
 *   state: active
 *   content: The user's favourite color is blue.
 *
 * Identity fields (logical_id/operation_id/version/state) are useAgent-owned and
 * must never be taken from arbitrary prompt text; only `kind`, `key` and
 * `content` originate from the caller.
 */

export const EXPLICIT_MEMORY_TAG = "[skynet-explicit-memory]";

export const EXPLICIT_MEMORY_KINDS = ["preference", "fact", "note"] as const;
export type ExplicitMemoryKind = (typeof EXPLICIT_MEMORY_KINDS)[number];

export const EXPLICIT_MEMORY_STATES = ["active", "superseded", "tombstoned"] as const;
export type ExplicitMemoryState = (typeof EXPLICIT_MEMORY_STATES)[number];

/** Bound on the human-readable content of one explicit memory. */
export const EXPLICIT_CONTENT_MAX = 2000;

export interface ExplicitMemoryEnvelope {
  /** Stable across every version/correction of the same logical memory. */
  readonly logicalId: string;
  /** Stable idempotency id for THIS specific write (reconcile a timed-out retry). */
  readonly operationId: string;
  /** 1-based; bumped by a correction that supersedes the prior version. */
  readonly version: number;
  readonly kind: ExplicitMemoryKind;
  /** Optional dedupe key within a pool (e.g. `favourite_color`). */
  readonly key?: string;
  readonly state: ExplicitMemoryState;
  readonly content: string;
}

function isKind(v: string): v is ExplicitMemoryKind {
  return (EXPLICIT_MEMORY_KINDS as readonly string[]).includes(v);
}
function isState(v: string): v is ExplicitMemoryState {
  return (EXPLICIT_MEMORY_STATES as readonly string[]).includes(v);
}

/** Collapse a value to a single clean line (envelope header fields are 1-line). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Render an envelope to its canonical L0 message content. `content` is placed
 * LAST and may span multiple lines; every header field is single-line so the
 * parser can recover them unambiguously.
 */
export function formatEnvelope(env: ExplicitMemoryEnvelope): string {
  const lines = [
    EXPLICIT_MEMORY_TAG,
    `logical_id: ${oneLine(env.logicalId)}`,
    `operation_id: ${oneLine(env.operationId)}`,
    `version: ${env.version}`,
    `kind: ${env.kind}`,
  ];
  if (env.key) lines.push(`key: ${oneLine(env.key)}`);
  lines.push(`state: ${env.state}`);
  lines.push(`content: ${env.content.slice(0, EXPLICIT_CONTENT_MAX).trim()}`);
  return lines.join("\n");
}

/** True when a block of text is a useAgent explicit-memory envelope. */
export function isExplicitMemory(text: string): boolean {
  return text.trimStart().startsWith(EXPLICIT_MEMORY_TAG);
}

/**
 * Parse an L0 message content back into an envelope, or null when it is not a
 * well-formed useAgent explicit memory (a plain distilled turn, or malformed).
 * `content` is everything after the `content:` marker, so it may be multi-line.
 */
export function parseEnvelope(text: string): ExplicitMemoryEnvelope | null {
  if (!isExplicitMemory(text)) return null;
  const body = text.slice(text.indexOf(EXPLICIT_MEMORY_TAG) + EXPLICIT_MEMORY_TAG.length);
  const fields = new Map<string, string>();
  const lines = body.split("\n");
  let content: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([a-z_]+):\s?([\s\S]*)$/.exec(line.trim() === "" ? "" : line);
    if (!m) continue;
    const keyName = m[1]!;
    if (keyName === "content") {
      // Everything from here on (this line's remainder + all following) is content.
      const rest = [m[2] ?? "", ...lines.slice(i + 1)].join("\n");
      content = rest.trim();
      break;
    }
    fields.set(keyName, (m[2] ?? "").trim());
  }
  const logicalId = fields.get("logical_id");
  const operationId = fields.get("operation_id");
  const versionRaw = fields.get("version");
  const kind = fields.get("kind");
  const state = fields.get("state");
  if (!logicalId || !operationId || !versionRaw || !kind || !state || content === null) return null;
  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!isKind(kind) || !isState(state)) return null;
  const key = fields.get("key");
  return {
    logicalId,
    operationId,
    version,
    kind,
    ...(key ? { key } : {}),
    state,
    content,
  };
}
