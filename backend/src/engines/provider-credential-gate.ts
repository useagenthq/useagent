import type { EngineId } from "../db/schema";
import {
  resolveProviderCredentialForRun,
  type ProviderCredentialResolvers,
} from "../provider-gateway/credentials";
import { providerForEngine, type ProviderId } from "../provider-gateway/provider";
import { engineAuthMode } from "../runs/engine-auth-mode";
import { ENGINE_DISPLAY_NAMES } from "../runs/engine-readiness";
import { defaultModelForEngine } from "../runs/model-policy";
import type { EngineRunContext } from "./types";

export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  cerebras: "Cerebras",
};

export function providerCredentialMissingMessage(engine: string, provider: ProviderId): string {
  const engineLabel = (ENGINE_DISPLAY_NAMES as Record<string, string | undefined>)[engine] ?? engine;
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  return `${engineLabel} cannot start: no ${providerLabel} key is connected for this organization. ` +
    `Connect an ${providerLabel} key in Settings, then retry.`;
}

/** Resolve the credential the provider gateway would use for this run's first
 * model call BEFORE any sandbox is provisioned. A missing key then fails the
 * run in milliseconds with the remedy instead of after a paid boot and an
 * upstream 401. Engines on a subscription or hybrid auth path carry their own
 * credential and are left alone. */
export async function assertRunProviderCredential(
  engine: string,
  ctx: Pick<EngineRunContext, "orgId" | "userId" | "model">,
  deps: ProviderCredentialResolvers & {
    readonly resolve?: typeof resolveProviderCredentialForRun;
  } = {},
): Promise<void> {
  if (!ctx.orgId) return;
  const env = deps.env ?? process.env;
  const engineId = engine as EngineId;
  if (engineAuthMode(engineId, env) !== "provider_gateway") return;
  const model = ctx.model?.trim() || defaultModelForEngine(engineId, env);
  const provider = providerForEngine(engineId, model);
  if (!provider) return;
  const { resolve = resolveProviderCredentialForRun, ...resolvers } = deps;
  const resolved = await resolve(
    { orgId: ctx.orgId, userId: ctx.userId, provider, model },
    resolvers,
  );
  if (resolved) return;
  throw new Error(providerCredentialMissingMessage(engine, provider));
}
