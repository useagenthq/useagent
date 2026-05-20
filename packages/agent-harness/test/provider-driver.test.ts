import { describe, expect, test } from "bun:test";
import { normalizeNegotiatedCapabilities, type HarnessSession } from "../src/canonical";
import {
  providerDriverHarnessCapabilities,
  providerDriverUnsupported,
  validateProviderDriver,
  type HarnessOperationResult,
  type ProviderDriver,
} from "../src/control";

const capabilities = normalizeNegotiatedCapabilities({
  streamingText: true,
  stop: true,
  resume: true,
  usage: true,
});

const session: HarnessSession = {
  provider: "test-provider",
  nativeSessionId: "native-1",
  runtime: { kind: "managed", id: "runtime-1" },
  protocolVersion: "test-v1",
  capabilities,
  generation: 1,
};

function makeDriver(): ProviderDriver {
  return {
    provider: "test-provider",
    descriptor: {
      provider: "test-provider",
      protocol: { name: "test-protocol", version: "1.0.0" },
      capabilities,
      model: {
        selection: "per_turn",
        defaultModel: "gpt-test",
        availableModels: [{ id: "gpt-test", displayName: "GPT Test" }],
      },
      tools: {
        mode: "skynet_brokered",
        approval: "skynet",
        tools: [{ name: "shell", description: "Run a bounded shell command" }],
      },
    },
    async start() {
      return { status: "ok", value: session };
    },
    async resume(request) {
      return { status: "ok", value: request.session };
    },
    async steer() {
      return { status: "ok" };
    },
    async cancel() {
      return { status: "ok" };
    },
  };
}

describe("ProviderDriver lifecycle contract", () => {
  test("start/resume/steer/cancel reuse one portable canonical session", async () => {
    const driver = makeDriver();

    const started = await driver.start({
      runId: "run-1",
      threadId: "thread-1",
      runtime: session.runtime,
    });
    expect(started).toEqual({ status: "ok", value: session });

    const resumed = await driver.resume({ session });
    expect(resumed).toEqual({ status: "ok", value: session });

    const steered: HarnessOperationResult = await driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session,
      input: { kind: "prompt", text: "continue" },
    });
    expect(steered).toEqual({ status: "ok" });
    await expect(
      driver.cancel(session, "user"),
    ).resolves.toEqual({ status: "ok" });
  });

  test("unsupported capability is an explicit result, not a throw or silent no-op", () => {
    expect(providerDriverUnsupported("test-provider", "toolGateway", "no broker installed")).toEqual({
      status: "unsupported_capability",
      provider: "test-provider",
      capability: "toolGateway",
      message: "no broker installed",
    });
  });

  test("projects the legacy control view from the canonical driver descriptor", () => {
    expect(providerDriverHarnessCapabilities(makeDriver())).toEqual({
      resume: true,
      cancel: true,
      streaming: "text",
      authoritativeHistory: false,
      childSessions: false,
      approvals: false,
      questions: false,
      reasoning: false,
      todos: false,
      patches: false,
      usage: true,
    });
  });

  test("validateProviderDriver checks descriptor/provider consistency", () => {
    expect(validateProviderDriver(makeDriver())).toEqual({ status: "ok" });

    const malformed = {
      ...makeDriver(),
      descriptor: { ...makeDriver().descriptor, provider: "other-provider" },
    };
    expect(validateProviderDriver(malformed)).toEqual({
      status: "error",
      code: "provider_descriptor_mismatch",
      message: "provider driver 'test-provider' must use a matching descriptor provider",
    });
  });

  test("validateProviderDriver rejects malformed runtime descriptor enums", () => {
    const malformed = {
      ...makeDriver(),
      descriptor: {
        ...makeDriver().descriptor,
        model: { selection: "sometimes" },
        tools: { mode: "maybe", approval: "later" },
      },
    };
    expect(validateProviderDriver(malformed)).toEqual({
      status: "error",
      code: "invalid_model_capability",
      message: "provider driver 'test-provider' has an invalid model selection mode",
    });
  });

  test("validateProviderDriver rejects a malformed optional recovery method", () => {
    expect(validateProviderDriver({ ...makeDriver(), reconcile: true })).toEqual({
      status: "error",
      code: "invalid_provider_method",
      message: "provider driver 'test-provider' must implement reconcile as a function",
    });
  });
});
