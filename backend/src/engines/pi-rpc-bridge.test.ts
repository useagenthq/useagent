import { describe, expect, test } from "bun:test";
import { RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { SandboxHandle, SandboxProcess } from "../sandboxes/provider";
import { DefaultPiBridgeManager } from "./pi-rpc-bridge";

function sandboxWithBracketedPastePrefix(
  requests: Array<Record<string, unknown>> = [],
  options: {
    readonly largeTranscript?: boolean;
    readonly splitTranscriptUtf8?: boolean;
    readonly malformedChunk?: boolean;
    readonly missingResponseId?: boolean;
    readonly hangChildTranscript?: boolean;
    readonly resetChildAOnce?: boolean;
    readonly negotiatedVersion?: number;
    readonly control?: { emit?: (data: string) => Promise<void> };
    readonly failRequestType?: string;
  } = {},
): SandboxHandle {
  const encoder = new TextEncoder();
  let nonCanonicalInput = false;
  let childAReset = false;
  return {
    id: "cube-box",
    cpu: 2,
    memory: 4,
    state: "started",
    process: {
      async createPty({ onData }: Parameters<SandboxProcess["createPty"]>[0]) {
        if (options.control) {
          options.control.emit = async (data) => onData(encoder.encode(data));
        }
        return {
          async waitForConnection() {},
          async sendInput(input: string | Uint8Array) {
            const text = typeof input === "string" ? input : new TextDecoder().decode(input);
            if (text.startsWith("stty ")) {
              nonCanonicalInput = text.includes(" -icanon min 1 time 0");
              await onData(encoder.encode("\u001b[?2004hroot@box:/work# "));
              await onData(encoder.encode(text.trimEnd()));
              await onData(encoder.encode("\r\n\u001b[?2004l\r"));
              await onData(encoder.encode(
                '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}\n',
              ));
              return;
            }
            const request = JSON.parse(text) as {
              id: string;
              type: string;
              message?: string;
              fromByte?: number;
              subagentId?: string;
            };
            requests.push(request);
            if (request.type === options.failRequestType) throw new Error("PTY send failed");
            if ((request.message?.length ?? 0) > 4_095 && !nonCanonicalInput) {
              throw new Error("canonical PTY input corrupted the long RPC frame");
            }
            const childCursor = request.subagentId === "child-b" ? 200 : 100;
            const childText = options.largeTranscript
              ? "x".repeat(1_100_000)
              : options.splitTranscriptUtf8
                ? "child final 🚀"
                : "child final";
            const reset = Boolean(
              options.resetChildAOnce &&
              request.subagentId === "child-a" &&
              request.fromByte === 100 &&
              !childAReset,
            );
            if (reset) childAReset = true;
            const data = request.type === "get_state"
              ? { sessionId: "pi-session", sessionFile: "/home/useagent-pi/agent/sessions/pi.jsonl" }
              : request.type === "negotiate_protocol"
                ? { protocolVersion: options.negotiatedVersion ?? 2 }
              : request.type === "get_subagent_messages"
                ? {
                    sessionFile: "/sessions/child.jsonl",
                    fromByte: request.fromByte ?? 0,
                    nextByte: reset ? 50 : childCursor,
                    reset,
                    entries: [],
                    messages: request.fromByte
                      ? []
                      : [{
                          role: "assistant",
                          timestamp: 123,
                          stopReason: "stop",
                          usage: { input: 2, output: 1 },
                          content: [{ type: "text", text: childText }],
                        }],
                  }
                : { level: "events" };
            const responseFrame = {
              type: "response",
              id: request.id,
              command: request.type,
              success: true,
              data,
            };
            if (request.type === "get_subagent_messages" && options.hangChildTranscript) return;
            if (request.type === "get_subagent_messages" && options.malformedChunk) {
              await onData(encoder.encode(JSON.stringify({
                type: "rpc_chunk",
                chunkId: "broken",
                index: 1,
                count: 2,
                byteLength: 1_048_576,
                data: "e30=",
              }) + "\n"));
              return;
            }
            if (request.type === "get_subagent_messages" && options.missingResponseId) {
              const { id: _id, ...withoutId } = responseFrame;
              await onData(encoder.encode(JSON.stringify(withoutId) + "\n"));
              return;
            }
            if (request.type === "get_subagent_messages" && options.largeTranscript) {
              const rpcEncoder = new RpcFrameEncoder();
              rpcEncoder.setProtocolVersion(2);
              for (const line of rpcEncoder.encodeFrames(responseFrame)) {
                await onData(encoder.encode(line));
              }
            } else {
              const encoded = encoder.encode(JSON.stringify(responseFrame) + "\n");
              if (request.type === "get_subagent_messages" && options.splitTranscriptUtf8) {
                const split = encoded.indexOf(0xf0) + 1;
                await onData(encoded.slice(0, split));
                await onData(encoded.slice(split));
              } else {
                await onData(encoded);
              }
            }
          },
          async resize() {},
          async disconnect() {},
          async kill() {},
        };
      },
    } as unknown as SandboxHandle["process"],
    fs: {} as SandboxHandle["fs"],
    async start() {},
    async delete() {},
    async getPreviewLink() {
      return { url: "https://example.test" };
    },
  };
}

describe("Pi RPC frame parsing", () => {
  test("becomes ready when Cube prefixes the first RPC frame with terminal control bytes", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(requests),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });

    expect(session.sessionId).toBe("pi-session");
    expect(session.sessionFile).toBe("/home/useagent-pi/agent/sessions/pi.jsonl");
    expect(requests.slice(0, 3).map((request) => request.type)).toEqual([
      "negotiate_protocol",
      "set_subagent_subscription",
      "get_state",
    ]);
    await session.dispose();
  }, 2_000);

  test("delivers prompt frames larger than Linux MAX_CANON intact", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });

    await expect(session.command({ kind: "prompt", text: "x".repeat(12_000) })).resolves.toBeUndefined();
    await session.dispose();
  }, 2_000);

  test("reconciles a completed child transcript with a bounded byte cursor", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(requests),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });

    const reconcileCompletedChild = session.reconcileCompletedChild?.bind(session);
    if (!reconcileCompletedChild) throw new Error("expected Pi child transcript reconciliation");
    expect(reconcileCompletedChild({
      type: "subagent_lifecycle",
      payload: { id: "child-a", status: "started" },
    })).toBeNull();
    expect(reconcileCompletedChild({
      type: "subagent_lifecycle",
      payload: { id: "child-a", status: "running" },
    })).toBeNull();
    const reconciliation = reconcileCompletedChild({
      type: "subagent_lifecycle",
      payload: { id: "child-a", status: "completed" },
    });
    const secondReconciliation = reconcileCompletedChild({
      type: "subagent_lifecycle",
      payload: { id: "child-b", status: "completed" },
    });
    expect(reconciliation).not.toBeNull();
    expect(secondReconciliation).not.toBeNull();
    if (!reconciliation || !secondReconciliation) {
      throw new Error("expected both Pi child transcript reconciliations");
    }
    const [firstFrames] = await Promise.all([reconciliation(), secondReconciliation()]);
    expect(firstFrames).toEqual([{
      type: "subagent_event",
      payload: {
        id: "child-a",
        event: expect.objectContaining({ type: "message_end" }),
      },
    }]);
    const transcriptRequests = requests.filter(
      (request) => request.type === "get_subagent_messages",
    );
    expect(transcriptRequests.filter((request) => request.subagentId === "child-a").map(
      (request) => request.fromByte,
    )).toEqual([0, 100, 100]);
    expect(transcriptRequests.filter((request) => request.subagentId === "child-b").map(
      (request) => request.fromByte,
    )).toEqual([0, 200, 200]);
    await session.dispose();
  }, 2_000);

  test("reassembles protocol-v2 child transcript responses larger than one MiB", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { largeTranscript: true }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    const readSubagentMessages = session.readSubagentMessages?.bind(session);
    if (!readSubagentMessages) throw new Error("expected Pi child transcript reads");
    const page = await readSubagentMessages({ subagentId: "child-a", fromByte: 0 });
    const message = page.messages[0] as { content?: Array<{ text?: string }> } | undefined;
    expect(message?.content?.[0]?.text?.length).toBe(1_100_000);
    await session.dispose();
  }, 2_000);

  test("preserves UTF-8 when a child transcript frame splits inside a multibyte character", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { splitTranscriptUtf8: true }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    const page = await session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 });
    const message = page?.messages[0] as { content?: Array<{ text?: string }> } | undefined;
    expect(message?.content?.[0]?.text).toBe("child final 🚀");
    await session.dispose();
  });

  test("fails and disposes the session when protocol-v2 chunk ordering is corrupt", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { malformedChunk: true }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    await expect(session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 }))
      .rejects.toThrow("rpc chunk sequence must start at index 0");
    await expect(session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 }))
      .rejects.toThrow("Pi RPC session is disposed");
  });

  test("rejects a response without a request id and disposes the session", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { missingResponseId: true }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    await expect(session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 }))
      .rejects.toThrow("missing its request id");
    await expect(session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 }))
      .rejects.toThrow("Pi RPC session is disposed");
  });

  test("dispose rejects an in-flight child transcript read", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { hangChildTranscript: true }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    const pending = session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 });
    await session.dispose();
    await expect(pending).rejects.toThrow("Pi RPC session disposed");
  });

  test("requires protocol-v2 negotiation before using the bridge", async () => {
    const manager = new DefaultPiBridgeManager();
    await expect(manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { negotiatedVersion: 1 }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    })).rejects.toThrow("protocol v2 negotiation failed");
  });

  test("rewinds only the child whose transcript reports a reset", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(requests, { resetChildAOnce: true }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    const reconcile = session.reconcileCompletedChild?.bind(session);
    const childA = reconcile?.({ type: "subagent_lifecycle", payload: { id: "child-a", status: "completed" } });
    const childB = reconcile?.({ type: "subagent_lifecycle", payload: { id: "child-b", status: "completed" } });
    if (!childA || !childB) throw new Error("expected child reconciliation");
    await Promise.all([childA(), childB()]);
    const transcriptRequests = requests.filter((request) => request.type === "get_subagent_messages");
    expect(transcriptRequests.filter((request) => request.subagentId === "child-a").map(
      (request) => request.fromByte,
    )).toEqual([0, 100, 50]);
    expect(transcriptRequests.filter((request) => request.subagentId === "child-b").map(
      (request) => request.fromByte,
    )).toEqual([0, 200, 200]);
    await session.dispose();
  });

  test("clears a timed-out child request and ignores its stale response", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const control: { emit?: (data: string) => Promise<void> } = {};
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(requests, { hangChildTranscript: true, control }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    await expect(session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 }))
      .rejects.toThrow("get_subagent_messages timed out");
    const request = requests.findLast((item) => item.type === "get_subagent_messages");
    if (typeof request?.id !== "string" || !control.emit) throw new Error("expected captured request");
    await control.emit(JSON.stringify({
      type: "response",
      id: request.id,
      command: "get_subagent_messages",
      success: true,
      data: {
        sessionFile: "/sessions/child.jsonl",
        fromByte: 0,
        nextByte: 10,
        reset: false,
        entries: [],
        messages: [],
      },
    }) + "\n");
    await expect(session.command({ kind: "steer", text: "still alive" })).resolves.toBeUndefined();
    await session.dispose();
  }, 3_000);

  test("disposes the bridge on malformed protocol JSON", async () => {
    const control: { emit?: (data: string) => Promise<void> } = {};
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { control }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    if (!control.emit) throw new Error("expected PTY control");
    await control.emit('{"type":\n');
    await expect(session.command({ kind: "steer", text: "must fail" }))
      .rejects.toThrow("Pi RPC session is disposed");
  });

  test("clears pending request state when PTY input fails", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { failRequestType: "steer" }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    await expect(session.command({ kind: "steer", text: "fails immediately" }))
      .rejects.toThrow("PTY send failed");
    await session.dispose();
  });

  test("disposes the bridge when a physical PTY line exceeds the transport cap", async () => {
    const control: { emit?: (data: string) => Promise<void> } = {};
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { control }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    if (!control.emit) throw new Error("expected PTY control");
    await control.emit("🚀".repeat(300_000));
    await expect(session.command({ kind: "steer", text: "must fail" }))
      .rejects.toThrow("Pi RPC session is disposed");
  });

  test("accepts coalesced physical frames when each line stays under the cap", async () => {
    const control: { emit?: (data: string) => Promise<void> } = {};
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { control }),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });
    if (!control.emit) throw new Error("expected PTY control");
    const frame = (name: string) => JSON.stringify({
      type: "available_commands_update",
      commands: [{ name, description: "x".repeat(600_000) }],
    });
    await control.emit(`${frame("a")}\n${frame("b")}\n`);
    await expect(session.command({ kind: "steer", text: "still alive" })).resolves.toBeUndefined();
    await session.dispose();
  });
});
