import { describe, expect, test } from "bun:test";
import {
  normalizeNegotiatedCapabilities,
  type ExecutionCapabilitySnapshot,
  type HarnessSession,
} from "@useagent/agent-harness/canonical";
import type { ProviderDriver } from "@useagent/agent-harness/control";
import {
  establishProviderSession,
  providerSessionStartedEvent,
  recordProviderSessionStarted,
} from "./provider-turn";

const capabilities = normalizeNegotiatedCapabilities({
  streamingText: true,
  resume: true,
  stop: true,
});
const executionCapabilities: ExecutionCapabilitySnapshot = {
  version: 1,
  runtime: "sandbox",
  facilities: {
    files: { availability: "ready", access: { kind: "native" } },
    shell: { availability: "ready", access: { kind: "native" } },
    terminal: { availability: "ready", access: { kind: "native" } },
    desktop: { availability: "unsupported", access: { kind: "none" } },
    browser: { availability: "unsupported", access: { kind: "none" } },
    tools: { availability: "unsupported", access: { kind: "none" } },
  },
};

function session(nativeSessionId: string): HarnessSession {
  return {
    provider: "native-test",
    nativeSessionId,
    runtime: { kind: "sandbox", id: "sandbox-1" },
    protocolVersion: "native-test-v1",
    capabilities,
    generation: 1,
  };
}

function driver(
  calls: string[],
  resumeStatus: "ok" | "invalid" | "failed" = "ok",
): ProviderDriver {
  return {
    provider: "native-test",
    descriptor: {
      provider: "native-test",
      protocol: { name: "native-test-v1" },
      capabilities,
      model: { selection: "per_turn" },
      tools: { mode: "skynet_brokered", approval: "skynet" },
    },
    async start() {
      calls.push("start");
      return { status: "ok", value: session("session-new") };
    },
    async resume(request) {
      calls.push(`resume:${request.session.nativeSessionId}`);
      if (resumeStatus === "ok") return { status: "ok", value: request.session };
      return {
        status: "error",
        code: resumeStatus === "invalid" ? "session_invalid" : "session_resume_failed",
        message: resumeStatus === "invalid" ? "gone" : "transport unavailable",
      };
    },
    async steer(request) {
      calls.push(`steer:${request.runId}:${request.input.kind}`);
      return { status: "ok" };
    },
    async cancel() {
      return { status: "ok" };
    },
  };
}

const ctx = {
  runId: "run-1",
  threadId: "thread-1",
  model: "model-1",
  signal: new AbortController().signal,
};

describe("production provider turn lifecycle", () => {
  test("does not steer when authoritative session capability persistence fails", async () => {
    const calls: string[] = [];
    const provider = driver(calls);
    const established = await establishProviderSession({
      driver: provider,
      ctx,
      runtime: { kind: "sandbox", id: "sandbox-1" },
      capabilities,
      executionCapabilities,
      persistSession: async () => {},
    });

    const dispatch = async () => {
      await recordProviderSessionStarted(
        ctx,
        established.session,
        { provider: "native-test", source: "native-test", resumed: established.resumed },
        async () => {
          throw new Error("database unavailable");
        },
      );
      await provider.steer({
        runId: ctx.runId,
        threadId: ctx.threadId,
        session: established.session,
        input: { kind: "prompt", text: "must not send", model: ctx.model },
        signal: ctx.signal,
      });
    };

    await expect(dispatch()).rejects.toThrow("database unavailable");
    expect(calls).toEqual(["start"]);
  });

  test("resumes and persists the canonical session before steering", async () => {
    const calls: string[] = [];
    const timings: string[] = [];
    const provider = driver(calls);
    const established = await establishProviderSession({
      driver: provider,
      ctx: {
        ...ctx,
        engineSessionId: "session-existing",
        timing: {
          begin: (stage) => (outcome) => timings.push(`${stage}:${outcome ?? "none"}`),
          mark: () => {},
        },
      },
      runtime: { kind: "sandbox", id: "sandbox-1" },
      capabilities,
      executionCapabilities,
      persistSession: async (nativeSessionId) => {
        calls.push(`persist:${nativeSessionId}`);
      },
    });
    const event = providerSessionStartedEvent(ctx, established.session, {
      provider: "native-test",
      source: "native-test",
      resumed: established.resumed,
    });
    const steered = await provider.steer({
      runId: ctx.runId,
      threadId: ctx.threadId,
      session: established.session,
      input: { kind: "prompt", text: "continue", model: ctx.model },
      signal: ctx.signal,
    });

    expect(established.resumed).toBe(true);
    expect(steered).toEqual({ status: "ok" });
    expect(calls).toEqual([
      "resume:session-existing",
      "persist:session-existing",
      "steer:run-1:prompt",
    ]);
    expect(timings).toEqual([
      "provider.session_resume:success",
      "provider.session_persist:success",
    ]);
    expect(event).toEqual({
      id: "run-1:session-existing:session",
      runId: "run-1",
      threadId: "thread-1",
      provider: "native-test",
      eventType: "session.started",
      nativeSessionId: "session-existing",
      payload: { source: "native-test", resumed: true, capabilities, executionCapabilities },
    });
  });

  test("persists a provider-replaced session id before returning from resume", async () => {
    const calls: string[] = [];
    const provider = driver(calls);
    provider.resume = async (request) => {
      calls.push(`resume:${request.session.nativeSessionId}`);
      return { status: "ok", value: session("session-replaced") };
    };

    const established = await establishProviderSession({
      driver: provider,
      ctx: { ...ctx, engineSessionId: "session-existing" },
      runtime: { kind: "sandbox", id: "sandbox-1" },
      capabilities,
      executionCapabilities,
      persistSession: async (nativeSessionId) => {
        calls.push(`persist:${nativeSessionId}`);
      },
    });

    expect(established.session.nativeSessionId).toBe("session-replaced");
    expect(calls).toEqual([
      "resume:session-existing",
      "persist:session-replaced",
    ]);
  });

  test("replaces only a driver-classified stale resume with start", async () => {
    const calls: string[] = [];
    const timings: string[] = [];
    const established = await establishProviderSession({
      driver: driver(calls, "invalid"),
      ctx: {
        ...ctx,
        engineSessionId: "session-stale",
        timing: {
          begin: (stage) => (outcome) => timings.push(`${stage}:${outcome ?? "none"}`),
          mark: () => {},
        },
      },
      runtime: { kind: "sandbox", id: "sandbox-1" },
      capabilities,
      executionCapabilities,
      persistSession: async () => {},
    });

    expect(established).toEqual({
      session: { ...session("session-new"), executionCapabilities },
      resumed: false,
    });
    expect(calls).toEqual(["resume:session-stale", "start"]);
    expect(timings).toEqual([
      "provider.session_resume:miss",
      "provider.session_start:success",
      "provider.session_persist:success",
    ]);
  });

  test("does not fork a retained conversation on a transient resume failure", async () => {
    const calls: string[] = [];

    await expect(establishProviderSession({
      driver: driver(calls, "failed"),
      ctx: { ...ctx, engineSessionId: "session-retained" },
      runtime: { kind: "sandbox", id: "sandbox-1" },
      capabilities,
      executionCapabilities,
      persistSession: async () => {},
    })).rejects.toThrow("resume error: transport unavailable");
    expect(calls).toEqual(["resume:session-retained"]);
  });

  test("does not steer a newly created session when durable persistence fails", async () => {
    const calls: string[] = [];
    const timings: string[] = [];
    const provider = driver(calls);

    const runTurn = async () => {
      const established = await establishProviderSession({
        driver: provider,
        ctx: {
          ...ctx,
          timing: {
            begin: (stage) => (outcome) => timings.push(`${stage}:${outcome ?? "none"}`),
            mark: () => {},
          },
        },
        runtime: { kind: "sandbox", id: "sandbox-1" },
        capabilities,
        executionCapabilities,
        persistSession: async (nativeSessionId) => {
          calls.push(`persist:${nativeSessionId}`);
          throw new Error("database unavailable");
        },
      });
      return await provider.steer({
        runId: ctx.runId,
        threadId: ctx.threadId,
        session: established.session,
        input: { kind: "prompt", text: "start", model: ctx.model },
        signal: ctx.signal,
      });
    };

    await expect(runTurn()).rejects.toThrow("database unavailable");
    expect(calls).toEqual(["start", "persist:session-new"]);
    expect(timings).toEqual([
      "provider.session_start:success",
      "provider.session_persist:failure",
    ]);
  });
});
