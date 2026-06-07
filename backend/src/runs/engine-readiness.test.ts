import { describe, expect, test } from "bun:test";
import {
  configuredDefaultRunEngine,
  engineModelReadyForDispatch,
  engineModelsForReadyEngines,
  engineReadyForDispatch,
  engineReadiness,
  modelProviderReadyForEngine,
  persistedEngineModelReadyForDispatch,
  readyUserFacingEngines,
  resolveAcceptedEngine,
} from "./engine-readiness";

const PROD = {
  NODE_ENV: "production",
  USEAGENT_DEV_MODE: "false",
} as const;

describe("engine readiness advertisement", () => {
  test("advertises no-sandbox chat only when its direct provider is configured", () => {
    expect(readyUserFacingEngines(PROD)).not.toContain("chat");

    const configured = { ...PROD, OPENROUTER_API_KEY: "test-openrouter-key" };
    expect(readyUserFacingEngines(configured)).toEqual(["chat"]);
    expect(engineReadiness("chat", configured)).toMatchObject({
      ready: true,
      reason: "enabled",
    });
    expect(engineModelsForReadyEngines(configured).chat).toContain(
      "anthropic/claude-sonnet-5",
    );
  });

  test("raw ENABLED_ENGINES is not enough to advertise an unproven Claude engine", () => {
    const env = {
      ...PROD,
      ENABLED_ENGINES: "claude,codex",
      T3_RUN_ADAPTER_ENABLED: "true",
      T3_RUN_ADAPTER_MODE: "all",
      T3_RUN_ADAPTER_ENGINES: "codex,opencode",
    };

    expect(readyUserFacingEngines(env)).toEqual([]);
    expect(engineReadiness("claude", env)).toMatchObject({
      ready: false,
      reason: "not_proven",
    });
  });

  test("engine and provider both require positive release evidence", () => {
    const engineOnly = {
      ...PROD,
      ENABLED_ENGINES: "codex",
      ENGINE_READINESS_CODEX: "verified",
    };
    expect(engineReadiness("codex", engineOnly)).toMatchObject({
      ready: false,
      reason: "not_proven",
    });
    expect(engineReadiness("codex", {
      ...engineOnly,
      PROVIDER_HEALTH_OPENAI: "verified",
    })).toMatchObject({ ready: true, reason: "enabled" });
  });

  test("Pi is hidden until its native bridge and selected provider are proven", () => {
    const engineOnly = {
      ...PROD,
      ENABLED_ENGINES: "pi",
      ENGINE_READINESS_PI: "verified",
    };
    expect(engineReadiness("pi", engineOnly)).toMatchObject({
      ready: false,
      reason: "not_proven",
    });
    expect(engineReadiness("pi", {
      ...engineOnly,
      PROVIDER_HEALTH_OPENAI: "verified",
    })).toMatchObject({ ready: true, reason: "enabled" });
  });

  test("subscription-backed Codex requires engine proof but not an API-key provider", () => {
    const env = {
      ...PROD,
      ENABLED_ENGINES: "codex",
      ENGINE_READINESS_CODEX: "verified",
      ENGINE_AUTH_MODE_CODEX: "subscription",
    };

    expect(engineReadiness("codex", env)).toMatchObject({
      ready: true,
      reason: "enabled",
    });
    expect(modelProviderReadyForEngine("codex", "gpt-5.6-sol", env)).toBe(true);
    expect(engineModelReadyForDispatch("codex", "gpt-5.6-sol", env)).toBe(true);
  });

  test("hybrid and provider-gateway Codex retain paid-provider readiness", () => {
    const base = {
      ...PROD,
      ENABLED_ENGINES: "codex",
      ENGINE_READINESS_CODEX: "verified",
    };

    expect(engineReadiness("codex", { ...base, ENGINE_AUTH_MODE_CODEX: "hybrid" }))
      .toMatchObject({ ready: false, reason: "not_proven" });
    expect(engineReadiness("codex", {
      ...base,
      ENGINE_AUTH_MODE_CODEX: "provider_gateway",
    })).toMatchObject({ ready: false, reason: "not_proven" });
  });

  test("unknown or inapplicable auth modes fail closed", () => {
    const proven = {
      ...PROD,
      ENABLED_ENGINES: "codex,opencode",
      ENGINE_READINESS_CODEX: "verified",
      ENGINE_READINESS_OPENCODE: "verified",
      PROVIDER_HEALTH_OPENAI: "verified",
      PROVIDER_HEALTH_OPENROUTER: "verified",
    };

    expect(engineReadiness("codex", {
      ...proven,
      ENGINE_AUTH_MODE_CODEX: "mystery",
    })).toMatchObject({ ready: false, reason: "not_proven" });
    expect(engineReadiness("opencode", {
      ...proven,
      ENGINE_AUTH_MODE_OPENCODE: "subscription",
    })).toMatchObject({ ready: false, reason: "not_proven" });
  });

  test("provider health failure removes a previously ready engine", () => {
    const env = {
      ...PROD,
      ENABLED_ENGINES: "claude",
      ENGINE_READINESS_CLAUDE: "verified",
      PROVIDER_HEALTH_ANTHROPIC: "401",
    };

    expect(engineReadiness("claude", env)).toMatchObject({
      ready: false,
      reason: "provider_unhealthy",
    });
    expect(readyUserFacingEngines(env)).toEqual([]);
  });

  test("provider models require explicit positive health", () => {
    const models = engineModelsForReadyEngines({
      ...PROD,
      ENGINE_READINESS_OPENCODE: "verified",
      PROVIDER_HEALTH_ANTHROPIC: "invalid",
      PROVIDER_HEALTH_OPENAI: "verified",
      PROVIDER_HEALTH_OPENROUTER: "verified",
    });

    expect(Object.keys(models)).toEqual(["opencode"]);
    expect(models.opencode).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "moonshotai/kimi-k3",
      "deepseek/deepseek-v4-flash",
      "google/gemini-3.7-flash",
      "nvidia/nemotron-3.5-lightning:free",
      "thinkingmachines/inkling:free",
      "poolside/laguna-s-2.1:free",
      "inclusionai/ling-3.0-flash-fin:free",
    ]);
  });

  test("explicit model switches cannot bypass provider readiness", () => {
    const env = {
      ...PROD,
      ENABLED_ENGINES: "opencode",
      ENGINE_READINESS_OPENCODE: "verified",
      PROVIDER_HEALTH_ANTHROPIC: "401",
      PROVIDER_HEALTH_OPENAI: "verified",
      PROVIDER_HEALTH_OPENROUTER: "401",
    };

    expect(modelProviderReadyForEngine("opencode", "claude-opus-5", env)).toBe(false);
    expect(modelProviderReadyForEngine("opencode", "openai/gpt-5.6-sol", env)).toBe(true);
    expect(engineModelReadyForDispatch("opencode", "claude-opus-5", env)).toBe(false);
    expect(engineModelReadyForDispatch("opencode", "openai/gpt-5.6-sol", env)).toBe(true);
    expect(engineModelReadyForDispatch("opencode", "made-up/provider-model", env)).toBe(false);
    expect(
      persistedEngineModelReadyForDispatch("opencode", "rotated/model:free", {
        ...env,
        PROVIDER_HEALTH_OPENROUTER: "verified",
      }),
    ).toBe(true);
    expect(
      persistedEngineModelReadyForDispatch("opencode", "rotated/model:free", env),
    ).toBe(false);
  });
});

describe("engine acceptance", () => {
  test("development keeps the internal omitted-engine mock flow", () => {
    expect(resolveAcceptedEngine(undefined, { NODE_ENV: "test" })).toEqual({
      ok: true,
      engine: "mock",
    });
  });

  test("production omitted engine resolves only an honest configured real default", () => {
    const withoutDefault = resolveAcceptedEngine(undefined, PROD);
    expect(withoutDefault).toEqual({ ok: false, status: 400, error: "engine is required" });

    const withDefault = {
      ...PROD,
      DEFAULT_RUN_ENGINE: "codex",
      ENABLED_ENGINES: "codex",
      ENGINE_READINESS_CODEX: "verified",
      PROVIDER_HEALTH_OPENAI: "verified",
    };
    expect(configuredDefaultRunEngine(withDefault)).toBe("codex");
    expect(resolveAcceptedEngine(undefined, withDefault)).toEqual({
      ok: true,
      engine: "codex",
    });
  });

  test("production explicit mock and not-ready Claude fail closed", () => {
    expect(resolveAcceptedEngine("mock", PROD)).toEqual({
      ok: false,
      status: 403,
      error: "engine_not_enabled",
      engine: "mock",
    });
    expect(resolveAcceptedEngine("claude", { ...PROD, ENABLED_ENGINES: "claude" })).toEqual({
      ok: false,
      status: 403,
      error: "engine_not_ready",
      engine: "claude",
    });
  });
});

describe("engine dispatch readiness", () => {
  test("production rejects legacy mock and unproven user-facing rows", () => {
    expect(engineReadyForDispatch("mock", PROD)).toBe(false);
    expect(engineReadyForDispatch("claude", { ...PROD, ENABLED_ENGINES: "claude" })).toBe(
      false,
    );
  });

  test("test mode retains mock while production accepts proven engines", () => {
    expect(engineReadyForDispatch("mock", { NODE_ENV: "test" })).toBe(true);
    expect(
      engineReadyForDispatch("codex", {
        ...PROD,
        ENABLED_ENGINES: "codex",
        ENGINE_READINESS_CODEX: "verified",
        PROVIDER_HEALTH_OPENAI: "verified",
      }),
    ).toBe(true);
  });
});
