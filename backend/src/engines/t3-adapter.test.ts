import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  t3RunAdapterEnabled,
  t3RunAdapterEngineSelected,
  t3RunAdapterMode,
  t3RunAdapterSelected,
  t3RunSnapshot,
  t3RuntimeMode,
} from "./t3-adapter";

describe("T3 run adapter gate", () => {
  test("is disabled unless explicitly enabled", () => {
    expect(t3RunAdapterEnabled({})).toBe(false);
    expect(t3RunAdapterEnabled({ T3_RUN_ADAPTER_ENABLED: "true" })).toBe(true);
  });

  test("defaults an enabled adapter to explicit canary threads", () => {
    const ctx = { runId: "run-1", threadId: "thread-1" };
    expect(t3RunAdapterMode({ T3_RUN_ADAPTER_ENABLED: "true" })).toBe("canary");
    expect(t3RunAdapterSelected(ctx, { T3_RUN_ADAPTER_ENABLED: "true" })).toBe(false);
    expect(
      t3RunAdapterSelected(ctx, {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_CANARY_THREAD_IDS: "other, thread-1",
      }),
    ).toBe(true);
    expect(
      t3RunAdapterSelected(ctx, {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_RUN_ADAPTER_MODE: "all",
      }),
    ).toBe(true);
  });

  test("rejects an unknown routing mode", () => {
    expect(() => t3RunAdapterMode({ T3_RUN_ADAPTER_MODE: "maybe" })).toThrow(
      "T3_RUN_ADAPTER_MODE must be canary or all",
    );
  });

  test("can restrict an all-mode cutover to proven engines", () => {
    expect(t3RunAdapterEngineSelected("codex", {})).toBe(true);
    expect(t3RunAdapterEngineSelected("opencode", {})).toBe(true);
    expect(t3RunAdapterEngineSelected("claude", {})).toBe(false);
    expect(
      t3RunAdapterEngineSelected("codex", {
        T3_RUN_ADAPTER_ENGINES: "codex, opencode",
      }),
    ).toBe(true);
    expect(
      t3RunAdapterEngineSelected("claude", {
        T3_RUN_ADAPTER_ENGINES: "codex, opencode",
      }),
    ).toBe(false);
  });

  test("uses a separate Cube candidate template during parity testing", () => {
    expect(
      t3RunSnapshot({
        SANDBOX_PROVIDER: "cube",
        CUBE_TEMPLATE_ID: "production",
        T3_CUBE_TEMPLATE_ID: "candidate",
      }),
    ).toBe("candidate");
  });

  test("inherits the configured Daytona snapshot unless a T3 override is present", () => {
    expect(
      t3RunSnapshot({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_SNAPSHOT: "production-daytona",
      }),
    ).toBe("production-daytona");
    expect(
      t3RunSnapshot({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_SNAPSHOT: "production-daytona",
        T3_DAYTONA_SNAPSHOT: "candidate-daytona",
      }),
    ).toBe("candidate-daytona");
  });

  test("matches T3's autonomous default and validates explicit runtime modes", () => {
    expect(t3RuntimeMode({})).toBe("full-access");
    expect(t3RuntimeMode({ T3_RUNTIME_MODE: "approval-required" })).toBe("approval-required");
    expect(t3RuntimeMode({ T3_RUNTIME_MODE: "full-access" })).toBe("full-access");
    expect(() => t3RuntimeMode({ T3_RUNTIME_MODE: "unsafe-ish" })).toThrow(
      "T3_RUNTIME_MODE must be",
    );
  });

  test("keeps semantic prompt composition and native T3 activity projection", () => {
    const source = readFileSync(new URL("./t3-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("composeTurnPrompt(ctx, established.resumed)");
    expect(source).toContain("await establishProviderSession({");
    expect(source).toContain("const steerResult = await driver.steer({");
    expect(source).toContain("metadata: { runtimeMode, createdAt }");
    expect(source).toContain("activityStep(activity)");
    expect(source).toContain("ctx.publishDelta?.(delta)");
    expect(source).toContain("warmPool: T3_CUBE_WARM_POOL_NAME");
    expect(source).toContain("requiredLabels:");
    expect(source).toContain("await driver.cancel(session, \"turn aborted\")");
    expect(source).toContain("providerGatewayWired()");
    expect(source).toContain("acquireThreadSandbox(ctx");
    expect(source).toContain("prepareT3ProviderBridge(sandbox, ctx, engine, workdir)");
    expect(source).toContain("await providerBridgeLease?.close()");
    expect(source).not.toContain("runManagedCodexSubscriptionTurn");
    expect(source).not.toContain('runtimeKind: "managed_codex_app_server"');
    expect(source).not.toContain("prompt.includes(");
    expect(source).not.toContain("keyword");
  });

  test("keeps desktop/noVNC readiness off the ordinary T3 turn critical path", () => {
    const source = readFileSync(new URL("./t3-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("Preparing T3 runtime and integrations");
    expect(source).toContain("Waiting for T3 activity");
    expect(source).toContain("t3FirstActivityTimeoutMs()");
    expect(source).not.toContain("ensureSandboxDesktopView");
    expect(source).not.toContain("desktop.available");
    expect(source).toContain("desktop: false");
  });

  test("bounds a provider retry storm with one no-progress watchdog owner", () => {
    const source = readFileSync(new URL("./t3-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "createNoProgressWatchdog(t3NoProgressTimeoutMs(), redact.text)",
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
    const source = readFileSync(new URL("./t3-adapter.ts", import.meta.url), "utf8");
    // Scoped to codex-engine runs only; opencode/claude never patch settings and
    // must not pay the barrier or restart.
    expect(source).toContain('if (engine === "codex") {');
    // (B) Content barrier is attempted first (fast path, no restart cost).
    expect(source).toContain(
      "awaitT3CodexProviderReady(sandbox, ctx.signal, T3_CODEX_BARRIER_DEADLINE_MS)",
    );
    // (A) Deterministic restart is the fallback, then a single verify.
    expect(source).toContain("restartT3Environment(sandbox, ctx.signal)");
    expect(source).toContain("invalidateT3EnvironmentAccess(sandbox)");
    expect(source).toContain(
      "awaitT3CodexProviderReady(sandbox, ctx.signal, T3_CODEX_VERIFY_DEADLINE_MS)",
    );
    expect(source).toContain(
      "T3 codex subscription runtime did not become ready after restart",
    );
    // Exactly one restart; the barrier probe runs twice (barrier + post-restart verify).
    expect(source.split("restartT3Environment(").length - 1).toBe(1);
    expect(source.split("awaitT3CodexProviderReady(").length - 1).toBe(2);
    // Ordering: barrier after the provider-bridge settings patch; restart after the
    // barrier; both before the provider session is established / the turn is steered.
    const bridgeIdx = source.indexOf("prepareT3ProviderBridge(sandbox, ctx, engine, workdir)");
    const barrierIdx = source.indexOf(
      "awaitT3CodexProviderReady(sandbox, ctx.signal, T3_CODEX_BARRIER_DEADLINE_MS)",
    );
    const restartIdx = source.indexOf("restartT3Environment(sandbox, ctx.signal)");
    const establishIdx = source.indexOf("await establishProviderSession({");
    const steerIdx = source.indexOf("const steerResult = await driver.steer({");
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(barrierIdx).toBeGreaterThan(bridgeIdx);
    expect(restartIdx).toBeGreaterThan(barrierIdx);
    expect(establishIdx).toBeGreaterThan(restartIdx);
    expect(steerIdx).toBeGreaterThan(establishIdx);
  });

  test("requires durable session persistence before T3 steering", () => {
    const source = readFileSync(new URL("./t3-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("persistSession: async (nativeSessionId) => {");
    expect(source).toContain("T3 session persistence is unavailable");
    expect(source).toContain("await ctx.saveEngineSessionId(nativeSessionId)");
    expect(source).not.toContain("ctx.saveEngineSessionId?.(");
  });
});
