import {
  sandboxProvider,
  sandboxProviderApiKey,
} from "../sandboxes/provider";
import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessOperationResult,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "./types";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import {
  assistantText,
  buildRuntimeTurnInterruptCommand,
  isRuntimeThreadSessionId,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";

const RUNTIME_CONTROL_TIMEOUT_MS = 10_000;

const RUNTIME_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  cancel: true,
  streaming: "parts",
  authoritativeHistory: true,
  childSessions: true,
  approvals: true,
  questions: true,
  reasoning: true,
  todos: true,
  patches: true,
  usage: true,
};

async function runtimeSandbox(handle: HarnessSessionHandle) {
  if (!isRuntimeThreadSessionId(handle.sessionId)) {
    throw new Error("session is not a provider-runtime thread");
  }
  return await sandboxProvider(sandboxProviderApiKey()).get(handle.sandboxId);
}

export const runtimeHarness: HarnessAdapter = {
  // Frozen VALUE: "t3" is the stored provider tag for this lane in durable
  // events and session records; only code identifiers were renamed.
  provider: "t3",

  capabilities(): HarnessCapabilities {
    return { ...RUNTIME_CAPABILITIES };
  },

  async cancel(handle): Promise<HarnessOperationResult> {
    try {
      const sandbox = await runtimeSandbox(handle);
      const snapshot = await requestRuntimeEnvironment<RuntimeThreadSnapshot>(
        sandbox,
        {
          method: "GET",
          path: `/api/orchestration/threads/${encodeURIComponent(handle.sessionId)}`,
        },
        AbortSignal.timeout(RUNTIME_CONTROL_TIMEOUT_MS),
      );
      await requestRuntimeEnvironment(
        sandbox,
        {
          method: "POST",
          path: "/api/orchestration/dispatch",
          payload: buildRuntimeTurnInterruptCommand(
            handle.sessionId,
            snapshot.thread.latestTurn?.turnId,
          ),
        },
        AbortSignal.timeout(RUNTIME_CONTROL_TIMEOUT_MS),
      );
      return { status: "ok" };
    } catch (error) {
      return {
        status: "error",
        code: "t3_cancel_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async reconcile(handle): Promise<HarnessReconciliation> {
    try {
      const sandbox = await runtimeSandbox(handle);
      const snapshot = await requestRuntimeEnvironment<RuntimeThreadSnapshot>(
        sandbox,
        {
          method: "GET",
          path: `/api/orchestration/threads/${encodeURIComponent(handle.sessionId)}`,
        },
        AbortSignal.timeout(RUNTIME_CONTROL_TIMEOUT_MS),
      );
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
};

function routeRuntimeHarnessForSession(
  legacy: HarnessAdapter,
  handle?: Pick<HarnessSessionHandle, "sessionId">,
): HarnessAdapter {
  return handle && isRuntimeThreadSessionId(handle.sessionId) ? runtimeHarness : legacy;
}

export function routeRuntimeHarness(legacy: HarnessAdapter): HarnessAdapter {
  return {
    provider: legacy.provider,
    capabilities: (handle) => routeRuntimeHarnessForSession(legacy, handle).capabilities(handle),
    cancel: (handle, reason) =>
      routeRuntimeHarnessForSession(legacy, handle).cancel(handle, reason),
    reconcile: (handle, checkpoint) =>
      routeRuntimeHarnessForSession(legacy, handle).reconcile(handle, checkpoint),
  };
}
