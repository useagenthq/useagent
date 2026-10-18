import type { EngineId } from "../db/schema";
import { modelOfferedTo } from "../provider-gateway/provider-accounts";
import { allowedModelsForEngine } from "../runs/model-policy";

/**
 * In-message engine/model directives for the Slack surface.
 *
 * A message may START with `model:terra` and/or `engine:opencode` tokens (either
 * order, `:` or `=`); the remainder is the actual prompt. Model tokens resolve
 * against the target engine's allowed catalog: an exact id wins, otherwise a
 * token that is a unique case-insensitive substring of exactly one allowed id
 * (so `terra` -> gpt-5.6-terra, `sonnet` -> claude-sonnet-5). Ambiguous or unknown
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

/** The engine's catalog as one account sees it (PROVIDER_ACCOUNTS withholds a provider from the rest). */
function offeredModels(engine: EngineId, account: string | null): readonly string[] {
  return allowedModelsForEngine(engine).filter((model) => modelOfferedTo(engine, model, account));
}

/** Resolve a user-typed model token against an engine's allowed catalog. */
export function resolveModelToken(engine: EngineId, token: string, account: string | null = null): string | null {
  const allowed = offeredModels(engine, account);
  const lower = token.toLowerCase();
  const exact = allowed.find((model) => model.toLowerCase() === lower);
  if (exact) return exact;
  const partial = allowed.filter((model) => model.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]! : null;
}

/** Catalog line for guidance replies. */
export function modelCatalogLine(engine: EngineId, account: string | null = null): string {
  return offeredModels(engine, account).join(", ");
}
