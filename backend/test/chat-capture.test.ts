// Chat capture parity (memory self-improvement item 7): a completed chat
// exchange enqueues through the SAME durable outbox as runs — same salience
// gate, same scope resolution (org pool / personal fail-closed), synthetic
// `chat:<uuid>` id (no run row), evidence marked source="chat". Enqueue never
// touches the network; memory failures never surface to the exchange.
import { afterEach, describe, expect, test } from "bun:test";
import { captureChatExchange } from "../src/chat/capture";
import { getCapture } from "../src/memory/capture-outbox";
import "./helpers"; // side-effect: imports src/index → migrate + seed

const ORG = "org-chat-capture";

function withMemoryEnv(): void {
  process.env.MEMORY_API_URL = "http://memory.invalid"; // enqueue never calls the network
}

afterEach(() => {
  delete process.env.MEMORY_API_URL;
});

const exchange = {
  orgId: ORG,
  userId: "user-42",
  memoryScope: "org" as const,
  prompt: "how do we rotate the staging DB credentials?",
  summary:
    "Rotation runs through the org-secrets store: update the sealed value, then restart the worker pool.",
  model: "anthropic/claude-sonnet-5",
};

describe("captureChatExchange", () => {
  test("a salient completed exchange enqueues into the ORG pool with chat-origin evidence", async () => {
    withMemoryEnv();
    const id = await captureChatExchange(exchange);
    expect(id).not.toBeNull();
    expect(id!.startsWith("chat:")).toBe(true);

    const row = await getCapture(id!);
    expect(row).not.toBeNull();
    expect(row!.state).toBe("pending");
    const payload = JSON.parse(row!.payload) as {
      scope: string;
      identity: { userId: string; teamId: string; sessionId: string };
      prompt: string;
      summary: string;
      evidence: { source: string; status: string; model: string };
    };
    expect(payload.scope).toBe("org");
    expect(payload.identity.teamId).toBe(ORG);
    expect(payload.identity.userId).toBe(`org:${ORG}`); // the shared org pool
    expect(payload.identity.sessionId).toBe(`chat:${ORG}`); // same provenance session as retrieval
    expect(payload.prompt).toBe(exchange.prompt);
    expect(payload.summary).toBe(exchange.summary);
    expect(payload.evidence).toEqual({
      source: "chat",
      status: "completed",
      model: "anthropic/claude-sonnet-5",
    });
  });

  test("personal scope captures into the PERSONAL pool; anonymous personal fails closed", async () => {
    withMemoryEnv();
    const personal = await captureChatExchange({ ...exchange, memoryScope: "personal" });
    expect(personal).not.toBeNull();
    const payload = JSON.parse((await getCapture(personal!))!.payload) as {
      scope: string;
      identity: { userId: string };
    };
    expect(payload.scope).toBe("personal");
    expect(payload.identity.userId).toBe("user-42");

    const anonymous = await captureChatExchange({ ...exchange, memoryScope: "personal", userId: null });
    expect(anonymous).toBeNull(); // fail closed, exactly like runs
  });

  test("the shared salience gate applies: a trivial answer enqueues nothing", async () => {
    withMemoryEnv();
    expect(await captureChatExchange({ ...exchange, summary: "OK" })).toBeNull();
    expect(
      await captureChatExchange({ ...exchange, summary: "I'm sorry, I can't help with that." }),
    ).toBeNull();
  });

  test("memory disabled → clean no-op null (never a throw)", async () => {
    delete process.env.MEMORY_API_URL;
    expect(await captureChatExchange(exchange)).toBeNull();
  });
});
