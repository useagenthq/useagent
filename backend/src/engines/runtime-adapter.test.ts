import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  runtimeAdapterEnabled,
  runtimeAdapterEngineSelected,
  runtimeAdapterMode,
  runtimeAdapterSelected,
  runtimeRunSnapshot,
  configuredRuntimeMode,
} from "./runtime-adapter";

describe("T3 run adapter gate", () => {
  test("is disabled unless explicitly enabled", () => {
    expect(runtimeAdapterEnabled({})).toBe(false);
    expect(runtimeAdapterEnabled({ RUNTIME_RUN_ADAPTER_ENABLED: "true" })).toBe(true);
    // Deployment-safe dual-read: legacy name still works; the new name wins.
    expect(runtimeAdapterEnabled({ T3_RUN_ADAPTER_ENABLED: "true" })).toBe(true);
    expect(
      runtimeAdapterEnabled({
        RUNTIME_RUN_ADAPTER_ENABLED: "false",
        T3_RUN_ADAPTER_ENABLED: "true",
      }),
    ).toBe(false);
  });

  test("defaults an enabled adapter to explicit canary threads", () => {
    const ctx = { runId: "run-1", threadId: "thread-1" };
    expect(runtimeAdapterMode({ T3_RUN_ADAPTER_ENABLED: "true" })).toBe("canary");
    expect(runtimeAdapterSelected(ctx, { T3_RUN_ADAPTER_ENABLED: "true" })).toBe(false);
    expect(
      runtimeAdapterSelected(ctx, {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_CANARY_THREAD_IDS: "other, thread-1",
      }),
    ).toBe(true);
    expect(
      runtimeAdapterSelected(ctx, {
        RUNTIME_RUN_ADAPTER_ENABLED: "true",
        RUNTIME_CANARY_THREAD_IDS: "other, thread-1",
      }),
    ).toBe(true);
    expect(
      runtimeAdapterSelected(ctx, {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_RUN_ADAPTER_MODE: "all",
      }),
    ).toBe(true);
  });

  test("rejects an unknown routing mode", () => {
    expect(() => runtimeAdapterMode({ T3_RUN_ADAPTER_MODE: "maybe" })).toThrow(
      "RUNTIME_RUN_ADAPTER_MODE (legacy T3_RUN_ADAPTER_MODE) must be canary or all",
    );
    expect(runtimeAdapterMode({ RUNTIME_RUN_ADAPTER_MODE: "all" })).toBe("all");
  });

  test("can restrict an all-mode cutover to proven engines", () => {
    expect(runtimeAdapterEngineSelected("codex", {})).toBe(true);
    expect(runtimeAdapterEngineSelected("opencode", {})).toBe(true);
    expect(runtimeAdapterEngineSelected("claude", {})).toBe(false);
    expect(
      runtimeAdapterEngineSelected("codex", {
        T3_RUN_ADAPTER_ENGINES: "codex, opencode",
      }),
    ).toBe(true);
    expect(
      runtimeAdapterEngineSelected("claude", {
        T3_RUN_ADAPTER_ENGINES: "claude, codex, opencode",
      }),
    ).toBe(true);
    expect(
      runtimeAdapterEngineSelected("claude", {
        T3_RUN_ADAPTER_ENGINES: "codex, opencode",
      }),
    ).toBe(false);
    expect(
      runtimeAdapterEngineSelected("claude", {
        RUNTIME_RUN_ADAPTER_ENGINES: "claude",
      }),
    ).toBe(true);
  });

  test("uses a separate Cube candidate template during parity testing", () => {
    expect(
      runtimeRunSnapshot({
        SANDBOX_PROVIDER: "cube",
        CUBE_TEMPLATE_ID: "production",
        T3_CUBE_TEMPLATE_ID: "candidate",
      }),
    ).toBe("candidate");
    expect(
      runtimeRunSnapshot({
        SANDBOX_PROVIDER: "cube",
        CUBE_TEMPLATE_ID: "production",
        RUNTIME_CUBE_TEMPLATE_ID: "candidate-new",
        T3_CUBE_TEMPLATE_ID: "candidate-legacy",
      }),
    ).toBe("candidate-new");
  });

  test("inherits the configured Daytona snapshot unless a T3 override is present", () => {
    expect(
      runtimeRunSnapshot({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_SNAPSHOT: "production-daytona",
      }),
    ).toBe("production-daytona");
    expect(
      runtimeRunSnapshot({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_SNAPSHOT: "production-daytona",
        T3_DAYTONA_SNAPSHOT: "candidate-daytona",
      }),
    ).toBe("candidate-daytona");
    expect(
      runtimeRunSnapshot({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_SNAPSHOT: "production-daytona",
        RUNTIME_DAYTONA_SNAPSHOT: "candidate-daytona-new",
      }),
    ).toBe("candidate-daytona-new");
  });

  test("matches T3's autonomous default and validates explicit runtime modes", () => {
    expect(configuredRuntimeMode({})).toBe("full-access");
    expect(configuredRuntimeMode({ T3_RUNTIME_MODE: "approval-required" })).toBe("approval-required");
    expect(configuredRuntimeMode({ RUNTIME_MODE: "full-access" })).toBe("full-access");
    expect(
      configuredRuntimeMode({ RUNTIME_MODE: "auto", T3_RUNTIME_MODE: "full-access" }),
    ).toBe("auto");
    expect(() => configuredRuntimeMode({ T3_RUNTIME_MODE: "unsafe-ish" })).toThrow(
      "RUNTIME_MODE (legacy T3_RUNTIME_MODE) must be",
    );
  });

  test("keeps semantic prompt composition and native T3 activity projection", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "composeTurnPrompt(ctx, established.resumed, executionCapabilities)",
    );
    expect(source).toContain("await establishProviderSession({");
    expect(source).toContain("const priorSnapshot = await readThreadSnapshot(ctx, sandbox);");
    expect(source).not.toContain("established.resumed\n          ? await readThreadSnapshot");
    expect(source).toContain("const steerResult = await driver.steer({");
    expect(source).toContain("metadata: { runtimeMode, createdAt }");
    expect(source).toContain("activityStep(activity)");
    expect(source).toContain("ctx.publishDelta?.(delta)");
    expect(source).toContain("warmPool: RUNTIME_CUBE_WARM_POOL_NAME");
    expect(source).toContain("requiredLabels:");
    expect(source).toContain("await driver.cancel(session, \"turn aborted\")");
    expect(source).toContain("providerGatewayWired()");
    expect(source).toContain("prepareSandboxTurn(ctx");
    expect(source).toContain("prepareRuntimeProviderBridge(sandbox, ctx, engine, workdir)");
    expect(source).toContain("await providerBridgeLease?.close()");
    expect(source).not.toContain("runManagedCodexSubscriptionTurn");
    expect(source).not.toContain('runtimeKind: "managed_codex_app_server"');
    expect(source).not.toContain("prompt.includes(");
    expect(source).not.toContain("keyword");
  });

  test("keeps desktop/noVNC readiness off the ordinary T3 turn critical path", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("Preparing runtime and integrations");
    expect(source).toContain("Waiting for provider activity");
    expect(source).toContain("runtimeFirstActivityTimeoutMs()");
    expect(source).not.toContain("ensureSandboxDesktopView");
    expect(source).not.toContain("desktop.available");
    expect(source).toContain("desktop: false");
  });

  test("bounds a provider retry storm with one no-progress watchdog owner", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "createNoProgressWatchdog(runtimeNoProgressTimeoutMs(), redact.text)",
    );
    expect(source).toContain("watchdog.observeActivity(activity)");
    expect(source).toContain("watchdog.observeProgress()");
    expect(source).toContain("AbortSignal.any([ctx.signal, watchdog.signal])");
    expect(source).toContain("if (watchdog.signal.aborted) throw watchdog.signal.reason;");
    expect(source).toContain('await driver.cancel(session, "provider made no progress")');
    // One watchdog owner and no steer replay after the turn may have started.
    expect(source.split("createNoProgressWatchdog(").length - 1).toBe(1);
    expect(source.split("driver.steer(").length - 1).toBe(1);
  });

  test("barriers on the codex reconcile (restart fallback) before steering", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    // Scoped to the subscription bridge only. Provider-gateway Codex and the
    // other engines never publish the relay-backed subscription cache marker.
    expect(source).toContain('providerBridgeLease?.authPath === "subscription"');
    // (B) Content barrier is attempted first (fast path, no restart cost).
    expect(source).toContain(
      "awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS)",
    );
    // (A) Deterministic restart is the fallback, then a single verify.
    expect(source).toContain("restartRuntimeEnvironment(sandbox, ctx.signal)");
    expect(source).toContain("invalidateRuntimeEnvironmentAccess(sandbox)");
    expect(source).toContain(
      "awaitCodexProviderReady(sandbox, ctx.signal, CODEX_VERIFY_DEADLINE_MS)",
    );
    expect(source).toContain(
      "Codex runtime did not become ready after restart",
    );
    // Exactly one restart; the barrier probe runs twice (barrier + post-restart verify).
    expect(source.split("restartRuntimeEnvironment(").length - 1).toBe(1);
    expect(source.split("awaitCodexProviderReady(").length - 1).toBe(2);
    // Ordering: barrier after the provider-bridge settings patch; restart after the
    // barrier; both before the provider session is established / the turn is steered.
    const bridgeIdx = source.indexOf("prepareRuntimeProviderBridge(sandbox, ctx, engine, workdir)");
    const barrierIdx = source.indexOf(
      "awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS)",
    );
    const restartIdx = source.indexOf("restartRuntimeEnvironment(sandbox, ctx.signal)");
    const establishIdx = source.indexOf("await establishProviderSession({");
    const steerIdx = source.indexOf("const steerResult = await driver.steer({");
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(barrierIdx).toBeGreaterThan(bridgeIdx);
    expect(restartIdx).toBeGreaterThan(barrierIdx);
    expect(establishIdx).toBeGreaterThan(restartIdx);
    expect(steerIdx).toBeGreaterThan(establishIdx);
    // A ready fast path leaves the barrier and continues to session start; it
    // must not return from the whole engine turn before dispatch.
    expect(source.slice(barrierIdx, restartIdx)).not.toContain("return;");
  });

  test("requires durable session persistence before T3 steering", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("persistSession: async (nativeSessionId) => {");
    expect(source).toContain("Session persistence is unavailable");
    expect(source).toContain("await ctx.saveEngineSessionId(nativeSessionId)");
    expect(source).not.toContain("ctx.saveEngineSessionId?.(");
  });
});
