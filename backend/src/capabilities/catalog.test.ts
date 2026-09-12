import { describe, expect, test } from "bun:test";
import { normalizeNegotiatedCapabilities } from "@useagent/agent-harness/canonical";
import { resolveProviderRegistration } from "../engines";
import { t3ProviderDrivers } from "../engines/t3-provider-driver";
import { buildCapabilityCatalog } from "./catalog";

const READY_ENV = {
  NODE_ENV: "production",
  ENABLED_ENGINES: "claude,codex,pi",
  ENGINE_READINESS_OPENCODE: "ready",
  ENGINE_READINESS_CLAUDE: "ready",
  ENGINE_READINESS_CODEX: "ready",
  ENGINE_READINESS_PI: "ready",
  RUNTIME_RUN_ADAPTER_ENABLED: "true",
  RUNTIME_RUN_ADAPTER_MODE: "all",
  RUNTIME_RUN_ADAPTER_ENGINES: "codex,opencode",
  OPENCODE_SERVER_PASSWORD: "configured-but-secret",
  PROVIDER_GATEWAY_URL: "https://provider.example.test",
  GATEWAY_PUBLIC_URL: "https://gateway.example.test",
  PROVIDER_GATEWAY_SECRET: "catalog-test-provider-gateway-secret-0123456789",
  PROVIDER_HEALTH_ANTHROPIC: "ready",
  PROVIDER_HEALTH_OPENAI: "insufficient_credit",
  PROVIDER_HEALTH_OPENROUTER: "ready",
} satisfies Record<string, string>;

describe("capability catalog", () => {
  test("native lifecycle capabilities do not depend on stale rollout settings", () => {
    for (const enabled of ["false", "true"]) {
      const catalog = buildCapabilityCatalog({
        env: { ...READY_ENV, RUNTIME_RUN_ADAPTER_ENABLED: enabled,
          RUNTIME_RUN_ADAPTER_MODE: "removed-mode", RUNTIME_RUN_ADAPTER_ENGINES: "codex,claude" },
        gatewayConfigured: true,
        slackConfigured: false,
      });
      for (const engine of ["codex", "claude"] as const) {
        expect(catalog.engines.find((value) => value.id === engine)?.session.declared)
          .toEqual(t3ProviderDrivers[engine].descriptor.capabilities);
      }
    }
  });
  test("separates configuration, readiness, and model dispatchability", () => {
    const catalog = buildCapabilityCatalog({
      env: READY_ENV,
      gatewayConfigured: true,
      slackConfigured: false,
      webSearchConfigured: false,
      memoryConfigured: false,
      gcsConfigured: false,
    });
    const codex = catalog.engines.find((engine) => engine.id === "codex");
    const opencode = catalog.engines.find((engine) => engine.id === "opencode");

    expect(codex?.configured).toBe(true);
    expect(codex?.ready).toBe(false);
    expect(codex?.degradationReason).toBe("provider_unhealthy");
    expect(codex?.models.every((model) => model.dispatchable === false)).toBe(true);
    expect(opencode?.models.some((model) => model.id.endsWith(":free"))).toBe(true);
    expect(opencode?.models.find((model) => model.default)?.id).toBe(opencode?.defaultModel);
    expect(opencode?.runtime).toEqual({
      kind: "t3",
      label: "any model · cloud sandbox",
    });
    expect(codex?.runtime.kind).toBe("t3");
    expect(catalog.engines.find((engine) => engine.id === "claude")?.runtime).toEqual({
      kind: "t3",
      label: "Anthropic agent · cloud sandbox",
    });
    expect(catalog.engines.find((engine) => engine.id === "pi")?.runtime.kind).toBe("native");
    expect(catalog.engines.find((engine) => engine.id === "chat")?.runtime.kind).toBe("direct");
  });

  test("publishes bounded registry metadata without run or credential material", () => {
    const catalog = buildCapabilityCatalog({
      env: READY_ENV,
      gatewayConfigured: true,
      slackConfigured: false,
    });
    const body = JSON.stringify(catalog);

    expect(catalog.scope).toBe("pre_run");
    expect(catalog.tools.declared.length).toBeGreaterThan(20);
    expect(catalog.tools.declared.length).toBeLessThanOrEqual(256);
    expect(catalog.tools.declared.find((tool) => tool.category === "slack")?.configured).toBe(
      false,
    );
    expect(catalog.tools.declared.find((tool) => tool.category === "web")?.configured).toBe(false);
    expect(catalog.tools.declared.find((tool) => tool.category === "memory")?.configured).toBe(false);
    expect(catalog.tools.declared.find((tool) => tool.category === "storage")?.configured).toBe(false);
    expect(catalog.tools.declared.find((tool) => tool.category === "artifacts")?.configured).toBe(true);
    expect(catalog.tools.families).toMatchObject({
      generic: true,
      web: false,
      memory: false,
      storage: false,
      slack: false,
      child_sessions: true,
    });
    expect(catalog.tools.declared.every((tool) => tool.currentRunAvailable === null)).toBe(true);
    expect(
      catalog.tools.declared.find((tool) => tool.name === "child_session_create_many")?.configured,
    ).toBe(false);
    expect(catalog.nativeSlashCommands).toEqual({ catalog: "session_runtime", currentRun: null });
    expect(body.length).toBeLessThan(128_000);
    for (const forbidden of [
      "configured-but-secret",
      "bearerToken",
      "authorizationHeader",
      "orgId",
      "userId",
      "threadId",
      "runId",
      "workspaceRoot",
      "inputSchema",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("marks batched product-child creation configured only when its rollout is on", () => {
    const catalog = buildCapabilityCatalog({
      env: { ...READY_ENV, PRODUCT_CHILD_THREADS: "on" },
      gatewayConfigured: true,
      slackConfigured: false,
    });
    expect(
      catalog.tools.declared.find((tool) => tool.name === "child_session_create_many")?.configured,
    ).toBe(true);
  });

  test("derives each conditional family from its own configuration truth", () => {
    const catalog = buildCapabilityCatalog({
      env: READY_ENV,
      gatewayConfigured: true,
      slackConfigured: true,
      webSearchConfigured: true,
      memoryConfigured: false,
      gcsConfigured: true,
      childSessionsConfigured: false,
      productChildThreadsConfigured: false,
    });
    expect(catalog.tools.families).toMatchObject({
      generic: true,
      web: true,
      memory: false,
      storage: true,
      slack: true,
      child_sessions: false,
    });
    expect(catalog.tools.declared.find((tool) => tool.category === "web")?.configured).toBe(true);
    expect(catalog.tools.declared.find((tool) => tool.category === "memory")?.configured).toBe(false);
    expect(catalog.tools.declared.find((tool) => tool.category === "storage")?.configured).toBe(true);
    expect(catalog.tools.declared.find((tool) => tool.category === "child_sessions")?.configured).toBe(false);
  });

  test("declares capabilities from the actually selected runtime driver", () => {
    const catalog = buildCapabilityCatalog({
      env: {
        ...READY_ENV,
        RUNTIME_RUN_ADAPTER_ENGINES: "claude,codex,opencode",
      },
      gatewayConfigured: true,
      slackConfigured: false,
    });
    const claude = catalog.engines.find((engine) => engine.id === "claude");
    expect(claude?.runtime.kind).toBe("t3");
    expect(claude?.session.declared).toEqual(
      normalizeNegotiatedCapabilities(t3ProviderDrivers.claude.descriptor.capabilities),
    );
    expect(catalog.engines.find((engine) => engine.id === "pi")?.session.declared).toEqual(
      normalizeNegotiatedCapabilities(
        resolveProviderRegistration("pi")!.driver.descriptor.capabilities,
      ),
    );
  });

  test("keeps Claude on its resident native driver despite legacy engine filters", () => {
    const catalog = buildCapabilityCatalog({
      env: READY_ENV,
      gatewayConfigured: true,
      slackConfigured: false,
    });
    expect(catalog.engines.find((engine) => engine.id === "claude")?.session.declared).toEqual(
      normalizeNegotiatedCapabilities(
        resolveProviderRegistration("claude")!.driver.descriptor.capabilities,
      ),
    );
    expect(catalog.engines.find((engine) => engine.id === "claude")?.runtime.kind).toBe("t3");
  });
});
