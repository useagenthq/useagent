import type { EngineAdapter, EngineRunContext } from "./types";
import { composeTurnPrompt } from "./types";
import { acquireThreadSandbox } from "./thread-sandbox";
import { checkoutPullRequestResources, prepareRepos } from "./repo-prep";
import {
  prepareRuntimeProviderBridge,
  type RuntimeProviderBridgeLease,
} from "./runtime-provider-bridge";
import {
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
import {
  composeSecretEnv,
  materializeSecretFiles,
  PROVIDER_SECRET_NAMES,
  recordSecretsInjected,
} from "../secrets/inject";
import { createSecretRedactor } from "../secrets/redact";
import { providerGatewayWired } from "../provider-gateway/sandbox-config";
import {
  sandboxProviderKind,
} from "../sandboxes/provider";
import { recordProviderEvent } from "../runs/provider-events";
import type { ProviderDriver } from "@skynet/agent-harness/control";
import { sessionCapabilities } from "./capabilities";
import {
  establishProviderSession,
  providerSessionStartedEvent,
} from "./provider-turn";
import { materializeRunInputs } from "../uploads/materialize";
import {
  restartRuntimeEnvironment,
  RUNTIME_CUBE_WARM_POOL_NAME,
  runtimeFirstActivityTimeoutMs,
  runtimeNoProgressTimeoutMs,
  RUNTIME_GENERATION,
  RUNTIME_GENERATION_LABEL,
} from "./runtime-environment";
import { createNoProgressWatchdog, NoProgressError } from "./turn-no-progress";
import { T3_SESSION_GENERATION, t3ProviderDrivers } from "./t3-provider-driver";
import { operatorEnv } from "./runtime-env";

const RUNTIME_POLL_INTERVAL_MS = 125;
// Codex subscription writes its per-run relay config into the sandbox's T3
// settings.json, which T3 applies through an asynchronous settings-watch
// reconcile. Wait for the reconcile to publish the remote instance before
// steering; if it does not land in time, fall back to a deterministic restart.
const CODEX_BARRIER_DEADLINE_MS = 5_000;
const CODEX_VERIFY_DEADLINE_MS = 8_000;

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
    const template = operatorEnv(env, "RUNTIME_CUBE_TEMPLATE_ID", "T3_CUBE_TEMPLATE_ID")?.trim() ||
      env.CUBE_TEMPLATE_ID?.trim();
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

async function resolveWorkspaceRoot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
): Promise<string> {
  const result = await sandbox.process.executeCommand(
    'mkdir -p "$HOME/work" && cd "$HOME/work" && pwd -P',
    undefined,
    undefined,
    10,
  );
  const workdir = result.result?.trim();
  if ((result.exitCode ?? 1) !== 0 || !workdir?.startsWith("/")) {
    throw new Error(`Run ${ctx.runId} could not resolve its sandbox workspace`);
  }
  return workdir;
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
      await recordProviderEvent(runtimeActivityProviderEvent(ctx, runtimeThreadId(ctx), activity), {
        critical:
          activity.kind === "user-input.requested" || activity.kind === "approval.requested",
      });
      watchdog.observeActivity(activity);
      if (!shouldProjectRuntimeActivity(activity, snapshot.thread.activities)) continue;
      const step = redact.unknown(activityStep(activity));
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
    if (text.startsWith(publishedText)) {
      const delta = text.slice(publishedText.length);
      if (delta) {
        ctx.publishDelta?.(delta);
        watchdog.observeProgress();
      }
    }
    publishedText = text;

    const error = runtimeTurnError(snapshot);
    if (error) throw new Error(redact.text(error));
    finalText = text;
    return !runtimeTurnSettled(snapshot);
  };
  // Dispatch commits before the read projection necessarily observes the new
  // turn. Poll only this short projection hand-off; all subsequent updates use
  // T3's native replayable websocket stream.
  try {
    const initial = await waitForNewRuntimeTurnSnapshot(ctx, sandbox, priorTurnId);
    if (!(await applySnapshot(initial))) return finalText;
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
  } finally {
    clearInterval(toolHeartbeat);
    watchdog.dispose();
  }
  if (watchdog.signal.aborted) throw watchdog.signal.reason;
  if (!ctx.signal.aborted) return finalText;
  throw new Error("Run aborted (timeout)");
}

export function makeRuntimeAdapter(engine: RuntimeEngineId, driver: ProviderDriver): EngineAdapter {
  return {
    id: engine,
    async run(ctx): Promise<void> {
      if (!providerGatewayWired()) {
        throw new Error("Engine requires a configured provider gateway");
      }
      const startedAt = Date.now();
      const secretInjection = await composeSecretEnv(ctx, { excludeNames: PROVIDER_SECRET_NAMES });
      const redact = createSecretRedactor(secretInjection.redactionValues);
      // The "t3.*" timing stage names are frozen VALUES: they are stored in the
      // run-timing ledger and pinned by the hosted-cutover canary.
      const endSandbox = ctx.timing?.begin("t3.sandbox_acquire");
      const lease = await acquireThreadSandbox(ctx, {
        snapshot: runtimeRunSnapshot(),
        chip: `runtime:${engine}`,
        warmPool: RUNTIME_CUBE_WARM_POOL_NAME,
        labels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
        requiredLabels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
      });
      endSandbox?.();
      const { sandbox } = lease;
      let providerBridgeLease: RuntimeProviderBridgeLease | undefined;

      try {
        await ctx.emit({
          kind: "task",
          label: "Preparing runtime and integrations…",
          chip: `runtime:${engine}`,
        });
        const endPrepare = ctx.timing?.begin("t3.prepare");
        const prepareStage = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
          const end = ctx.timing?.begin(`t3.prepare.${stage}`);
          try {
            return await operation();
          } finally {
            end?.();
          }
        };
        const workdir = await prepareStage("workspace_root", () =>
          resolveWorkspaceRoot(ctx, sandbox),
        );
        // Secrets land BEFORE the parallel stages: provider_bridge may launch
        // (or restart) the T3 environment, whose boot sources the secrets
        // dotenv. Racing them left cold launches without org secrets in env.
        await prepareStage("secrets", () =>
          materializeSecretFiles(
            (command) => sandbox.process.executeCommand(command, undefined, undefined, 30),
            secretInjection.files,
          ),
        );
        await Promise.all([
          prepareStage("provider_bridge", async () => {
            providerBridgeLease = await prepareRuntimeProviderBridge(sandbox, ctx, engine, workdir);
          }),
          prepareStage("repos", async () => {
            await prepareRepos(sandbox, workdir, ctx);
            await checkoutPullRequestResources(
              sandbox,
              workdir,
              ctx.resolvedResources ?? [],
              ctx,
            );
          }),
          prepareStage("inputs", () => materializeRunInputs(sandbox, ctx.inputFiles)),
        ]);
        await prepareStage("secrets_marker", () => recordSecretsInjected(ctx, secretInjection));
        // Codex subscription patches its per-run relay config into the sandbox's
        // T3 settings.json above (provider_bridge). T3 only applies settings via
        // an asynchronous settings-watch reconcile, so a turn dispatched before
        // that reconcile binds to the pre-reconcile, relay-less codex instance and
        // falls back to a local, unauthenticated app-server (no first activity).
        // Scoped to codex; opencode/claude do not patch settings and their paths
        // stay unchanged. The no-first-activity watchdog below remains the net.
        if (engine === "codex") {
          await prepareStage("runtime_barrier", async () => {
            // (B) Barrier: wait for the reconcile to publish the subscription
            // (relay-backed) codex instance into its status cache. Content, not
            // mtime: health refreshes rewrite the cache for the legacy instance
            // too. Fast path, no restart cost.
            if (
              await awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS)
            ) {
              return;
            }
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
          });
        }
        endPrepare?.();

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
        const established = await establishProviderSession({
          driver,
          ctx,
          runtime: { kind: "sandbox", id: sandbox.id },
          capabilities: negotiatedCapabilities,
          generation: T3_SESSION_GENERATION,
          priorSessionId: threadExists ? threadId : undefined,
          startMetadata: { workspaceRoot: workdir, runtimeMode, createdAt },
          persistSession: async (nativeSessionId) => {
            if (!ctx.saveEngineSessionId) {
              throw new Error("Session persistence is unavailable");
            }
            await ctx.saveEngineSessionId(nativeSessionId);
          },
        });
        const session = established.session;
        const priorSnapshot = established.resumed
          ? await readThreadSnapshot(ctx, sandbox)
          : null;
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
        const prompt = composeTurnPrompt(ctx, established.resumed);
        await recordProviderEvent(
          providerSessionStartedEvent(ctx, session, { provider: "t3", source: engine }),
          { critical: true },
        );
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
          ctx.setSummary(summary.trim() || `${engine} run completed`, Date.now() - startedAt);
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
        if (lease.releaseAfterRun) await sandbox.delete().catch(() => {});
      }
    },
  };
}

export const runtimeCodexAdapter = makeRuntimeAdapter("codex", t3ProviderDrivers.codex);
export const runtimeClaudeAdapter = makeRuntimeAdapter("claude", t3ProviderDrivers.claude);
export const runtimeOpenCodeAdapter = makeRuntimeAdapter("opencode", t3ProviderDrivers.opencode);
