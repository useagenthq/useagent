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
