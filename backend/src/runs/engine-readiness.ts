import { ENGINE_IDS, type EngineId } from "../db/schema";
import {
  allowedModelsForEngine,
  defaultModelForEngine,
  isModelAllowedForEngine,
  isPersistedModelAllowedForEngine,
} from "./model-policy";
import { providerForEngine, type ProviderId } from "../provider-gateway/provider";
import { engineAuthMode, engineUsesProviderGateway } from "./engine-auth-mode";
import { chatLlmEnabled } from "../chat/stream";
import { enabledEnginesForEnv } from "../env";

export const USER_FACING_ENGINES = ["chat", "opencode", "claude", "codex", "pi"] as const;
export type UserFacingEngineId = (typeof USER_FACING_ENGINES)[number];

const POSITIVE_HEALTH = new Set(["ready", "healthy", "ok", "pass", "passed", "verified"]);
const ENGINE_ID_SET: ReadonlySet<string> = new Set(ENGINE_IDS);
const USER_FACING_ENGINE_SET: ReadonlySet<string> = new Set(USER_FACING_ENGINES);

export type EngineReadinessReason =
  | "enabled"
  | "disabled"
  | "provider_unhealthy"
  | "not_proven";

export interface EngineReadiness {
  readonly engine: UserFacingEngineId;
  readonly ready: boolean;
  readonly reason: EngineReadinessReason;
  readonly provider?: ProviderId;
  readonly providerHealth?: string;
  readonly message?: string;
}

export type EngineResolution =
  | { readonly ok: true; readonly engine: EngineId }
  | {
      readonly ok: false;
      readonly status: 400 | 403;
      readonly error: string;
      readonly engine?: EngineId;
      readonly reason?: EngineReadinessReason;
      readonly provider?: ProviderId;
      readonly providerHealth?: string;
      readonly message?: string;
    };

type RejectedEngineResolution = Extract<EngineResolution, { readonly ok: false }>;

export function engineResolutionErrorBody(
  resolution: RejectedEngineResolution,
): {
  readonly error: string;
  readonly engine?: EngineId;
  readonly reason?: EngineReadinessReason;
  readonly provider?: ProviderId;
  readonly providerHealth?: string;
  readonly message?: string;
} {
  return {
    error: resolution.error,
    ...(resolution.engine === undefined ? {} : { engine: resolution.engine }),
    ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
    ...(resolution.provider === undefined ? {} : { provider: resolution.provider }),
    ...(resolution.providerHealth === undefined
      ? {}
      : { providerHealth: resolution.providerHealth }),
    ...(resolution.message === undefined ? {} : { message: resolution.message }),
  };
}

const ENGINE_DISPLAY_NAMES: Record<UserFacingEngineId, string> = {
  chat: "Chat",
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

function unavailableMessage(readiness: EngineReadiness): string {
  const label = ENGINE_DISPLAY_NAMES[readiness.engine];
  if (readiness.reason === "provider_unhealthy" && readiness.provider) {
    const provider = readiness.provider === "anthropic"
      ? "Anthropic"
      : readiness.provider === "openai"
        ? "OpenAI"
        : "OpenRouter";
    if (readiness.providerHealth === "insufficient_credit") {
      return `${label} is configured, but ${provider} reports insufficient credits. Add credits or update the provider key in Settings, then retry.`;
    }
    return `${label} is configured, but ${provider} is unavailable${readiness.providerHealth ? ` (${readiness.providerHealth})` : ""}. Check provider credentials and billing in Settings, then retry.`;
  }
  if (readiness.reason === "disabled") return `${label} is disabled on this server.`;
  return `${label} is configured but not ready. Check its provider connection in Settings, then retry.`;
}

function devModeEnabledForEnv(env: Record<string, string | undefined>): boolean {
  const explicit = env.USEAGENT_DEV_MODE;
  if (explicit !== undefined) return explicit === "true";
  return (env.NODE_ENV ?? "development") !== "production";
}

function healthFlag(name: string, env: Record<string, string | undefined>): string | null {
  return env[name]?.trim().toLowerCase() || null;
}

function explicitEngineHealth(engine: string, env: Record<string, string | undefined>): string | null {
  return healthFlag(`ENGINE_READINESS_${engine.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`, env);
}

function providerHealth(provider: ProviderId, env: Record<string, string | undefined>): string | null {
  return healthFlag(`PROVIDER_HEALTH_${provider.toUpperCase()}`, env);
}

function providerHealthStatus(
  provider: ProviderId,
  env: Record<string, string | undefined>,
): "ready" | "unhealthy" | "not_proven" {
  const health = providerHealth(provider, env);
  if (!health) return "not_proven";
  if (POSITIVE_HEALTH.has(health)) return "ready";
  return "unhealthy";
}

/** A model is dispatchable only when its concrete paid provider has current,
 * positive release evidence. Engine readiness covers the default model; this
 * companion gate covers explicit model switches and persisted legacy rows. */
export function modelProviderReadyForEngine(
  engine: EngineId,
  model: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (engine === "chat") return chatLlmEnabled(env);
  if (engineAuthMode(engine, env) === null) return false;
  if (!engineUsesProviderGateway(engine, env)) return true;
  const provider = providerForEngine(engine, model);
  return provider === null || providerHealthStatus(provider, env) === "ready";
}

/** The shared acceptance and worker predicate. Keeping the two checks together
 * prevents a non-HTTP caller from validating only the engine or only the
 * selected model's paid provider. */
export function engineModelReadyForDispatch(
  engine: EngineId,
  model: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return engineReadyForDispatch(engine, env) &&
    isModelAllowedForEngine(engine, model, env) &&
    modelProviderReadyForEngine(engine, model, env);
}

export function modelProviderReadinessErrorBody(
  engine: EngineId,
  model: string,
  env: Record<string, string | undefined> = process.env,
): {
  readonly error: "model_provider_not_ready";
  readonly engine: EngineId;
  readonly model: string;
  readonly provider?: ProviderId;
  readonly providerHealth?: string;
  readonly message: string;
} {
  const provider = providerForEngine(engine, model);
  const health = provider ? providerHealth(provider, env) ?? "not_proven" : undefined;
  const providerLabel = provider === "anthropic"
    ? "Anthropic"
    : provider === "openai"
      ? "OpenAI"
      : provider === "openrouter"
        ? "OpenRouter"
        : "The selected model provider";
  const action = health === "insufficient_credit"
    ? "Add credits or update the provider key in Settings, then retry."
    : "Check provider credentials and billing in Settings, then retry.";
  return {
    error: "model_provider_not_ready",
    engine,
    model,
    ...(provider ? { provider } : {}),
    ...(health ? { providerHealth: health } : {}),
    message: `${providerLabel} cannot run ${model}${health ? ` (${health})` : ""}. ${action}`,
  };
}

/** Readiness for a run that already crossed the acceptance transaction. */
export function persistedEngineModelReadyForDispatch(
  engine: EngineId,
  model: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return engineReadyForDispatch(engine, env) &&
    isPersistedModelAllowedForEngine(engine, model, env) &&
    modelProviderReadyForEngine(engine, model, env);
}

function providerForDefaultEngineModel(
  engine: UserFacingEngineId,
  env: Record<string, string | undefined>,
): ProviderId | null {
  return providerForEngine(engine, defaultModelForEngine(engine, env));
}

export function engineReadiness(
  engine: UserFacingEngineId,
  env: Record<string, string | undefined> = process.env,
): EngineReadiness {
  if (!enabledEnginesForEnv(env).has(engine)) {
    return { engine, ready: false, reason: "disabled" };
  }

  if (engine === "chat") {
    return chatLlmEnabled(env)
      ? { engine, ready: true, reason: "enabled" }
      : { engine, ready: false, reason: "not_proven" };
  }

  const engineHealth = explicitEngineHealth(engine, env);
  if (!engineHealth || !POSITIVE_HEALTH.has(engineHealth)) {
    return { engine, ready: false, reason: "not_proven" };
  }

  if (engineAuthMode(engine, env) === null) {
    return { engine, ready: false, reason: "not_proven" };
  }

  const provider = engineUsesProviderGateway(engine, env)
    ? providerForDefaultEngineModel(engine, env)
    : null;
  if (provider) {
    const status = providerHealthStatus(provider, env);
    if (status !== "ready") {
      const readiness: EngineReadiness = {
        engine,
        ready: false,
        reason: status === "unhealthy" ? "provider_unhealthy" : "not_proven",
        provider,
        providerHealth: providerHealth(provider, env) ?? "not_proven",
      };
      return { ...readiness, message: unavailableMessage(readiness) };
    }
  }
  return { engine, ready: true, reason: "enabled" };
}

/** Discoverability and dispatchability are separate contracts. A configured
 * engine stays visible so a user can understand and repair its provider state;
 * engineReadyForDispatch remains the fail-closed execution gate. */
export function configuredUserFacingEngines(
  env: Record<string, string | undefined> = process.env,
): readonly UserFacingEngineId[] {
  const enabled = enabledEnginesForEnv(env);
  return USER_FACING_ENGINES.filter((engine) =>
    engine === "chat" ? chatLlmEnabled(env) : enabled.has(engine)
  );
}

export function configuredEngineReadiness(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<UserFacingEngineId, EngineReadiness>> {
  return Object.fromEntries(
    configuredUserFacingEngines(env).map((engine) => [engine, engineReadiness(engine, env)]),
  );
}

export function readyUserFacingEngines(
  env: Record<string, string | undefined> = process.env,
): readonly UserFacingEngineId[] {
  return USER_FACING_ENGINES.filter((engine) => engineReadiness(engine, env).ready);
}

/** Defense-in-depth for persisted runs. HTTP acceptance prevents new unsafe
 * rows, while this check also protects the worker from legacy rows and direct
 * database writes. Production never dispatches the scripted mock or an
 * unproven user-facing engine. */
export function engineReadyForDispatch(
  engine: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!ENGINE_ID_SET.has(engine)) return false;
  if (engine === "chat") return chatLlmEnabled(env);
  if (engine === "mock") return devModeEnabledForEnv(env);
  const knownEngine = engine as EngineId;
  if (!enabledEnginesForEnv(env).has(knownEngine)) return false;
  if (!USER_FACING_ENGINE_SET.has(engine)) return true;
  return engineReadiness(engine as UserFacingEngineId, env).ready;
}

export function configuredDefaultRunEngine(
  env: Record<string, string | undefined> = process.env,
): UserFacingEngineId | null {
  const raw = env.DEFAULT_RUN_ENGINE?.trim();
  if (!raw) return null;
  if (!USER_FACING_ENGINE_SET.has(raw)) return null;
  const engine = raw as UserFacingEngineId;
  return engineReadiness(engine, env).ready ? engine : null;
}

export function resolveAcceptedEngine(
  rawEngine: unknown,
  env: Record<string, string | undefined> = process.env,
): EngineResolution {
  if (rawEngine !== undefined && rawEngine !== null && rawEngine !== "") {
    if (
      typeof rawEngine !== "string" ||
      !ENGINE_ID_SET.has(rawEngine)
    ) {
      return { ok: false, status: 400, error: `engine must be one of: ${ENGINE_IDS.join(", ")}` };
    }
    const engine = rawEngine as EngineId;
    if (engine === "mock") {
      if (devModeEnabledForEnv(env)) return { ok: true, engine };
      return { ok: false, status: 403, error: "engine_not_enabled", engine };
    }
    if (!enabledEnginesForEnv(env).has(engine)) {
      return { ok: false, status: 403, error: "engine_not_enabled", engine };
    }
    if (USER_FACING_ENGINE_SET.has(engine)) {
      const readiness = engineReadiness(engine as UserFacingEngineId, env);
      if (!readiness.ready) {
        return {
          ok: false,
          status: 403,
          error: "engine_not_ready",
          engine,
          reason: readiness.reason,
          provider: readiness.provider,
          providerHealth: readiness.providerHealth,
          message: readiness.message,
        };
      }
    }
    return { ok: true, engine };
  }

  if (devModeEnabledForEnv(env)) return { ok: true, engine: "mock" };

  const defaultEngine = configuredDefaultRunEngine(env);
  if (defaultEngine) return { ok: true, engine: defaultEngine };
  return { ok: false, status: 400, error: "engine is required" };
}

export function engineModelsForReadyEngines(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<UserFacingEngineId, readonly string[]>> {
  const engines = readyUserFacingEngines(env);
  const models: Partial<Record<UserFacingEngineId, readonly string[]>> = {};
  for (const engine of engines) {
    models[engine] = allowedModelsForEngine(engine, env)
      .filter((model) => modelProviderReadyForEngine(engine, model, env));
  }
  return models;
}

export function engineModelsForConfiguredEngines(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<UserFacingEngineId, readonly string[]>> {
  const models: Partial<Record<UserFacingEngineId, readonly string[]>> = {};
  for (const engine of configuredUserFacingEngines(env)) {
    models[engine] = allowedModelsForEngine(engine, env)
      .filter((model) => modelProviderReadyForEngine(engine, model, env));
  }
  return models;
}
