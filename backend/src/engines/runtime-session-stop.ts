import { awaitRuntimeOperation } from "./runtime-operation";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import type { SandboxHandle } from "../sandboxes/provider";
import { setTimeout as delay } from "node:timers/promises";

const RUNTIME_POLL_INTERVAL_MS = 125;
const OPENCODE_CONFIG_RELOAD_DEADLINE_MS = 10_000;

function stableId(prefix: string, value: string): string {
  return `${prefix}-${value}`.replace(/[^a-zA-Z0-9._~-]/g, "-");
}

export function buildRuntimeSessionStopCommand(
  threadId: string,
  createdAt = new Date().toISOString(),
  revision: string = crypto.randomUUID(),
): Readonly<Record<string, unknown>> {
  return {
    type: "thread.session.stop",
    commandId: stableId("skynet-session-stop", `${revision}-${threadId}`),
    threadId,
    onlyIfSettled: true,
    createdAt,
  };
}

export interface OpenCodeSessionReloadDependencies {
  readonly requestEnvironment: typeof requestRuntimeEnvironment;
  readonly wait: (signal: AbortSignal) => Promise<void>;
}

const openCodeSessionReloadDependencies: OpenCodeSessionReloadDependencies = {
  requestEnvironment: requestRuntimeEnvironment,
  async wait(signal) {
    await delay(RUNTIME_POLL_INTERVAL_MS, undefined, { signal });
  },
};

const awaitReloadOperation = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  awaitRuntimeOperation(operation, signal, async () => {});

const OPENCODE_RELOAD_SESSION_STATUSES = new Set([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);

function reloadThreadState(
  value: unknown,
  expectedThreadId: string,
): { readonly latestTurnRunning: boolean; readonly sessionStatus: string | null } {
  const isoDate = (candidate: unknown): boolean =>
    typeof candidate === "string" && Number.isFinite(Date.parse(candidate));
  const nullableIsoDate = (candidate: unknown): boolean => candidate === null || isoDate(candidate);
  const nullableTrimmedString = (candidate: unknown): boolean =>
    candidate === null || (typeof candidate === "string" && candidate.trim().length > 0);
  if (!value || typeof value !== "object") {
    throw new Error("OpenCode retained thread snapshot is malformed");
  }
  const thread = (value as { thread?: unknown }).thread;
  if (
    !thread ||
    typeof thread !== "object" ||
    (thread as { id?: unknown }).id !== expectedThreadId ||
    !Object.hasOwn(thread, "latestTurn") ||
    !Object.hasOwn(thread, "session")
  ) {
    throw new Error("OpenCode retained thread snapshot is malformed");
  }
  const latestTurn = (thread as { latestTurn: unknown }).latestTurn;
  if (
    latestTurn !== null &&
    (!latestTurn ||
      typeof latestTurn !== "object" ||
      typeof (latestTurn as { turnId?: unknown }).turnId !== "string" ||
      (latestTurn as { turnId: string }).turnId.trim().length === 0 ||
      !["running", "completed", "interrupted", "error"].includes(
        String((latestTurn as { state?: unknown }).state),
      ) ||
      !isoDate((latestTurn as { requestedAt?: unknown }).requestedAt) ||
      !nullableIsoDate((latestTurn as { startedAt?: unknown }).startedAt) ||
      !nullableIsoDate((latestTurn as { completedAt?: unknown }).completedAt) ||
      !nullableTrimmedString((latestTurn as { assistantMessageId?: unknown }).assistantMessageId))
  ) {
    throw new Error("OpenCode retained thread snapshot is malformed");
  }
  const session = (thread as { session: unknown }).session;
  if (session === null) {
    return {
      latestTurnRunning: latestTurn !== null &&
        (latestTurn as { state: string }).state === "running",
      sessionStatus: null,
    };
  }
  if (!session || typeof session !== "object") {
    throw new Error("OpenCode retained session snapshot is malformed");
  }
  const record = session as Record<string, unknown>;
  if (
    record.threadId !== expectedThreadId ||
    typeof record.status !== "string" ||
    !OPENCODE_RELOAD_SESSION_STATUSES.has(record.status) ||
    !nullableTrimmedString(record.providerName) ||
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
      String(record.runtimeMode),
    ) ||
    !nullableTrimmedString(record.activeTurnId) ||
    !nullableTrimmedString(record.lastError) ||
    !isoDate(record.updatedAt)
  ) {
    throw new Error("OpenCode retained session snapshot is malformed");
  }
  return {
    latestTurnRunning: latestTurn !== null &&
      (latestTurn as { state: string }).state === "running",
    sessionStatus: record.status,
  };
}

export async function reloadRetainedOpenCodeSession(input: {
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly threadExists: boolean;
  readonly modelLimitsChanged: boolean;
  readonly modelLimitsRevision?: string | null;
  readonly modelLimitsChangedAt?: string | null;
  readonly deadlineMs?: number;
  readonly dependencies?: OpenCodeSessionReloadDependencies;
}): Promise<void> {
  if (!input.threadExists || !input.modelLimitsChanged) return;
  if (!input.modelLimitsRevision || !input.modelLimitsChangedAt) {
    throw new Error("OpenCode model-limit refresh command state is missing");
  }

  const dependencies = input.dependencies ?? openCodeSessionReloadDependencies;
  const deadline = AbortSignal.timeout(input.deadlineMs ?? OPENCODE_CONFIG_RELOAD_DEADLINE_MS);
  const signal = AbortSignal.any([input.signal, deadline]);
  const readThread = async () => reloadThreadState(await awaitReloadOperation(
    dependencies.requestEnvironment<unknown>(
      input.sandbox,
      {
        method: "GET",
        path: `/api/orchestration/threads/${encodeURIComponent(input.threadId)}`,
      },
      signal,
    ),
    signal,
  ), input.threadId);

  try {
    let state = await readThread();
    if (state.latestTurnRunning) {
      throw new Error("OpenCode model limits changed while the retained native turn is running");
    }
    if (state.sessionStatus === "running" || state.sessionStatus === "starting") {
      throw new Error(`OpenCode model limits changed while the retained session is ${state.sessionStatus}`);
    }
    if (state.sessionStatus === null || state.sessionStatus === "stopped") return;

    try {
      await awaitReloadOperation(
        dependencies.requestEnvironment(
          input.sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildRuntimeSessionStopCommand(
              input.threadId,
              input.modelLimitsChangedAt,
              input.modelLimitsRevision,
            ),
          },
          signal,
        ),
        signal,
      );
    } catch (error) {
      input.signal.throwIfAborted();
      deadline.throwIfAborted();
      state = await readThread();
      if (state.latestTurnRunning || state.sessionStatus === "running" || state.sessionStatus === "starting") {
        throw new Error("OpenCode retained session reactivated before the conditional stop");
      }
      if (state.sessionStatus !== "stopped") throw error;
    }
    while (state.sessionStatus !== "stopped") {
      await awaitReloadOperation(dependencies.wait(signal), signal);
      state = await readThread();
      if (state.latestTurnRunning || state.sessionStatus === "running" || state.sessionStatus === "starting") {
        throw new Error("OpenCode retained session became active while waiting for stop");
      }
      if (state.sessionStatus === null) {
        throw new Error("OpenCode retained session disappeared before stop was confirmed");
      }
    }
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (deadline.aborted) {
      throw new Error("Timed out waiting for the retained OpenCode session to stop");
    }
    throw error;
  }
}
