import type { EngineId } from "../db/schema";

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "cerebras"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function providerForEngine(engine: EngineId, model: string): ProviderId | null {
  switch (engine) {
    case "opencode":
    case "daytona":
    case "pi":
      if (model.startsWith("openai/")) return "openai";
      if (model.startsWith("cerebras/")) return "cerebras";
      return model.includes("/") ? "openrouter" : "anthropic";
    case "claude":
    case "claude-sdk":
      return "anthropic";
    case "codex":
      return "openai";
    case "chat":
      return "openrouter";
    case "mock":
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
    case "cerebras":
      return "CEREBRAS_API_KEY";
  }
}

/** Which model providers this deployment serves from its own keys. A provider
 *  NAME is not a secret; the value never leaves the server. Lets Settings say
 *  "provided by this deployment" instead of "not connected" beside a working
 *  product. */
export function deploymentProvidedProviders(
  env: Record<string, string | undefined> = process.env,
): Record<ProviderId, boolean> {
  return Object.fromEntries(
    PROVIDER_IDS.map((provider) => [provider, Boolean(env[providerCredentialName(provider)]?.trim())]),
  ) as Record<ProviderId, boolean>;
}
