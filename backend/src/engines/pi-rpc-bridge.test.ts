import { describe, expect, test } from "bun:test";
import { RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { SandboxHandle, SandboxProcess } from "../sandboxes/provider";
import type { ProviderEventInput } from "../runs/provider-events";
import { createPiRpcFrameMapper } from "./pi-canonical";
import { runNativeBridgeTurn } from "./native-bridge-runtime";
import { DefaultPiBridgeManager } from "./pi-rpc-bridge";

interface BridgeTestControl {
  emit?: (data: string) => Promise<void>;
  sent?: string[];
  lifecycle?: string[];
  terminate?: (result?: { exitCode?: number; error?: string }) => void;
  terminations?: Array<(result?: { exitCode?: number; error?: string }) => void>;
  releaseKills?: Array<() => void>;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("test condition did not become true");
}

function sandboxWithBracketedPastePrefix(
  requests: Array<Record<string, unknown>> = [],
  options: {
    readonly largeTranscript?: boolean;
    readonly splitTranscriptUtf8?: boolean;
    readonly malformedChunk?: boolean;
    readonly hangChildTranscript?: boolean;
    readonly resetChildAOnce?: boolean;
    readonly negotiatedVersion?: number;
    readonly readyOnPtyAttempt?: number;
    readonly control?: BridgeTestControl;
    readonly failRequestType?: string;
    readonly hangRequestType?: string;
    readonly terminateOnWait?: { exitCode?: number; error?: string };
    readonly hangConnection?: boolean;
    readonly hangStartupSend?: boolean;
    readonly rejectKill?: boolean;
    readonly deferKill?: boolean;
    readonly deferKillOnPtyAttempt?: number;
  } = {},
): SandboxHandle {
  const encoder = new TextEncoder();
  let nonCanonicalInput = false;
  let childAReset = false;
  let ptyAttempt = 0;
  return {
    id: "cube-box",
    cpu: 2,
    memory: 4,
    state: "started",
    process: {
      async createPty({ onData }: Parameters<SandboxProcess["createPty"]>[0]) {
        ptyAttempt += 1;
        const thisAttempt = ptyAttempt;
        const termination = Promise.withResolvers<{ exitCode?: number; error?: string }>();
        const killRelease = Promise.withResolvers<void>();
        const terminate = (result: { exitCode?: number; error?: string } = {}) => {
          termination.resolve(result);
        };
        options.control?.lifecycle?.push(`create-${thisAttempt}`);
        if (options.control) {
          options.control.emit = async (data) => onData(encoder.encode(data));
          options.control.terminate = terminate;
          options.control.terminations?.push(terminate);
          options.control.releaseKills?.push(killRelease.resolve);
        }
        return {
          async waitForConnection() {
            if (options.hangConnection) await new Promise(() => {});
          },
          async waitForTermination() {
            if (options.terminateOnWait) terminate(options.terminateOnWait);
            return termination.promise;
          },
          async sendInput(input: string | Uint8Array) {
            const text = typeof input === "string" ? input : new TextDecoder().decode(input);
            options.control?.sent?.push(text);
            if (text.startsWith("stty ")) {
              if (options.hangStartupSend) await new Promise(() => {});
              if (thisAttempt < (options.readyOnPtyAttempt ?? 1)) return;
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
            if (request.type === options.hangRequestType) await new Promise(() => {});
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
          async disconnect() {
            options.control?.lifecycle?.push(`disconnect-${thisAttempt}`);
          },
          async kill() {
            options.control?.lifecycle?.push(`kill-${thisAttempt}`);
            if (options.rejectKill) throw new Error("remote kill rejected");
            terminate({ exitCode: 0 });
            if (options.deferKill || options.deferKillOnPtyAttempt === thisAttempt) {
              await killRelease.promise;
            }
          },
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
  test("tolerates a pre-ready shell prompt and terminal control bytes", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(requests, { control: { sent } }),
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
    expect(sent[0]).toContain("exec su -s /bin/sh 'useagent-pi'");
    expect(sent[0]).toContain("/work");
    expect(requests.slice(0, 3).map((request) => request.type)).toEqual([
      "negotiate_protocol",
      "set_subagent_subscription",
      "get_state",
    ]);
    await session.dispose();
  }, 2_000);

  test("launches directly as the current user on a non-root Box runtime", async () => {
    const sent: string[] = [];
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { control: { sent } }),
      workdir: "/home/user/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "box-runtime",
        knowledgeTools: false,
        executable: "/home/user/.useagent/pi-runtime/cli.js",
        bunExecutable: "/home/user/.useagent/pi-runtime/bun",
        runAsUser: null,
        home: "/home/user/.useagent/pi",
      },
    });

    expect(sent[0]).toContain("--cwd '/home/user/work'");
    expect(sent[0]).toContain("HOME='/home/user/.useagent/pi'");
    expect(sent[0]).not.toContain("su -s");
    expect(sent[0]).not.toContain("/root");
    await session.dispose();
  }, 2_000);

  test("retries one readiness timeout after disposing the first PTY", async () => {
    const lifecycle: string[] = [];
    const manager = new DefaultPiBridgeManager(5);
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], {
        readyOnPtyAttempt: 2,
        control: { lifecycle },
      }),
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

    expect(lifecycle.slice(0, 4)).toEqual([
      "create-1",
      "kill-1",
      "disconnect-1",
      "create-2",
    ]);
    await session.dispose();
  });

  test("bounds startup when PTY connection never settles", async () => {
    const manager = new DefaultPiBridgeManager(5, 5);
    const startup = manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { hangConnection: true }),
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

    await expect(Promise.race([
      startup,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startup stayed pending")), 40)),
    ])).rejects.toThrow("RPC readiness timed out");
  });

  test("bounds startup when initial PTY input never settles", async () => {
    const manager = new DefaultPiBridgeManager(5, 5);
    const startup = manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { hangStartupSend: true }),
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

    await expect(Promise.race([
      startup,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startup stayed pending")), 40)),
    ])).rejects.toThrow("RPC readiness timed out");
  });

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

  test("an id-less response rejects concurrent matching commands without guessing", async () => {
    const control: { emit?: (data: string) => Promise<void> } = {};
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { hangChildTranscript: true, control }),
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
    const first = session.readSubagentMessages?.({ subagentId: "child-a", fromByte: 0 });
    const second = session.readSubagentMessages?.({ subagentId: "child-b", fromByte: 0 });
    if (!first || !second || !control.emit) throw new Error("expected concurrent requests");
    const settled = Promise.allSettled([first, second]);
    await control.emit(JSON.stringify({
      type: "response",
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
    const outcomes = await settled;
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect(outcome.status === "rejected" ? String(outcome.reason) : "")
        .toContain("Pi RPC get_subagent_messages response is missing its request id");
    }
    await expect(session.command({ kind: "steer", text: "session is poisoned" }))
      .rejects.toThrow("Pi RPC session is disposed");
  });

  test("isolates a throwing frame listener from the PTY and pending requests", async () => {
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
    session.subscribe(() => {
      throw new Error("listener failed");
    });
    const received: unknown[] = [];
    session.subscribe((frame) => received.push(frame));
    if (!control.emit) throw new Error("expected PTY control");
    await expect(control.emit(JSON.stringify({
      type: "available_commands_update",
      commands: [],
    }) + "\n")).resolves.toBeUndefined();
    expect(received).toContainEqual({ type: "available_commands_update", commands: [] });
    await expect(session.command({ kind: "steer", text: "still alive" })).resolves.toBeUndefined();
    await session.dispose();
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
    expect(manager.get(session.sessionFile)).toBeUndefined();
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

  test("fails startup promptly when the PTY terminates during a pending command write", async () => {
    const control: BridgeTestControl = { sent: [] };
    const manager = new DefaultPiBridgeManager();
    const startedAt = performance.now();
    const startup = manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { control, hangStartupSend: true }),
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
    await waitUntil(() => Boolean(control.sent?.some((value) => value.startsWith("stty "))));
    control.terminate?.({ exitCode: 17 });

    await expect(Promise.race([
      startup,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startup stayed pending")), 250)),
    ])).rejects.toThrow("Pi RPC process exited unexpectedly (code 17)");
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("unexpected PTY termination fails an active native bridge turn exactly once", async () => {
    const control: BridgeTestControl = { sent: [] };
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { control, hangRequestType: "prompt" }),
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
    const captured: ProviderEventInput[] = [];
    const turn = runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
        reportActivity: () => {},
      } as never,
      driver: {
        steer: async () => {
          await session.command({ kind: "prompt", text: "keep working" });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: session.sessionFile } as never,
      bridge: session,
      prompt: "keep working",
      mapFrame: createPiRpcFrameMapper("pi-message-run"),
      redact: { text: (value) => value, unknown: (value) => value },
    }, async (event) => {
      captured.push(event);
    });
    while (!control.sent?.some((value) => value.includes('"type":"prompt"'))) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    control.terminate?.({ error: "provider-secret-transport-detail" });

    await expect(Promise.race([
      turn,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("turn stayed pending")), 250)),
    ])).rejects.toThrow("Pi RPC transport closed with an error");
    expect(captured.filter((event) => event.eventType === "pi.turn.failed")).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain("provider-secret-transport-detail");
    expect(manager.get(session.sessionFile)).toBeUndefined();
  });

  test("intentional disposal emits no protocol error and evicts the session", async () => {
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
    const frames: unknown[] = [];
    session.subscribe((frame) => frames.push(frame));

    await session.dispose();

    expect(frames.filter((frame) => (frame as { type?: string }).type === "rpc_frame_error"))
      .toHaveLength(0);
    expect(manager.get(session.sessionFile)).toBeUndefined();
  });

  test("waits for remote kill before resuming the same durable session file", async () => {
    const sent: string[] = [];
    const lifecycle: string[] = [];
    const terminations: Array<(result?: { exitCode?: number; error?: string }) => void> = [];
    const releaseKills: Array<() => void> = [];
    const control: BridgeTestControl = { sent, lifecycle, terminations, releaseKills };
    const sandbox = sandboxWithBracketedPastePrefix([], { control, deferKill: true });
    const manager = new DefaultPiBridgeManager();
    const runtime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const first = await manager.ensure({ sandbox, workdir: "/work", runtime });
    terminations[0]?.({ exitCode: 9 });
    await waitUntil(() => manager.get(first.sessionFile) === undefined);
    expect(manager.get(first.sessionFile)).toBeUndefined();

    const replacementPromise = manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    });
    await Promise.resolve();
    expect(lifecycle.filter((value) => value.startsWith("create-"))).toEqual(["create-1"]);
    releaseKills[0]?.();

    const replacement = await replacementPromise;
    expect(replacement).not.toBe(first);
    const resumedCommand = sent.filter((value) => value.startsWith("stty "))[1];
    expect(resumedCommand).toContain("--resume");
    expect(resumedCommand).toContain(first.sessionFile);

    await waitUntil(() => lifecycle.includes("disconnect-1"));
    await Promise.resolve();
    expect(manager.get(first.sessionFile)).toBe(replacement);

    const disposed = replacement.dispose();
    releaseKills[1]?.();
    await disposed;
  });

  test("refuses native resume when remote kill rejects", async () => {
    const lifecycle: string[] = [];
    const control: BridgeTestControl = { lifecycle };
    const sandbox = sandboxWithBracketedPastePrefix([], { control, rejectKill: true });
    const manager = new DefaultPiBridgeManager();
    const runtime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const first = await manager.ensure({ sandbox, workdir: "/work", runtime });
    control.terminate?.({ error: "socket closed" });
    await waitUntil(() => manager.get(first.sessionFile) === undefined);

    await expect(manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    })).rejects.toThrow("Pi RPC remote teardown failed; refusing native resume");
    expect(lifecycle.filter((value) => value.startsWith("create-"))).toEqual(["create-1"]);
  });

  test("times out remote teardown and keeps native resume fenced", async () => {
    const lifecycle: string[] = [];
    const releaseKills: Array<() => void> = [];
    const control: BridgeTestControl = { lifecycle, releaseKills };
    const sandbox = sandboxWithBracketedPastePrefix([], { control, deferKill: true });
    const manager = new DefaultPiBridgeManager(30_000, 5);
    const runtime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const first = await manager.ensure({ sandbox, workdir: "/work", runtime });
    control.terminate?.({ exitCode: 9 });
    await waitUntil(() => manager.get(first.sessionFile) === undefined);

    await expect(manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    })).rejects.toThrow("Pi RPC remote teardown timed out; refusing native resume");
    expect(lifecycle.filter((value) => value.startsWith("create-"))).toEqual(["create-1"]);

    releaseKills[0]?.();
    await waitUntil(() => lifecycle.includes("disconnect-1"));
  });

  test("keeps resume fenced when transport closure lacks a confirmed remote exit", async () => {
    const lifecycle: string[] = [];
    const control: BridgeTestControl = { lifecycle };
    const sandbox = sandboxWithBracketedPastePrefix([], { control });
    const manager = new DefaultPiBridgeManager();
    const runtime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const first = await manager.ensure({ sandbox, workdir: "/work", runtime });
    control.terminate?.({ error: "provider-secret-transport-detail" });
    await waitUntil(() => manager.get(first.sessionFile) === undefined);

    await expect(manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    })).rejects.toThrow("Pi RPC remote exit could not be confirmed; refusing native resume");
    expect(lifecycle.filter((value) => value.startsWith("create-"))).toEqual(["create-1"]);
  });

  test("does not retry startup when cleanup cannot confirm remote exit", async () => {
    const manager = new DefaultPiBridgeManager(5, 5);
    const initialRuntime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime-1",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const first = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(),
      workdir: "/work",
      runtime: initialRuntime,
    });
    const lifecycle: string[] = [];
    const releaseKills: Array<() => void> = [];
    const retrySandbox = sandboxWithBracketedPastePrefix([], {
      readyOnPtyAttempt: 2,
      deferKillOnPtyAttempt: 1,
      control: { lifecycle, releaseKills },
    });

    await expect(manager.ensure({
      sandbox: retrySandbox,
      workdir: "/work",
      runtime: { ...initialRuntime, fingerprint: "runtime-2" },
      resumeSessionFile: first.sessionFile,
    })).rejects.toThrow("Pi RPC remote teardown timed out; refusing native resume");
    expect(lifecycle.filter((value) => value.startsWith("create-"))).toEqual(["create-1"]);

    await expect(manager.awaitTeardown(first.sessionFile))
      .rejects.toThrow("Pi RPC remote teardown timed out; refusing native resume");
    releaseKills[0]?.();
    await waitUntil(() => lifecycle.includes("disconnect-1"));
  });

  test("request timeout remains bounded while PTY input never settles", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix([], { hangRequestType: "get_subagent_messages" }),
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
    await session.dispose();
  }, 3_000);

  test("a BEL-prefixed terminal agent_end frame completes the native bridge turn", async () => {
    const control: BridgeTestControl = { sent: [] };
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
    const captured: ProviderEventInput[] = [];
    const turn = runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
        reportActivity: () => {},
      } as never,
      driver: {
        steer: async () => {
          await session.command({ kind: "prompt", text: "finish" });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: session.sessionFile } as never,
      bridge: session,
      prompt: "finish",
      mapFrame: createPiRpcFrameMapper("pi-message-run"),
      redact: { text: (value) => value, unknown: (value) => value },
    }, async (event) => {
      captured.push(event);
    });
    await waitUntil(() => Boolean(
      control.sent?.some((value) => value.includes('"type":"prompt"')),
    ));
    await control.emit?.('\u0007{"type":"agent_end","isTerminal":true,"messages":[]}\n');

    await expect(turn).resolves.toBe("");
    expect(captured.filter((event) => event.eventType === "pi.turn.completed")).toHaveLength(1);
    await session.dispose();
  });

  test("fails on non-JSON output after readiness instead of dropping it", async () => {
    const control: BridgeTestControl = {};
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
    const frames: unknown[] = [];
    session.subscribe((frame) => frames.push(frame));
    await control.emit?.("native process wrote plain text\n");

    expect(frames).toContainEqual({
      type: "rpc_frame_error",
      error: "Pi RPC frame decode failed: unexpected non-JSON Pi RPC output",
    });
    expect(manager.get(session.sessionFile)).toBeUndefined();
  });
});
