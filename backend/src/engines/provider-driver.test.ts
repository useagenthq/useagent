import { describe, expect, test } from "bun:test";
import {
  providerProtocolIdentity,
  unsupportedProviderDriverOperations,
  validateProviderDriver,
} from "@useagent/agent-harness/control";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import {
  resolveHarness,
  resolveProviderDriver,
  resolveProviderRegistration,
} from "./index";
import {
  makeOpenCodeProviderDriver,
  opencodeProviderDriver,
} from "./opencode-server";
import { t3ProviderDrivers } from "./t3-provider-driver";

const residentServer = {
  baseUrl: "https://opencode.test",
  token: "preview-token",
  dirQ: "?directory=%2Fworkspace",
};

function mockFetch(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect(_url: string | URL): void {},
  });
}

function sessionFor(driver: ReturnType<typeof makeOpenCodeProviderDriver>): HarnessSession {
  return {
    provider: driver.provider,
    nativeSessionId: "ses/opencode 1",
    runtime: { kind: "sandbox", id: "sandbox-1" },
    protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
    capabilities: driver.descriptor.capabilities,
    generation: driver.descriptor.sessionGeneration as number,
  };
}

describe("OpenCode provider driver", () => {
  test("start preserves provider, runtime, protocol, and negotiated capability identity", async () => {
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async () => residentServer,
      fetcher: mockFetch(async () => Response.json({ id: "ses-created" })),
    });

    const result = await driver.start({
      runId: "run-1",
      threadId: "thread-1",
      runtime: { kind: "sandbox", id: "sandbox-1" },
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value).toMatchObject({
      provider: "opencode",
      nativeSessionId: "ses-created",
      runtime: { kind: "sandbox", id: "sandbox-1" },
      protocolVersion: "opencode-server/compat",
      generation: 1,
    });
    expect(result.value.capabilities).toEqual(driver.descriptor.capabilities);
  });

  test("resume probes the encoded native session and returns the same portable session", async () => {
    const requests: string[] = [];
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async () => residentServer,
      fetcher: mockFetch(async (input) => {
        requests.push(String(input));
        return new Response(null, { status: 200 });
      }),
    });
    const session = sessionFor(driver);

    await expect(driver.resume({ session })).resolves.toEqual({ status: "ok", value: session });
    expect(requests).toEqual([
      "https://opencode.test/session/ses%2Fopencode%201?directory=%2Fworkspace",
    ]);
  });

  test("resume classifies only a missing session as stale", async () => {
    const statuses = [404, 503];
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async () => residentServer,
      fetcher: mockFetch(async () => new Response(null, { status: statuses.shift() ?? 500 })),
    });
    const session = sessionFor(driver);

    await expect(driver.resume({ session })).resolves.toEqual({
      status: "error",
      code: "session_invalid",
      message: "HTTP 404",
    });
    await expect(driver.resume({ session })).resolves.toEqual({
      status: "error",
      code: "session_resume_failed",
      message: "HTTP 503",
    });
  });

  test("reconcile projects provider-native history through the portable driver", async () => {
    const driver = makeOpenCodeProviderDriver({
      reconcile: async (input) => ({
        outcome: "completed",
        summary: `${input.sandboxId}:${input.sessionId}:${input.sinceMs}`,
      }),
    });

    await expect(driver.reconcile?.({
      session: sessionFor(driver),
      checkpoint: { sinceMs: 42 },
    })).resolves.toEqual({
      status: "completed",
      summary: "sandbox-1:ses/opencode 1:42",
    });
  });

  test("approval steering is explicitly unsupported before touching the provider", async () => {
    let resolverCalls = 0;
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async () => {
        resolverCalls += 1;
        return residentServer;
      },
    });

    await expect(driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session: sessionFor(driver),
      input: { kind: "approval", approvalId: "approval-1", decision: "accept" },
    })).resolves.toEqual({
      status: "unsupported_capability",
      provider: "opencode",
      capability: "steer",
      message: "OpenCode provider driver currently supports prompt steering only",
    });
    expect(resolverCalls).toBe(0);
  });

  test("cancel uses the driver factory dependencies and encodes the native session", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async () => residentServer,
      fetcher: mockFetch(async (input, init) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        return new Response(null, { status: 200 });
      }),
    });

    await expect(driver.cancel(sessionFor(driver), "user stop")).resolves.toEqual({
      status: "ok",
    });
    expect(requests).toEqual([{
      url: "https://opencode.test/session/ses%2Fopencode%201/abort?directory=%2Fworkspace",
      method: "POST",
    }]);
  });
});

describe("production provider registry", () => {
  test("production selection resolves ProviderDrivers and declares only ACP compatibility fallbacks", () => {
    for (const engineId of ["acp", "claude", "claude-sdk", "codex", "daytona", "opencode", "pi"]) {
      const registration = resolveProviderRegistration(engineId);
      expect(registration).toBeDefined();
      if (!registration) continue;
      expect(validateProviderDriver(registration.driver)).toEqual({ status: "ok" });
      expect(resolveProviderDriver(engineId)).toBe(registration.driver);
    }

    expect(resolveProviderRegistration("opencode")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("pi")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("codex")?.execution.kind).toBe("acp_compatibility");
    expect(resolveProviderRegistration("claude")?.execution.kind).toBe("acp_compatibility");

    expect(resolveProviderDriver("opencode")).toBe(opencodeProviderDriver);
    expect(resolveProviderRegistration("daytona")).toBe(resolveProviderRegistration("opencode"));
    expect(resolveProviderRegistration("claude-sdk")).toBe(resolveProviderRegistration("claude"));
  });

  test("selected T3 turns resolve a native T3 ProviderDriver before ACP fallback", () => {
    const driver = resolveProviderDriver(
      "codex",
      { runId: "run-t3", threadId: "thread-t3" },
      {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_RUN_ADAPTER_MODE: "all",
        T3_RUN_ADAPTER_ENGINES: "codex,opencode",
      },
    );

    expect(driver?.provider).toBe("codex");
    expect(driver?.descriptor.protocol).toEqual({
      name: "t3-orchestration",
      version: "useagent-runtime-v8",
    });
    expect(validateProviderDriver(driver)).toEqual({ status: "ok" });
  });

  test("selects Claude's runtime driver while preserving ACP as the config rollback", () => {
    const ctx = { runId: "run-claude", threadId: "thread-claude" };
    const enabled = resolveProviderDriver("claude", ctx, {
      T3_RUN_ADAPTER_ENABLED: "true",
      T3_RUN_ADAPTER_MODE: "all",
      T3_RUN_ADAPTER_ENGINES: "claude,codex,opencode",
    });
    const rolledBack = resolveProviderDriver("claude", ctx, {
      T3_RUN_ADAPTER_ENABLED: "true",
      T3_RUN_ADAPTER_MODE: "all",
      T3_RUN_ADAPTER_ENGINES: "codex,opencode",
    });

    expect(enabled?.provider).toBe("claude");
    expect(enabled?.descriptor.protocol.name).toBe("t3-orchestration");
    expect(rolledBack?.descriptor.protocol.name).toBe("acp");
  });

  test("projects T3 control capabilities from the selected lifecycle driver", () => {
    const handle = {
      provider: "codex",
      sessionId: "skynet-thread-thread-t3",
      sandboxId: "cube-t3",
      protocol: providerProtocolIdentity(t3ProviderDrivers.codex.descriptor.protocol),
      generation: 2,
      authEpoch: null,
      currentAuthEpoch: null,
    };
    const capabilities = resolveHarness("codex")?.capabilities(handle);

    expect(capabilities).toMatchObject({
      resume: true,
      cancel: true,
      authoritativeHistory: true,
      childSessions: true,
      approvals: true,
      questions: true,
      reasoning: true,
      todos: true,
      patches: true,
      usage: true,
    });
  });

  test("rejects stale T3 protocol and generation before control dispatch", async () => {
    const harness = resolveHarness("codex");
    expect(harness).toBeDefined();
    if (!harness) return;
    for (const stale of [
      { protocol: "t3-orchestration/useagent-runtime-v6", generation: 2 },
      {
        protocol: providerProtocolIdentity(t3ProviderDrivers.codex.descriptor.protocol),
        generation: 1,
      },
      {
        protocol: providerProtocolIdentity(t3ProviderDrivers.codex.descriptor.protocol),
        generation: 2,
        authEpoch: "epoch-old",
        currentAuthEpoch: "epoch-current",
      },
      {
        provider: "claude",
        protocol: providerProtocolIdentity(t3ProviderDrivers.codex.descriptor.protocol),
        generation: 2,
      },
    ]) {
      const handle = {
        provider: "codex",
        sessionId: "skynet-thread-stale",
        sandboxId: "cube-stale",
        authEpoch: null,
        currentAuthEpoch: null,
        ...stale,
      };
      expect(harness.capabilities(handle)).toMatchObject({
        cancel: false,
        authoritativeHistory: false,
      });
      await expect(harness.cancel(handle, "stop")).resolves.toMatchObject({
        status: "unsupported_capability",
        capability: "cancel",
      });
    }
  });

  test("legacy orchestration losses are declared and return typed unsupported results", async () => {
    const registration = resolveProviderRegistration("claude");
    expect(registration).toBeDefined();
    if (!registration) return;
    expect(unsupportedProviderDriverOperations(registration.driver)).toEqual([
      "start",
      "resume",
      "reconcile",
      "steer",
    ]);

    await expect(registration.driver.start({
      runId: "run-compat",
      threadId: "thread-compat",
      runtime: { kind: "sandbox", id: "sandbox-compat" },
    })).resolves.toEqual({
      status: "unsupported_capability",
      provider: "claude",
      capability: "start",
      message: "claude lifecycle is still owned by EngineAdapter compatibility orchestration",
    });
  });
});
