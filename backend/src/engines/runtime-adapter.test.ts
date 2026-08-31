import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  runtimeAdapterEnabled,
  runtimeAdapterEngineSelected,
  runtimeAdapterMode,
  runtimeAdapterSelected,
  runtimeRunSnapshot,
  configuredRuntimeMode,
  createRuntimeTerminalSessionCleanup,
  drainRuntimeTerminalOutput,
  ensureRuntimeProviderReadyForTurn,
  projectRuntimeAssistantText,
  readRuntimeTerminalSnapshot,
  RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR,
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
    expect(() => runtimeRunSnapshot({
      SANDBOX_PROVIDER: "cube",
      CUBE_TEMPLATE_ID: "production-v7",
      USEAGENT_RUNTIME_GENERATION: "useagent-runtime-v9",
    })).toThrow("requires a dedicated RUNTIME_CUBE_TEMPLATE_ID");
    expect(runtimeRunSnapshot({
      SANDBOX_PROVIDER: "cube",
      CUBE_TEMPLATE_ID: "production-v7",
      RUNTIME_CUBE_TEMPLATE_ID: "candidate-v9",
      USEAGENT_RUNTIME_GENERATION: "useagent-runtime-v9",
    })).toBe("candidate-v9");
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
    expect(source).toContain("activityStep(activity, runtimeThreadId(ctx))");
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
    // The Codex barrier probe runs twice (barrier + post-restart verify).
    expect(source.split("awaitCodexProviderReady(").length - 1).toBe(2);
    // Ordering: barrier after the provider-bridge settings patch; restart after the
    // barrier; both before the provider session is established / the turn is steered.
    const bridgeIdx = source.indexOf("prepareRuntimeProviderBridge(sandbox, ctx, engine, workdir)");
    const barrierIdx = source.indexOf(
      "awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS)",
    );
    const restartIdx = source.indexOf(
      "restartRuntimeEnvironment(sandbox, ctx.signal)",
      barrierIdx,
    );
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

  test("barriers on the reconciled Claude gateway instance before session start", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    const bridgeIdx = source.indexOf("prepareRuntimeProviderBridge(sandbox, ctx, engine, workdir)");
    const barrierIdx = source.indexOf("await ensureRuntimeProviderReadyForTurn({", bridgeIdx);
    const establishIdx = source.indexOf("await establishProviderSession({");

    expect(barrierIdx).toBeGreaterThan(bridgeIdx);
    expect(establishIdx).toBeGreaterThan(barrierIdx);
  });

  test("skips the Claude runtime restart on the ready fast path", async () => {
    let waits = 0;
    let restarts = 0;
    await ensureRuntimeProviderReadyForTurn({
      sandbox: {} as never,
      signal: new AbortController().signal,
      readiness: {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "UseAgent Claude gateway current",
      },
      barrierDeadlineMs: 10,
      verifyDeadlineMs: 10,
      providerLabel: "Claude",
      dependencies: {
        awaitReady: async () => {
          waits += 1;
          return true;
        },
        restart: async () => {
          restarts += 1;
          return {} as never;
        },
        invalidateAccess: () => {},
      },
    });
    expect(waits).toBe(1);
    expect(restarts).toBe(0);
  });

  test("restarts Claude exactly once after a readiness timeout", async () => {
    const outcomes = [false, true];
    let restarts = 0;
    let invalidations = 0;
    await ensureRuntimeProviderReadyForTurn({
      sandbox: {} as never,
      signal: new AbortController().signal,
      readiness: {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "UseAgent Claude gateway current",
      },
      barrierDeadlineMs: 10,
      verifyDeadlineMs: 10,
      providerLabel: "Claude",
      dependencies: {
        awaitReady: async () => outcomes.shift() ?? false,
        restart: async () => {
          restarts += 1;
          return {} as never;
        },
        invalidateAccess: () => {
          invalidations += 1;
        },
      },
    });
    expect(restarts).toBe(1);
    expect(invalidations).toBe(1);
    expect(outcomes).toHaveLength(0);
  });

  test("does not restart Claude when readiness is cancelled", async () => {
    const reason = new Error("turn cancelled");
    let restarts = 0;
    await expect(
      ensureRuntimeProviderReadyForTurn({
        sandbox: {} as never,
        signal: new AbortController().signal,
        readiness: {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "UseAgent Claude gateway current",
        },
        barrierDeadlineMs: 10,
        verifyDeadlineMs: 10,
        providerLabel: "Claude",
        dependencies: {
          awaitReady: async () => {
            throw reason;
          },
          restart: async () => {
            restarts += 1;
            return {} as never;
          },
          invalidateAccess: () => {},
        },
      }),
    ).rejects.toBe(reason);
    expect(restarts).toBe(0);
  });

  test("fails closed when Claude is still not ready after restart", async () => {
    let restarts = 0;
    await expect(
      ensureRuntimeProviderReadyForTurn({
        sandbox: {} as never,
        signal: new AbortController().signal,
        readiness: {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "UseAgent Claude gateway current",
        },
        barrierDeadlineMs: 10,
        verifyDeadlineMs: 10,
        providerLabel: "Claude",
        dependencies: {
          awaitReady: async () => false,
          restart: async () => {
            restarts += 1;
            return {} as never;
          },
          invalidateAccess: () => {},
        },
      }),
    ).rejects.toThrow("Claude runtime did not become ready after restart");
    expect(restarts).toBe(1);
  });

  test("requires durable session persistence before T3 steering", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("persistSession: async (providerSession) => {");
    expect(source).toContain("Session persistence is unavailable");
    expect(source).toContain(
      "await ctx.saveProviderSession(providerSession, providerBridgeLease.authEpoch)",
    );
    expect(source).not.toContain("ctx.saveProviderSession?.(");
  });

  test("drains late text and reads Cube and Daytona synchronous snapshot output", async () => {
    const snapshots = [
      { text: "", settled: true, activities: ["child.completed"] },
      { text: "Final answer", settled: true, activities: ["child.completed", "root.summary"] },
    ];
    const persistedActivities: string[] = [];
    const publishedDeltas: string[] = [];
    let projection: ReturnType<typeof projectRuntimeAssistantText> = {
      publishedText: "",
      finalText: "",
      delta: "",
    };

    const summary = await drainRuntimeTerminalOutput({
      initialText: "",
      fallbackText: "",
      signal: new AbortController().signal,
      deadlineSignal: new AbortController().signal,
      readAndApplySnapshot: async () => {
        const snapshot = snapshots.shift()!;
        persistedActivities.push(...snapshot.activities);
        projection = projectRuntimeAssistantText(projection, snapshot.text, snapshot.settled);
        if (projection.delta) publishedDeltas.push(projection.delta);
        return projection.finalText;
      },
    });

    expect(summary).toBe("Final answer");
    expect(persistedActivities).toEqual([
      "child.completed",
      "child.completed",
      "root.summary",
    ]);
    expect(publishedDeltas).toEqual(["Final answer"]);

    const terminalSnapshotContext = {
      runId: "run-terminal-drain",
      threadId: "thread-terminal-drain",
    } as Parameters<typeof readRuntimeTerminalSnapshot>[0];
    const snapshotBody = JSON.stringify({
      snapshotSequence: 1,
      thread: {
        id: "skynet-thread-thread-terminal-drain",
        latestTurn: null,
        messages: [],
        activities: [],
        session: null,
      },
    });
    for (const result of [
      { cmdId: "cube", output: `${snapshotBody}\n__USEAGENT_T3_HTTP_STATUS__:200`, exitCode: 0 },
      { cmdId: "daytona", stdout: `${snapshotBody}\n__USEAGENT_T3_HTTP_STATUS__:200`, exitCode: 0 },
    ]) {
      const calls: Array<unknown> = [];
      const sandbox = ({
        process: {
          createSession: async (sessionId: string) => calls.push(["create", sessionId]),
          executeSessionCommand: async (
            sessionId: string,
            request: { runAsync?: boolean },
            timeoutSeconds?: number,
          ) => {
            calls.push(["execute", sessionId, request.runAsync, timeoutSeconds]);
            return result;
          },
          deleteSession: async (sessionId: string) => calls.push(["delete", sessionId]),
        },
      }) as unknown as Parameters<typeof readRuntimeTerminalSnapshot>[1];
      await expect(readRuntimeTerminalSnapshot(
        terminalSnapshotContext,
        sandbox,
        new AbortController().signal,
      )).resolves.toMatchObject({ snapshotSequence: 1 });
      expect(calls.some((call) => Array.isArray(call) && call[0] === "execute" && call[2] === false && call[3] === 2)).toBe(true);
      expect(calls.some((call) => Array.isArray(call) && call[0] === "delete")).toBe(true);
    }
  });

  test("bounds a hung snapshot read and preserves parent abort", async () => {
    const deadline = new AbortController();
    const terminalSnapshotContext = {
      runId: "run-terminal-drain",
      threadId: "thread-terminal-drain",
    } as Parameters<typeof readRuntimeTerminalSnapshot>[0];
    const hungSandbox = (abort: () => void, onCleanup: () => void) => ({
      process: {
        createSession: async () => {},
        executeSessionCommand: () => new Promise<never>(() => queueMicrotask(abort)),
        deleteSession: async () => onCleanup(),
      },
    }) as unknown as Parameters<typeof readRuntimeTerminalSnapshot>[1];
    let deadlineCleanupCount = 0;
    await expect(drainRuntimeTerminalOutput({
      initialText: "",
      fallbackText: "",
      signal: new AbortController().signal,
      deadlineSignal: deadline.signal,
      readAndApplySnapshot: async (signal) => {
        await readRuntimeTerminalSnapshot(
          terminalSnapshotContext,
          hungSandbox(
            () => deadline.abort(new Error("drain deadline")),
            () => { deadlineCleanupCount += 1; },
          ),
          signal,
        );
        return "";
      },
    })).rejects.toThrow(RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR);
    expect(deadlineCleanupCount).toBeGreaterThan(0);

    const controller = new AbortController();
    const reason = new Error("terminal drain aborted");
    let parentCleanupCount = 0;
    await expect(drainRuntimeTerminalOutput({
      initialText: "",
      fallbackText: "",
      signal: controller.signal,
      deadlineSignal: new AbortController().signal,
      readAndApplySnapshot: async (signal) => {
        await readRuntimeTerminalSnapshot(
          terminalSnapshotContext,
          hungSandbox(
            () => controller.abort(reason),
            () => { parentCleanupCount += 1; },
          ),
          signal,
        );
        return "";
      },
    })).rejects.toBe(reason);
    expect(parentCleanupCount).toBeGreaterThan(0);
  });

  test("cleans sessions recreated by late create and execute settlement", async () => {
    const context = {
      runId: "run-late-settlement",
      threadId: "thread-late-settlement",
    } as Parameters<typeof readRuntimeTerminalSnapshot>[0];
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    };

    const lateCreate = deferred<void>();
    let createSessionLive = false;
    let createCleanupCount = 0;
    const createSandbox = ({
      process: {
        createSession: () => lateCreate.promise.then(() => { createSessionLive = true; }),
        deleteSession: async () => {
          createCleanupCount += 1;
          createSessionLive = false;
        },
      },
    }) as unknown as Parameters<typeof readRuntimeTerminalSnapshot>[1];
    const createAbort = new AbortController();
    const createReason = new Error("abort during create");
    const createRead = readRuntimeTerminalSnapshot(context, createSandbox, createAbort.signal);
    createAbort.abort(createReason);
    await expect(createRead).rejects.toBe(createReason);
    lateCreate.resolve();
    await lateCreate.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createSessionLive).toBe(false);
    expect(createCleanupCount).toBeGreaterThanOrEqual(2);

    const lateExecute = deferred<{
      cmdId: string;
      output: string;
      exitCode: number;
    }>();
    let executeSessionLive = false;
    let executeCleanupCount = 0;
    const executeSandbox = ({
      process: {
        createSession: async () => { executeSessionLive = true; },
        executeSessionCommand: () => lateExecute.promise.finally(() => {
          executeSessionLive = true;
        }),
        deleteSession: async () => {
          executeCleanupCount += 1;
          executeSessionLive = false;
        },
      },
    }) as unknown as Parameters<typeof readRuntimeTerminalSnapshot>[1];
    const executeAbort = new AbortController();
    const executeReason = new Error("abort during execute");
    const executeRead = readRuntimeTerminalSnapshot(context, executeSandbox, executeAbort.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    executeAbort.abort(executeReason);
    await expect(executeRead).rejects.toBe(executeReason);
    lateExecute.reject(new Error("late execute rejection"));
    await lateExecute.promise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executeSessionLive).toBe(false);
    expect(executeCleanupCount).toBeGreaterThanOrEqual(2);
  });

  test("cleans delayed create and execute settlement from the pre-aborted path", async () => {
    const context = {
      runId: "run-pre-aborted",
      threadId: "thread-pre-aborted",
    } as Parameters<typeof readRuntimeTerminalSnapshot>[0];
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => { resolve = done; });
      return { promise, resolve };
    };

    const delayedCreate = deferred<void>();
    let createLive = false;
    const createSandbox = ({
      process: {
        createSession: () => delayedCreate.promise.then(() => { createLive = true; }),
        deleteSession: async () => { createLive = false; },
      },
    }) as unknown as Parameters<typeof readRuntimeTerminalSnapshot>[1];
    const createAbort = new AbortController();
    const createReason = new Error("pre-aborted create");
    createAbort.abort(createReason);
    const createRead = readRuntimeTerminalSnapshot(context, createSandbox, createAbort.signal);
    await expect(createRead).rejects.toBe(createReason);
    delayedCreate.resolve();
    await delayedCreate.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createLive).toBe(false);

    const delayedExecute = deferred<{ cmdId: string; output: string; exitCode: number }>();
    let executeLive = false;
    const executeAbort = new AbortController();
    const executeReason = new Error("pre-aborted execute");
    const executeSandbox = ({
      process: {
        createSession: async () => { executeLive = true; },
        executeSessionCommand: () => {
          executeAbort.abort(executeReason);
          return delayedExecute.promise.then((result) => {
            executeLive = true;
            return result;
          });
        },
        deleteSession: async () => { executeLive = false; },
      },
    }) as unknown as Parameters<typeof readRuntimeTerminalSnapshot>[1];
    const executeRead = readRuntimeTerminalSnapshot(context, executeSandbox, executeAbort.signal);
    await expect(executeRead).rejects.toBe(executeReason);
    delayedExecute.resolve({ cmdId: "late", output: "", exitCode: 0 });
    await delayedExecute.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executeLive).toBe(false);
  });

  test("bounds and logs terminal session cleanup failures", async () => {
    const warnings: Array<{ message: string; context: Record<string, string> }> = [];
    const warn = (message: string, context: Record<string, string>) => warnings.push({ message, context });
    const failedSandbox = ({
      process: { deleteSession: async () => { throw new Error("cleanup rejected"); } },
    }) as unknown as Parameters<typeof createRuntimeTerminalSessionCleanup>[0];
    await createRuntimeTerminalSessionCleanup(failedSandbox, "failed-cleanup", { warn })();

    const cleanupDeadline = new AbortController();
    const hungCleanupSandbox = ({
      process: {
        deleteSession: () => new Promise<never>(() =>
          queueMicrotask(() => cleanupDeadline.abort(new Error("cleanup deadline")))),
      },
    }) as unknown as Parameters<typeof createRuntimeTerminalSessionCleanup>[0];
    await createRuntimeTerminalSessionCleanup(hungCleanupSandbox, "hung-cleanup", {
      warn,
      deadlineSignal: cleanupDeadline.signal,
    })();

    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.context.error)).toEqual([
      "cleanup rejected",
      "cleanup deadline",
    ]);

    const dedupedWarnings: typeof warnings = [];
    const dedupedCleanup = createRuntimeTerminalSessionCleanup(
      failedSandbox,
      "deduped-cleanup",
      { warn: (message, context) => dedupedWarnings.push({ message, context }) },
    );
    await Promise.all([dedupedCleanup(), dedupedCleanup()]);
    await dedupedCleanup();
    expect(dedupedWarnings).toHaveLength(1);
  });

  test("uses monotonic published text when the terminal snapshot stays empty", async () => {
    let projection = { publishedText: "", finalText: "" };
    projection = projectRuntimeAssistantText(projection, "Hello", false);
    projection = projectRuntimeAssistantText(projection, "", true);
    expect(projection).toMatchObject({ publishedText: "Hello", finalText: "" });

    const deadline = new AbortController();
    let reads = 0;
    await expect(drainRuntimeTerminalOutput({
      initialText: projection.finalText,
      fallbackText: projection.publishedText,
      signal: new AbortController().signal,
      deadlineSignal: deadline.signal,
      readAndApplySnapshot: async () => {
        reads += 1;
        deadline.abort(new Error("drain deadline"));
        return "";
      },
    })).resolves.toBe("Hello");
    expect(reads).toBe(1);

    projection = { publishedText: "", finalText: "" };
    const deltas: string[] = [];
    for (const snapshot of [
      { text: "Hello", settled: false },
      { text: "Hel", settled: false },
      { text: "Hello", settled: true },
    ]) {
      const next = projectRuntimeAssistantText(projection, snapshot.text, snapshot.settled);
      if (next.delta) deltas.push(next.delta);
      projection = next;
    }
    expect(deltas).toEqual(["Hello"]);
    expect(projection).toMatchObject({ publishedText: "Hello", finalText: "Hello" });
  });
});
