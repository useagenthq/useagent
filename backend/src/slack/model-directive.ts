import type { EngineId } from "../db/schema";
import { allowedModelsForEngine } from "../runs/model-policy";

/**
 * In-message engine/model directives for the Slack surface.
 *
 * A message may START with `model:sol` and/or `engine:opencode` tokens (either
 * order, `:` or `=`); the remainder is the actual prompt. Model tokens resolve
 * against the target engine's allowed catalog: an exact id wins, otherwise a
 * token that is a unique case-insensitive substring of exactly one allowed id
 * (so `sol` -> gpt-5.6-sol, `sonnet` -> claude-sonnet-5). Ambiguous or unknown
 * tokens resolve to null and the caller replies with the catalog instead of
 * guessing.
 */

export interface SlackDirectives {
  readonly engine: string | null;
  readonly model: string | null;
}

const DIRECTIVE_RE = /^(engine|model)\s*[:=]\s*(\S+)\s*/i;

export function parseSlackDirectives(text: string): {
  directives: SlackDirectives;
  rest: string;
} {
  let rest = text.trim();
  let engine: string | null = null;
  let model: string | null = null;
  for (;;) {
    const match = DIRECTIVE_RE.exec(rest);
    if (!match) break;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "engine") engine = value.toLowerCase();
    else model = value;
    rest = rest.slice(match[0].length);
  }
  return { directives: { engine, model }, rest: rest.trim() };
}

/** The engines a Slack thread may start on (sandboxed run engines only). */
export const SLACK_SWITCHABLE_ENGINES = ["opencode", "claude", "codex"] as const;

export function isSlackSwitchableEngine(value: string): value is EngineId {
  return (SLACK_SWITCHABLE_ENGINES as readonly string[]).includes(value);
}

/** Resolve a user-typed model token against an engine's allowed catalog. */
export function resolveModelToken(engine: EngineId, token: string): string | null {
  const allowed = allowedModelsForEngine(engine);
  const lower = token.toLowerCase();
  const exact = allowed.find((model) => model.toLowerCase() === lower);
  if (exact) return exact;
  const partial = allowed.filter((model) => model.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]! : null;
}

/** Catalog line for guidance replies. */
export function modelCatalogLine(engine: EngineId): string {
  return allowedModelsForEngine(engine).join(", ");
}
