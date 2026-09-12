import type { SandboxHandle } from "../sandboxes/provider.js";
import { restartRuntimeEnvironment } from "./runtime-environment.js";
import {
  invalidateRuntimeEnvironmentAccess,
  requestRuntimeEnvironment,
} from "./runtime-environment-client.js";
import {
  runtimeThreadId,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration.js";
import type { RuntimeProviderBridgeLease } from "./runtime-provider-bridge.js";
import type { EngineRunContext } from "./types.js";

const CODEX_STUCK_START_RECOVERY_MS = 30_000;

interface RuntimeShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

export class RuntimeFirstActivityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The provider produced no first activity within ${timeoutMs}ms`);
    this.name = "RuntimeFirstActivityTimeoutError";
  }
}

export interface StuckCodexStartRecoveryDependencies {
  readonly requestEnvironment: typeof requestRuntimeEnvironment;
  readonly restart: typeof restartRuntimeEnvironment;
  readonly invalidateAccess: typeof invalidateRuntimeEnvironmentAccess;
  readonly cleanupSignal: () => AbortSignal;
  readonly warn: (message: string, context: Record<string, unknown>) => void;
}

export interface StuckCodexStartRecoveryInput {
  readonly error: unknown;
  readonly ctx: Pick<EngineRunContext, "runId" | "threadId" | "signal">;
  readonly sandbox: SandboxHandle;
  readonly lease: Pick<RuntimeProviderBridgeLease, "authPath" | "close">;
  readonly priorTurnId: string | null;
  readonly dependencies?: StuckCodexStartRecoveryDependencies;
}

export interface StuckCodexStartRecoveryResult {
  readonly error: unknown;
  readonly stuckStartConfirmed: boolean;
}

const stuckCodexStartRecoveryDependencies: StuckCodexStartRecoveryDependencies = {
  requestEnvironment: requestRuntimeEnvironment,
  restart: restartRuntimeEnvironment,
  invalidateAccess: invalidateRuntimeEnvironmentAccess,
  cleanupSignal: () => AbortSignal.timeout(CODEX_STUCK_START_RECOVERY_MS),
  warn: (message, context) => console.warn(message, context),
};

export async function recoverStuckCodexSubscriptionStart(
  input: StuckCodexStartRecoveryInput,
): Promise<StuckCodexStartRecoveryResult> {
  if (
    (!(input.error instanceof RuntimeFirstActivityTimeoutError) && !input.ctx.signal.aborted) ||
    input.lease.authPath !== "subscription"
  ) {
    return { error: input.error, stuckStartConfirmed: false };
  }
  const dependencies = input.dependencies ?? stuckCodexStartRecoveryDependencies;
  const signal = dependencies.cleanupSignal();
  const threadId = runtimeThreadId(input.ctx);
  let stuckStartConfirmed = false;
  try {
    const snapshot = await dependencies.requestEnvironment<RuntimeThreadSnapshot>(
      input.sandbox,
      { method: "GET", path: `/api/orchestration/threads/${encodeURIComponent(threadId)}` },
      signal,
    );
    if (
      snapshot.thread.id !== threadId ||
      (snapshot.thread.latestTurn?.turnId ?? null) !== input.priorTurnId ||
      snapshot.thread.session?.status !== "starting"
    ) {
      return { error: input.error, stuckStartConfirmed: false };
    }
    const shell = await dependencies.requestEnvironment<RuntimeShellSnapshot>(
      input.sandbox,
      { method: "GET", path: "/api/orchestration/shell" },
      signal,
    );
    if (shell.threads.length !== 1 || shell.threads[0]?.id !== threadId) {
      return { error: input.error, stuckStartConfirmed: false };
    }
    stuckStartConfirmed = true;
    await input.lease.close();
    await dependencies.restart(input.sandbox, signal);
    dependencies.invalidateAccess(input.sandbox);
  } catch (recoveryError) {
    dependencies.warn("Codex stuck-start runtime recovery failed", {
      runId: input.ctx.runId,
      threadId: input.ctx.threadId ?? input.ctx.runId,
      cause: recoveryError,
    });
  }
  return { error: input.error, stuckStartConfirmed };
}
