import { describe, expect, test } from "bun:test";
import type { CodexSubscriptionRelayBinding } from "./codex-subscription-relay";
import { CodexSubscriptionProtocol } from "./codex-subscription-protocol";

describe("CodexSubscriptionProtocol", () => {
  test("rejects thread fields that could override host-owned Codex configuration", async () => {
    const protocol = makeProtocol();

    await expect(
      protocol.acceptClientFrame(JSON.stringify({
        id: 1,
        method: "thread/start",
        params: {
          cwd: "/root/work",
          model: "gpt-5.5",
          config: { model_provider: "attacker" },
        },
      })),
    ).rejects.toThrow("thread config is host-owned");

    await expect(
      protocol.acceptClientFrame(JSON.stringify({
        id: 2,
        method: "thread/start",
        params: {
          cwd: "/root/work",
          model: "gpt-5.5",
          modelProvider: "attacker",
        },
      })),
    ).rejects.toThrow("model provider is host-owned");
  });

  test("rejects a turn-level workspace override outside the bound remote environment", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-thread-1" });

    await expect(
      protocol.acceptClientFrame(JSON.stringify({
        id: 3,
        method: "turn/start",
        params: {
          threadId: "provider-thread-1",
          model: "gpt-5.5",
          cwd: "/host",
          environments: [remoteEnvironment()],
        },
      })),
    ).rejects.toThrow("workspace binding mismatch");
  });

  test("rejects duplicate and excessive outstanding request ids", async () => {
    const duplicate = makeProtocol();
    const request = JSON.stringify({ id: 1, method: "initialize", params: {} });
    await duplicate.acceptClientFrame(request);
    await expect(duplicate.acceptClientFrame(request)).rejects.toThrow("duplicate client request id");

    const saturated = makeProtocol();
    for (let id = 0; id < 256; id += 1) {
      await saturated.acceptClientFrame(JSON.stringify({ id, method: "initialize", params: {} }));
    }
    await expect(
      saturated.acceptClientFrame(JSON.stringify({ id: 256, method: "initialize", params: {} })),
    ).rejects.toThrow("client request limit exceeded");
  });

  test("rejects oversized native frames before parsing or forwarding them", async () => {
    const protocol = makeProtocol();
    const oversized = JSON.stringify({
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(1_048_576) },
    });

    await expect(protocol.acceptClientFrame(oversized)).rejects.toThrow("frame exceeds the relay limit");
  });

  test("forwards an unbound thread/start verbatim", async () => {
    const protocol = makeProtocol();
    const start = JSON.stringify({
      id: 4,
      method: "thread/start",
      params: { cwd: "/root/work", model: "gpt-5.5" },
    });

    expect(await protocol.acceptClientFrame(start)).toBe(start);
  });

  test("rewrites a bound thread/start into a resume of the bound provider thread", async () => {
    // The T3 driver falls back to thread/start whenever its local resume
    // cursor is lost (per-run relay teardown) - the relay must continue the
    // bound provider thread, not fork or reject it.
    const protocol = makeProtocol({ providerThreadId: "provider-thread-9" });
    const outbound = await protocol.acceptClientFrame(JSON.stringify({
      id: 5,
      method: "thread/start",
      params: { cwd: "/root/work", model: "gpt-5.5" },
    }));

    const frame = JSON.parse(outbound) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(frame.method).toBe("thread/resume");
    expect(frame.params.threadId).toBe("provider-thread-9");
    expect(frame.params.cwd).toBe("/root/work");
    expect(frame.id).toBe(5);

    // The response is validated under RESUME semantics: a server reply that
    // switches to a different provider thread is refused.
    await expect(
      protocol.observeServerFrame(JSON.stringify({
        id: 5,
        result: { thread: { id: "some-other-thread" } },
      })),
    ).rejects.toThrow("Codex resume response changed thread");
  });

  test("a rewritten start still enforces host-owned thread fields", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-thread-9" });
    await expect(
      protocol.acceptClientFrame(JSON.stringify({
        id: 6,
        method: "thread/start",
        params: { cwd: "/root/work", model: "gpt-5.5", modelProvider: "attacker" },
      })),
    ).rejects.toThrow("model provider is host-owned");
  });
});

function makeProtocol(input: { readonly providerThreadId?: string } = {}) {
  return new CodexSubscriptionProtocol(binding(), {
    loadThreadBinding: async () => input.providerThreadId ?? null,
    bindThread: async () => {},
  });
}

function binding(): CodexSubscriptionRelayBinding {
  return {
    orgId: "org-1",
    userId: "user-1",
    threadId: "thread-1",
    runId: "run-1",
    connectionId: "connection-1",
    authEpoch: "credential-generation-123",
    model: "gpt-5.5",
    sandboxId: "sandbox-1",
    sandboxGeneration: "t3-v2",
    environmentId: "skynet-sandbox-1-run-1",
    cwd: "/root/work",
  };
}

function remoteEnvironment() {
  return {
    environmentId: "skynet-sandbox-1-run-1",
    cwd: "/root/work",
    runtimeWorkspaceRoots: ["/root/work"],
  };
}
