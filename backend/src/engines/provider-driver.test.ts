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
  resolveProviderDriverForSession,
  resolveProviderRegistration,
} from "./index";
import {
  makeOpenCodeProviderDriver,
  opencodeProviderDriver,
} from "./opencode-server";
import { t3ProviderDrivers } from "./t3-provider-driver";
import { RUNTIME_GENERATION } from "./runtime-environment";

const residentServer = {
  baseUrl: "https://opencode.test",
  token: "preview-token", headers: {},
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

  test("prompt steering retries one transient server response", async () => {
    let calls = 0;
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async () => residentServer,
      fetcher: mockFetch(async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ name: "UnknownError" }, { status: 500 })
          : new Response(null, { status: 200 });
      }),
    });

    await expect(driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session: sessionFor(driver),
      input: { kind: "prompt", text: "hello", model: "cerebras/qwen-3.8-27b" },
    })).resolves.toEqual({ status: "ok" });
    expect(calls).toBe(2);
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
  test("keeps ACP exclusive to the explicit compatibility engine", () => {
    for (const engineId of ["acp", "claude", "claude-sdk", "codex", "daytona", "opencode", "pi"]) {
      const registration = resolveProviderRegistration(engineId);
      expect(registration).toBeDefined();
      if (!registration) continue;
      expect(validateProviderDriver(registration.driver)).toEqual({ status: "ok" });
      expect(resolveProviderDriver(engineId)).toBe(registration.driver);
    }

    expect(resolveProviderRegistration("opencode")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("pi")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("codex")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("claude")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("acp")?.execution.kind).toBe("acp_compatibility");
    expect(resolveProviderDriver("codex")).toBe(t3ProviderDrivers.codex);
    expect(resolveProviderDriver("claude")).toBe(t3ProviderDrivers.claude);

    expect(resolveProviderDriver("opencode")).toBe(opencodeProviderDriver);
    expect(resolveProviderRegistration("daytona")).toBe(resolveProviderRegistration("opencode"));
    expect(resolveProviderRegistration("claude-sdk")).toBe(resolveProviderRegistration("claude"));
  });

  test("selected T3 turns resolve a native T3 ProviderDriver", () => {
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
      version: RUNTIME_GENERATION,
    });
    expect(validateProviderDriver(driver)).toEqual({ status: "ok" });
  });

  test("keeps engine protocol and grammar stable across providers and legacy flags", () => {
    const ctx = { runId: "run-provider-layout", threadId: "thread-provider-layout" };
    const legacyFlagSets = [
      {},
      { T3_RUN_ADAPTER_ENABLED: "false", ENGINE_TRANSPORT: "cli" },
      {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_RUN_ADAPTER_MODE: "all",
        T3_RUN_ADAPTER_ENGINES: "opencode",
      },
    ] as const;

    for (const env of legacyFlagSets) {
      for (const engine of ["claude", "codex", "opencode", "pi"] as const) {
        const selections = (["box", "cube", "daytona"] as const).map((kind) =>
          resolveProviderDriver(engine, ctx, env, kind)
        );
        expect(selections.every(Boolean)).toBe(true);
        expect(selections.map((driver) => driver?.descriptor.protocol)).toEqual([
          selections[0]?.descriptor.protocol,
          selections[0]?.descriptor.protocol,
          selections[0]?.descriptor.protocol,
        ]);
        expect(selections.map((driver) => driver?.descriptor.capabilities)).toEqual([
          selections[0]?.descriptor.capabilities,
          selections[0]?.descriptor.capabilities,
          selections[0]?.descriptor.capabilities,
        ]);
        expect(selections.some((driver) => driver?.descriptor.protocol.name === "acp"))
          .toBe(false);
      }
      expect(resolveProviderDriver("codex", ctx, env, "box")).toBe(t3ProviderDrivers.codex);
      expect(resolveProviderDriver("claude", ctx, env, "box")).toBe(t3ProviderDrivers.claude);
    }
    expect(resolveProviderDriver("opencode", ctx, {}, "box")).toBe(opencodeProviderDriver);
    expect(resolveProviderDriver("pi", ctx, {}, "box")?.descriptor.protocol.name)
      .toBe("oh-my-pi-rpc");
  });

  test("does not let rollout or transport flags demote Codex or Claude", () => {
    const ctx = { runId: "run-claude", threadId: "thread-claude" };
    const enabled = resolveProviderDriver("claude", ctx, {
      T3_RUN_ADAPTER_ENABLED: "true",
      T3_RUN_ADAPTER_MODE: "all",
      T3_RUN_ADAPTER_ENGINES: "claude,codex,opencode",
    });
    const excluded = resolveProviderDriver("claude", ctx, {
      T3_RUN_ADAPTER_ENABLED: "true",
      T3_RUN_ADAPTER_MODE: "all",
      T3_RUN_ADAPTER_ENGINES: "codex,opencode",
      ENGINE_TRANSPORT: "cli",
    });

    expect(enabled).toBe(t3ProviderDrivers.claude);
    expect(excluded).toBe(t3ProviderDrivers.claude);
    expect(resolveProviderDriver("codex", ctx, {})).toBe(t3ProviderDrivers.codex);
  });

  test("rejects old ACP bindings and accepts only fresh native bindings", () => {
    for (const engine of ["claude", "codex"] as const) {
      expect(resolveProviderDriverForSession(engine, {
        provider: engine,
        protocol: "acp/1",
        generation: 1,
        authEpoch: null,
      }, null)).toBeUndefined();

      const current = t3ProviderDrivers[engine];
      expect(resolveProviderDriverForSession(engine, {
        provider: engine,
        protocol: providerProtocolIdentity(current.descriptor.protocol),
        generation: current.descriptor.sessionGeneration as number,
        authEpoch: null,
      }, null)).toBe(current);
    }
  });

  test("projects T3 control capabilities from the selected lifecycle driver", () => {
    for (const engine of ["claude", "codex"] as const) {
      const capabilities = resolveHarness(engine)?.capabilities({
        provider: engine,
        sessionId: "skynet-thread-thread-t3",
        sandboxId: "cube-t3",
        protocol: providerProtocolIdentity(t3ProviderDrivers[engine].descriptor.protocol),
        generation: 2,
        authEpoch: null,
        currentAuthEpoch: null,
      });

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
    }
  });

  test("rejects stale T3 protocol and generation before control dispatch", async () => {
    for (const engine of ["claude", "codex"] as const) {
      const harness = resolveHarness(engine);
      expect(harness).toBeDefined();
      if (!harness) continue;
      for (const stale of [
        { protocol: "acp/1", generation: 1 },
        { protocol: "t3-orchestration/useagent-runtime-v6", generation: 2 },
        {
          protocol: providerProtocolIdentity(t3ProviderDrivers[engine].descriptor.protocol),
          generation: 1,
        },
        {
          protocol: providerProtocolIdentity(t3ProviderDrivers[engine].descriptor.protocol),
          generation: 2,
          authEpoch: "epoch-old",
          currentAuthEpoch: "epoch-current",
        },
      ]) {
        const handle = {
          provider: engine,
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
    }
  });

  test("primary native drivers retain lifecycle while explicit ACP stays compatibility-only", () => {
    for (const engine of ["claude", "codex"] as const) {
      const registration = resolveProviderRegistration(engine);
      expect(registration?.driver).toBe(t3ProviderDrivers[engine]);
      if (!registration) continue;
      expect(unsupportedProviderDriverOperations(registration.driver)).toEqual([]);
      expect(registration.driver.descriptor.lifecycle.operations).toEqual([
        "start",
        "resume",
        "reconcile",
        "steer",
        "cancel",
      ]);
    }
    const acp = resolveProviderRegistration("acp");
    expect(acp).toBeDefined();
    if (!acp) return;
    expect(unsupportedProviderDriverOperations(acp.driver)).toEqual([
      "start",
      "resume",
      "reconcile",
      "steer",
      "cancel",
    ]);
  });
});
