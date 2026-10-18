// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity, validateProviderDriver } from "@useagent/agent-harness/control";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  RuntimeEnvironmentRequestError,
  type RuntimeEnvironmentRequest,
} from "./runtime-environment-client";
import {
  makeT3ProviderDriver,
  T3_SESSION_GENERATION,
  t3ProviderDrivers,
} from "./t3-provider-driver";
import { RUNTIME_GENERATION } from "./runtime-environment";
import { createSecretRedactor } from "../secrets/redact";
import { PersonalSandboxConnectionUnavailableError } from "../sandboxes/binding";
import {
  forgetLiveThreadSandbox,
  getLiveSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "./sandbox-runtime";
import { RuntimeRpcError, type RuntimeCommand, type V2ThreadSnapshot } from "./runtime-v2-wire";
import {
  at, v2Item, v2Message, v2Projection, v2ProviderThread, v2Run, v2Session, v2Snapshot,
} from "./runtime-v2.test-support";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

type Dependencies = Parameters<typeof makeT3ProviderDriver>[1];

const THREAD = `${SANDBOX_NAME_PREFIX}-thread-thread-1`;
const SANDBOX = { id: "cube-t3-resume" } as SandboxHandle;
const unreachable = async (): Promise<never> => { throw new Error("unreachable"); };

function sessionFor(driver: ReturnType<typeof makeT3ProviderDriver>): HarnessSession {
  return {
    provider: driver.provider,
    nativeSessionId: THREAD,
    runtime: { kind: "sandbox", id: "cube-t3-resume" },
    protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
    capabilities: driver.descriptor.capabilities,
    generation: driver.descriptor.sessionGeneration as number,
  };
}

/** A runtime that answers thread reads with `thread`, the shell with `shell`, and records every command. */
function runtime(thread: V2ThreadSnapshot | (() => V2ThreadSnapshot), shell = { projects: [], threads: [] }) {
  const requests: RuntimeEnvironmentRequest[] = [];
  const commands: RuntimeCommand[] = [];
  const dependencies: Dependencies = {
    resolveRuntime: async () => SANDBOX,
    requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest): Promise<T> => {
      requests.push(request);
      if (request.path === "/api/orchestration/shell") return shell as T;
      if (request.method === "POST") return {} as T;
      return (typeof thread === "function" ? thread() : thread) as T;
    },
    dispatch: async (_sandbox, command) => {
      commands.push(command);
      return { sequence: commands.length };
    },
  };
  return { dependencies, requests, commands };
}

function driverRejectingResume(error: Error) {
  return makeT3ProviderDriver("codex", {
    resolveRuntime: async () => SANDBOX,
    requestEnvironment: async () => { throw error; },
    dispatch: unreachable,
  });
}

function reconcile(driver: ReturnType<typeof makeT3ProviderDriver>, runId: string, secrets: string[] = [], nativeCommand?: object) {
  if (!driver.reconcile) throw new Error("T3 driver must own recovery");
  return driver.reconcile({
    session: sessionFor(driver),
    checkpoint: {
      sinceMs: 10,
      eventContext: {
        runId,
        threadId: "thread-1",
        redact: createSecretRedactor(secrets),
        ...(nativeCommand ? { nativeCommand } : {}),
      } as never,
    },
  });
}

const expectedSandbox = {
  version: 1 as const,
  sandboxId: "cube-t3-resume",
  provider: "cube" as const,
  credential: "env" as const,
  ownerOrgId: "org-1",
  ownerUserId: null,
  credentialGeneration: "b".repeat(64),
};

/** One finished plane run and its answer. */
function answered(runId: string, text: string, extra: Partial<Parameters<typeof v2Projection>[0]> = {}) {
  return v2Snapshot(8, v2Projection({
    runs: [v2Run({ id: `run-of-${runId}`, userMessageId: `${SANDBOX_NAME_PREFIX}-message-${runId}` })],
    messages: [
      v2Message({ id: `${SANDBOX_NAME_PREFIX}-message-${runId}`, role: "user", runId: `run-of-${runId}`, text: "Current request" }),
      v2Message({ id: `assistant-${runId}`, runId: `run-of-${runId}`, text, createdAt: at(1) }),
    ],
    providerSessions: [v2Session()],
    providerThreads: [v2ProviderThread()],
    ...extra,
  }));
}

describe("T3 provider drivers", () => {
  test("re-resolves the accepted sandbox before every native lifecycle operation", async () => {
    const resolutions: unknown[][] = [];
    const { dependencies } = runtime(v2Snapshot(1), {
      projects: [{ id: `${SANDBOX_NAME_PREFIX}-project-thread-1` }],
      threads: [{ id: THREAD }],
    } as never);
    const driver = makeT3ProviderDriver("codex", {
      ...dependencies,
      resolveRuntime: async (...args) => {
        resolutions.push(args);
        return SANDBOX;
      },
    });
    const control = { expectedSandbox, threadId: "thread-1" };
    const current = sessionFor(driver);

    await driver.start({
      runId: "run-1",
      threadId: "thread-1",
      runtime: current.runtime,
      metadata: { workspaceRoot: "/root/work", runtimeMode: "full-access", createdAt: "2026-09-07T00:00:00.000Z", ...control },
    });
    await driver.resume({ session: current, metadata: control });
    await driver.steer({
      runId: "run-1", threadId: "thread-1", session: current,
      input: { kind: "prompt", text: "continue" }, metadata: control,
    });
    await driver.reconcile?.({
      session: current,
      metadata: control,
      checkpoint: { metadata: control, eventContext: { runId: "run-1", threadId: "thread-1", redact: createSecretRedactor([]) } },
    });
    await driver.cancel(current, "stop", control);

    expect(resolutions).toHaveLength(5);
    for (const [runtimeArg, expected, threadId] of resolutions) {
      expect(runtimeArg).toEqual(current.runtime);
      expect(expected).toEqual(expectedSandbox);
      expect(threadId).toBe("thread-1");
    }
  });

  test("rejects a runtime id mismatch before sandbox resolution", async () => {
    let resolutions = 0;
    const driver = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => {
        resolutions += 1;
        return null;
      },
      requestEnvironment: unreachable,
      dispatch: unreachable,
    });
    await expect(driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session: { ...sessionFor(driver), runtime: { kind: "sandbox", id: "other-sandbox" } },
      input: { kind: "prompt", text: "must not dispatch" },
      metadata: { expectedSandbox, threadId: "thread-1" },
    })).resolves.toMatchObject({
      status: "error",
      code: "expected_sandbox_mismatch",
      message: "The accepted sandbox binding is no longer available; no replacement was created.",
    });
    expect(resolutions).toBe(0);
  });

  test("registers one valid native lifecycle driver per T3 engine", () => {
    for (const provider of ["codex", "claude", "opencode"] as const) {
      const driver = t3ProviderDrivers[provider];
      expect(validateProviderDriver(driver)).toEqual({ status: "ok" });
      expect(driver.provider).toBe(provider);
      expect(driver.descriptor.protocol).toEqual({ name: "t3-orchestration", version: RUNTIME_GENERATION });
    }
  });

  test("a session bound before protocol 2 is stale", () => {
    expect(T3_SESSION_GENERATION).toBe(4);
    expect(RUNTIME_GENERATION).toBe("useagent-runtime-v9");
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

  test("preserves safe personal-connection failures without exposing unknown resolution errors", async () => {
    const request = {
      runId: "run-1",
      threadId: "thread-1",
      runtime: { kind: "sandbox" as const, id: "personal-sandbox" },
      metadata: { workspaceRoot: "/home/user/work", runtimeMode: "full-access", createdAt: "2026-09-05T00:00:00.000Z" },
    };
    const revoked = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => {
        throw new PersonalSandboxConnectionUnavailableError("the box connection that created this sandbox has been revoked");
      },
      requestEnvironment: unreachable,
      dispatch: unreachable,
    });
    await expect(revoked.start(request)).resolves.toEqual({
      status: "error",
      code: "session_create_failed",
      message: "the box connection that created this sandbox has been revoked",
    });

    const secret = "Bearer secret-request-header";
    const unknown = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => { throw new Error(secret); },
      requestEnvironment: unreachable,
      dispatch: unreachable,
    });
    const unknownResult = await unknown.start(request);
    expect(unknownResult).toEqual({
      status: "error",
      code: "session_create_failed",
      message: "The provider runtime sandbox could not be resolved",
    });
    expect(JSON.stringify(unknownResult)).not.toContain(secret);

    const absent = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => null,
      requestEnvironment: unreachable,
      dispatch: unreachable,
    });
    await expect(absent.start(request)).resolves.toEqual({
      status: "error",
      code: "runtime_unreachable",
      message: "The provider runtime sandbox is unreachable",
    });
  });

  test("rejects a stale session generation before resolving its sandbox", async () => {
    let resolutions = 0;
    const driver = makeT3ProviderDriver("codex", {
      resolveRuntime: async () => {
        resolutions += 1;
        return null;
      },
      requestEnvironment: unreachable,
      dispatch: unreachable,
    });
    const stale = { ...sessionFor(driver), generation: T3_SESSION_GENERATION - 1 };
    await expect(driver.resume({ session: stale })).resolves.toEqual({
      status: "error",
      code: "stale_session",
      message: "Provider runtime session protocol or generation is stale",
    });
    expect(resolutions).toBe(0);
  });

  test("classifies only a missing native T3 thread as session_invalid", async () => {
    const missingByStatus = driverRejectingResume(
      new RuntimeEnvironmentRequestError("T3 environment GET request failed (HTTP 404)", { status: 404 }),
    );
    const missingByResponse = driverRejectingResume(
      new RuntimeEnvironmentRequestError("T3 environment GET request failed", {
        response: { code: "not_found", reason: "thread_not_found", traceId: "trace-missing-thread" },
      }),
    );
    const providerFailure = driverRejectingResume(
      new RuntimeEnvironmentRequestError("T3 environment GET request failed (HTTP 503)", { status: 503 }),
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
        nativeSessionId: THREAD,
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
    const { dependencies, requests, commands } = runtime(v2Snapshot(1), {
      projects: [{ id: `${SANDBOX_NAME_PREFIX}-project-thread-1` }],
      threads: [{ id: THREAD }],
    } as never);
    const driver = makeT3ProviderDriver("opencode", dependencies);
    await expect(driver.start({
      runId: "run-1",
      threadId: "thread-1",
      runtime: { kind: "sandbox", id: "cube-t3-resume" },
      model: "openai/gpt-5.6-luna",
      metadata: { workspaceRoot: "/root/work", runtimeMode: "full-access", createdAt: "2026-08-22T00:00:00.000Z" },
    })).resolves.toMatchObject({ status: "ok", value: { nativeSessionId: THREAD } });
    expect(requests).toEqual([{ method: "GET", path: "/api/orchestration/shell" }]);
    expect(commands).toEqual([]);
  });

  test("a fresh session creates its project over HTTP and its thread over the socket, without polling", async () => {
    const { dependencies, requests, commands } = runtime(v2Snapshot(1));
    const driver = makeT3ProviderDriver("codex", dependencies);
    await expect(driver.start({
      runId: "run-1",
      threadId: "thread-1",
      runtime: { kind: "sandbox", id: "cube-t3-resume" },
      metadata: {
        workspaceRoot: "/root/work",
        runtimeMode: "approval-required",
        createdAt: "2026-10-02T00:00:00.000Z",
        shell: { projects: [], threads: [] },
      },
    })).resolves.toMatchObject({ status: "ok", value: { nativeSessionId: THREAD } });
    expect(requests.map((request) => [request.method, request.path, request.payload?.type])).toEqual([
      ["POST", "/api/projects/mutate", "project.create"],
    ]);
    expect(commands).toEqual([expect.objectContaining({
      type: "thread.create", threadId: THREAD, projectId: `${SANDBOX_NAME_PREFIX}-project-thread-1`, runtimeMode: "approval-required",
    })]);
  });

  test("steers with the run's own message over the socket", async () => {
    const { dependencies, commands } = runtime(v2Snapshot(1));
    const driver = makeT3ProviderDriver("claude", dependencies);
    await expect(driver.steer({
      runId: "run-9", threadId: "thread-1", session: sessionFor(driver),
      input: { kind: "prompt", text: "continue", model: "claude-opus-5", reasoningEffort: "max" },
    })).resolves.toEqual({ status: "ok" });
    expect(commands).toEqual([expect.objectContaining({
      type: "message.dispatch",
      commandId: `${SANDBOX_NAME_PREFIX}-turn-run-9`,
      messageId: `${SANDBOX_NAME_PREFIX}-message-run-9`,
      text: "continue",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5", options: [{ id: "effort", value: "max" }] },
    })]);
  });

  describe("a handle this process already verified", () => {
    const threadId = "thread-driver-reuse";
    const live = { id: "cube-t3-resume", providerKind: "cube" } as SandboxHandle;
    const fresh = { id: "cube-t3-resume", providerKind: "cube" } as SandboxHandle;

    function reusingDriver(failOnLive: Error) {
      const used: SandboxHandle[] = [];
      let resolutions = 0;
      const driver = makeT3ProviderDriver("codex", {
        // The real resolve hands back the live handle while this process holds one.
        resolveRuntime: async (runtimeArg) => {
          resolutions += 1;
          return getLiveSandbox(runtimeArg.id) ?? fresh;
        },
        requestEnvironment: unreachable,
        dispatch: async (sandbox) => {
          used.push(sandbox);
          if (sandbox === live) throw failOnLive;
          return { sequence: 1 };
        },
      });
      return { driver, used, resolutions: () => resolutions };
    }

    function steer(driver: ReturnType<typeof makeT3ProviderDriver>) {
      return driver.steer({ runId: "run-1", threadId: "thread-1", session: sessionFor(driver), input: { kind: "prompt", text: "continue" } });
    }

    test("is dropped when it fails before the runtime answers, and the dispatch runs once more on a full resolve", async () => {
      rememberLiveThreadSandbox(threadId, live);
      const { driver, used, resolutions } = reusingDriver(new Error("envd connection reset"));
      try {
        await expect(steer(driver)).resolves.toEqual({ status: "ok" });
        expect(used).toEqual([live, fresh]);
        expect(resolutions()).toBe(2);
        expect(getLiveThreadSandbox(threadId)).toBeNull();
      } finally {
        forgetLiveThreadSandbox(threadId);
      }
    });

    test("is kept and not retried when the runtime itself answered", async () => {
      rememberLiveThreadSandbox(threadId, live);
      const { driver, used, resolutions } = reusingDriver(
        new RuntimeRpcError("orchestration.dispatchCommand", "OrchestrationV2DispatchCommandError", "refused", undefined, []),
      );
      try {
        await expect(steer(driver)).resolves.toMatchObject({ status: "error", code: "steer_failed" });
        expect(used).toEqual([live]);
        expect(resolutions()).toBe(1);
        expect(getLiveThreadSandbox(threadId)).toBe(live);
      } finally {
        forgetLiveThreadSandbox(threadId);
      }
    });
  });

  test("cancel interrupts the run still going, and nothing on a settled thread", async () => {
    let state = v2Snapshot(3, v2Projection({ runs: [v2Run({ id: "r-live", status: "running", completedAt: null })] }));
    const { dependencies, requests, commands } = runtime(() => state);
    const driver = makeT3ProviderDriver("codex", dependencies);
    const session = sessionFor(driver);
    await expect(driver.cancel(session, "user stop")).resolves.toEqual({ status: "ok" });
    expect(commands).toEqual([expect.objectContaining({ type: "run.interrupt", threadId: THREAD, runId: "r-live" })]);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([`GET /api/orchestration/threads/${THREAD}/bounded`]);

    state = v2Snapshot(4, v2Projection({ runs: [v2Run({ id: "r-live", status: "completed" })] }));
    await expect(driver.cancel(session, "user stop")).resolves.toEqual({ status: "ok" });
    expect(commands).toHaveLength(1);
  });

  test("recovery answers a settled run with its message and answer", async () => {
    const { dependencies } = runtime(answered("run-1", "Recovered summary"));
    const driver = makeT3ProviderDriver("codex", dependencies);
    await expect(reconcile(driver, "run-1")).resolves.toEqual({
      status: "completed",
      summary: "Recovered summary",
      events: [
        expect.objectContaining({ eventType: "t3.message.started", messageId: "assistant-run-1", payload: { role: "assistant", turnId: "run-of-run-1" } }),
        expect.objectContaining({ eventType: "t3.message.updated", messageId: "assistant-run-1",
          payload: expect.objectContaining({ text: "Recovered summary", final: true, segmentCount: 1 }) }),
      ],
    });
  });

  test("restart recovery completes compact from its exact request", async () => {
    const thread = v2Snapshot(9, v2Projection({
      runs: [v2Run({ id: "prior", ordinal: 1 }), v2Run({ id: "compact", ordinal: 2, userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-compact`, status: "running", completedAt: null })],
      turnItems: [v2Item({ id: "compaction-1", type: "compaction", runId: "compact", status: "completed" })],
    }));
    const { dependencies } = runtime(thread);
    const driver = makeT3ProviderDriver("codex", dependencies);
    await expect(reconcile(driver, "run-compact", [], {
      name: "compact", provider: "codex", sessionId: THREAD, catalogRevision: 4,
    })).resolves.toMatchObject({
      status: "completed",
      summary: "Compacted",
      events: [{ id: "pe_run-compact_t3_compaction-1:compaction", eventType: "t3.activity.context-compaction", sessionId: THREAD }],
    });
  });

  test("restart recovery ignores unrelated compact completion", async () => {
    const thread = v2Snapshot(9, v2Projection({
      runs: [v2Run({ id: "other", userMessageId: `${SANDBOX_NAME_PREFIX}-message-other-run` })],
      turnItems: [v2Item({ id: "compaction-other", type: "compaction", runId: "other", status: "completed" })],
    }));
    const { dependencies } = runtime(thread);
    const driver = makeT3ProviderDriver("codex", dependencies);
    await expect(reconcile(driver, "run-compact", [], {
      name: "compact", provider: "codex", sessionId: THREAD, catalogRevision: 4,
    })).resolves.toEqual({ status: "in_progress" });
  });

  test("restart compact recovery fails with the compact run's own reason", async () => {
    const thread = v2Snapshot(9, v2Projection({
      runs: [v2Run({ id: "compact", userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-compact`, status: "failed" })],
      turnItems: [v2Item({ id: "e1", type: "error", runId: "compact", failure: { class: "provider_error", message: "Context limit unavailable" } })],
    }));
    const { dependencies } = runtime(thread);
    const driver = makeT3ProviderDriver("codex", dependencies);
    await expect(reconcile(driver, "run-compact", [], {
      name: "compact", provider: "codex", sessionId: THREAD, catalogRevision: 4,
    })).resolves.toEqual({ status: "failed", summary: "Context limit unavailable" });
  });

  test("restart compact recovery fails closed on stale durable command identity", async () => {
    const { dependencies } = runtime(v2Snapshot(1));
    const driver = makeT3ProviderDriver("codex", dependencies);
    await expect(reconcile(driver, "run-compact", [], {
      name: "compact", provider: "codex", sessionId: "replaced-session", catalogRevision: 4,
    })).resolves.toEqual({ status: "failed", summary: "The accepted native command identity is stale" });
  });

  test("a continuation that is accepted but not yet answered leaves the run in progress", async () => {
    const original = v2Run({ id: "run-a", ordinal: 1, userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-2` });
    const continuation = v2Run({ id: "run-b", ordinal: 2, userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-2-continue-2`, status: "queued", completedAt: null });
    const messages = [
      v2Message({ id: `${SANDBOX_NAME_PREFIX}-message-run-2`, role: "user", runId: "run-a" }),
      v2Message({ id: "assistant-a", runId: "run-a", text: "", createdAt: at(1) }),
      v2Message({ id: `${SANDBOX_NAME_PREFIX}-message-run-2-continue-2`, role: "user", runId: "run-b", createdAt: at(2) }),
    ];
    const pending = runtime(v2Snapshot(3, v2Projection({ runs: [original, continuation], messages })));
    expect((await reconcile(makeT3ProviderDriver("codex", pending.dependencies), "run-2")).status).toBe("in_progress");

    const done = runtime(v2Snapshot(4, v2Projection({
      runs: [original, { ...continuation, status: "completed", completedAt: at(3) }],
      messages: [...messages, v2Message({ id: "assistant-b", runId: "run-b", text: "The answer", createdAt: at(3) })],
    })));
    const result = await reconcile(makeT3ProviderDriver("codex", done.dependencies), "run-2");
    expect(result).toMatchObject({ status: "completed", summary: "The answer" });
  });

  test("reconciles only the run's own turns through the live activity mapper", async () => {
    const secret = "sk-recovery-secret-1234567890";
    const thread = v2Snapshot(9, v2Projection({
      runs: [v2Run({ id: "turn-1", ordinal: 1, userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-1` }), v2Run({ id: "turn-2", ordinal: 2, userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-2` })],
      messages: [
        v2Message({ id: `${SANDBOX_NAME_PREFIX}-message-run-2`, role: "user", runId: "turn-2", text: "Current request" }),
        v2Message({ id: "assistant-2", runId: "turn-2", text: `Recovered with tail activity ${secret}`, createdAt: at(1) }),
      ],
      turnItems: [
        v2Item({ id: "prior-tool", type: "command_execution", runId: "turn-1", input: "ls" }),
        v2Item({ id: "child-terminal", type: "subagent", runId: "turn-2", status: "completed", subagentId: "sa-1", childThreadId: "child-session-1", prompt: "look", result: `safe ${secret}` }),
      ],
    }));
    const { dependencies } = runtime(thread);
    const driver = makeT3ProviderDriver("codex", dependencies);
    const first = await reconcile(driver, "run-2", [secret]);
    const second = await reconcile(driver, "run-2", [secret]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: "completed",
      summary: "Recovered with tail activity <redacted>",
      events: [
        { eventType: "t3.message.started", messageId: "assistant-2" },
        { eventType: "t3.message.updated", messageId: "assistant-2", payload: { text: "Recovered with tail activity <redacted>", final: true } },
        {
          id: "pe_run-2_t3_child-terminal:started",
          eventType: "t3.activity.task.started",
          sessionId: "sa-1",
          parentSessionId: THREAD,
        },
        {
          id: "pe_run-2_t3_child-terminal:completed",
          runScopedId: true,
          provider: "t3",
          eventType: "t3.activity.task.completed",
          sessionId: "sa-1",
          callId: "sa-1",
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("prior-tool");
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(JSON.stringify(first)).toContain("<redacted>");
  });

  test("a running run exposes its current mapped activities", async () => {
    const thread = v2Snapshot(3, v2Projection({
      runs: [v2Run({ id: "turn-live", userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-live`, status: "running", completedAt: null })],
      messages: [v2Message({ id: `${SANDBOX_NAME_PREFIX}-message-run-live`, role: "user", runId: "turn-live" })],
      turnItems: [v2Item({ id: "call-live", type: "command_execution", runId: "turn-live", status: "running", input: "sleep 5" })],
    }));
    const { dependencies } = runtime(thread);
    await expect(reconcile(makeT3ProviderDriver("codex", dependencies), "run-live")).resolves.toMatchObject({
      status: "in_progress",
      events: [{ id: "pe_run-live_t3_call-live:updated", callId: "call-live" }],
    });
  });

  test("does not adopt a previous completed run before the current run was dispatched", async () => {
    const { dependencies } = runtime(answered("previous-run", "Previous answer"));
    await expect(reconcile(makeT3ProviderDriver("codex", dependencies), "new-run")).resolves.toEqual({ status: "no_change" });
  });

  test("returns redacted failure and interruption reasons with their terminal events", async () => {
    const secret = "sk-failed-turn-secret-1234567890";
    const failed = runtime(v2Snapshot(5, v2Projection({
      runs: [v2Run({ id: "turn-error", userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-error`, status: "failed" })],
      messages: [v2Message({ id: `${SANDBOX_NAME_PREFIX}-message-run-error`, role: "user", runId: "turn-error" })],
      turnItems: [v2Item({ id: "terminal-error", type: "error", runId: "turn-error", failure: { class: "provider_error", message: `Provider error: ${secret}` } })],
    })));
    const failedResult = await reconcile(makeT3ProviderDriver("codex", failed.dependencies), "run-error", [secret]);
    expect(failedResult).toMatchObject({
      status: "failed",
      summary: "Provider error: <redacted>",
      events: [{ id: "pe_run-error_t3_terminal-error:error" }],
    });
    expect(JSON.stringify(failedResult)).not.toContain(secret);

    const interrupted = runtime(v2Snapshot(6, v2Projection({
      runs: [v2Run({ id: "turn-interrupted", userMessageId: `${SANDBOX_NAME_PREFIX}-message-run-interrupted`, status: "interrupted" })],
      messages: [v2Message({ id: `${SANDBOX_NAME_PREFIX}-message-run-interrupted`, role: "user", runId: "turn-interrupted" })],
      turnItems: [v2Item({ id: "tool-cut", type: "command_execution", runId: "turn-interrupted", status: "interrupted", input: "make" })],
      providerSessions: [v2Session({ lastError: `Provider interrupted: ${secret}` })],
      providerThreads: [v2ProviderThread()],
    })));
    const interruptedResult = await reconcile(makeT3ProviderDriver("codex", interrupted.dependencies), "run-interrupted", [secret]);
    expect(interruptedResult).toMatchObject({
      status: "failed",
      summary: "Provider interrupted: <redacted>",
      events: [{ id: "pe_run-interrupted_t3_tool-cut:completed" }],
    });
    expect(JSON.stringify(interruptedResult)).not.toContain(secret);
  });
});
