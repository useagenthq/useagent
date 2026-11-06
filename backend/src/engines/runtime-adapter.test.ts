import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  runtimeRunSnapshot,
  runtimeThreadHasAuthoritativeHistory,
  configuredRuntimeMode,
  createRuntimeTerminalSessionCleanup,
  drainRuntimeTerminalOutput,
  projectRuntimeAssistantText,
  readRuntimeTerminalSnapshot,
  RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR,
  waitForRuntimeTurn,
} from "./runtime-adapter";
import { ensureRuntimeProviderReadyForTurn } from "./runtime-provider-barrier";
import {
  recoverStuckCodexSubscriptionStart,
  RuntimeFirstActivityTimeoutError,
} from "./runtime-startup-recovery.js";
import { composeTurnPrompt } from "./turn-prompt";
import { buildExecutionCapabilitySnapshot } from "./execution-capabilities";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { RuntimeEnvironmentRequestError, type RuntimeEnvironmentRequest } from "./runtime-environment-client";
import type { SandboxHandle } from "../sandboxes/provider";
import { createSecretRedactor } from "../secrets/redact";
import type { EngineRunContext } from "./types";
import { SandboxUnresponsiveError } from "./turn-liveness";
import { scriptedFollow, v2Projection, v2ProviderThread, v2Run, v2Session, v2Snapshot, v2Turn } from "./runtime-v2.test-support";
import { runtimeThreadView } from "./runtime-v2-view";
import { createForeignRunGuard, FOREIGN_RUN_REASON } from "./runtime-foreign-runs";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

/** A runtime thread whose provider session is `sessionStatus` after its latest run `runId` in `runState`. */
function stuckThread(
  sessionStatus: string | null,
  runState: "running" | "completed" | null = "completed",
  _threadId = `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
  runId = "turn-1",
) {
  return v2Snapshot(1, v2Projection({
    runs: runState === null ? [] : [v2Run({ id: runId, status: runState, completedAt: runState === "running" ? null : "x" })],
    providerSessions: sessionStatus === null ? [] : [v2Session({ status: sessionStatus })],
    providerThreads: sessionStatus === null ? [] : [v2ProviderThread()],
  }));
}

function turnContext(runId: string, overrides: Partial<EngineRunContext> = {}): EngineRunContext {
  return {
    runId,
    threadId: "thread-1",
    signal: new AbortController().signal,
    emit: async () => undefined,
    setSummary() {},
    ...overrides,
  } as unknown as EngineRunContext;
}

const noRead = async (): Promise<never> => { throw new Error("unexpected HTTP thread read"); };
const noGuard = () => async () => [] as string[];

describe("T3 run adapter gate", () => {
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
      USEAGENT_RUNTIME_GENERATION: "useagent-runtime-v10",
    })).toThrow("requires a dedicated RUNTIME_CUBE_TEMPLATE_ID");
    expect(runtimeRunSnapshot({
      SANDBOX_PROVIDER: "cube",
      CUBE_TEMPLATE_ID: "production-v7",
      RUNTIME_CUBE_TEMPLATE_ID: "candidate-v9",
      USEAGENT_RUNTIME_GENERATION: "useagent-runtime-v9",
    })).toBe("candidate-v9");
  });

  test("prefers the baked native Box snapshot over the generic Box template", () => {
    expect(runtimeRunSnapshot({ SANDBOX_PROVIDER: "box" })).toBe("");
    expect(runtimeRunSnapshot({ SANDBOX_PROVIDER: "box", BOX_SNAPSHOT: "generic" })).toBe("generic");
    expect(
      runtimeRunSnapshot({
        SANDBOX_PROVIDER: "box",
        BOX_SNAPSHOT: "generic",
        RUNTIME_BOX_SNAPSHOT: "useagent-native-524d46b-a2f93ea",
      }),
    ).toBe("useagent-native-524d46b-a2f93ea");
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
    const adapterSource = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    const waitSource = readFileSync(new URL("./runtime-turn-wait.ts", import.meta.url), "utf8");
    const source = adapterSource;
    expect(source).toContain(
      "runtimeThreadHasAuthoritativeHistory(priorSnapshot, providerBridgeLease)",
    );
    expect(source).toContain("const prompt = await composeRunTurnPrompt(");
    expect(source).toContain("await establishProviderSession({");
    expect(source).toContain("snapshot: await readThreadSnapshot(ctx, sandbox),");
    expect(source).not.toContain("established.resumed\n          ? await readThreadSnapshot");
    expect(source).toContain("const steerResult = await driver.steer({");
    const reloadIdx = source.indexOf("const limitsApplied = await reloadRetainedSession({");
    const ackIdx = source.indexOf("await providerBridgeLease.ackModelLimitsReload();");
    const establishIdx = source.indexOf("await establishProviderSession({");
    const steerIdx = source.indexOf("const steerResult = await driver.steer({");
    expect(reloadIdx).toBeGreaterThan(-1);
    expect(ackIdx).toBeGreaterThan(reloadIdx);
    expect(establishIdx).toBeGreaterThan(ackIdx);
    // Local Codex detaches a session started on an older config.toml before the turn, like OpenCode.
    const codexStampIdx = source.indexOf("await stampCodexConfig(sandbox, threadId, configRevision);");
    expect(codexStampIdx).toBeGreaterThan(ackIdx);
    expect(establishIdx).toBeGreaterThan(codexStampIdx);
    expect(source.indexOf("readCodexConfigChange(sandbox, runtimeThreadId(ctx))")).toBeLessThan(source.indexOf("const shell = "));
    expect(steerIdx).toBeGreaterThan(establishIdx);
    const reloadModuleSource = readFileSync(
      new URL("./runtime-session-stop.ts", import.meta.url),
      "utf8",
    );
    const reloadFunctionIdx = reloadModuleSource.indexOf(
      "export async function reloadRetainedSession",
    );
    expect(reloadFunctionIdx).toBeGreaterThan(-1);
    const reloadSource = reloadModuleSource.slice(reloadFunctionIdx);
    expect(reloadSource.length).toBeGreaterThan(0);
    expect(reloadSource).not.toContain("restartRuntimeEnvironment");
    expect(reloadSource).not.toContain("deleteSession");
    expect(reloadSource).not.toContain("sandbox.delete");
    expect(reloadSource).not.toContain("driver.cancel");
    expect(reloadSource).not.toContain("/config");
    expect(reloadSource).not.toContain("global/dispose");
    expect(source).toContain("? { runtimeMode, createdAt, ...controlMetadata }");
    // Native activity projection lives with the turn projector the adapter drives.
    const projectorSource = readFileSync(new URL("./turn-projector.ts", import.meta.url), "utf8");
    expect(projectorSource).toContain("activityStep(recordedRuntimeActivity(activity, redact), threadId, engine)");
    expect(projectorSource).toContain("ctx.publishDelta?.(projection.delta)");
    // The observer feeds the watchdog every activity and, for a read-only run, answers its write requests.
    expect(waitSource).toContain("projector.apply(snapshot, observe)");
    expect(waitSource).toContain("watchdog.observeActivity(activity);");
    // The turn is steered on the subscribed socket: the wait owns the steer as its start.
    expect(source).toContain("const start = async () => {");
    expect(source).toContain("engine, projector, start,");
    expect(waitSource).toContain("...(start ? { start } : {}),");
    // Every view first passes the guard against runs the plane did not start.
    expect(waitSource).toContain("await guardForeignRuns(source.projection);");
    // The run's mode is applied to the runtime THREAD before the turn is steered.
    expect(source).toContain("const priorSnapshot = await ensureRuntimeThreadMode({");
    // A read-only turn never resumes a thread that may hold an "always allow" grant.
    expect(source).toContain("await assertReadOnlyTurnAllowed({ threadId: ctx.threadId ?? ctx.runId, permissionMode: ctx.permissionMode, threadExists });");
    expect(source).toContain("warmPool: RUNTIME_CUBE_WARM_POOL_NAME");
    expect(source).toContain("requiredLabels:");
    expect(source).toContain('"turn aborted",');
    expect(source).toContain("providerGatewayWired()");
    expect(source).toContain("prepareSandboxTurn(ctx");
    expect(source).toContain("prepareStableRuntimeProvider(sandbox, ctx, engine)");
    expect(source).toContain('providerAfterResources: engine === "claude"');
    expect(source).toContain('resourceUser: engine === "claude"');
    expect(source).toContain("preparation.stableProviderPrepared");
    expect(source).toContain("stableProviderPendingRevision");
    expect(source).toContain("closeProvider: (state) => state.close()");
    expect(source).toContain("await prepared.close().catch(() => {})");
    expect(source).not.toContain("await providerBridgeLease?.close()");
    expect(source).not.toContain("runManagedCodexSubscriptionTurn");
    expect(source).not.toContain('runtimeKind: "managed_codex_app_server"');
    expect(source).not.toContain("prompt.includes(");
    expect(source).not.toContain("keyword");
  });

  test("records the session's command catalog once the session is up, before steering, and again once the turn settled", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    const establishedIdx = source.indexOf("const session = established.session;");
    const catalogIdx = source.indexOf("const commandCatalog = recordRuntimeCommandCatalog({ ctx, sandbox, engine, session });");
    const snapshotIdx = source.indexOf("snapshot: await readThreadSnapshot(ctx, sandbox),");
    const sessionStartedIdx = source.indexOf("await recordProviderSessionStarted(ctx, session, {");
    const awaitedIdx = source.indexOf("await commandCatalog;");
    const revalidateIdx = source.indexOf("await runtimeCommandDispatchRejection({");
    const steerIdx = source.indexOf("const steerResult = await driver.steer({");
    const settledIdx = source.lastIndexOf("await recordRuntimeCommandCatalog({ ctx, sandbox, engine, session });");
    const closeIdx = source.indexOf("await prepared.close().catch(() => {});");
    expect(establishedIdx).toBeGreaterThan(-1);
    expect(catalogIdx).toBeGreaterThan(establishedIdx);
    // The catalog probe runs alongside the thread snapshot read, not after it.
    expect(snapshotIdx).toBeGreaterThan(catalogIdx);
    expect(awaitedIdx).toBeGreaterThan(sessionStartedIdx);
    expect(revalidateIdx).toBeGreaterThan(awaitedIdx);
    expect(steerIdx).toBeGreaterThan(revalidateIdx);
    expect(settledIdx).toBeGreaterThan(steerIdx);
    expect(closeIdx).toBeGreaterThan(settledIdx);
  });

  test("the plane's history goes only into a fresh runtime thread", () => {
    const ctx = {
      prompt: "continue",
      bootstrapContext: "CANONICAL PRIOR THREAD HISTORY\n\n",
      turnContext: "",
      threadId: "thread-1",
      orgId: "org-1",
      origin: null,
    };
    const executionCapabilities = buildExecutionCapabilitySnapshot({
      runtime: "sandbox",
      workspaceRoot: "/root/work",
      gatewayAvailable: true,
      desktopAvailability: "on_demand",
    });
    const promptFor = (snapshot: RuntimeThreadSnapshot, lease: Parameters<typeof runtimeThreadHasAuthoritativeHistory>[1]) =>
      composeTurnPrompt(ctx, runtimeThreadHasAuthoritativeHistory(snapshot, lease), executionCapabilities, {});
    const gateway = { authPath: "provider_gateway", hasCurrentEpochThreadBinding: false } as const;

    // The first turn, or the first after the sandbox was recreated: no runs yet.
    const fresh = runtimeThreadView(v2Snapshot(1, v2Projection()));
    expect(promptFor(fresh, gateway)).toContain("CANONICAL PRIOR THREAD HISTORY");

    // Another engine on a living thread: the runtime hands its own history
    // over, even though the plane's session for this engine is new.
    const living = runtimeThreadView(v2Snapshot(2, v2Projection({
      runs: [v2Run({ id: "run-codex", status: "completed", providerThreadId: "pt-codex" })],
      providerThreads: [v2ProviderThread({ id: "pt-codex" })],
    })));
    expect(promptFor(living, gateway)).not.toContain("CANONICAL PRIOR THREAD HISTORY");

    // A subscription thread keeps the plane's history until it is bound for the current auth epoch.
    expect(promptFor(living, { authPath: "subscription", hasCurrentEpochThreadBinding: false }))
      .toContain("CANONICAL PRIOR THREAD HISTORY");
    expect(promptFor(living, { authPath: "subscription", hasCurrentEpochThreadBinding: true }))
      .not.toContain("CANONICAL PRIOR THREAD HISTORY");
  });

  test("reads a warm runtime's shell alongside the provider bridge, and again after a restart", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    const prepareProviderIdx = source.indexOf("async prepareProvider(sandbox, workdir, binding, preparation) {");
    const earlyIdx = source.indexOf("if (runtimeEnvironmentAccessValidated(sandbox)) {", prepareProviderIdx);
    const bridgeIdx = source.indexOf("return await prepareRuntimeProviderBridge(", prepareProviderIdx);
    expect(prepareProviderIdx).toBeGreaterThan(-1);
    expect(earlyIdx).toBeGreaterThan(prepareProviderIdx);
    expect(bridgeIdx).toBeGreaterThan(earlyIdx);
    // A barrier that restarts the runtime discards the early read; one that
    // only waits (or asks T3 to re-check) keeps it.
    const pending = source.indexOf("await applyPendingCodexProviderConfiguration({");
    // The pending Codex configuration always restarts the runtime.
    const pendingBlock = source.lastIndexOf('providerBridgeLease.authPath !== "subscription" &&', pending);
    expect(pendingBlock).toBeGreaterThan(-1);
    expect(source.slice(pendingBlock, pending)).toContain("runtimeTouched = true;");
    expect(source).toContain("runtimeTouched = (await ensureRuntimeProviderReadyForTurn({");
    const subscriptionRestart = source.indexOf("await restartRuntimeEnvironment(sandbox, ctx.signal, ctx.timing);");
    const lineAbove = source.lastIndexOf("\n", source.lastIndexOf("\n", subscriptionRestart) - 1);
    expect(source.slice(lineAbove, subscriptionRestart)).toContain("runtimeTouched = true;");
    expect(source.match(/runtimeTouched = true;/g)).toHaveLength(2);
    expect(source).toContain("const shell = (!runtimeTouched && await earlyShell) ||");
  });

  test("keeps desktop/noVNC readiness off the ordinary T3 turn critical path", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8") +
      readFileSync(new URL("./runtime-turn-wait.ts", import.meta.url), "utf8");
    expect(source).toContain("Preparing runtime and integrations");
    expect(source).toContain("Waiting for provider activity");
    expect(source).toContain("runtimeFirstActivityTimeoutMs()");
    expect(source).not.toContain("ensureSandboxDesktopView");
    expect(source).not.toContain("desktop.available");
    expect(source).toContain("desktop: false");
  });

  test("recovers only an owned subscription thread stuck starting after first-activity timeout", async () => {
    const calls: string[] = [];
    const nativeHistory = ["message-1", "message-2"];
    const error = new RuntimeFirstActivityTimeoutError(45_000);
    const sandbox = { id: "sandbox-owned", nativeHistory } as unknown as SandboxHandle;
    const cleanupSignal = new AbortController().signal;
    const returned = await recoverStuckCodexSubscriptionStart({
      error,
      ctx: {
        runId: "run-2",
        threadId: "thread-1",
        signal: new AbortController().signal,
      },
      sandbox,
      lease: {
        authPath: "subscription",
        close: async () => { calls.push("close-lease"); },
      },
      priorTurnId: "turn-previous",
      dependencies: {
        requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) => {
          calls.push(request.path);
          return (request.path === "/api/orchestration/shell"
            ? { projects: [], threads: [{ id: `${SANDBOX_NAME_PREFIX}-thread-thread-1` }] }
            : stuckThread(
                "starting",
                "completed",
                `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
                "turn-previous",
              )) as T;
        },
        restart: async (restarted, signal) => {
          calls.push("restart-runtime");
          expect(restarted).toBe(sandbox);
          expect(signal).toBe(cleanupSignal);
          return {} as never;
        },
        invalidateAccess: () => { calls.push("invalidate-access"); },
        cleanupSignal: () => cleanupSignal,
        warn: () => { throw new Error("unexpected recovery warning"); },
      },
    });

    expect(returned).toEqual({ error, stuckStartConfirmed: true });
    expect(calls).toEqual([
      `/api/orchestration/threads/${SANDBOX_NAME_PREFIX}-thread-thread-1/bounded`,
      "/api/orchestration/shell",
      "close-lease",
      "restart-runtime",
      "invalidate-access",
    ]);
    expect(nativeHistory).toEqual(["message-1", "message-2"]);
  });

  test("re-resolves the expected sandbox before stuck-start recovery touches the runtime", async () => {
    const expectedSandbox = {
      version: 1 as const,
      sandboxId: "sandbox-owned",
      provider: "cube" as const,
      credential: "env" as const,
      ownerOrgId: "org-1",
      ownerUserId: null,
      credentialGeneration: "e".repeat(64),
    };
    const resolved = { id: "sandbox-owned", resolved: true } as unknown as SandboxHandle;
    const touched: unknown[] = [];
    const error = new RuntimeFirstActivityTimeoutError(45_000);
    await expect(recoverStuckCodexSubscriptionStart({
      error,
      ctx: {
        runId: "run-2",
        threadId: "thread-1",
        expectedSandbox,
        signal: new AbortController().signal,
      },
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease: { authPath: "subscription", close: async () => {} },
      priorTurnId: null,
      dependencies: {
        resolveExpectedSandbox: async (expected, threadId) => {
          expect(expected).toEqual(expectedSandbox);
          expect(threadId).toBe("thread-1");
          return resolved;
        },
        requestEnvironment: async <T>(
          sandbox: SandboxHandle,
          request: RuntimeEnvironmentRequest,
        ) => {
          touched.push(sandbox);
          return (request.path === "/api/orchestration/shell"
            ? { projects: [], threads: [{ id: `${SANDBOX_NAME_PREFIX}-thread-thread-1` }] }
            : stuckThread("starting", null, `${SANDBOX_NAME_PREFIX}-thread-thread-1`)) as T;
        },
        restart: async (sandbox) => { touched.push(sandbox); return {} as never; },
        invalidateAccess: (sandbox) => { touched.push(sandbox); },
        cleanupSignal: () => new AbortController().signal,
        warn: () => { throw new Error("unexpected recovery warning"); },
      },
    })).resolves.toEqual({ error, stuckStartConfirmed: true });
    expect(touched).toEqual([resolved, resolved, resolved, resolved]);
  });

  test("rejects a stuck-start runtime id mismatch before strict lookup or remote access", async () => {
    let lookups = 0;
    let remoteOperations = 0;
    const error = new RuntimeFirstActivityTimeoutError(45_000);
    const result = await recoverStuckCodexSubscriptionStart({
      error,
      ctx: {
        runId: "run-2",
        threadId: "thread-1",
        expectedSandbox: {
          version: 1,
          sandboxId: "expected",
          provider: "cube",
          credential: "env",
          ownerOrgId: "org-1",
          ownerUserId: null,
          credentialGeneration: "f".repeat(64),
        },
        signal: new AbortController().signal,
      },
      sandbox: { id: "other" } as SandboxHandle,
      lease: { authPath: "subscription", close: async () => {} },
      priorTurnId: null,
      dependencies: {
        resolveExpectedSandbox: async () => { lookups += 1; return {} as never; },
        requestEnvironment: async () => { remoteOperations += 1; return {} as never; },
        restart: async () => { remoteOperations += 1; return {} as never; },
        invalidateAccess: () => { remoteOperations += 1; },
        cleanupSignal: () => new AbortController().signal,
        warn: () => {},
      },
    });
    expect(result).toEqual({ error, stuckStartConfirmed: false });
    expect(lookups).toBe(0);
    expect(remoteOperations).toBe(0);
  });

  test("recovers a proven stuck startup on early user abort without queueing cancel", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const userStopped = new Error("user stopped the run");
    controller.abort(userStopped);
    const recovery = await recoverStuckCodexSubscriptionStart({
      error: userStopped,
      ctx: { runId: "run-2", threadId: "thread-1", signal: controller.signal },
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease: {
        authPath: "subscription",
        close: async () => { calls.push("close-lease"); },
      },
      priorTurnId: null,
      dependencies: {
        requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) => {
          calls.push(request.path);
          return (request.path === "/api/orchestration/shell"
            ? { projects: [], threads: [{ id: `${SANDBOX_NAME_PREFIX}-thread-thread-1` }] }
            : stuckThread("starting", null, `${SANDBOX_NAME_PREFIX}-thread-thread-1`)) as T;
        },
        restart: async () => { calls.push("restart-runtime"); return {} as never; },
        invalidateAccess: () => { calls.push("invalidate-access"); },
        cleanupSignal: () => new AbortController().signal,
        warn: () => { throw new Error("unexpected recovery warning"); },
      },
    });

    expect(recovery).toEqual({ error: userStopped, stuckStartConfirmed: true });
    expect(calls).toEqual([
      `/api/orchestration/threads/${SANDBOX_NAME_PREFIX}-thread-thread-1/bounded`,
      "/api/orchestration/shell",
      "close-lease",
      "restart-runtime",
      "invalidate-access",
    ]);
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("skipQueuedCancel = recovery.stuckStartConfirmed");
    expect(source).toContain(
      'if (ctx.signal.aborted && !skipQueuedCancel && ctx.commandName !== "compact")',
    );
  });

  test("does not restart for ordinary waits or when the native turn advanced", async () => {
    const calls: string[] = [];
    const dependencies = {
      requestEnvironment: async <T>() => {
        calls.push("read");
        return stuckThread("starting", "completed", `${SANDBOX_NAME_PREFIX}-thread-thread-1`) as T;
      },
      restart: async () => { calls.push("restart"); return {} as never; },
      invalidateAccess: () => { calls.push("invalidate"); },
      cleanupSignal: () => new AbortController().signal,
      warn: () => { calls.push("warn"); },
    };
    const lease = { authPath: "subscription" as const, close: async () => { calls.push("close"); } };
    const ctx = {
      runId: "run-2",
      threadId: "thread-1",
      signal: new AbortController().signal,
    };

    const ordinaryWait = new Error("model is still running");
    expect(await recoverStuckCodexSubscriptionStart({
      error: ordinaryWait,
      ctx,
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease,
      priorTurnId: "turn-previous",
      dependencies,
    })).toEqual({ error: ordinaryWait, stuckStartConfirmed: false });
    expect(calls).toEqual([]);

    const timeout = new RuntimeFirstActivityTimeoutError(45_000);
    expect(await recoverStuckCodexSubscriptionStart({
      error: timeout,
      ctx,
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease,
      priorTurnId: "turn-previous",
      dependencies,
    })).toEqual({ error: timeout, stuckStartConfirmed: false });
    expect(calls).toEqual(["read"]);

    calls.length = 0;
    const activeAbort = new AbortController();
    const activeAbortReason = new Error("stop active turn");
    activeAbort.abort(activeAbortReason);
    expect(await recoverStuckCodexSubscriptionStart({
      error: activeAbortReason,
      ctx: { ...ctx, signal: activeAbort.signal },
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease,
      priorTurnId: "turn-previous",
      dependencies,
    })).toEqual({ error: activeAbortReason, stuckStartConfirmed: false });
    expect(calls).toEqual(["read"]);

    calls.length = 0;
    expect(await recoverStuckCodexSubscriptionStart({
      error: timeout,
      ctx,
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease,
      priorTurnId: "turn-previous",
      dependencies: {
        ...dependencies,
        requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) => {
          calls.push(request.path);
          return (request.path === "/api/orchestration/shell"
            ? {
                projects: [],
                threads: [
                  { id: `${SANDBOX_NAME_PREFIX}-thread-thread-1` },
                  { id: `${SANDBOX_NAME_PREFIX}-thread-another-active-thread` },
                ],
              }
            : stuckThread(
                "starting",
                "completed",
                `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
                "turn-previous",
              )) as T;
        },
      },
    })).toEqual({ error: timeout, stuckStartConfirmed: false });
    expect(calls).toEqual([
      `/api/orchestration/threads/${SANDBOX_NAME_PREFIX}-thread-thread-1/bounded`,
      "/api/orchestration/shell",
    ]);

    // The thread's own subagent children share its runtime and do not block the restart.
    calls.length = 0;
    expect(await recoverStuckCodexSubscriptionStart({
      error: timeout,
      ctx,
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease,
      priorTurnId: "turn-previous",
      dependencies: {
        ...dependencies,
        requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) =>
          (request.path === "/api/orchestration/shell"
            ? {
                projects: [],
                threads: [
                  { id: `${SANDBOX_NAME_PREFIX}-thread-thread-1`, lineage: { rootThreadId: `${SANDBOX_NAME_PREFIX}-thread-thread-1` } },
                  { id: "child-of-thread-1", lineage: { rootThreadId: `${SANDBOX_NAME_PREFIX}-thread-thread-1` } },
                ],
              }
            : stuckThread("starting", "completed", `${SANDBOX_NAME_PREFIX}-thread-thread-1`, "turn-previous")) as T,
      },
    })).toEqual({ error: timeout, stuckStartConfirmed: true });
    expect(calls).toEqual(["close", "restart", "invalidate"]);
  });

  test("preserves the first-activity cause when stuck-start recovery fails", async () => {
    const calls: string[] = [];
    const warnings: unknown[] = [];
    const error = new RuntimeFirstActivityTimeoutError(45_000);
    const returned = await recoverStuckCodexSubscriptionStart({
      error,
      ctx: {
        runId: "run-2",
        threadId: "thread-1",
        signal: new AbortController().signal,
      },
      sandbox: { id: "sandbox-owned" } as SandboxHandle,
      lease: {
        authPath: "subscription",
        close: async () => { calls.push("close-lease"); },
      },
      priorTurnId: null,
      dependencies: {
        requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) =>
          (request.path === "/api/orchestration/shell"
            ? { projects: [], threads: [{ id: `${SANDBOX_NAME_PREFIX}-thread-thread-1` }] }
            : stuckThread("starting", null, `${SANDBOX_NAME_PREFIX}-thread-thread-1`)) as T,
        restart: async () => {
          calls.push("restart-runtime");
          throw new Error("restart failed");
        },
        invalidateAccess: () => { calls.push("invalidate-access"); },
        cleanupSignal: () => new AbortController().signal,
        warn: (_message, context) => { warnings.push(context.cause); },
      },
    });

    expect(returned).toEqual({ error, stuckStartConfirmed: true });
    expect(calls).toEqual(["close-lease", "restart-runtime"]);
    expect(warnings).toHaveLength(1);
  });

  test("bounds a provider retry storm with one no-progress watchdog owner", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8") +
      readFileSync(new URL("./runtime-turn-wait.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "createNoProgressWatchdog(runtimeNoProgressTimeoutMs(), redact.text)",
    );
    expect(source).toContain("watchdog.observeActivity(activity)");
    expect(source).toContain("watchdog.observeProgress()");
    expect(source).toContain("watchdog.signal,");
    expect(source).toContain("if (watchdog.signal.aborted) throw watchdog.signal.reason;");
    expect(source).toContain('"provider made no progress",');
    // One watchdog owner and no steer replay after the turn may have started.
    expect(source.split("createNoProgressWatchdog(").length - 1).toBe(1);
    expect(source.split("driver.steer(").length - 1).toBe(1);
  });

  test("barriers on the codex reconcile (restart fallback) before steering", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    // Scoped to the subscription bridge only. Provider-gateway Codex and the
    // other engines never publish the relay-backed subscription cache marker.
    expect(source).toContain('providerBridgeLease?.authPath === "subscription"');
    // A run that reuses the thread's kept session changed no settings: no barrier.
    expect(source).toContain('providerBridgeLease?.authPath === "subscription" && !providerBridgeLease.sessionReused');
    // (B) Content barrier is attempted first (fast path, no restart cost).
    expect(source).toContain(
      "awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS, codexInstanceName)",
    );
    // (A) Deterministic restart is the fallback, then a single verify.
    expect(source).toContain("restartRuntimeEnvironment(sandbox, ctx.signal, ctx.timing)");
    expect(source).toContain("invalidateRuntimeEnvironmentAccess(sandbox)");
    expect(source).toContain(
      "awaitCodexProviderReady(sandbox, ctx.signal, CODEX_VERIFY_DEADLINE_MS, codexInstanceName)",
    );
    expect(source).toContain(
      "Codex runtime did not become ready after restart",
    );
    // The Codex barrier probe runs twice (barrier + post-restart verify).
    expect(source.split("awaitCodexProviderReady(").length - 1).toBe(2);
    // Ordering: barrier after the provider-bridge settings patch; restart after the
    // barrier; both before the provider session is established / the turn is steered.
    const bridgeIdx = source.indexOf("return await prepareRuntimeProviderBridge(");
    const barrierIdx = source.indexOf(
      "awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS, codexInstanceName)",
    );
    const restartIdx = source.indexOf(
      "restartRuntimeEnvironment(sandbox, ctx.signal, ctx.timing)",
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
    expect(source).toContain("const CLAUDE_BARRIER_DEADLINE_MS = 35_000");
    expect(source).toContain("const CLAUDE_VERIFY_DEADLINE_MS = 35_000");
    const bridgeIdx = source.indexOf("prepareRuntimeProviderBridge(sandbox, ctx, engine, workdir)");
    const barrierIdx = source.indexOf("await ensureRuntimeProviderReadyForTurn({", bridgeIdx);
    const establishIdx = source.indexOf("await establishProviderSession({");

    expect(barrierIdx).toBeGreaterThan(bridgeIdx);
    expect(establishIdx).toBeGreaterThan(barrierIdx);
  });

  test("boots a runtime that is not up instead of waiting out the barrier first", async () => {
    const calls: string[] = [];
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
        healthy: async () => {
          calls.push("healthy");
          return false;
        },
        awaitReady: async () => {
          calls.push("await");
          return true;
        },
        restart: async () => {
          calls.push("restart");
          return {} as never;
        },
        invalidateAccess: () => {
          calls.push("invalidate");
        },
      },
    });
    // No barrier poll against a server that does not exist: boot, then one verify.
    expect(calls).toEqual(["healthy", "restart", "invalidate", "await"]);
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

  test("asks T3 to re-check Claude when the cache is not ready, and restarts nothing once it is", async () => {
    const calls: string[] = [];
    const looks = [false, true];
    const restarted = await ensureRuntimeProviderReadyForTurn({
      sandbox: {} as never,
      signal: new AbortController().signal,
      readiness: {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "UseAgent Claude gateway current",
      },
      barrierDeadlineMs: 35_000,
      verifyDeadlineMs: 35_000,
      providerLabel: "Claude",
      dependencies: {
        awaitReady: async (_sandbox, _signal, deadlineMs) => {
          calls.push(`look:${deadlineMs <= 1_500 ? "quick" : "rest"}`);
          return looks.shift() ?? false;
        },
        refresh: async (_sandbox, instanceId, _signal, timeoutMs) => {
          calls.push(`refresh:${instanceId}:${timeoutMs > 30_000 ? "within-deadline" : "short"}`);
          return true;
        },
        restart: async () => {
          calls.push("restart");
          return {} as never;
        },
        invalidateAccess: () => {
          calls.push("invalidate");
        },
      },
    });
    // A pooled sandbox's cache predates the run's capability: one quick look,
    // a targeted re-check, and the rest of the same deadline. No restart.
    expect(calls).toEqual(["look:quick", "refresh:claudeAgent:within-deadline", "look:rest"]);
    expect(restarted).toBe(false);
  });

  test("still restarts once when the re-check does not make Claude ready", async () => {
    const calls: string[] = [];
    const looks = [false, false, true];
    const restarted = await ensureRuntimeProviderReadyForTurn({
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
          calls.push("look");
          return looks.shift() ?? false;
        },
        refresh: async () => {
          calls.push("refresh");
          throw new Error("socket closed");
        },
        restart: async () => {
          calls.push("restart");
          return {} as never;
        },
        invalidateAccess: () => {
          calls.push("invalidate");
        },
      },
    });
    expect(calls).toEqual(["look", "refresh", "look", "restart", "invalidate", "look"]);
    expect(restarted).toBe(true);
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

  test("dispatches the turn on the subscribed stream and projects its views without an HTTP reread", async () => {
    const deltas: string[] = [];
    const order: string[] = [];
    const ctx = turnContext("run-stream-snapshot", { publishDelta: (delta: string) => deltas.push(delta) });
    const prior = runtimeThreadView(v2Turn({ sequence: 10, runId: "turn-prior", status: "completed", text: "old" }));
    const { follow, calls } = scriptedFollow([
      v2Turn({ sequence: 11, runId: "turn-current", status: "running", text: "hello", ordinal: 2 }),
      v2Turn({ sequence: 12, runId: "turn-current", status: "completed", text: "hello world", ordinal: 2 }),
    ]);
    await expect(waitForRuntimeTurn(
      ctx, {} as SandboxHandle, new Map(), prior, createSecretRedactor([]),
      { followRuntimeThread: follow, readThreadSnapshot: noRead, guardForeignRuns: noGuard },
      null, undefined, async () => { order.push("start"); },
    )).resolves.toBe("hello world");
    expect(order).toEqual(["start"]);
    expect(calls[0]?.threadId).toBe(`${SANDBOX_NAME_PREFIX}-thread-thread-1`);
    expect(deltas).toEqual(["hello", " world"]);
  });

  test("a run the plane did not start is interrupted and never taken for the turn", async () => {
    const deltas: string[] = [];
    const interrupted: unknown[] = [];
    const recorded: unknown[] = [];
    const ctx = turnContext("run-guarded", { publishDelta: (delta: string) => deltas.push(delta) });
    const prior = runtimeThreadView(v2Turn({ sequence: 20, runId: "turn-prior", status: "completed", text: "old" }));
    const wake = v2Run({ id: "turn-wake", ordinal: 2, userMessageId: "notification-1", status: "running", completedAt: null });
    const withWake = (state: ReturnType<typeof v2Turn>) =>
      v2Snapshot(state.snapshotSequence, { ...state.projection, runs: [...state.projection.runs, wake] });
    const { follow } = scriptedFollow([
      withWake(v2Turn({ sequence: 21, runId: "turn-prior", status: "completed", text: "old" })),
      v2Turn({ sequence: 22, runId: "turn-current", status: "completed", text: "mine", ordinal: 3 }),
    ]);
    await expect(waitForRuntimeTurn(
      ctx, {} as SandboxHandle, new Map(), prior, createSecretRedactor([]),
      {
        followRuntimeThread: follow,
        readThreadSnapshot: noRead,
        guardForeignRuns: (input) => createForeignRunGuard({
          ...input,
          dependencies: {
            dispatch: async (_sandbox, command) => { interrupted.push(command); return { sequence: 1 }; },
            record: async (event) => { recorded.push(event); },
          },
        }),
      },
    )).resolves.toBe("mine");
    expect(interrupted).toEqual([expect.objectContaining({ type: "run.interrupt", runId: "turn-wake", reason: FOREIGN_RUN_REASON })]);
    expect(recorded).toEqual([expect.objectContaining({ eventType: "t3.activity.runtime.warning", runId: "run-guarded" })]);
    expect(deltas).toEqual(["mine"]);
  });

  test("ignores the prior run until the plane's next run appears", async () => {
    const deltas: string[] = [];
    const ctx = turnContext("run-stream-fence", { publishDelta: (delta: string) => deltas.push(delta) });
    const prior = runtimeThreadView(v2Turn({ sequence: 30, runId: "turn-prior", status: "completed", text: "old" }));
    const { follow } = scriptedFollow([
      v2Turn({ sequence: 31, runId: "turn-prior", status: "completed", text: "old" }),
      v2Turn({ sequence: 32, runId: "turn-current", status: "running", text: "new", ordinal: 2 }),
      v2Turn({ sequence: 33, runId: "turn-current", status: "completed", text: "new done", ordinal: 2 }),
    ]);
    await expect(waitForRuntimeTurn(
      ctx, {} as SandboxHandle, new Map(), prior, createSecretRedactor([]),
      { followRuntimeThread: follow, readThreadSnapshot: noRead, guardForeignRuns: noGuard },
    )).resolves.toBe("new done");
    expect(deltas).toEqual(["new", " done"]);
  });

  test("preserves caller cancellation while waiting on the stream", async () => {
    const controller = new AbortController();
    const reason = new Error("turn cancelled");
    const waiting = waitForRuntimeTurn(
      turnContext("run-stream-cancel", { signal: controller.signal }),
      {} as SandboxHandle,
      new Map(),
      runtimeThreadView(v2Turn({ sequence: 40, runId: "turn-prior", status: "completed", text: "old" })),
      createSecretRedactor([]),
      {
        followRuntimeThread: async ({ signal }) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
        readThreadSnapshot: noRead,
        guardForeignRuns: noGuard,
      },
    );
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  test("does not hide a stream failure behind terminal fallback", async () => {
    const connectionError = new Error("provider stream closed before the turn settled");
    await expect(waitForRuntimeTurn(
      turnContext("run-stream-close"),
      {} as SandboxHandle,
      new Map(),
      runtimeThreadView(v2Turn({ sequence: 50, runId: "turn-prior", status: "completed", text: "old" })),
      createSecretRedactor([]),
      { followRuntimeThread: async () => { throw connectionError; }, readThreadSnapshot: noRead, guardForeignRuns: noGuard },
    )).rejects.toBe(connectionError);
  });

  test("fails a turn whose sandbox stopped responding and feeds the stream's signs of life to the watch", async () => {
    const dead = new AbortController();
    let heard = 0;
    let disposed = false;
    await expect(waitForRuntimeTurn(
      turnContext("run-stream-dead"),
      {} as SandboxHandle,
      new Map(),
      runtimeThreadView(v2Turn({ sequence: 60, runId: "turn-prior", status: "completed", text: "old" })),
      createSecretRedactor([]),
      {
        watchLiveness: () => ({
          signal: dead.signal,
          heard: () => { heard += 1; },
          dispose: () => { disposed = true; },
        }),
        followRuntimeThread: async ({ signal, onHeard }) => {
          onHeard?.();
          dead.abort(new SandboxUnresponsiveError());
          expect(signal.aborted).toBe(true);
        },
        readThreadSnapshot: noRead,
        guardForeignRuns: noGuard,
      },
    )).rejects.toThrow("The sandbox stopped responding");
    expect(heard).toBe(1);
    expect(disposed).toBe(true);
  }, 5_000);

  test("caller cancellation wins over a socket failure", async () => {
    const controller = new AbortController();
    const reason = new Error("turn cancelled during a socket failure");
    await expect(waitForRuntimeTurn(
      turnContext("run-stream-terminal-cancel", { signal: controller.signal }),
      {} as SandboxHandle,
      new Map(),
      runtimeThreadView(v2Turn({ sequence: 50, runId: "turn-prior", status: "completed", text: "old" })),
      createSecretRedactor([]),
      {
        followRuntimeThread: async () => {
          controller.abort(reason);
          throw new Error("socket closed");
        },
        readThreadSnapshot: noRead,
        guardForeignRuns: noGuard,
      },
    )).rejects.toBe(reason);
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
    const snapshotBody = JSON.stringify(v2Snapshot(1, v2Projection({}, `${SANDBOX_NAME_PREFIX}-thread-thread-terminal-drain`)));
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
      )).resolves.toMatchObject({ snapshotSequence: 1, thread: { id: `${SANDBOX_NAME_PREFIX}-thread-thread-terminal-drain`, latestTurn: null } });
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
