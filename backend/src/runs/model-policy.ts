import type { EngineId } from "../db/schema";

/** Models that the OpenCode picker and provider gateway are allowed to spend. */
export const OPENCODE_ALLOWED_MODELS = {
  anthropic: [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-haiku-4-5",
  ],
  openrouter: [
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-sol-pro",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
  ],
} as const;

const OPENCODE_MODELS = new Set<string>(Object.values(OPENCODE_ALLOWED_MODELS).flat());
const CLAUDE_MODELS = new Set<string>(OPENCODE_ALLOWED_MODELS.anthropic);
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

function codexModels(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const configured = env.CODEX_ALLOWED_MODELS
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return new Set(configured?.length ? configured : [DEFAULT_CODEX_MODEL]);
}

/** Engine-owned default. ACP engines never inherit OpenCode's default model. */
export function defaultModelForEngine(
  engine: EngineId,
  env: Record<string, string | undefined> = process.env,
): string {
  switch (engine) {
    case "codex":
      return codexModels(env).values().next().value ?? DEFAULT_CODEX_MODEL;
    case "mock":
    case "opencode":
    case "daytona":
    case "claude":
    case "claude-sdk":
    case "acp":
      return DEFAULT_CLAUDE_MODEL;
  }
}

/** Fail-closed paid-model policy. Mock remains unconstrained for deterministic tests. */
export function isModelAllowedForEngine(
  engine: EngineId,
  model: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!model.trim()) return false;
  switch (engine) {
    case "mock":
      return true;
    case "opencode":
    case "daytona":
      return OPENCODE_MODELS.has(model);
    case "claude":
    case "claude-sdk":
      return CLAUDE_MODELS.has(model);
    case "codex":
      return codexModels(env).has(model);
    case "acp":
      return false;
  }
}
