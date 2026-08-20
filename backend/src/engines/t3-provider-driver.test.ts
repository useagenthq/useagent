import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@skynet/agent-harness/canonical";
import { validateProviderDriver } from "@skynet/agent-harness/control";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  T3EnvironmentRequestError,
  type T3EnvironmentRequest,
  type requestT3Environment,
} from "./runtime-environment-client";
import { makeT3ProviderDriver, t3ProviderDrivers } from "./t3-provider-driver";
import type { T3ThreadSnapshot } from "./runtime-orchestration";

function sessionFor(driver: ReturnType<typeof makeT3ProviderDriver>): HarnessSession {
  return {
    provider: driver.provider,
    nativeSessionId: "skynet-thread-thread-1",
    runtime: { kind: "sandbox", id: "cube-t3-resume" },
    protocolVersion: driver.descriptor.protocol.name,
    capabilities: driver.descriptor.capabilities,
    generation: 2,
  };
}

function driverRejectingResume(error: Error) {
  return makeT3ProviderDriver("codex", {
    resolveRuntime: async () => ({ id: "cube-t3-resume" }) as SandboxHandle,
    requestEnvironment: async () => {
      throw error;
    },
  });
}

describe("T3 provider drivers", () => {
  test("registers one valid native lifecycle driver per T3 engine", () => {
    for (const provider of ["codex", "claude", "opencode"] as const) {
      const driver = t3ProviderDrivers[provider];
      expect(validateProviderDriver(driver)).toEqual({ status: "ok" });
      expect(driver.provider).toBe(provider);
      expect(driver.descriptor.protocol).toEqual({
        name: "t3-orchestration",
        version: "t3-v3",
      });
    }
  });

  test("classifies missing start metadata before resolving a runtime", async () => {
    await expect(t3ProviderDrivers.codex.start({
      runId: "run-1",
      threadId: "thread-1",
      runtime: { kind: "managed", id: "managed-1" },
    })).resolves.toEqual({
      status: "error",
      code: "invalid_start_metadata",
      message: "T3 start requires workspaceRoot, runtimeMode, and createdAt metadata",
    });
  });

  test("classifies only a missing native T3 thread as session_invalid", async () => {
    const missingByStatus = driverRejectingResume(
      new T3EnvironmentRequestError("T3 environment GET request failed (HTTP 404)", {
        status: 404,
      }),
    );
    const missingByResponse = driverRejectingResume(
      new T3EnvironmentRequestError("T3 environment GET request failed", {
        response: {
          code: "not_found",
          reason: "thread_not_found",
          traceId: "trace-missing-thread",
        },
      }),
    );
    const providerFailure = driverRejectingResume(
      new T3EnvironmentRequestError("T3 environment GET request failed (HTTP 503)", {
        status: 503,
      }),
    );
    const networkFailure = driverRejectingResume(new Error("T3 transport unavailable"));

    await expect(missingByStatus.resume({ session: sessionFor(missingByStatus) })).resolves
      .toMatchObject({ status: "error", code: "session_invalid" });
    await expect(missingByResponse.resume({ session: sessionFor(missingByResponse) })).resolves
      .toMatchObject({ status: "error", code: "session_invalid" });
    await expect(providerFailure.resume({ session: sessionFor(providerFailure) })).resolves.toEqual({
      status: "error",
      code: "session_resume_failed",
      message: "T3 environment GET request failed (HTTP 503)",
    });
    await expect(networkFailure.resume({ session: sessionFor(networkFailure) })).resolves.toEqual({
      status: "error",
      code: "session_resume_failed",
      message: "T3 transport unavailable",
    });
  });

  test("returns typed unsupported results for non-prompt steering", async () => {
    const driver = t3ProviderDrivers.opencode;
    await expect(driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session: {
        provider: driver.provider,
        nativeSessionId: "skynet-thread-thread-1",
        runtime: { kind: "managed", id: "managed-1" },
        protocolVersion: driver.descriptor.protocol.name,
        capabilities: driver.descriptor.capabilities,
        generation: 2,
      },
      input: { kind: "approval", approvalId: "approval-1", decision: "accept" },
    })).resolves.toEqual({
      status: "unsupported_capability",
      provider: "opencode",
      capability: "steer",
      message: "T3 production turns currently accept prompt steering through this seam",
    });
  });

  test("owns native cancel and recovery through the same driver session", async () => {
    const snapshot: T3ThreadSnapshot = {
      snapshotSequence: 8,
      thread: {
        id: "skynet-thread-thread-1",
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          assistantMessageId: "assistant-1",
        },
        messages: [{
          id: "assistant-1",
          role: "assistant",
          text: "Recovered summary",
          turnId: "turn-1",
          streaming: false,
        }],
        activities: [],
        session: { status: "ready", lastError: null },
      },
    };
    const requests: T3EnvironmentRequest[] = [];
    const requestEnvironment: typeof requestT3Environment = async <T>(
      _sandbox: SandboxHandle,
      request: T3EnvironmentRequest,
    ): Promise<T> => {
      requests.push(request);
      return snapshot as unknown as T;
    };
    const driver = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => ({ id: "cube-t3-resume" }) as SandboxHandle,
      requestEnvironment,
    });
    const session = sessionFor(driver);

    await expect(driver.cancel(session, "user stop")).resolves.toEqual({ status: "ok" });
    expect(driver.reconcile).toBeFunction();
    if (!driver.reconcile) throw new Error("T3 driver must own recovery");
    await expect(driver.reconcile({ session, checkpoint: { sinceMs: 10 } })).resolves.toEqual({
      status: "completed",
      summary: "Recovered summary",
    });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/api/orchestration/threads/skynet-thread-thread-1" },
      { method: "POST", path: "/api/orchestration/dispatch" },
      { method: "GET", path: "/api/orchestration/threads/skynet-thread-thread-1" },
    ]);
    expect(requests[1]?.payload).toMatchObject({
      type: "thread.turn.interrupt",
      threadId: "skynet-thread-thread-1",
      turnId: "turn-1",
    });
  });
});
