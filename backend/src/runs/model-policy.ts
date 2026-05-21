import type { EngineId } from "../db/schema";
import { chatModelCatalog } from "../chat/models";
import { chatModel } from "../chat/stream";

export const KIMI_K3_MODEL = "moonshotai/kimi-k3";
export const FAST_OPENCODE_MODEL = "openai/gpt-5.6-luna";
export const FAST_CODEX_MODEL = "gpt-5.6-luna";
export const CODEX_ALLOWED_MODELS = [
  FAST_CODEX_MODEL,
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

/** Models that the OpenCode picker and provider gateway are allowed to spend. */
export const OPENCODE_ALLOWED_MODELS = {
  anthropic: [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-haiku-4-5",
  ],
  openai: [
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-sol-pro",
    FAST_OPENCODE_MODEL,
    "openai/gpt-5.6-terra",
  ],
  openrouter: [
    KIMI_K3_MODEL,
  ],
} as const;

const OPENCODE_MODELS = new Set<string>(Object.values(OPENCODE_ALLOWED_MODELS).flat());
const CLAUDE_MODELS = new Set<string>(OPENCODE_ALLOWED_MODELS.anthropic);
export const DEFAULT_OPENCODE_MODEL = FAST_OPENCODE_MODEL;
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";
export const DEFAULT_CODEX_MODEL = FAST_CODEX_MODEL;

function codexModels(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const configured = env.CODEX_ALLOWED_MODELS
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return new Set(configured?.length ? configured : CODEX_ALLOWED_MODELS);
}

export function allowedModelsForEngine(
  engine: EngineId,
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  switch (engine) {
    case "opencode":
    case "daytona":
      return Object.values(OPENCODE_ALLOWED_MODELS).flat();
    case "claude":
    case "claude-sdk":
      return OPENCODE_ALLOWED_MODELS.anthropic;
    case "codex":
      return [...codexModels(env)];
    case "chat":
      return chatModelCatalog(env).models.map((model) => model.value);
    case "mock":
    case "acp":
      return [];
  }
}

/** Engine-owned default. ACP engines never inherit OpenCode's default model. */
export function defaultModelForEngine(
  engine: EngineId,
  env: Record<string, string | undefined> = process.env,
): string {
  switch (engine) {
    case "opencode":
    case "daytona":
      return DEFAULT_OPENCODE_MODEL;
    case "codex":
      return codexModels(env).values().next().value ?? DEFAULT_CODEX_MODEL;
    case "chat":
      return chatModel(env);
    case "mock":
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
    case "chat":
      return chatModelCatalog(env).models.some((candidate) => candidate.value === model);
    case "acp":
      return false;
  }
}
