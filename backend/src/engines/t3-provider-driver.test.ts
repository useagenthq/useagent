import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity, validateProviderDriver } from "@useagent/agent-harness/control";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  RuntimeEnvironmentRequestError,
  type RuntimeEnvironmentRequest,
  type requestRuntimeEnvironment,
} from "./runtime-environment-client";
import { makeT3ProviderDriver, t3ProviderDrivers } from "./t3-provider-driver";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { RUNTIME_GENERATION } from "./runtime-environment";
import { createSecretRedactor } from "../secrets/redact";

function sessionFor(driver: ReturnType<typeof makeT3ProviderDriver>): HarnessSession {
  return {
    provider: driver.provider,
    nativeSessionId: "skynet-thread-thread-1",
    runtime: { kind: "sandbox", id: "cube-t3-resume" },
    protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
    capabilities: driver.descriptor.capabilities,
    generation: driver.descriptor.sessionGeneration as number,
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
        version: RUNTIME_GENERATION,
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
      message: "The provider runtime start requires workspaceRoot, runtimeMode, and createdAt metadata",
    });
  });

  test("classifies only a missing native T3 thread as session_invalid", async () => {
    const missingByStatus = driverRejectingResume(
      new RuntimeEnvironmentRequestError("T3 environment GET request failed (HTTP 404)", {
        status: 404,
      }),
    );
    const missingByResponse = driverRejectingResume(
      new RuntimeEnvironmentRequestError("T3 environment GET request failed", {
        response: {
          code: "not_found",
          reason: "thread_not_found",
          traceId: "trace-missing-thread",
        },
      }),
    );
    const providerFailure = driverRejectingResume(
      new RuntimeEnvironmentRequestError("T3 environment GET request failed (HTTP 503)", {
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
        protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
        capabilities: driver.descriptor.capabilities,
        generation: driver.descriptor.sessionGeneration as number,
      },
      input: { kind: "approval", approvalId: "approval-1", decision: "accept" },
    })).resolves.toEqual({
      status: "unsupported_capability",
      provider: "opencode",
      capability: "steer",
      message: "The provider runtime currently accepts prompt steering through this seam",
    });
  });

  test("a fresh provider lifecycle can adopt an already-projected runtime thread", async () => {
    const requests: RuntimeEnvironmentRequest[] = [];
    const requestEnvironment: typeof requestRuntimeEnvironment = async <T>(
      _sandbox: SandboxHandle,
      request: RuntimeEnvironmentRequest,
    ): Promise<T> => {
      requests.push(request);
      return {
        projects: [{ id: "skynet-project-thread-1" }],
        threads: [{ id: "skynet-thread-thread-1" }],
      } as T;
    };
    const driver = makeT3ProviderDriver("opencode", {
      resolveRuntime: async () => ({ id: "cube-t3-resume" }) as SandboxHandle,
      requestEnvironment,
    });

    await expect(driver.start({
      runId: "run-1",
      threadId: "thread-1",
      runtime: { kind: "sandbox", id: "cube-t3-resume" },
      model: "openai/gpt-5.6-luna",
      metadata: {
        workspaceRoot: "/root/work",
        runtimeMode: "full-access",
        createdAt: "2026-08-22T00:00:00.000Z",
      },
    })).resolves.toMatchObject({
      status: "ok",
      value: { nativeSessionId: "skynet-thread-thread-1" },
    });
    expect(requests).toEqual([{ method: "GET", path: "/api/orchestration/shell" }]);
  });

  test("owns native cancel and recovery through the same driver session", async () => {
    const snapshot: RuntimeThreadSnapshot = {
      snapshotSequence: 8,
      thread: {
        id: "skynet-thread-thread-1",
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          requestedAt: "2026-09-05T00:00:00.000Z",
          assistantMessageId: "assistant-1",
        },
        messages: [
          {
            id: "skynet-message-run-1",
            role: "user",
            text: "Current request",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-05T00:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            text: "Recovered summary",
            turnId: "turn-1",
            streaming: false,
          },
        ],
        activities: [],
        session: { status: "ready", lastError: null },
      },
    };
    const requests: RuntimeEnvironmentRequest[] = [];
    const requestEnvironment: typeof requestRuntimeEnvironment = async <T>(
      _sandbox: SandboxHandle,
      request: RuntimeEnvironmentRequest,
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
    await expect(driver.reconcile({
      session,
      checkpoint: {
        sinceMs: 10,
        eventContext: {
          runId: "run-1",
          threadId: "thread-1",
          redact: createSecretRedactor([]),
        },
      },
    })).resolves.toEqual({
      status: "completed",
      summary: "Recovered summary",
      events: [],
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

  test("reconciles only the latest turn through the live activity mapper", async () => {
    const secret = "sk-recovery-secret-1234567890";
    const snapshot: RuntimeThreadSnapshot = {
      snapshotSequence: 9,
      thread: {
        id: "skynet-thread-thread-1",
        latestTurn: {
          turnId: "turn-2",
          state: "completed",
          requestedAt: "2026-09-05T00:01:00.000Z",
          assistantMessageId: "assistant-2",
        },
        messages: [
          {
            id: "skynet-message-run-2",
            role: "user",
            text: "Current request",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-05T00:01:00.000Z",
          },
          {
            id: "assistant-2",
            role: "assistant",
            text: `Recovered with tail activity ${secret}`,
            turnId: "turn-2",
            streaming: false,
          },
        ],
        activities: [
          {
            id: "prior-tool",
            tone: "tool",
            kind: "tool.completed",
            summary: "Prior turn tool",
            payload: { toolCallId: "prior-call" },
            turnId: "turn-1",
          },
          {
            id: "child-terminal",
            tone: "tool",
            kind: "task.completed",
            summary: "Child complete",
            payload: {
              agentKind: "agent",
              taskId: "child-session-1",
              parentAgentId: "parent-session-1",
              status: "completed",
              summary: `safe ${secret}`,
            },
            turnId: "turn-2",
          },
        ],
        session: { status: "ready", lastError: null },
      },
    };
    const driver = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => ({ id: "cube-t3-resume" }) as SandboxHandle,
      requestEnvironment: async <T>() => snapshot as T,
    });
    const session = sessionFor(driver);
    const request = {
      session,
      checkpoint: {
        sinceMs: 10,
        eventContext: {
          runId: "run-2",
          threadId: "thread-1",
          redact: createSecretRedactor([secret]),
        },
      },
    };
    if (!driver.reconcile) throw new Error("T3 driver must own recovery");

    const first = await driver.reconcile(request);
    const second = await driver.reconcile(request);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: "completed",
      summary: "Recovered with tail activity <redacted>",
      events: [{
        id: "pe_run-2_t3_child-terminal",
        runScopedId: true,
        provider: "t3",
        eventType: "t3.activity.task.completed",
        sessionId: "child-session-1",
        parentSessionId: "parent-session-1",
        partId: "child-terminal",
        callId: "child-session-1",
      }],
    });
    expect(JSON.stringify(first)).not.toContain("prior-tool");
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(JSON.stringify(first)).toContain("<redacted>");
  });

  test("a running latest turn exposes its current mapped activities", async () => {
    const snapshot: RuntimeThreadSnapshot = {
      snapshotSequence: 3,
      thread: {
        id: "skynet-thread-thread-1",
        latestTurn: {
          turnId: "turn-live",
          state: "running",
          requestedAt: "2026-09-05T00:02:00.000Z",
          assistantMessageId: null,
        },
        messages: [{
          id: "skynet-message-run-live",
          role: "user",
          text: "Current request",
          turnId: "turn-live",
          streaming: false,
          createdAt: "2026-09-05T00:02:00.000Z",
        }],
        activities: [{
          id: "tool-live",
          tone: "tool",
          kind: "tool.started",
          summary: "Running tool",
          payload: { toolCallId: "call-live", tool: "bash" },
          turnId: "turn-live",
        }],
        session: { status: "busy", lastError: null },
      },
    };
    const driver = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => ({ id: "cube-t3-resume" }) as SandboxHandle,
      requestEnvironment: async <T>() => snapshot as T,
    });
    if (!driver.reconcile) throw new Error("T3 driver must own recovery");
    await expect(driver.reconcile({
      session: sessionFor(driver),
      checkpoint: {
        eventContext: {
          runId: "run-live",
          threadId: "thread-live",
          redact: createSecretRedactor([]),
        },
      },
    })).resolves.toMatchObject({
      status: "in_progress",
      events: [{
        id: "pe_run-live_t3_tool-live",
        callId: "call-live",
      }],
    });
  });

  test("does not adopt a previous completed turn before the current run was dispatched", async () => {
    const snapshot: RuntimeThreadSnapshot = {
      snapshotSequence: 4,
      thread: {
        id: "skynet-thread-thread-1",
        latestTurn: {
          turnId: "turn-previous",
          state: "completed",
          requestedAt: "2026-09-05T00:00:00.000Z",
          assistantMessageId: "assistant-previous",
        },
        messages: [
          {
            id: "skynet-message-previous-run",
            role: "user",
            text: "Previous request",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-05T00:00:00.000Z",
          },
          {
            id: "assistant-previous",
            role: "assistant",
            text: "Previous answer",
            turnId: "turn-previous",
            streaming: false,
          },
        ],
        activities: [],
        session: { status: "ready", lastError: null },
      },
    };
    const driver = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => ({ id: "cube-t3-resume" }) as SandboxHandle,
      requestEnvironment: async <T>() => snapshot as T,
    });
    if (!driver.reconcile) throw new Error("T3 driver must own recovery");

    await expect(driver.reconcile({
      session: sessionFor(driver),
      checkpoint: {
        eventContext: {
          runId: "new-run",
          threadId: "thread-1",
          redact: createSecretRedactor([]),
        },
      },
    })).resolves.toEqual({ status: "no_change" });
  });

  test("returns redacted error and interruption reasons with their terminal events", async () => {
    const secret = "sk-failed-turn-secret-1234567890";
    for (const state of ["error", "interrupted"] as const) {
      const runId = `run-${state}`;
      const turnId = `turn-${state}`;
      const at = `2026-09-05T00:0${state === "error" ? "3" : "4"}:00.000Z`;
      const snapshot: RuntimeThreadSnapshot = {
        snapshotSequence: 5,
        thread: {
          id: "skynet-thread-thread-1",
          latestTurn: { turnId, state, requestedAt: at, assistantMessageId: null },
          messages: [{
            id: `skynet-message-${runId}`,
            role: "user",
            text: "Current request",
            turnId: null,
            streaming: false,
            createdAt: at,
          }],
          activities: [{
            id: `terminal-${state}`,
            tone: "error",
            kind: "runtime.warning",
            summary: `${state} activity`,
            payload: { detail: secret },
            turnId,
          }],
          session: { status: state, lastError: `Provider ${state}: ${secret}` },
        },
      };
      const driver = makeT3ProviderDriver("codex", {
        resolveRuntime: async () => ({ id: "cube-t3-resume" }) as SandboxHandle,
        requestEnvironment: async <T>() => snapshot as T,
      });
      if (!driver.reconcile) throw new Error("T3 driver must own recovery");
      const result = await driver.reconcile({
        session: sessionFor(driver),
        checkpoint: {
          eventContext: {
            runId,
            threadId: "thread-1",
            redact: createSecretRedactor([secret]),
          },
        },
      });

      expect(result).toMatchObject({
        status: "failed",
        summary: `Provider ${state}: <redacted>`,
        events: [{ id: `pe_${runId}_t3_terminal-${state}` }],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
