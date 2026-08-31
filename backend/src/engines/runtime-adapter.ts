import type { EngineAdapter, EngineRunContext } from "./types";
import { composeTurnPrompt } from "./types";
import { setTimeout as delay } from "node:timers/promises";
import { acquireThreadSandbox } from "./thread-sandbox";
import {
  awaitRuntimeProviderReady,
  prepareRuntimeProviderBridge,
  type RuntimeProviderReadiness,
  type RuntimeProviderBridgeLease,
} from "./runtime-provider-bridge";
import {
  buildRuntimeEnvironmentRequestCommand,
  decodeRuntimeEnvironmentCommandOutput,
  invalidateRuntimeEnvironmentAccess,
  requestRuntimeEnvironment,
} from "./runtime-environment-client";
import { awaitCodexProviderReady } from "./codex-subscription-runtime";
import { subscribeRuntimeThread } from "./runtime-event-stream";
import {
  activityStep,
  assistantText,
  hasOpenRuntimeToolCall,
  runtimeActivityProviderEvent,
  runtimeActivityRevision,
  runtimeActivityStepKey,
  shouldProjectRuntimeActivity,
  runtimeThreadId,
  runtimeTurnError,
  runtimeTurnSettled,
  type RuntimeEngineId,
  type RuntimeMode,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import { providerGatewayWired } from "../provider-gateway/sandbox-config";
import { createSecretRedactor } from "../secrets/redact";
import {
  sandboxProviderKind,
  type SandboxHandle,
} from "../sandboxes/provider";
import { recordProviderEvent } from "../runs/provider-events";
import type { ProviderDriver } from "@useagent/agent-harness/control";
import { sessionCapabilities } from "./capabilities";
import {
  establishProviderSession,
  recordProviderSessionStarted,
} from "./provider-turn";
import {
  restartRuntimeEnvironment,
  RUNTIME_CUBE_WARM_POOL_NAME,
  runtimeFirstActivityTimeoutMs,
  runtimeNoProgressTimeoutMs,
  runtimeGeneration,
  RUNTIME_GENERATION,
  RUNTIME_GENERATION_LABEL,
} from "./runtime-environment";
import { createNoProgressWatchdog, NoProgressError } from "./turn-no-progress";
import { T3_SESSION_GENERATION, t3ProviderDrivers } from "./t3-provider-driver";
import { operatorEnv } from "./runtime-env";
import { prepareSandboxTurn } from "./sandbox-turn-preparation";
import { buildExecutionCapabilitySnapshot } from "./execution-capabilities";

const RUNTIME_POLL_INTERVAL_MS = 125;
// T3 can publish root idle just before the final assistant projection. Re-read
// for two seconds so that ordering gap is tolerated without accepting no output.
const RUNTIME_TERMINAL_OUTPUT_DRAIN_MS = 2_000;
const RUNTIME_TERMINAL_OUTPUT_DRAIN_SECONDS = 2;
const RUNTIME_TERMINAL_CLEANUP_MS = 250;
export const RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR = "provider completed without assistant output";
// Codex subscription writes its per-run relay config into the sandbox's T3
// settings.json, which T3 applies through an asynchronous settings-watch
// reconcile. Wait for the reconcile to publish the remote instance before
// steering; if it does not land in time, fall back to a deterministic restart.
const CODEX_BARRIER_DEADLINE_MS = 5_000;
const CODEX_VERIFY_DEADLINE_MS = 8_000;
const CLAUDE_BARRIER_DEADLINE_MS = 5_000;
const CLAUDE_VERIFY_DEADLINE_MS = 8_000;

interface RuntimeProviderBarrierDependencies {
  readonly awaitReady: typeof awaitRuntimeProviderReady;
  readonly restart: typeof restartRuntimeEnvironment;
  readonly invalidateAccess: typeof invalidateRuntimeEnvironmentAccess;
}

const runtimeProviderBarrierDependencies: RuntimeProviderBarrierDependencies = {
  awaitReady: awaitRuntimeProviderReady,
  restart: restartRuntimeEnvironment,
  invalidateAccess: invalidateRuntimeEnvironmentAccess,
};

export async function ensureRuntimeProviderReadyForTurn(input: {
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
  readonly readiness: RuntimeProviderReadiness;
  readonly barrierDeadlineMs: number;
  readonly verifyDeadlineMs: number;
  readonly providerLabel: string;
  readonly dependencies?: RuntimeProviderBarrierDependencies;
}): Promise<void> {
  const dependencies = input.dependencies ?? runtimeProviderBarrierDependencies;
  if (
    await dependencies.awaitReady(
      input.sandbox,
      input.signal,
      input.barrierDeadlineMs,
      input.readiness,
    )
  ) {
    return;
  }
  input.signal.throwIfAborted();
  await dependencies.restart(input.sandbox, input.signal);
  dependencies.invalidateAccess(input.sandbox);
  input.signal.throwIfAborted();
  if (
    !(await dependencies.awaitReady(
      input.sandbox,
      input.signal,
      input.verifyDeadlineMs,
      input.readiness,
    ))
  ) {
    input.signal.throwIfAborted();
    throw new Error(`${input.providerLabel} runtime did not become ready after restart`);
  }
}

interface RuntimeShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

export function runtimeAdapterEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = operatorEnv(env, "RUNTIME_RUN_ADAPTER_ENABLED", "T3_RUN_ADAPTER_ENABLED")
    ?.trim()
    .toLowerCase();
  return value === "1" || value === "true";
}

export function runtimeAdapterEngineSelected(
  engine: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const configured = operatorEnv(env, "RUNTIME_RUN_ADAPTER_ENGINES", "T3_RUN_ADAPTER_ENGINES")?.trim();
  if (!configured) return engine === "codex" || engine === "opencode";
  return configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(engine.toLowerCase());
}

export type RuntimeAdapterMode = "canary" | "all";

export function runtimeAdapterMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeAdapterMode {
  const mode = operatorEnv(env, "RUNTIME_RUN_ADAPTER_MODE", "T3_RUN_ADAPTER_MODE")
    ?.trim()
    .toLowerCase() || "canary";
  if (mode !== "canary" && mode !== "all") {
    throw new Error("RUNTIME_RUN_ADAPTER_MODE (legacy T3_RUN_ADAPTER_MODE) must be canary or all");
  }
  return mode;
}

export function runtimeAdapterSelected(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!runtimeAdapterEnabled(env)) return false;
  if (runtimeAdapterMode(env) === "all") return true;
  const allowlist = new Set(
    (operatorEnv(env, "RUNTIME_CANARY_THREAD_IDS", "T3_CANARY_THREAD_IDS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return allowlist.has(ctx.threadId ?? "") || allowlist.has(ctx.runId);
}

export function runtimeRunSnapshot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (sandboxProviderKind(env) === "cube") {
    const runtimeTemplate = operatorEnv(
      env,
      "RUNTIME_CUBE_TEMPLATE_ID",
      "T3_CUBE_TEMPLATE_ID",
    )?.trim();
    const generation = runtimeGeneration(env);
    if (generation !== runtimeGeneration({}) && !runtimeTemplate) {
      throw new Error(
        `Runtime generation ${generation} requires a dedicated RUNTIME_CUBE_TEMPLATE_ID; refusing to relabel CUBE_TEMPLATE_ID`,
      );
    }
    const template = runtimeTemplate || env.CUBE_TEMPLATE_ID?.trim();
    if (!template) {
      throw new Error(
        "RUNTIME_CUBE_TEMPLATE_ID (legacy T3_CUBE_TEMPLATE_ID) is required for the Cube runtime adapter",
      );
    }
    return template;
  }
  return (
    operatorEnv(env, "RUNTIME_DAYTONA_SNAPSHOT", "T3_DAYTONA_SNAPSHOT")?.trim() ||
    env.DAYTONA_SNAPSHOT?.trim() ||
    "skynet-agent-v17"
  );
}

export function configuredRuntimeMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeMode {
  const mode = operatorEnv(env, "RUNTIME_MODE", "T3_RUNTIME_MODE")?.trim() || "full-access";
  if (
    mode !== "approval-required" &&
    mode !== "auto-accept-edits" &&
    mode !== "auto" &&
    mode !== "full-access"
  ) {
    throw new Error(
      "RUNTIME_MODE (legacy T3_RUNTIME_MODE) must be approval-required, auto-accept-edits, auto, or full-access",
    );
  }
  return mode;
}

async function readThreadSnapshot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
): Promise<RuntimeThreadSnapshot> {
  return await requestRuntimeEnvironment<RuntimeThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(runtimeThreadId(ctx))}`,
    },
    ctx.signal,
  );
}

async function waitForNewRuntimeTurnSnapshot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  priorTurnId: string | null,
): Promise<RuntimeThreadSnapshot> {
  const deadline = Date.now() + runtimeFirstActivityTimeoutMs();
  while (!ctx.signal.aborted) {
    const snapshot = await readThreadSnapshot(ctx, sandbox).catch(() => null);
    const latestTurnId = snapshot?.thread.latestTurn?.turnId ?? null;
    if (snapshot && latestTurnId !== null && latestTurnId !== priorTurnId) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The provider produced no first activity within ${runtimeFirstActivityTimeoutMs()}ms`,
      );
    }
    await Bun.sleep(RUNTIME_POLL_INTERVAL_MS);
  }
  throw new Error("Turn projection aborted");
}

export async function drainRuntimeTerminalOutput(input: {
  readonly initialText: string;
  readonly fallbackText: string;
  readonly signal: AbortSignal;
  readonly readAndApplySnapshot: (signal: AbortSignal) => Promise<string>;
  readonly deadlineSignal?: AbortSignal;
}): Promise<string> {
  let text = input.initialText;
  const deadlineSignal = input.deadlineSignal ?? AbortSignal.timeout(RUNTIME_TERMINAL_OUTPUT_DRAIN_MS);
  const drainSignal = AbortSignal.any([input.signal, deadlineSignal]);

  while (!text.trim()) {
    try {
      input.signal.throwIfAborted();
      await delay(RUNTIME_POLL_INTERVAL_MS, undefined, { signal: drainSignal });
      text = await input.readAndApplySnapshot(drainSignal);
      input.signal.throwIfAborted();
      if (text.trim()) return text;
      deadlineSignal.throwIfAborted();
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (deadlineSignal.aborted) {
        if (input.fallbackText.trim()) return input.fallbackText;
        throw new Error(RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR);
      }
      throw error;
    }
  }
  input.signal.throwIfAborted();
  return text;
}

function awaitRuntimeOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cleanup: () => Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void cleanup();
    void operation.then(
      () => cleanup().catch(() => {}),
      () => cleanup().catch(() => {}),
    );
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) {
          void cleanup();
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) {
          void cleanup();
          return;
        }
        reject(error);
      },
    );
  });
}

export function createRuntimeTerminalSessionCleanup(
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  sessionId: string,
  options: {
    readonly deadlineSignal?: AbortSignal;
    readonly warn?: (message: string, context: Record<string, string>) => void;
  } = {},
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let warned = false;
  return () => {
    if (inFlight) return inFlight;
    const deadline = options.deadlineSignal ?? AbortSignal.timeout(RUNTIME_TERMINAL_CLEANUP_MS);
    const operation: Promise<void> = awaitRuntimeOperation(
      sandbox.process.deleteSession(sessionId), deadline, async () => {},
    ).then(() => {}).catch((error) => {
        if (warned) return;
        warned = true;
        (options.warn ?? ((message, context) => console.warn(message, context)))(
          "[runtime-terminal-drain] session cleanup failed",
          { sessionId, error: error instanceof Error ? error.message : String(error) },
        );
      });
    inFlight = operation.finally(() => {
      inFlight = null;
    });
    return inFlight!;
  };
}

export async function readRuntimeTerminalSnapshot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  signal: AbortSignal,
): Promise<RuntimeThreadSnapshot> {
  const sessionId = `useagent-terminal-drain-${crypto.randomUUID()}`;
  const cleanup = createRuntimeTerminalSessionCleanup(sandbox, sessionId);
  try {
    await awaitRuntimeOperation(sandbox.process.createSession(sessionId), signal, cleanup);
    const result = await awaitRuntimeOperation(
      sandbox.process.executeSessionCommand(sessionId, {
        command: buildRuntimeEnvironmentRequestCommand({
          method: "GET",
          path: `/api/orchestration/threads/${encodeURIComponent(runtimeThreadId(ctx))}`,
        }),
        runAsync: false,
      }, RUNTIME_TERMINAL_OUTPUT_DRAIN_SECONDS),
      signal,
      cleanup,
    );
    const response = decodeRuntimeEnvironmentCommandOutput(
      result.output ?? `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
    if ((result.exitCode ?? 1) !== 0 || response.status === undefined || response.status >= 400) {
      throw new Error("The provider runtime terminal snapshot request failed");
    }
    return JSON.parse(response.body) as RuntimeThreadSnapshot;
  } finally {
    await cleanup();
  }
}

export function projectRuntimeAssistantText(
  state: { readonly publishedText: string; readonly finalText: string },
  text: string,
  settled: boolean,
): { readonly publishedText: string; readonly finalText: string; readonly delta: string } {
  const monotonic = text.startsWith(state.publishedText);
  return {
    publishedText: monotonic ? text : state.publishedText,
    finalText: settled ? text : state.finalText,
    delta: monotonic ? text.slice(state.publishedText.length) : "",
  };
}

async function waitForRuntimeTurn(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  preExistingActivities: ReadonlyMap<string, string>,
  priorTurnId: string | null,
  redact: ReturnType<typeof createSecretRedactor>,
): Promise<string> {
  const activityRevisions = new Map(preExistingActivities);
  const activitySteps = new Map<string, string>();
  // Single owner of the turn-stream no-progress bound: a provider retry storm
  // (only runtime.warning activities, no tool/text progress) must terminate
  // the run with the real provider reason instead of running forever.
  const watchdog = createNoProgressWatchdog(runtimeNoProgressTimeoutMs(), redact.text);
  // A long-running tool emits no new activity revisions while it executes, so
  // the event stream goes silent even though the turn is making real progress.
  // While the latest snapshot shows an open tool call, tick the watchdog on a
  // timer; provider stalls (no tool running, no text) stay fully guarded.
  let toolInFlight = false;
  const toolHeartbeat = setInterval(() => {
    if (toolInFlight) {
      watchdog.observeProgress();
      ctx.reportActivity?.();
    }
  }, 15_000);
  toolHeartbeat.unref?.();
  let publishedText = "";
  let finalText = "";
  const applySnapshot = async (snapshot: RuntimeThreadSnapshot): Promise<boolean> => {
    toolInFlight = hasOpenRuntimeToolCall(snapshot.thread.activities);
    for (const activity of snapshot.thread.activities) {
      const revision = runtimeActivityRevision(activity);
      if (activityRevisions.get(activity.id) === revision) continue;
      activityRevisions.set(activity.id, revision);
      await recordProviderEvent(runtimeActivityProviderEvent(
        ctx,
        runtimeThreadId(ctx),
        activity,
        redact,
      ), {
        critical:
          activity.kind === "user-input.requested" || activity.kind === "approval.requested",
      });
      watchdog.observeActivity(activity);
      if (!shouldProjectRuntimeActivity(activity, snapshot.thread.activities)) continue;
      const step = redact.unknown(activityStep(activity, runtimeThreadId(ctx)));
      const activityStepKey = runtimeActivityStepKey(activity);
      const priorStepId = activitySteps.get(activityStepKey);
      if (priorStepId && ctx.updateStep) {
        await ctx.updateStep(priorStepId, step.code_json ?? null);
      } else {
        const stepId = await ctx.emit(step);
        if (stepId) activitySteps.set(activityStepKey, stepId);
      }
    }

    const text = redact.text(assistantText(snapshot));
    const settled = runtimeTurnSettled(snapshot);
    const projection = projectRuntimeAssistantText({ publishedText, finalText }, text, settled);
    const delta = projection.delta;
    if (delta) {
      ctx.publishDelta?.(delta);
      watchdog.observeProgress();
    }
    publishedText = projection.publishedText;
    finalText = projection.finalText;

    const error = runtimeTurnError(snapshot);
    if (error) throw new Error(redact.text(error));
    return !settled;
  };
  // Dispatch commits before the read projection necessarily observes the new
  // turn. Poll only this short projection hand-off; all subsequent updates use
  // T3's native replayable websocket stream.
  try {
    const initial = await waitForNewRuntimeTurnSnapshot(ctx, sandbox, priorTurnId);
    if (await applySnapshot(initial)) {
      await subscribeRuntimeThread(
        sandbox,
        runtimeThreadId(ctx),
        initial.snapshotSequence,
        AbortSignal.any([ctx.signal, watchdog.signal]),
        async (item) => {
          if (item.kind === "synchronized") return true;
          return await applySnapshot(await readThreadSnapshot(ctx, sandbox));
        },
      );
    }
  } finally {
    clearInterval(toolHeartbeat);
    watchdog.dispose();
  }
  if (watchdog.signal.aborted) throw watchdog.signal.reason;
  ctx.signal.throwIfAborted();
  return await drainRuntimeTerminalOutput({
    initialText: finalText,
    fallbackText: publishedText,
    signal: ctx.signal,
    readAndApplySnapshot: async (drainSignal) => {
      await applySnapshot(await readRuntimeTerminalSnapshot(ctx, sandbox, drainSignal));
      return finalText;
    },
  });
}

export function makeRuntimeAdapter(engine: RuntimeEngineId, driver: ProviderDriver): EngineAdapter {
  return {
    id: engine,
    async run(ctx): Promise<void> {
      if (!providerGatewayWired()) {
        throw new Error("Engine requires a configured provider gateway");
      }
      const startedAt = Date.now();
      await ctx.emit({
        kind: "task",
        label: "Preparing runtime and integrations…",
        chip: `runtime:${engine}`,
      });
      const prepared = await prepareSandboxTurn(ctx, {
        snapshot: runtimeRunSnapshot(),
        chip: `runtime:${engine}`,
        warmPool: RUNTIME_CUBE_WARM_POOL_NAME,
        labels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
        requiredLabels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
        // Frozen timing prefix: hosted cutover canaries read these values.
        timingPrefix: "t3",
        async prepareProvider(sandbox, workdir) {
          return await prepareRuntimeProviderBridge(sandbox, ctx, engine, workdir);
        },
      });
      const { sandbox, workdir, redact } = prepared;
      const providerBridgeLease: RuntimeProviderBridgeLease = prepared.providerState;

      try {
        // Claude also patches T3 settings.json above. The explicit provider
        // instance carries a unique display marker, so the cache probe proves
        // T3 applied the gateway-backed wrapper rather than merely observing
        // that the settings file exists.
        if (providerBridgeLease.readiness) {
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            await ensureRuntimeProviderReadyForTurn({
              sandbox,
              signal: ctx.signal,
              readiness: providerBridgeLease.readiness,
              barrierDeadlineMs: CLAUDE_BARRIER_DEADLINE_MS,
              verifyDeadlineMs: CLAUDE_VERIFY_DEADLINE_MS,
              providerLabel: "Claude",
            });
          } finally {
            endBarrier?.();
          }
        }

        // Codex subscription patches its per-run relay config into the sandbox's
        // T3 settings.json above (provider_bridge). T3 only applies settings via
        // an asynchronous settings-watch reconcile, so a turn dispatched before
        // that reconcile binds to the pre-reconcile, relay-less codex instance and
        // falls back to a local, unauthenticated app-server (no first activity).
        // Scoped to subscription Codex. Provider-gateway Codex does not create
        // a per-run instance, and Claude has its own marker barrier above. The
        // no-first-activity watchdog below remains the final safety net.
        if (providerBridgeLease?.authPath === "subscription") {
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            // (B) Barrier: wait for the reconcile to publish the subscription
            // (relay-backed) codex instance into its status cache. Content, not
            // mtime: health refreshes rewrite the cache for the legacy instance
            // too. Fast path, no restart cost.
            if (
              !(await awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS))
            ) {
              // (A) Fallback: the reconcile did not land in time. Bounce T3 so boot
              // reads the relay config synchronously and builds the remote instance
              // from the start, then verify once before steering. Honest error if
              // the runtime never reports ready.
              await restartRuntimeEnvironment(sandbox, ctx.signal);
              invalidateRuntimeEnvironmentAccess(sandbox);
              if (
                !(await awaitCodexProviderReady(sandbox, ctx.signal, CODEX_VERIFY_DEADLINE_MS))
              ) {
                throw new Error("Codex runtime did not become ready after restart");
              }
            }
          } finally {
            endBarrier?.();
          }
        }

        const endShell = ctx.timing?.begin("t3.shell");
        const shell = await requestRuntimeEnvironment<RuntimeShellSnapshot>(
          sandbox,
          { method: "GET", path: "/api/orchestration/shell" },
          ctx.signal,
        );
        endShell?.();
        const threadId = runtimeThreadId(ctx);
        const threadExists = shell.threads.some((thread) => thread.id === threadId);
        const createdAt = new Date().toISOString();
        const runtimeMode = configuredRuntimeMode();
        const negotiatedCapabilities = sessionCapabilities(engine, {
          desktop: false,
          knowledgeTools: true,
          runtimeOrchestration: true,
        });
        const executionCapabilities = buildExecutionCapabilitySnapshot({
          runtime: "sandbox",
          workspaceRoot: workdir,
          gatewayAvailable: true,
          desktopAvailability: "on_demand",
        });
        const established = await establishProviderSession({
          driver,
          ctx,
          runtime: { kind: "sandbox", id: sandbox.id },
          capabilities: negotiatedCapabilities,
          executionCapabilities,
          generation: T3_SESSION_GENERATION,
          authEpoch: providerBridgeLease.authEpoch,
          priorSessionId: threadExists ? threadId : undefined,
          startMetadata: { workspaceRoot: workdir, runtimeMode, createdAt },
          persistSession: async (providerSession) => {
            if (!ctx.saveProviderSession) {
              throw new Error("Session persistence is unavailable");
            }
            await ctx.saveProviderSession(providerSession, providerBridgeLease.authEpoch);
          },
        });
        const session = established.session;
        // `start()` may adopt a thread the runtime already projected even when
        // the durable provider lifecycle is fresh. Always capture its current
        // turn before steering so an initialization greeting cannot be mistaken
        // for the response to this run.
        const priorSnapshot = await readThreadSnapshot(ctx, sandbox);
        const preExistingActivities = new Map(
          priorSnapshot?.thread.activities.map((activity) => [
            activity.id,
            runtimeActivityRevision(activity),
          ]) ?? [],
        );
        const priorTurnId = priorSnapshot?.thread.latestTurn?.turnId ?? null;

        // HTTP orchestration dispatch validates thread.turn.start against an
        // already-projected thread. ProviderDriver.start creates it explicitly instead of
        // relying on the websocket-only bootstrap normalization path.
        const prompt = composeTurnPrompt(ctx, established.resumed, executionCapabilities);
        await recordProviderSessionStarted(ctx, session, {
          provider: "t3",
          source: engine,
          resumed: established.resumed,
        });
        ctx.timing?.mark("dispatch");
        const endDispatch = ctx.timing?.begin("t3.dispatch_request");
        const steerResult = await driver.steer({
          runId: ctx.runId,
          threadId: ctx.threadId ?? ctx.runId,
          session,
          input: { kind: "prompt", text: prompt, model: ctx.model },
          metadata: { runtimeMode, createdAt },
          signal: ctx.signal,
        });
        endDispatch?.();
        if (steerResult.status !== "ok") {
          throw new Error(
            `the provider runtime ${engine} steer failed (${steerResult.status}): ${steerResult.message ?? "unsupported"}`,
          );
        }
        const endTurn = ctx.timing?.begin("t3.turn_wait");
        await ctx.emit({
          kind: "task",
          label: "Waiting for provider activity…",
          chip: `runtime:${engine}`,
        });
        try {
          const summary = await waitForRuntimeTurn(
            ctx,
            sandbox,
            preExistingActivities,
            priorTurnId,
            redact,
          );
          await ctx.emit({ kind: "done", label: "Done", chip: null });
          ctx.setSummary(summary, Date.now() - startedAt);
        } catch (error) {
          if (error instanceof NoProgressError && !ctx.signal.aborted) {
            // The durable run is failing with the provider's real reason; also
            // stop the sandbox-side turn so a persistent thread does not keep
            // retrying against the provider gateway. Best-effort only: a cancel
            // failure must not mask the no-progress reason.
            await driver.cancel(session, "provider made no progress").catch(() => {});
          }
          throw error;
        } finally {
          endTurn?.();
          if (ctx.signal.aborted) {
            const cancelResult = await driver.cancel(session, "turn aborted");
            if (cancelResult.status !== "ok") {
              throw new Error(
                `the provider runtime ${engine} cancel failed (${cancelResult.status}): ${cancelResult.message ?? "unsupported"}`,
              );
            }
          }
        }
      } finally {
        await providerBridgeLease?.close().catch(() => {});
        await prepared.close();
      }
    },
  };
}

export const runtimeCodexAdapter = makeRuntimeAdapter("codex", t3ProviderDrivers.codex);
export const runtimeClaudeAdapter = makeRuntimeAdapter("claude", t3ProviderDrivers.claude);
export const runtimeOpenCodeAdapter = makeRuntimeAdapter("opencode", t3ProviderDrivers.opencode);
