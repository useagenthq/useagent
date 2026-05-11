import type { EngineId } from "../db/schema";

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function providerForEngine(engine: EngineId, model: string): ProviderId | null {
  switch (engine) {
    case "opencode":
    case "daytona":
      return model.includes("/") ? "openrouter" : "anthropic";
    case "claude":
    case "claude-sdk":
      return "anthropic";
    case "codex":
      return "openai";
    case "mock":
    case "acp":
      return null;
  }
}

export function providerCredentialName(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
  }
}
