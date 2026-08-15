import type { EngineAdapter, EngineRunContext } from "./types";
import { composeTurnPrompt } from "./types";
import { acquireThreadSandbox } from "./thread-sandbox";
import { ensureSandboxDesktopView } from "./desktop";
import { prepareRepos } from "./repo-prep";
import { prepareT3ProviderBridge } from "./t3-provider-bridge";
import { requestT3Environment } from "./t3-environment-client";
import { subscribeT3Thread } from "./t3-event-stream";
import {
  activityStep,
  assistantText,
  buildT3ProjectCreateCommand,
  buildT3ThreadCreateCommand,
  buildT3TurnInterruptCommand,
  buildT3TurnStartCommand,
  t3ProjectId,
  t3ActivityProviderEvent,
  t3ActivityRevision,
  t3ActivityStepKey,
  shouldProjectT3Activity,
  t3ThreadId,
  t3TurnError,
  t3TurnSettled,
  type T3EngineId,
  type T3RuntimeMode,
  type T3ThreadSnapshot,
} from "./t3-orchestration";
import {
  composeSecretEnv,
  materializeSecretFiles,
  PROVIDER_SECRET_NAMES,
  recordSecretsInjected,
} from "../secrets/inject";
import { createSecretRedactor } from "../secrets/redact";
import { providerGatewayWired } from "../provider-gateway/sandbox-config";
import { sandboxProviderKind } from "../sandboxes/provider";
import { recordProviderEvent } from "../runs/provider-events";
import { SESSION_STARTED_EVENT_TYPE } from "@skynet/agent-harness/canonical";
import { sessionCapabilities } from "./capabilities";
import { materializeRunInputs } from "../uploads/materialize";
import {
  T3_CUBE_WARM_POOL_NAME,
  T3_RUNTIME_GENERATION,
  T3_RUNTIME_GENERATION_LABEL,
} from "./t3-environment";

const T3_POLL_INTERVAL_MS = 125;

interface T3ShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

async function waitForProject(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  projectId: string,
): Promise<void> {
  while (!ctx.signal.aborted) {
    const shell = await requestT3Environment<T3ShellSnapshot>(
      sandbox,
      { method: "GET", path: "/api/orchestration/shell" },
      ctx.signal,
    );
    if (shell.projects.some((project) => project.id === projectId)) return;
    await Bun.sleep(T3_POLL_INTERVAL_MS);
  }
  throw new Error("T3 project creation aborted");
}

async function waitForThread(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  threadId: string,
): Promise<void> {
  while (!ctx.signal.aborted) {
    const shell = await requestT3Environment<T3ShellSnapshot>(
      sandbox,
      { method: "GET", path: "/api/orchestration/shell" },
      ctx.signal,
    );
    if (shell.threads.some((thread) => thread.id === threadId)) return;
    await Bun.sleep(T3_POLL_INTERVAL_MS);
  }
  throw new Error("T3 thread creation aborted");
}

export function t3RunAdapterEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.T3_RUN_ADAPTER_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function t3RunAdapterEngineSelected(
  engine: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const configured = env.T3_RUN_ADAPTER_ENGINES?.trim();
  if (!configured) return engine === "codex" || engine === "opencode";
  return configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(engine.toLowerCase());
}

export type T3RunAdapterMode = "canary" | "all";

export function t3RunAdapterMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): T3RunAdapterMode {
  const mode = env.T3_RUN_ADAPTER_MODE?.trim().toLowerCase() || "canary";
  if (mode !== "canary" && mode !== "all") {
    throw new Error("T3_RUN_ADAPTER_MODE must be canary or all");
  }
  return mode;
}

export function t3RunAdapterSelected(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!t3RunAdapterEnabled(env)) return false;
  if (t3RunAdapterMode(env) === "all") return true;
  const allowlist = new Set(
    (env.T3_CANARY_THREAD_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return allowlist.has(ctx.threadId ?? "") || allowlist.has(ctx.runId);
}

export function t3RunSnapshot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (sandboxProviderKind(env) === "cube") {
    const template = env.T3_CUBE_TEMPLATE_ID?.trim() || env.CUBE_TEMPLATE_ID?.trim();
    if (!template) throw new Error("T3_CUBE_TEMPLATE_ID is required for the T3 Cube adapter");
    return template;
  }
  return (
    env.T3_DAYTONA_SNAPSHOT?.trim() ||
    env.DAYTONA_SNAPSHOT?.trim() ||
    "skynet-agent-v17"
  );
}

export function t3RuntimeMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): T3RuntimeMode {
  const mode = env.T3_RUNTIME_MODE?.trim() || "full-access";
  if (
    mode !== "approval-required" &&
    mode !== "auto-accept-edits" &&
    mode !== "auto" &&
    mode !== "full-access"
  ) {
    throw new Error(
      "T3_RUNTIME_MODE must be approval-required, auto-accept-edits, auto, or full-access",
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
    throw new Error(`T3 run ${ctx.runId} could not resolve its sandbox workspace`);
  }
  return workdir;
}

async function readThreadSnapshot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
): Promise<T3ThreadSnapshot> {
  return await requestT3Environment<T3ThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(t3ThreadId(ctx))}`,
    },
    ctx.signal,
  );
}

async function interruptActiveT3Turn(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
): Promise<void> {
  const threadId = t3ThreadId(ctx);
  const snapshot = await requestT3Environment<T3ThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
    },
    AbortSignal.timeout(5_000),
  ).catch(() => null);
  const turnId = snapshot?.thread.latestTurn?.turnId;
  try {
    await requestT3Environment(
      sandbox,
      {
        method: "POST",
        path: "/api/orchestration/dispatch",
        payload: buildT3TurnInterruptCommand(threadId, turnId),
      },
      AbortSignal.timeout(5_000),
    );
  } catch (error) {
    console.error(`[t3] failed to interrupt native turn for run ${ctx.runId}:`, error);
    throw error;
  }
}

async function waitForNewT3TurnSnapshot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  priorTurnId: string | null,
): Promise<T3ThreadSnapshot> {
  while (!ctx.signal.aborted) {
    const snapshot = await readThreadSnapshot(ctx, sandbox).catch(() => null);
    const latestTurnId = snapshot?.thread.latestTurn?.turnId ?? null;
    if (snapshot && latestTurnId !== null && latestTurnId !== priorTurnId) {
      return snapshot;
    }
    await Bun.sleep(T3_POLL_INTERVAL_MS);
  }
  throw new Error("T3 turn projection aborted");
}

async function waitForT3Turn(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  preExistingActivities: ReadonlyMap<string, string>,
  priorTurnId: string | null,
  redact: ReturnType<typeof createSecretRedactor>,
): Promise<string> {
  const activityRevisions = new Map(preExistingActivities);
  const activitySteps = new Map<string, string>();
  let publishedText = "";
  let finalText = "";
  const applySnapshot = async (snapshot: T3ThreadSnapshot): Promise<boolean> => {
    for (const activity of snapshot.thread.activities) {
      const revision = t3ActivityRevision(activity);
      if (activityRevisions.get(activity.id) === revision) continue;
      activityRevisions.set(activity.id, revision);
      await recordProviderEvent(t3ActivityProviderEvent(ctx, t3ThreadId(ctx), activity), {
        critical:
          activity.kind === "user-input.requested" || activity.kind === "approval.requested",
      });
      if (!shouldProjectT3Activity(activity, snapshot.thread.activities)) continue;
      const step = redact.unknown(activityStep(activity));
      const activityStepKey = t3ActivityStepKey(activity);
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
      if (delta) ctx.publishDelta?.(delta);
    }
    publishedText = text;

    const error = t3TurnError(snapshot);
    if (error) throw new Error(redact.text(error));
    finalText = text;
    return !t3TurnSettled(snapshot);
  };
  // Dispatch commits before the read projection necessarily observes the new
  // turn. Poll only this short projection hand-off; all subsequent updates use
  // T3's native replayable websocket stream.
  const initial = await waitForNewT3TurnSnapshot(ctx, sandbox, priorTurnId);
  if (!(await applySnapshot(initial))) return finalText;
  await subscribeT3Thread(
    sandbox,
    t3ThreadId(ctx),
    initial.snapshotSequence,
    ctx.signal,
    async (item) => {
      if (item.kind === "synchronized") return true;
      return await applySnapshot(await readThreadSnapshot(ctx, sandbox));
    },
  );
  if (!ctx.signal.aborted) return finalText;
  throw new Error("T3 run aborted (timeout)");
}

function makeT3Adapter(engine: T3EngineId): EngineAdapter {
  return {
    id: engine,
    async run(ctx): Promise<void> {
      if (!providerGatewayWired()) {
        throw new Error("T3 engine requires a configured provider gateway");
      }
      const startedAt = Date.now();
      const secretInjection = await composeSecretEnv(ctx, { excludeNames: PROVIDER_SECRET_NAMES });
      const redact = createSecretRedactor(secretInjection.redactionValues);
      const endSandbox = ctx.timing?.begin("t3.sandbox_acquire");
      const lease = await acquireThreadSandbox(ctx, {
        snapshot: t3RunSnapshot(),
        chip: `t3:${engine}`,
        warmPool: T3_CUBE_WARM_POOL_NAME,
        labels: { [T3_RUNTIME_GENERATION_LABEL]: T3_RUNTIME_GENERATION },
        requiredLabels: { [T3_RUNTIME_GENERATION_LABEL]: T3_RUNTIME_GENERATION },
      });
      endSandbox?.();
      const { sandbox } = lease;

      try {
        await ctx.emit({
          kind: "task",
          label: "Preparing T3 runtime, desktop, tools, and integrations…",
          chip: `t3:${engine}`,
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
        const desktopPromise = prepareStage("desktop", () =>
          ensureSandboxDesktopView(sandbox, ctx.signal),
        );
        await Promise.all([
          prepareStage("secrets", () =>
            materializeSecretFiles(
              (command) => sandbox.process.executeCommand(command, undefined, undefined, 30),
              secretInjection.files,
            ),
          ),
          prepareStage("provider_bridge", () => prepareT3ProviderBridge(sandbox, ctx, engine)),
          prepareStage("repos", () => prepareRepos(sandbox, workdir, ctx)),
          prepareStage("inputs", () => materializeRunInputs(sandbox, ctx.inputFiles)),
        ]);
        await prepareStage("secrets_marker", () => recordSecretsInjected(ctx, secretInjection));
        const desktop = await desktopPromise;
        endPrepare?.();
        if (!desktop.available) {
          await ctx.emit({
            kind: "task",
            label: desktop.reason ?? "Desktop computer-use tools unavailable",
            chip: "warning",
          });
        }

        const endShell = ctx.timing?.begin("t3.shell");
        const shell = await requestT3Environment<T3ShellSnapshot>(
          sandbox,
          { method: "GET", path: "/api/orchestration/shell" },
          ctx.signal,
        );
        endShell?.();
        const projectId = t3ProjectId(ctx);
        const threadId = t3ThreadId(ctx);
        const projectExists = shell.projects.some((project) => project.id === projectId);
        const threadExists = shell.threads.some((thread) => thread.id === threadId);
        const priorSnapshot = threadExists ? await readThreadSnapshot(ctx, sandbox) : null;
        const preExistingActivities = new Map(
          priorSnapshot?.thread.activities.map((activity) => [
            activity.id,
            t3ActivityRevision(activity),
          ]) ?? [],
        );
        const priorTurnId = priorSnapshot?.thread.latestTurn?.turnId ?? null;
        const createdAt = new Date().toISOString();
        if (!projectExists) {
          const endProject = ctx.timing?.begin("t3.project_create");
          await requestT3Environment(
            sandbox,
            {
              method: "POST",
              path: "/api/orchestration/dispatch",
              payload: buildT3ProjectCreateCommand(ctx, workdir, createdAt),
            },
            ctx.signal,
          );
          await waitForProject(ctx, sandbox, projectId);
          endProject?.();
        }
        const runtimeMode = t3RuntimeMode();
        if (!threadExists) {
          const endThread = ctx.timing?.begin("t3.thread_create");
          await requestT3Environment(
            sandbox,
            {
              method: "POST",
              path: "/api/orchestration/dispatch",
              payload: buildT3ThreadCreateCommand(ctx, engine, createdAt, runtimeMode),
            },
            ctx.signal,
          );
          await waitForThread(ctx, sandbox, threadId);
          endThread?.();
        }

        // HTTP orchestration dispatch validates thread.turn.start against an
        // already-projected thread. Create it explicitly above instead of
        // relying on the websocket-only bootstrap normalization path.
        const prompt = composeTurnPrompt(ctx, threadExists);
        ctx.saveEngineSessionId?.(threadId);
        await recordProviderEvent({
          id: `${ctx.runId}:${threadId}:session`,
          runId: ctx.runId,
          threadId: ctx.threadId ?? ctx.runId,
          provider: "t3",
          eventType: SESSION_STARTED_EVENT_TYPE,
          nativeSessionId: threadId,
          payload: {
            source: engine,
            capabilities: sessionCapabilities(engine, {
              desktop: desktop.available,
              knowledgeTools: true,
              t3Orchestration: true,
            }),
          },
        }, { critical: true });
        ctx.timing?.mark("dispatch");
        const endDispatch = ctx.timing?.begin("t3.dispatch_request");
        await requestT3Environment(
          sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildT3TurnStartCommand(ctx, engine, prompt, createdAt, false, runtimeMode),
          },
          ctx.signal,
        );
        endDispatch?.();
        const endTurn = ctx.timing?.begin("t3.turn_wait");
        try {
          const summary = await waitForT3Turn(
            ctx,
            sandbox,
            preExistingActivities,
            priorTurnId,
            redact,
          );
          await ctx.emit({ kind: "done", label: "Done", chip: null });
          ctx.setSummary(summary.trim() || `T3 ${engine} run completed`, Date.now() - startedAt);
        } finally {
          endTurn?.();
          if (ctx.signal.aborted) await interruptActiveT3Turn(ctx, sandbox);
        }
      } finally {
        if (lease.releaseAfterRun) await sandbox.delete().catch(() => {});
      }
    },
  };
}

export const t3CodexAdapter = makeT3Adapter("codex");
export const t3ClaudeAdapter = makeT3Adapter("claude");
export const t3OpenCodeAdapter = makeT3Adapter("opencode");
