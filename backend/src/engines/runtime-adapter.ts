import type { EngineAdapter } from "./types";
import { composeRunTurnPrompt } from "./types";
import { setTimeout as delay } from "node:timers/promises";
import {
  prefetchRuntimeProviderBridge,
  prepareRuntimeProviderBridge,
  prepareStableRuntimeProvider,
  type RuntimeProviderBridgeLease,
} from "./runtime-provider-bridge";
import {
  invalidateRuntimeEnvironmentAccess,
  requestRuntimeEnvironment,
  runtimeEnvironmentAccessValidated,
  type RuntimeEnvironmentRequest,
} from "./runtime-environment-client";
import { awaitCodexProviderReady } from "./codex-subscription-runtime";
import { ensureRuntimeProviderReadyForTurn } from "./runtime-provider-barrier";
import {
  runtimeThreadId,
  runtimeUserMessageId,
  type RuntimeEngineId,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import { configuredRuntimeMode, runtimeModeFor } from "./permission-mode";
import { assertReadOnlyTurnAllowed, ensureRuntimeThreadMode } from "./runtime-thread-mode";
import { providerGatewayWired } from "../provider-gateway/sandbox-config";
import { sandboxPlugin } from "../sandboxes/plugins";
import type { ProviderDriver } from "@useagent/agent-harness/control";
import { sessionCapabilities } from "./capabilities";
import {
  establishProviderSession,
  recordProviderSessionStarted,
} from "./provider-turn";
import {
  recordRuntimeCommandCatalog,
  runtimeCommandDispatchRejection,
} from "./runtime-command-catalog";
import {
  restartRuntimeEnvironment,
  RUNTIME_CUBE_WARM_POOL_NAME,
  RUNTIME_GENERATION,
  RUNTIME_GENERATION_LABEL,
  runtimeEnvironmentHealthy,
} from "./runtime-environment";
import { NoProgressError } from "./turn-no-progress";
import { activityRevisions, createTurnProjector } from "./turn-projector";
import { continuationRunId, turnRecovery, upstreamCauseLabel } from "./turn-recovery";
import { T3_SESSION_GENERATION, t3ProviderDrivers } from "./t3-provider-driver";
import { runtimeRunSnapshot } from "./runtime-snapshot";
import { prepareSandboxTurn } from "./sandbox-turn-preparation";
import { buildExecutionCapabilitySnapshot } from "./execution-capabilities";
import { reloadRetainedSession } from "./runtime-session-stop";
import { readCodexConfigChange, stampCodexConfig } from "./runtime-codex-config-stamp";
import {
  recoverStuckCodexSubscriptionStart,
  RuntimeFirstActivityTimeoutError,
} from "./runtime-startup-recovery.js";
import { applyPendingCodexProviderConfiguration } from "./runtime-codex-plan-config";
import { waitForRuntimeCompact } from "./runtime-compact-completion";
import { readThreadSnapshot, runtimeTurnWaitDependencies, waitForRuntimeTurn } from "./runtime-turn-wait";
export {
  reloadRetainedSession,
  type SessionReloadDependencies,
} from "./runtime-session-stop";
export {
  createRuntimeTerminalSessionCleanup,
  drainRuntimeTerminalOutput,
  readRuntimeTerminalSnapshot,
  waitForRuntimeTurn,
} from "./runtime-turn-wait";

/**
 * Whether the runtime thread carries the conversation's history itself. A
 * thread that already has runs does (native resume, or the runtime's own
 * handoff when the session or engine changed), so the plane's history goes
 * only into a fresh thread: the first turn, or after the sandbox was recreated.
 */
export function runtimeThreadHasAuthoritativeHistory(
  snapshot: RuntimeThreadSnapshot,
  lease: Pick<RuntimeProviderBridgeLease, "authPath" | "hasCurrentEpochThreadBinding">,
): boolean {
  return snapshot.thread.latestTurn !== null && (
    lease.authPath !== "subscription" || lease.hasCurrentEpochThreadBinding
  );
}

export { RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR } from "./turn-recovery";
export { projectRuntimeAssistantText } from "./turn-projector";
// Codex subscription writes its per-run relay config into the sandbox's T3
// settings.json, which T3 applies through an asynchronous settings-watch
// reconcile. Wait for the reconcile to publish the remote instance before
// steering; if it does not land in time, fall back to a deterministic restart.
const CODEX_BARRIER_DEADLINE_MS = 5_000;
const CODEX_VERIFY_DEADLINE_MS = 8_000;
// T3's authoritative Claude health check includes a 4s CLI version probe and
// a prompt-free SDK initialization bounded at 25s. Leave scheduling margin
// without adding a second CLI retry loop in Pro.
const CLAUDE_BARRIER_DEADLINE_MS = 35_000;
const CLAUDE_VERIFY_DEADLINE_MS = 35_000;

interface RuntimeShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

const SHELL_REQUEST = { method: "GET", path: "/api/orchestration/shell" } as const satisfies RuntimeEnvironmentRequest;

export { runtimeRunSnapshot };

export { configuredRuntimeMode } from "./permission-mode";

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
      let stableProviderPendingRevision: string | null = null;
      // A runtime this process already talks to lists the same projects and
      // threads before and after the provider bridge, so its shell is read
      // alongside the bridge; a barrier below that restarts it reads again.
      let earlyShell: Promise<RuntimeShellSnapshot | null> | null = null;
      let runtimeTouched = false;
      const prepared = await prepareSandboxTurn(ctx, {
        snapshot: runtimeRunSnapshot(),
        chip: `runtime:${engine}`,
        warmPool: RUNTIME_CUBE_WARM_POOL_NAME,
        labels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
        requiredLabels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
        providerAfterResources: engine === "claude",
        resourceUser: engine === "claude"
          ? (binding) => sandboxPlugin(binding.kind).runsAsRoot
            ? { uid: 1000, gid: 1000, home: "/home/user" }
            : undefined
          : undefined,
        // Frozen timing prefix: hosted cutover canaries read these values.
        timingPrefix: "t3",
        async prepareStableProvider(sandbox) {
          stableProviderPendingRevision = await prepareStableRuntimeProvider(sandbox, ctx, engine);
        },
        async prepareProvider(sandbox, workdir, binding, preparation) {
          if (runtimeEnvironmentAccessValidated(sandbox)) {
            earlyShell = requestRuntimeEnvironment<RuntimeShellSnapshot>(sandbox, SHELL_REQUEST, ctx.signal).catch(() => null);
          }
          return await prepareRuntimeProviderBridge(
            sandbox,
            ctx,
            engine,
            workdir,
            preparation.stableProviderPrepared,
            binding,
            stableProviderPendingRevision,
          );
        },
        closeProvider: (state) => state.close(),
        prefetchProvider: (sandbox) => prefetchRuntimeProviderBridge(sandbox, engine),
      });
      const { sandbox, workdir, redact } = prepared;
      const providerBridgeLease: RuntimeProviderBridgeLease = prepared.providerState;
      // This sandbox's Codex reads config.toml (the tool gateway's bearer) only
      // when its session starts. Whether the thread's session predates the file
      // the bridge just wrote is read alongside the barriers and the shell read.
      // Hosted Codex reconnects its tools on the relay's kept session instead.
      const codexConfigChange = engine === "codex" && providerBridgeLease.authPath !== "subscription"
        ? readCodexConfigChange(sandbox, runtimeThreadId(ctx))
        : null;
      codexConfigChange?.catch(() => {});
      const controlMetadata = ctx.expectedSandbox
        ? { expectedSandbox: ctx.expectedSandbox, threadId: ctx.threadId ?? ctx.runId }
        : undefined;

      try {
        // A warm T3 process may still own a Codex app-server launched from the
        // previous stable settings. When the host changes those settings,
        // restart once before session lookup so T3 boots the new argv and then
        // resumes the retained native thread from its persisted cursor.
        if (
          engine === "codex" &&
          providerBridgeLease.authPath !== "subscription" &&
          providerBridgeLease.pendingProviderConfigurationRevision
        ) {
          runtimeTouched = true;
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            await applyPendingCodexProviderConfiguration({
              sandbox,
              signal: ctx.signal,
              revision: providerBridgeLease.pendingProviderConfigurationRevision,
              timing: ctx.timing,
            });
          } finally {
            endBarrier?.();
          }
        }

        // Claude also patches T3 settings.json above. The explicit provider
        // instance carries a unique display marker, so the cache probe proves
        // T3 applied the gateway-backed wrapper rather than merely observing
        // that the settings file exists.
        if (providerBridgeLease.readiness) {
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            runtimeTouched = (await ensureRuntimeProviderReadyForTurn({
              sandbox,
              signal: ctx.signal,
              readiness: providerBridgeLease.readiness,
              barrierDeadlineMs: CLAUDE_BARRIER_DEADLINE_MS,
              verifyDeadlineMs: CLAUDE_VERIFY_DEADLINE_MS,
              providerLabel: "Claude",
            })) || runtimeTouched;
          } finally {
            endBarrier?.();
          }
        }

        // A new Codex subscription session patches its relay config into T3's
        // settings.json above (provider_bridge; a kept one changes nothing). T3 applies settings via
        // an asynchronous settings-watch reconcile, so a turn dispatched before
        // that reconcile binds to the pre-reconcile, relay-less codex instance and
        // falls back to a local, unauthenticated app-server (no first activity).
        // Scoped to subscription Codex. Provider-gateway Codex does not create
        // a per-run instance, and Claude has its own marker barrier above. The
        // no-first-activity watchdog below remains the final safety net.
        if (providerBridgeLease?.authPath === "subscription" && !providerBridgeLease.sessionReused) {
          const codexInstanceName = providerBridgeLease.codexInstanceName;
          if (!codexInstanceName) throw new Error("Codex subscription instance name is missing");
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            // A sandbox whose runtime is down cannot publish the status cache,
            // so polling it only spends the barrier deadline. Boot now (timed as
            // runtime.readiness); the boot reads the relay config written above.
            // A runtime the image booted already is up and takes the relay
            // config through its settings watch; the barrier below waits for it.
            const up = await runtimeEnvironmentHealthy(sandbox);
            // (B) Barrier: wait for the reconcile to publish the subscription
            // (relay-backed) codex instance into its status cache. Content, not
            // mtime: health refreshes rewrite the cache for the legacy instance
            // too. Fast path, no restart cost.
            if (
              !up ||
              !(await awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS, codexInstanceName))
            ) {
              // (A) Fallback: the reconcile did not land in time. Bounce T3 so boot
              // reads the relay config synchronously and builds the remote instance
              // from the start, then verify once before steering. Honest error if
              // the runtime never reports ready.
              runtimeTouched = true;
              await restartRuntimeEnvironment(sandbox, ctx.signal, ctx.timing);
              invalidateRuntimeEnvironmentAccess(sandbox);
              if (
                !(await awaitCodexProviderReady(sandbox, ctx.signal, CODEX_VERIFY_DEADLINE_MS, codexInstanceName))
              ) {
                throw new Error("Codex runtime did not become ready after restart");
              }
            }
          } finally {
            endBarrier?.();
          }
        }

        const endShell = ctx.timing?.begin("t3.shell");
        const shell = (!runtimeTouched && await earlyShell) ||
          await requestRuntimeEnvironment<RuntimeShellSnapshot>(sandbox, SHELL_REQUEST, ctx.signal);
        endShell?.();
        const threadId = runtimeThreadId(ctx);
        const threadExists = shell.threads.some((thread) => thread.id === threadId);
        // A read-only turn never resumes a thread that may hold a session grant.
        await assertReadOnlyTurnAllowed({ threadId: ctx.threadId ?? ctx.runId, permissionMode: ctx.permissionMode, threadExists });
        if (engine === "opencode") {
          const limitsApplied = await reloadRetainedSession({
            sandbox,
            signal: ctx.signal,
            threadId,
            threadExists,
            change: "OpenCode model limits",
            changed: providerBridgeLease.modelLimitsChanged,
            revision: providerBridgeLease.modelLimitsRevision,
          });
          // A declined stop leaves the refresh owed, so the next turn tries again.
          if (limitsApplied) await providerBridgeLease.ackModelLimitsReload();
        } else if (codexConfigChange) {
          const configRevision = await codexConfigChange;
          if (configRevision && await reloadRetainedSession({
            sandbox, signal: ctx.signal, threadId, threadExists,
            change: "Codex configuration", changed: true, revision: configRevision,
          })) {
            await stampCodexConfig(sandbox, threadId, configRevision);
          }
        }
        const createdAt = new Date().toISOString();
        // The run's own policy; the operator posture only covers runs created without one.
        const runtimeMode = runtimeModeFor(ctx.permissionMode ?? configuredRuntimeMode());
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
          startMetadata: { workspaceRoot: workdir, runtimeMode, createdAt, shell },
          persistSession: async (providerSession) => {
            if (!ctx.saveProviderSession) {
              throw new Error("Session persistence is unavailable");
            }
            await ctx.saveProviderSession(providerSession, providerBridgeLease.authEpoch);
          },
        });
        const session = established.session;
        // The session's native command list, recorded with the session so the
        // reply composer's typed commands and Compact authorize against it. Best
        // effort and independent of the snapshot read below, so the two overlap.
        const commandCatalog = recordRuntimeCommandCatalog({ ctx, sandbox, engine, session });
        // `start()` may adopt a thread the runtime already projected even when
        // the durable provider lifecycle is fresh. Always capture its current
        // turn before steering so an initialization greeting cannot be mistaken
        // for the response to this run.
        // The runtime runs a turn with the mode stored on its THREAD, so a run
        // whose mode differs from the thread's (a reply that changed it) sets the
        // thread's mode and proceeds only once the runtime reports it.
        const priorSnapshot = await ensureRuntimeThreadMode({
          sandbox,
          threadId,
          runtimeMode,
          snapshot: await readThreadSnapshot(ctx, sandbox),
          signal: ctx.signal,
        });

        const prompt = await composeRunTurnPrompt(
          ctx,
          runtimeThreadHasAuthoritativeHistory(priorSnapshot, providerBridgeLease),
          executionCapabilities,
        );
        await recordProviderSessionStarted(ctx, session, {
          provider: "t3",
          source: engine,
          resumed: established.resumed,
        });
        await commandCatalog;
        let turnInput = { kind: "prompt" as const, text: prompt, model: ctx.model, reasoningEffort: ctx.reasoningEffort };
        let turnBase = priorSnapshot;
        let projector = createTurnProjector({ ctx, redact, engine, seen: activityRevisions(priorSnapshot) });
        let attempt = 1;
        // Each attempt is requested at its own time: the runtime keeps the
        // request time on the turn, and recovery tells attempts apart by it.
        let turnRequestedAt = createdAt;
        const endTurn = ctx.timing?.begin("t3.turn_wait");
        let skipQueuedCancel = false;
        try {
          for (;;) {
            const createdAt = turnRequestedAt;
            if (ctx.commandName) {
              const command = {
                name: ctx.commandName, provider: ctx.commandProvider ?? null,
                sessionId: ctx.commandSessionId ?? null, catalogRevision: ctx.commandCatalogRevision ?? null,
              };
              const rejection = await runtimeCommandDispatchRejection({ ctx, sandbox, engine, session, command });
              if (rejection) throw new Error(`Native command dispatch rejected: ${rejection}`);
            }
            ctx.timing?.mark("dispatch");
            // The turn is dispatched on the socket already following its thread,
            // so nothing it starts can happen before the plane is listening.
            let steerFailure: Error | null = null;
            const start = async () => {
              const endDispatch = ctx.timing?.begin("t3.dispatch_request");
              const steerResult = await driver.steer({
                runId: attempt === 1 ? ctx.runId : continuationRunId(ctx.runId, attempt),
                threadId: ctx.threadId ?? ctx.runId,
                session,
                input: turnInput,
                metadata: controlMetadata
                  ? { runtimeMode, createdAt, ...controlMetadata }
                  : { runtimeMode, createdAt },
                signal: ctx.signal,
              });
              endDispatch?.();
              if (steerResult.status !== "ok") {
                steerFailure = new Error(`the provider runtime ${engine} steer failed (${steerResult.status}): ${steerResult.message ?? "unsupported"}`);
                throw steerFailure;
              }
              // Delivery evidence, separate from session authority: only an accepted
              // steer proves this prompt, and the history it carried, reached the engine.
              await ctx.markPromptDelivered?.();
              await ctx.emit({ kind: "task", label: "Waiting for provider activity…", chip: `runtime:${engine}` });
            };
            try {
              const summary = ctx.commandName === "compact"
                ? await waitForRuntimeCompact(
                    ctx, sandbox, turnBase, redact, runtimeUserMessageId(ctx.runId), runtimeTurnWaitDependencies, start,
                  )
                : await waitForRuntimeTurn(
                    ctx, sandbox, projector.seen(), turnBase, redact, runtimeTurnWaitDependencies, engine, projector, start,
                  );
              await ctx.emit({ kind: "done", label: "Done", chip: null });
              ctx.setSummary(summary, Date.now() - startedAt);
              break;
            } catch (error) {
              if (error === steerFailure) throw error;
              if (ctx.commandName === "compact") throw error;
              if (
                providerBridgeLease.authPath === "subscription" &&
                (error instanceof RuntimeFirstActivityTimeoutError || ctx.signal.aborted)
              ) {
                const recovery = await recoverStuckCodexSubscriptionStart({
                  error,
                  ctx,
                  sandbox,
                  lease: providerBridgeLease,
                  priorTurnId: turnBase.thread.latestTurn?.turnId ?? null,
                });
                skipQueuedCancel = recovery.stuckStartConfirmed;
                throw recovery.error;
              }
              if (error instanceof NoProgressError && !ctx.signal.aborted) {
                // The durable run is failing with the provider's real reason; also
                // stop the sandbox-side turn so a persistent thread does not keep
                // retrying against the provider gateway. Best-effort only: a cancel
                // failure must not mask the no-progress reason.
                await driver.cancel(session, "provider made no progress", controlMetadata).catch(() => {});
                throw error;
              }
              // A turn that may still be running is never steered again; only a
              // settled failure (no answer, or a transient provider error the
              // runtime reported) gets one continuation before it stands.
              if (error instanceof RuntimeFirstActivityTimeoutError || ctx.signal.aborted) throw error;
              const recovery = turnRecovery(error, attempt);
              if (!recovery) {
                const cause = await upstreamCauseLabel(ctx.runId, error);
                if (cause) await ctx.emit({ kind: "task", label: cause, chip: `runtime:${engine}` });
                throw error;
              }
              attempt += 1;
              if (recovery.delayMs > 0) await delay(recovery.delayMs, undefined, { signal: ctx.signal });
              // Whatever landed after the wait gave up goes through the same
              // projector, so the record keeps it and the continuation does not
              // take it for old. An answer that landed late is the answer.
              const settledSnapshot = await readThreadSnapshot(ctx, sandbox);
              await projector.apply(settledSnapshot);
              if (recovery.answerMayBeLate && projector.finalText.trim()) {
                await ctx.emit({ kind: "done", label: "Done", chip: null });
                ctx.setSummary(projector.finalText, Date.now() - startedAt);
                break;
              }
              await ctx.emit({ kind: "task", label: recovery.label, chip: `runtime:${engine}` });
              turnBase = settledSnapshot;
              turnRequestedAt = new Date().toISOString();
              projector = createTurnProjector({ ctx, redact, engine, seen: projector.seen(), steps: projector.steps() });
              turnInput = { kind: "prompt" as const, text: recovery.prompt, model: ctx.model, reasoningEffort: ctx.reasoningEffort };
            }
          }
          // The runtime rewrites its snapshot when the provider's command list
          // changes (a command this turn created, a refreshed provider); read it
          // again once the turn settled so the next reply composes against the
          // current catalog. An unchanged list records nothing.
          await recordRuntimeCommandCatalog({ ctx, sandbox, engine, session });
        } finally {
          endTurn?.();
          if (ctx.signal.aborted && !skipQueuedCancel && ctx.commandName !== "compact") {
            const cancelResult = await driver.cancel(
              session,
              "turn aborted",
              controlMetadata,
            );
            if (cancelResult.status !== "ok") {
              throw new Error(
                `the provider runtime ${engine} cancel failed (${cancelResult.status}): ${cancelResult.message ?? "unsupported"}`,
              );
            }
          }
        }
      } finally {
        await prepared.close().catch(() => {});
      }
    },
  };
}

export const runtimeCodexAdapter = makeRuntimeAdapter("codex", t3ProviderDrivers.codex);
export const runtimeClaudeAdapter = makeRuntimeAdapter("claude", t3ProviderDrivers.claude);
export const runtimeOpenCodeAdapter = makeRuntimeAdapter("opencode", t3ProviderDrivers.opencode);
