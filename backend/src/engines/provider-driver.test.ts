import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateProviderDriver } from "@useagent/agent-harness/control";
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
    protocolVersion: driver.descriptor.protocol.name,
    capabilities: driver.descriptor.capabilities,
    generation: 1,
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
      protocolVersion: "opencode-server",
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

  test("the real worker path dispatches through ProviderDriver lifecycle wiring", () => {
    const worker = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
    const opencode = readFileSync(new URL("./opencode-server.ts", import.meta.url), "utf8");

    expect(worker).toContain("await runProviderTurn(engineId, ctx)");
    expect(worker).not.toContain("await adapter.run(ctx)");
    expect(worker).toContain("const persistence = setRunEngineSession(runId, sid)");
    expect(worker).toContain("return persistence;");
    expect(worker).not.toContain("void setRunEngineSession(runId, sid)");
    expect(opencode).toContain("await establishProviderSession({\n        driver,");
    expect(opencode).toContain("persistSession: async (nativeSessionId) => {");
    expect(opencode).toContain("const steerResult = await driver.steer({");
  });

  test("keeps only the ProviderDriver registry as production lifecycle authority", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).not.toContain("export const harnessAdapters");
    expect(source).not.toContain("routeRuntimeHarness");
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
    expect(rolledBack?.descriptor.protocol.name).toBe("engine-adapter-compatibility");
  });

  test("projects T3 control capabilities from the selected lifecycle driver", () => {
    const handle = {
      provider: "codex",
      sessionId: "skynet-thread-thread-t3",
      sandboxId: "cube-t3",
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

  test("legacy orchestration losses are declared and return typed unsupported results", async () => {
    const registration = resolveProviderRegistration("claude");
    expect(registration).toBeDefined();
    if (!registration) return;
    expect(registration.unsupportedDriverCapabilities).toEqual([
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
