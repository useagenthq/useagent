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
import { requestT3Environment } from "./t3-environment-client";
import {
  assistantText,
  buildT3TurnInterruptCommand,
  isT3ThreadSessionId,
  type T3ThreadSnapshot,
} from "./t3-orchestration";

const T3_CONTROL_TIMEOUT_MS = 10_000;

const T3_CAPABILITIES: HarnessCapabilities = {
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

async function t3Sandbox(handle: HarnessSessionHandle) {
  if (!isT3ThreadSessionId(handle.sessionId)) {
    throw new Error("session is not a T3 thread");
  }
  return await sandboxProvider(sandboxProviderApiKey()).get(handle.sandboxId);
}

export const t3Harness: HarnessAdapter = {
  provider: "t3",

  capabilities(): HarnessCapabilities {
    return { ...T3_CAPABILITIES };
  },

  async cancel(handle): Promise<HarnessOperationResult> {
    try {
      const sandbox = await t3Sandbox(handle);
      const snapshot = await requestT3Environment<T3ThreadSnapshot>(
        sandbox,
        {
          method: "GET",
          path: `/api/orchestration/threads/${encodeURIComponent(handle.sessionId)}`,
        },
        AbortSignal.timeout(T3_CONTROL_TIMEOUT_MS),
      );
      await requestT3Environment(
        sandbox,
        {
          method: "POST",
          path: "/api/orchestration/dispatch",
          payload: buildT3TurnInterruptCommand(
            handle.sessionId,
            snapshot.thread.latestTurn?.turnId,
          ),
        },
        AbortSignal.timeout(T3_CONTROL_TIMEOUT_MS),
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
      const sandbox = await t3Sandbox(handle);
      const snapshot = await requestT3Environment<T3ThreadSnapshot>(
        sandbox,
        {
          method: "GET",
          path: `/api/orchestration/threads/${encodeURIComponent(handle.sessionId)}`,
        },
        AbortSignal.timeout(T3_CONTROL_TIMEOUT_MS),
      );
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
};

function routeT3HarnessForSession(
  legacy: HarnessAdapter,
  handle?: Pick<HarnessSessionHandle, "sessionId">,
): HarnessAdapter {
  return handle && isT3ThreadSessionId(handle.sessionId) ? t3Harness : legacy;
}

export function routeT3Harness(legacy: HarnessAdapter): HarnessAdapter {
  return {
    provider: legacy.provider,
    capabilities: (handle) => routeT3HarnessForSession(legacy, handle).capabilities(handle),
    cancel: (handle, reason) =>
      routeT3HarnessForSession(legacy, handle).cancel(handle, reason),
    reconcile: (handle, checkpoint) =>
      routeT3HarnessForSession(legacy, handle).reconcile(handle, checkpoint),
  };
}
