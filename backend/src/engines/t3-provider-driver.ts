import type { HarnessRuntime, HarnessSession } from "@skynet/agent-harness/canonical";
import {
  providerDriverUnsupported,
  type HarnessOperationResult,
  type ProviderDriver,
  type ProviderStartRequest,
} from "@skynet/agent-harness/control";
import {
  sandboxProvider,
  sandboxProviderApiKey,
  type SandboxHandle,
} from "../sandboxes/provider";
import { sessionCapabilities } from "./capabilities";
import {
  isT3EnvironmentMissingSessionError,
  requestT3Environment,
} from "./t3-environment-client";
import { T3_RUNTIME_GENERATION } from "./t3-environment";
import {
  assistantText,
  buildT3ProjectCreateCommand,
  buildT3ThreadCreateCommand,
  buildT3TurnInterruptCommand,
  buildT3TurnStartCommand,
  t3ProjectId,
  t3ThreadId,
  type T3EngineId,
  type T3RuntimeMode,
  type T3ThreadSnapshot,
} from "./t3-orchestration";

const T3_POLL_INTERVAL_MS = 125;
export const T3_SESSION_GENERATION = 2;

interface T3ShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

interface T3StartMetadata {
  readonly workspaceRoot: string;
  readonly runtimeMode: T3RuntimeMode;
  readonly createdAt: string;
}

function isT3RuntimeMode(value: unknown): value is T3RuntimeMode {
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access";
}

function steerRuntimeMode(metadata: Record<string, unknown> | undefined): T3RuntimeMode {
  return isT3RuntimeMode(metadata?.runtimeMode) ? metadata.runtimeMode : "full-access";
}

function steerCreatedAt(metadata: Record<string, unknown> | undefined): string {
  return typeof metadata?.createdAt === "string" ? metadata.createdAt : new Date().toISOString();
}

function t3StartMetadata(metadata: Record<string, unknown> | undefined): T3StartMetadata | null {
  const workspaceRoot = metadata?.workspaceRoot;
  const runtimeMode = metadata?.runtimeMode;
  const createdAt = metadata?.createdAt;
  return typeof workspaceRoot === "string" &&
    workspaceRoot.startsWith("/") &&
    isT3RuntimeMode(runtimeMode) &&
    typeof createdAt === "string"
    ? { workspaceRoot, runtimeMode, createdAt }
    : null;
}

function driverError(code: string, message: string): {
  readonly status: "error";
  readonly code: string;
  readonly message: string;
} {
  return { status: "error", code, message };
}

async function resolveRuntime(runtime: HarnessRuntime): Promise<SandboxHandle | null> {
  if (runtime.kind !== "sandbox") return null;
  try {
    return await sandboxProvider(sandboxProviderApiKey()).get(runtime.id);
  } catch {
    return null;
  }
}

interface T3ProviderDriverDependencies {
  readonly resolveRuntime: typeof resolveRuntime;
  readonly requestEnvironment: typeof requestT3Environment;
}

const defaultT3ProviderDriverDependencies = {
  resolveRuntime,
  requestEnvironment: requestT3Environment,
} satisfies T3ProviderDriverDependencies;

async function waitForShellState(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  ready: (shell: T3ShellSnapshot) => boolean,
  description: string,
): Promise<void> {
  while (!signal.aborted) {
    const shell = await requestT3Environment<T3ShellSnapshot>(
      sandbox,
      { method: "GET", path: "/api/orchestration/shell" },
      signal,
    );
    if (ready(shell)) return;
    await Bun.sleep(T3_POLL_INTERVAL_MS);
  }
  throw new Error(`T3 ${description} creation aborted`);
}

function session(
  driver: ProviderDriver,
  runtime: HarnessRuntime,
  nativeSessionId: string,
): HarnessSession {
  return {
    provider: driver.provider,
    nativeSessionId,
    runtime,
    protocolVersion: driver.descriptor.protocol.name,
    capabilities: driver.descriptor.capabilities,
    generation: T3_SESSION_GENERATION,
  };
}

async function readThreadSnapshot(
  dependencies: T3ProviderDriverDependencies,
  currentSession: HarnessSession,
  signal: AbortSignal,
): Promise<{ readonly sandbox: SandboxHandle; readonly snapshot: T3ThreadSnapshot } | null> {
  const sandbox = await dependencies.resolveRuntime(currentSession.runtime);
  if (!sandbox) return null;
  const snapshot = await dependencies.requestEnvironment<T3ThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(currentSession.nativeSessionId)}`,
    },
    signal,
  );
  return { sandbox, snapshot };
}

export function makeT3ProviderDriver(
  engine: T3EngineId,
  dependencies: T3ProviderDriverDependencies = defaultT3ProviderDriverDependencies,
): ProviderDriver {
  const capabilities = sessionCapabilities(engine, {
    desktop: false,
    knowledgeTools: true,
    t3Orchestration: true,
  });
  const driver: ProviderDriver = {
    provider: engine,
    descriptor: {
      provider: engine,
      protocol: { name: "t3-orchestration", version: T3_RUNTIME_GENERATION },
      capabilities,
      model: { selection: "per_turn", supportsArbitraryModel: true },
      tools: { mode: "skynet_brokered", approval: "skynet" },
    },

    async start(request: ProviderStartRequest) {
      const metadata = t3StartMetadata(request.metadata);
      if (!metadata) {
        return driverError(
          "invalid_start_metadata",
          "T3 start requires workspaceRoot, runtimeMode, and createdAt metadata",
        );
      }
      const sandbox = await dependencies.resolveRuntime(request.runtime);
      if (!sandbox) return driverError("runtime_unreachable", "T3 sandbox is unreachable");
      const signal = request.signal ?? AbortSignal.timeout(30_000);
      const ctx = { runId: request.runId, threadId: request.threadId, model: request.model };
      try {
        const shell = await dependencies.requestEnvironment<T3ShellSnapshot>(
          sandbox,
          { method: "GET", path: "/api/orchestration/shell" },
          signal,
        );
        const projectId = t3ProjectId(ctx);
        const threadId = t3ThreadId(ctx);
        if (!shell.projects.some((project) => project.id === projectId)) {
          await dependencies.requestEnvironment(
            sandbox,
            {
              method: "POST",
              path: "/api/orchestration/dispatch",
              payload: buildT3ProjectCreateCommand(ctx, metadata.workspaceRoot, metadata.createdAt),
            },
            signal,
          );
          await waitForShellState(
            sandbox,
            signal,
            (current) => current.projects.some((project) => project.id === projectId),
            "project",
          );
        }
        if (!shell.threads.some((thread) => thread.id === threadId)) {
          await dependencies.requestEnvironment(
            sandbox,
            {
              method: "POST",
              path: "/api/orchestration/dispatch",
              payload: buildT3ThreadCreateCommand(
                ctx,
                engine,
                metadata.createdAt,
                metadata.runtimeMode,
              ),
            },
            signal,
          );
          await waitForShellState(
            sandbox,
            signal,
            (current) => current.threads.some((thread) => thread.id === threadId),
            "thread",
          );
        }
        return { status: "ok", value: session(driver, request.runtime, threadId) };
      } catch (error) {
        return driverError(
          "session_create_failed",
          error instanceof Error ? error.message : "unknown T3 session create error",
        );
      }
    },

    async resume(request) {
      try {
        const result = await readThreadSnapshot(
          dependencies,
          request.session,
          request.signal ?? AbortSignal.timeout(10_000),
        );
        if (!result) return driverError("runtime_unreachable", "T3 sandbox is unreachable");
        const { snapshot } = result;
        return snapshot.thread.id === request.session.nativeSessionId
          ? { status: "ok", value: request.session }
          : driverError("session_invalid", "T3 thread identity changed");
      } catch (error) {
        return driverError(
          isT3EnvironmentMissingSessionError(error)
            ? "session_invalid"
            : "session_resume_failed",
          error instanceof Error ? error.message : "T3 thread is not available",
        );
      }
    },

    async reconcile(request) {
      try {
        const result = await readThreadSnapshot(
          dependencies,
          request.session,
          request.signal ?? AbortSignal.timeout(10_000),
        );
        if (!result) return { status: "unreachable" };
        const { snapshot } = result;
        const state = snapshot.thread.latestTurn?.state;
        if (state === "running") return { status: "in_progress" };
        if (state === "completed") {
          return {
            status: "completed",
            summary: assistantText(snapshot).trim() || "T3 run completed",
          };
        }
        return { status: "no_change" };
      } catch {
        return { status: "unreachable" };
      }
    },

    async steer(request): Promise<HarnessOperationResult> {
      if (request.input.kind !== "prompt") {
        return providerDriverUnsupported(
          engine,
          "steer",
          "T3 production turns currently accept prompt steering through this seam",
        );
      }
      const sandbox = await dependencies.resolveRuntime(request.session.runtime);
      if (!sandbox) return driverError("runtime_unreachable", "T3 sandbox is unreachable");
      try {
        await dependencies.requestEnvironment(
          sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildT3TurnStartCommand(
              {
                runId: request.runId,
                threadId: request.threadId,
                model: request.input.model,
              },
              engine,
              request.input.text,
              steerCreatedAt(request.metadata),
              false,
              steerRuntimeMode(request.metadata),
            ),
          },
          request.signal ?? AbortSignal.timeout(30_000),
        );
        return { status: "ok" };
      } catch (error) {
        return driverError(
          "steer_failed",
          error instanceof Error ? error.message : "unknown T3 steer error",
        );
      }
    },

    async cancel(currentSession): Promise<HarnessOperationResult> {
      try {
        const signal = AbortSignal.timeout(10_000);
        const result = await readThreadSnapshot(
          dependencies,
          currentSession,
          signal,
        );
        if (!result) return driverError("runtime_unreachable", "T3 sandbox is unreachable");
        const { sandbox, snapshot } = result;
        await dependencies.requestEnvironment(
          sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildT3TurnInterruptCommand(
              currentSession.nativeSessionId,
              snapshot.thread.latestTurn?.turnId,
            ),
          },
          signal,
        );
        return { status: "ok" };
      } catch (error) {
        return driverError(
          "cancel_failed",
          error instanceof Error ? error.message : "unknown T3 cancel error",
        );
      }
    },
  };
  return driver;
}

export const t3ProviderDrivers: Readonly<Record<T3EngineId, ProviderDriver>> = {
  codex: makeT3ProviderDriver("codex"),
  claude: makeT3ProviderDriver("claude"),
  opencode: makeT3ProviderDriver("opencode"),
};
