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
      observe(protocol, JSON.stringify({
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

  test("validates native output against the protocol-owned thread and active turn", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-thread-1" });
    await protocol.acceptClientFrame(JSON.stringify({
      id: 7,
      method: "thread/resume",
      params: { threadId: "provider-thread-1", cwd: "/root/work", model: "gpt-5.5" },
    }));
    await observe(protocol, JSON.stringify({
      id: 7,
      result: { thread: { id: "provider-thread-1" } },
    }));
    await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-thread-1", turn: { id: "turn-1" } },
    }));

    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-thread-1",
      turnId: "turn-1",
    })).resolves.toBeUndefined();
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-thread-forged",
      turnId: "turn-1",
    })).rejects.toThrow("thread binding mismatch");
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-thread-1",
      turnId: "turn-forged",
    })).rejects.toThrow("turn binding mismatch");

    await observe(protocol, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "provider-thread-1", turn: { id: "turn-1" } },
    }));
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-thread-1",
      turnId: "turn-1",
    })).rejects.toThrow("turn binding mismatch");
  });

  test("rejects cross-thread lifecycle splices and validates concurrent turn pairs", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-thread-1" });
    await confirmResume(protocol, 20, "provider-thread-1");

    expect(await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-thread-forged", turn: { id: "turn-forged" } },
    }))).toEqual([]);

    await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-thread-1", turn: { id: "turn-a" } },
    }));
    await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-thread-1", turn: { id: "turn-b" } },
    }));
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-thread-1",
      turnId: "turn-a",
    })).resolves.toBeUndefined();
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-thread-1",
      turnId: "turn-b",
    })).resolves.toBeUndefined();

    await expect(observe(protocol, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "provider-thread-1", turn: { id: "turn-unknown" } },
    }))).rejects.toThrow("turn lifecycle pair mismatch");
    await observe(protocol, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "provider-thread-1", turn: { id: "turn-a" } },
    }));
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-thread-1",
      turnId: "turn-b",
    })).resolves.toBeUndefined();
  });

  test("authorizes only provider-declared descendants of the bound root", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(protocol, 25, "provider-root");

    await observe(protocol, threadStarted(
      "provider-child-a",
      { subAgent: { thread_spawn: { parent_thread_id: "provider-root" } } },
    ));
    await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-child-a", turn: { id: "child-turn-a" } },
    }));
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-child-a",
      turnId: "child-turn-a",
    })).resolves.toBeUndefined();
    await observe(protocol, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "provider-child-a", turn: { id: "child-turn-a" } },
    }));

    // The root remains live after a child turn and can spawn another child.
    await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-root", turn: { id: "root-turn-2" } },
    }));
    await observe(protocol, threadStarted(
      "provider-child-b",
      { subAgent: { thread_spawn: { parentThreadId: "provider-root" } } },
    ));
    await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-child-b", turn: { id: "child-turn-b" } },
    }));
    await observe(protocol, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "provider-child-b", turn: { id: "child-turn-b" } },
    }));
    await observe(protocol, JSON.stringify({
      method: "turn/completed",
      params: { threadId: "provider-root", turn: { id: "root-turn-2" } },
    }));

    // Nested descendants are owned only through an already-owned parent.
    await observe(protocol, threadStarted(
      "provider-grandchild",
      { subAgent: { thread_spawn: { parent_thread_id: "provider-child-a" } } },
    ));
    await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-grandchild", turn: { id: "grandchild-turn" } },
    }));
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-grandchild",
      turnId: "grandchild-turn",
    })).resolves.toBeUndefined();

    // An account-wide foreign thread is not admitted merely because app-server
    // announced it; its ancestry must root in this relay's confirmed thread.
    expect(await observe(protocol, threadStarted(
      "provider-foreign-child",
      { subAgent: { thread_spawn: { parent_thread_id: "provider-foreign-root" } } },
    ))).toEqual([]);
    expect(await observe(protocol, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-foreign-child", turn: { id: "foreign-turn" } },
    }))).toEqual([]);
  });

  test("does not own descendants until the root resume is confirmed", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-root" });
    await protocol.acceptClientFrame(JSON.stringify({
      id: 26,
      method: "thread/resume",
      params: { threadId: "provider-root", cwd: "/root/work", model: "gpt-5.5" },
    }));
    const child = threadStarted(
      "provider-child",
      { subAgent: { thread_spawn: { parent_thread_id: "provider-root" } } },
    );
    const childTurn = JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-child", turn: { id: "child-turn" } },
    });
    expect(await observe(protocol, child)).toEqual([]);
    expect(await observe(protocol, childTurn)).toEqual([]);
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-child",
      turnId: "child-turn",
    })).rejects.toThrow("native output thread binding mismatch");

    const rootResponse = JSON.stringify({
      id: 26,
      result: { thread: { id: "provider-root" } },
    });
    expect(await observe(protocol, rootResponse)).toEqual([
      rootResponse,
      child,
      childTurn,
    ]);
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-child",
      turnId: "child-turn",
    })).resolves.toBeUndefined();
  });

  test("rejects conflicting provider ancestry representations", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(protocol, 27, "provider-root");
    await expect(observe(protocol, JSON.stringify({
      method: "thread/started",
      params: {
        thread: {
          id: "provider-child",
          parentThreadId: "provider-root",
          source: {
            subAgent: { thread_spawn: { parent_thread_id: "provider-foreign-root" } },
          },
        },
      },
    }))).rejects.toThrow("thread ancestry conflict");
  });

  test("recursively releases child-before-parent frames in observation order", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(protocol, 28, "provider-root");
    const grandchildStarted = threadStarted(
      "provider-grandchild",
      { subAgent: { thread_spawn: { parent_thread_id: "provider-child" } } },
    );
    const grandchildDelta = JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "provider-grandchild", turnId: "grandchild-turn", delta: "hello" },
    });
    const childStarted = threadStarted(
      "provider-child",
      { subAgent: { thread_spawn: { parent_thread_id: "provider-root" } } },
    );

    expect(await observe(protocol, grandchildStarted)).toEqual([]);
    expect(await observe(protocol, grandchildDelta)).toEqual([]);
    expect(await observe(protocol, childStarted)).toEqual([
      grandchildStarted,
      grandchildDelta,
      childStarted,
    ]);
  });

  test("registers captured child traffic from a parent-owned subAgentActivity", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(protocol, 29, "provider-root");
    const childStatus = JSON.stringify({
      method: "thread/status/changed",
      params: { threadId: "provider-child", status: { type: "idle" } },
    });
    const registration = JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "provider-root",
        turnId: "root-turn",
        item: {
          type: "subAgentActivity",
          id: "spawn-call",
          kind: "started",
          agentThreadId: "provider-child",
          agentPath: "/root/alpha",
        },
      },
    });

    expect(await observe(protocol, childStatus)).toEqual([]);
    expect(await observe(protocol, registration)).toEqual([childStatus, registration]);
    const childTurn = JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-child", turn: { id: "child-turn" } },
    });
    expect(await observe(protocol, childTurn)).toEqual([childTurn]);
    await expect(protocol.validateNativeOutputIdentity({
      threadId: "provider-child",
      turnId: "child-turn",
    })).resolves.toBeUndefined();
  });

  test("holds foreign thread-scoped activity and drops pending overflow", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(protocol, 30, "provider-root");
    for (let index = 0; index < 64; index += 1) {
      expect(await observe(protocol, JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: `foreign-${index}`, status: "active" },
      }))).toEqual([]);
    }
    expect(await observe(protocol, JSON.stringify({
      method: "item/completed",
      params: { threadId: "foreign-overflow", item: { id: "item" } },
    }))).toEqual([]);

    const bytes = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(bytes, 31, "provider-root");
    expect(await observe(bytes, JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "foreign-large", delta: "x".repeat(1_048_576) },
    }))).toEqual([]);

    const frames = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(frames, 32, "provider-root");
    for (let index = 0; index < 256; index += 1) {
      expect(await observe(frames, JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "foreign-buffered", delta: String(index) },
      }))).toEqual([]);
    }
    expect(await observe(frames, JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "foreign-buffered", delta: "overflow" },
    }))).toEqual([]);
  });

  test("fails closed when owned thread or active turn bounds are exceeded", async () => {
    const threads = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(threads, 33, "provider-root");
    for (let index = 0; index < 255; index += 1) {
      await observe(threads, threadStarted(
        `provider-child-${index}`,
        { subAgent: { thread_spawn: { parent_thread_id: "provider-root" } } },
      ));
    }
    await expect(observe(threads, threadStarted(
      "provider-child-overflow",
      { subAgent: { thread_spawn: { parent_thread_id: "provider-root" } } },
    ))).rejects.toThrow("owned provider thread limit exceeded");

    const turns = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(turns, 34, "provider-root");
    for (let index = 0; index < 256; index += 1) {
      await observe(turns, JSON.stringify({
        method: "turn/started",
        params: { threadId: "provider-root", turn: { id: `turn-${index}` } },
      }));
    }
    await expect(observe(turns, JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-root", turn: { id: "turn-overflow" } },
    }))).rejects.toThrow("active turn limit exceeded");
  });

  test("rejects malformed and conflicting nested server-frame addresses", async () => {
    const protocol = makeProtocol({ providerThreadId: "provider-root" });
    await confirmResume(protocol, 35, "provider-root");
    await expect(observe(protocol, JSON.stringify({
      method: "item/completed",
      params: { threadId: 123, item: { id: "bad" } },
    }))).rejects.toThrow("thread id is invalid");
    await expect(observe(protocol, JSON.stringify({
      method: "future/thread-event",
      params: { thread: { id: 123 } },
    }))).rejects.toThrow("thread id is invalid");
    await expect(observe(protocol, JSON.stringify({
      method: "future/thread-event",
      params: { threadId: "provider-root", thread: { id: "provider-foreign" } },
    }))).rejects.toThrow("thread binding conflict");
    expect(await observe(protocol, JSON.stringify({
      method: "future/thread-event",
      params: { thread: { id: "provider-foreign" } },
    }))).toEqual([]);
  });

  test("fails closed when start and resume responses race a changed durable binding", async () => {
    let providerThreadId: string | null = null;
    const protocol = new CodexSubscriptionProtocol(binding(), {
      loadThreadBinding: async () => providerThreadId,
      bindThread: async (value) => {
        providerThreadId = value;
      },
    });
    await protocol.acceptClientFrame(JSON.stringify({
      id: 30,
      method: "thread/start",
      params: { cwd: "/root/work", model: "gpt-5.5" },
    }));
    providerThreadId = "provider-thread-race-winner";
    await expect(observe(protocol, JSON.stringify({
      id: 30,
      result: { thread: { id: "provider-thread-race-loser" } },
    }))).rejects.toThrow("start response changed concurrently bound thread");

    const resumed = new CodexSubscriptionProtocol(binding(), {
      loadThreadBinding: async () => providerThreadId,
      bindThread: async () => {},
    });
    await resumed.acceptClientFrame(JSON.stringify({
      id: 31,
      method: "thread/resume",
      params: {
        threadId: "provider-thread-race-winner",
        cwd: "/root/work",
        model: "gpt-5.5",
      },
    }));
    providerThreadId = "provider-thread-new-winner";
    await expect(resumed.observeServerFrame(JSON.stringify({
      id: 31,
      result: { thread: { id: "provider-thread-race-winner" } },
    }))).rejects.toThrow("resume response changed thread");
  });
});

async function observe(
  protocol: CodexSubscriptionProtocol,
  raw: string,
): Promise<readonly string[]> {
  const ready = await protocol.observeServerFrame(raw);
  for (const frame of ready) frame.commit();
  return ready.map((frame) => frame.raw);
}

async function confirmResume(
  protocol: CodexSubscriptionProtocol,
  requestId: number,
  providerThreadId: string,
): Promise<void> {
  await protocol.acceptClientFrame(JSON.stringify({
    id: requestId,
    method: "thread/resume",
    params: { threadId: providerThreadId, cwd: "/root/work", model: "gpt-5.5" },
  }));
  await observe(protocol, JSON.stringify({
    id: requestId,
    result: { thread: { id: providerThreadId } },
  }));
}

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

function threadStarted(id: string, source: Record<string, unknown>): string {
  return JSON.stringify({
    method: "thread/started",
    params: { thread: { id, source } },
  });
}
