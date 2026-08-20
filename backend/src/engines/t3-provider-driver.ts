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
  isRuntimeEnvironmentMissingSessionError,
  requestRuntimeEnvironment,
} from "./runtime-environment-client";
import { RUNTIME_GENERATION } from "./runtime-environment";
import {
  assistantText,
  buildRuntimeProjectCreateCommand,
  buildRuntimeThreadCreateCommand,
  buildRuntimeTurnInterruptCommand,
  buildRuntimeTurnStartCommand,
  runtimeProjectId,
  runtimeThreadId,
  type RuntimeEngineId,
  type RuntimeMode,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";

const RUNTIME_POLL_INTERVAL_MS = 125;
export const T3_SESSION_GENERATION = 2;

interface RuntimeShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

interface T3StartMetadata {
  readonly workspaceRoot: string;
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access";
}

function steerRuntimeMode(metadata: Record<string, unknown> | undefined): RuntimeMode {
  return isRuntimeMode(metadata?.runtimeMode) ? metadata.runtimeMode : "full-access";
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
    isRuntimeMode(runtimeMode) &&
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
  readonly requestEnvironment: typeof requestRuntimeEnvironment;
}

const defaultT3ProviderDriverDependencies = {
  resolveRuntime,
  requestEnvironment: requestRuntimeEnvironment,
} satisfies T3ProviderDriverDependencies;

async function waitForShellState(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  ready: (shell: RuntimeShellSnapshot) => boolean,
  description: string,
): Promise<void> {
  while (!signal.aborted) {
    const shell = await requestRuntimeEnvironment<RuntimeShellSnapshot>(
      sandbox,
      { method: "GET", path: "/api/orchestration/shell" },
      signal,
    );
    if (ready(shell)) return;
    await Bun.sleep(RUNTIME_POLL_INTERVAL_MS);
  }
  throw new Error(`Provider runtime ${description} creation aborted`);
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
): Promise<{ readonly sandbox: SandboxHandle; readonly snapshot: RuntimeThreadSnapshot } | null> {
  const sandbox = await dependencies.resolveRuntime(currentSession.runtime);
  if (!sandbox) return null;
  const snapshot = await dependencies.requestEnvironment<RuntimeThreadSnapshot>(
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
  engine: RuntimeEngineId,
  dependencies: T3ProviderDriverDependencies = defaultT3ProviderDriverDependencies,
): ProviderDriver {
  const capabilities = sessionCapabilities(engine, {
    desktop: false,
    knowledgeTools: true,
    runtimeOrchestration: true,
  });
  const driver: ProviderDriver = {
    provider: engine,
    descriptor: {
      provider: engine,
      protocol: { name: "t3-orchestration", version: RUNTIME_GENERATION },
      capabilities,
      model: { selection: "per_turn", supportsArbitraryModel: true },
      tools: { mode: "skynet_brokered", approval: "skynet" },
    },

    async start(request: ProviderStartRequest) {
      const metadata = t3StartMetadata(request.metadata);
      if (!metadata) {
        return driverError(
          "invalid_start_metadata",
          "The provider runtime start requires workspaceRoot, runtimeMode, and createdAt metadata",
        );
      }
      const sandbox = await dependencies.resolveRuntime(request.runtime);
      if (!sandbox) return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
      const signal = request.signal ?? AbortSignal.timeout(30_000);
      const ctx = { runId: request.runId, threadId: request.threadId, model: request.model };
      try {
        const shell = await dependencies.requestEnvironment<RuntimeShellSnapshot>(
          sandbox,
          { method: "GET", path: "/api/orchestration/shell" },
          signal,
        );
        const projectId = runtimeProjectId(ctx);
        const threadId = runtimeThreadId(ctx);
        if (!shell.projects.some((project) => project.id === projectId)) {
          await dependencies.requestEnvironment(
            sandbox,
            {
              method: "POST",
              path: "/api/orchestration/dispatch",
              payload: buildRuntimeProjectCreateCommand(ctx, metadata.workspaceRoot, metadata.createdAt),
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
              payload: buildRuntimeThreadCreateCommand(
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
          error instanceof Error ? error.message : "unknown provider runtime session create error",
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
        if (!result) return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
        const { snapshot } = result;
        return snapshot.thread.id === request.session.nativeSessionId
          ? { status: "ok", value: request.session }
          : driverError("session_invalid", "The provider runtime thread identity changed");
      } catch (error) {
        return driverError(
          isRuntimeEnvironmentMissingSessionError(error)
            ? "session_invalid"
            : "session_resume_failed",
          error instanceof Error ? error.message : "The provider runtime thread is not available",
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
            summary: assistantText(snapshot).trim() || "Run completed",
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
          "The provider runtime currently accepts prompt steering through this seam",
        );
      }
      const sandbox = await dependencies.resolveRuntime(request.session.runtime);
      if (!sandbox) return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
      try {
        await dependencies.requestEnvironment(
          sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildRuntimeTurnStartCommand(
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
          error instanceof Error ? error.message : "unknown provider runtime steer error",
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
        if (!result) return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
        const { sandbox, snapshot } = result;
        await dependencies.requestEnvironment(
          sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildRuntimeTurnInterruptCommand(
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
          error instanceof Error ? error.message : "unknown provider runtime cancel error",
        );
      }
    },
  };
  return driver;
}

export const t3ProviderDrivers: Readonly<Record<RuntimeEngineId, ProviderDriver>> = {
  codex: makeT3ProviderDriver("codex"),
  claude: makeT3ProviderDriver("claude"),
  opencode: makeT3ProviderDriver("opencode"),
};
