// The curated model catalog behind every model picker. Split out of ./types
// (which re-exports everything here, so consumers keep one import path): the
// paid per-engine catalogs plus the zero-cost Free lane.

import type { EngineId } from "@useagent/agent-client/wire";

/** The curated model set (single source of truth for every picker). Bare ids →
 * Anthropic direct; provider/model ids → OpenRouter. */
export const MODELS: { value: string; label: string; tint: string }[] = [
  { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna · Fast", tint: "text-sky-500" },
  {
    value: "moonshotai/kimi-k3",
    label: "Kimi K3",
    tint: "text-fuchsia-500",
  },
  {
    value: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash · Wafer Fast",
    tint: "text-cyan-500",
  },
  {
    value: "google/gemini-3.7-flash",
    label: "Gemini 3.7 Flash · Fast",
    tint: "text-blue-500",
  },
  { value: "claude-opus-5", label: "Opus 5", tint: "text-orange-500" },
  { value: "claude-sonnet-5", label: "Sonnet 5", tint: "text-blue-500" },
  { value: "claude-fable-5", label: "Fable 5", tint: "text-purple-500" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", tint: "text-green-500" },
  { value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", tint: "text-teal-500" },
  { value: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", tint: "text-amber-500" },
];

/** The Free lane SEED: curated labels for the backend's fallback lane and the
 * offline picker default. The lane itself is DYNAMIC - the backend derives it
 * from OpenRouter's public catalog and advertises it via the manifest; Free
 * section MEMBERSHIP comes from the id's ":free" suffix (isFreeModel), so a
 * newly advertised free model appears here with no frontend change (its raw id
 * doubles as the label until it earns a curated entry). OpenCode only (backend
 * policy); free turns run on a user's own connected OpenRouter key when one is
 * connected. */
export const FREE_MODELS: { value: string; label: string; tint: string }[] = [
  { value: "minimax/minimax-m3:free", label: "MiniMax M3", tint: "text-emerald-500" },
  { value: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super", tint: "text-rose-500" },
  {
    value: "dots-studio/dots-3-note-preview:free",
    label: "Dots 3 Note",
    tint: "text-indigo-500",
  },
];

/** OpenRouter marks zero-cost variants with a ":free" slug suffix. */
export function isFreeModel(value: string): boolean {
  return value.endsWith(":free");
}

/** Partition picker options into the paid catalog and the Free lane (shared by
 * every picker's "Free" section; membership is manifest-driven via the id
 * suffix, never a hardcoded list). */
export function partitionModelOptions(options: ModelOption[]): {
  paid: ModelOption[];
  free: ModelOption[];
} {
  return {
    paid: options.filter((option) => !isFreeModel(option.value)),
    free: options.filter((option) => isFreeModel(option.value)),
  };
}

/** Codex model ids are the backend-policy ids accepted by the Codex runner. */
export const CODEX_MODELS: { value: string; label: string; tint: string }[] = [
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna · Fast", tint: "text-sky-500" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", tint: "text-amber-500" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", tint: "text-teal-500" },
];

/** Claude Code accepts the backend's exact Anthropic model policy ids. */
export const CLAUDE_MODELS: ModelOption[] = MODELS.filter((model) =>
  model.value.startsWith("claude-")
);

export const CHAT_MODELS: { value: string; label: string; tint: string }[] = [
  {
    value: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    tint: "text-blue-500",
  },
  {
    value: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    tint: "text-orange-500",
  },
  {
    value: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    tint: "text-green-500",
  },
  { value: "z-ai/glm-5.2", label: "GLM 5.2", tint: "text-purple-500" },
];

export type ModelOption = { value: string; label: string; tint: string };

// Stable reference so per-render callers never see a fresh array identity.
const OPENCODE_SELECTABLE_MODELS: ModelOption[] = [...MODELS, ...FREE_MODELS];

export function selectableModelsForEngine(engine: EngineId): ModelOption[] {
  const normalized = normalizeEngine(engine);
  // The Free lane is OpenCode-only backend policy; pi keeps the paid catalog.
  if (normalized === "opencode") return OPENCODE_SELECTABLE_MODELS;
  if (normalized === "pi") return MODELS;
  if (normalized === "claude") return CLAUDE_MODELS;
  if (normalized === "codex") return CODEX_MODELS;
  if (normalized === "chat") return CHAT_MODELS;
  return [];
}

/**
 * Pre-session model-selection capability. The durable `session.started`
 * capability map remains authoritative once it arrives; this catalog-backed
 * fallback keeps the picker usable while a new native session is booting.
 */
export function supportsPreSessionModelSelection(engine: EngineId): boolean {
  return selectableModelsForEngine(engine).length > 0;
}

export function modelOptionsForEngine(
  engine: EngineId,
  allowedModelIds?: readonly string[],
): ModelOption[] {
  const known = selectableModelsForEngine(engine);
  if (known.length === 0) return [];
  if (!allowedModelIds) return known;
  return allowedModelIds.map(
    (value) =>
      known.find((model) => model.value === value) ?? {
        value,
        label: value,
        tint: "text-text-secondary",
      },
  );
}

export function modelLabel(value: string, engine: EngineId = "opencode"): string {
  return selectableModelsForEngine(engine).find((m) => m.value === value)?.label ?? value;
}

/** Fold a legacy engine id into its current sandbox equivalent (the backend
 * aliases them the same way), so old threads pick up the modern picker entry
 * instead of surfacing a raw legacy id. */
export function normalizeEngine(id: EngineId): EngineId {
  if (id === "claude-sdk") return "claude";
  if (id === "daytona") return "opencode";
  return id;
}
