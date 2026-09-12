import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_RPC_FRAME_BYTES, RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { SandboxHandle, SandboxProcess } from "../sandboxes/provider";
import type { ProviderEventInput } from "../runs/provider-events";
import { createPiRpcFrameMapper } from "./pi-canonical";
import { runNativeBridgeTurn } from "./native-bridge-runtime";
import { DefaultPiBridgeManager } from "./pi-rpc-bridge";
import {
  cleanupOwnedPiTransports,
  piProcessSessionPrefix,
  processSessionTransportAvailable,
  ProcessSessionPiRpcTransport,
} from "./pi-rpc-transport";

interface BridgeTestControl {
  emit?: (data: string) => Promise<void>;
  sent?: string[];
  lifecycle?: string[];
  terminate?: (result?: { exitCode?: number; error?: string }) => void;
  terminations?: Array<(result?: { exitCode?: number; error?: string }) => void>;
  releaseKills?: Array<() => void>;
}

interface ProcessSessionTestControl {
  readonly sent: string[];
  readonly lifecycle: string[];
  readonly stdoutReadOffsets: number[];
  readonly stdoutReadLengths: number[];
  appendStdout(stdout: string | Buffer): void;
  appendStderr(stderr: string): void;
  interruptNextStdoutReadAt(offset: number): void;
  releaseCreate(): void;
  releaseExecute(): void;
  writerAlive(): boolean;
  exitProcess(exitCode: number): void;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
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

function processSessionSandbox(options: {
  failDelete?: boolean;
  hangExecuteSessionCommand?: boolean;
  deferCreateSession?: boolean;
  deferExecuteSessionCommand?: boolean;
  initialStdout?: Buffer;
  noOpDelete?: boolean;
  failInventoryAfterDelete?: boolean;
  reportedStdoutSize?: number;
} = {}): {
  sandbox: SandboxHandle;
  control: ProcessSessionTestControl;
} {
  const readyOutput = Buffer.from(JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1_048_576,
    maxReassembledFrameBytes: 67_108_864,
  }) + "\n");
  let storedStdout = options.initialStdout ?? readyOutput;
  let storedStderr = Buffer.alloc(0);
  let stdoutPath = "";
  let stderrPath = "";
  const sent: string[] = [];
  const lifecycle: string[] = [];
  const stdoutReadOffsets: number[] = [];
  const stdoutReadLengths: number[] = [];
  const interruptedStdoutOffsets = new Set<number>();
  const processSessionIds = new Set<string>();
  const spoolFiles = new Set<string>();
  const createRelease = Promise.withResolvers<void>();
  const executeRelease = Promise.withResolvers<void>();
  let writerAlive = false;
  let deleteAttempted = false;
  const command = { id: "command-1", exitCode: undefined as number | undefined };
  const appendResponse = (request: { id: string; type: string }): void => {
    const data = request.type === "get_state"
      ? { sessionId: "pi-session", sessionFile: "/home/useagent-pi/agent/sessions/pi.jsonl" }
      : request.type === "negotiate_protocol"
        ? { protocolVersion: 2 }
        : { level: "events" };
    const line = JSON.stringify({
      type: "response",
      id: request.id,
      command: request.type,
      success: true,
      data,
    }) + "\n";
    storedStdout = Buffer.concat([storedStdout, Buffer.from(line)]);
  };
  const process = {
    async executeCommand(commandText: string) {
      lifecycle.push("execute-command");
      if (commandText.startsWith("rm -f -- ")) {
        lifecycle.push("remove-spool");
        for (const match of commandText.matchAll(/'([^']+\.(?:stdout|stderr))'/gu)) {
          spoolFiles.delete(match[1]!);
        }
        storedStdout = Buffer.alloc(0);
        storedStderr = Buffer.alloc(0);
        return { exitCode: 0, result: "" };
      }
      if (commandText.includes("-printf")) {
        lifecycle.push("inventory-spool");
        return {
          exitCode: 0,
          result: [...spoolFiles].map((path) => path.slice(path.lastIndexOf("/") + 1)).join("\n"),
        };
      }
      const stream = commandText.includes(".stdout'") ? "stdout" :
        commandText.includes(".stderr'") ? "stderr" : null;
      const offsetMatch = commandText.match(/skip=(\d+)/u);
      if (!stream || !offsetMatch) return { exitCode: 1, result: "unexpected command" };
      const offset = Number(offsetMatch[1]);
      if (stream === "stdout") {
        stdoutReadOffsets.push(offset);
        if (interruptedStdoutOffsets.delete(offset)) return { exitCode: 1, result: "interrupted" };
      }
      const contents = stream === "stdout" ? storedStdout : storedStderr;
      const bytes = contents.subarray(offset, offset + 256 * 1024);
      if (bytes.byteLength === 0 && commandText.startsWith("i=0;")) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (stream === "stdout") stdoutReadLengths.push(bytes.byteLength);
      return {
        exitCode: 0,
        result: JSON.stringify({
          size: stream === "stdout" && options.reportedStdoutSize !== undefined
            ? options.reportedStdoutSize
            : contents.byteLength,
          length: bytes.byteLength,
          data: bytes.toString("base64"),
        }),
      };
    },
    async createSession(sessionId: string) {
      lifecycle.push("create-session");
      lifecycle.push(`create:${sessionId}`);
      processSessionIds.add(sessionId);
      if (options.deferCreateSession) await createRelease.promise;
    },
    async deleteSession(sessionId: string) {
      lifecycle.push("delete-session");
      lifecycle.push(`delete:${sessionId}`);
      deleteAttempted = true;
      if (options.failDelete) throw new Error("delete rejected");
      if (!processSessionIds.has(sessionId)) throw new Error("session not found");
      if (options.noOpDelete) return;
      processSessionIds.delete(sessionId);
      command.exitCode = 0;
      writerAlive = false;
    },
    async getSession(sessionId: string) {
      lifecycle.push("get-session");
      if (!processSessionIds.has(sessionId)) throw new Error("session not found");
      return { commands: [{ id: command.id }] };
    },
    async getSessionCommand(sessionId: string, commandId: string) {
      lifecycle.push("get-session-command");
      if (!processSessionIds.has(sessionId) || commandId !== command.id) throw new Error("command not found");
      return { ...command };
    },
    async executeSessionCommand(_sessionId: string, request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean }) {
      lifecycle.push("execute-session-command");
      expect(request.runAsync).toBe(true);
      expect(request.suppressInputEcho).toBe(true);
      expect(request.command).not.toContain("stty");
      expect(request.command).toContain("umask 077");
      expect(request.command).toContain("install -d -m 700 '/root/.useagent/pi-rpc-output'");
      const paths = request.command.match(/exec 3>'([^']+\.stdout)' 4>'([^']+\.stderr)'/u);
      expect(paths).not.toBeNull();
      stdoutPath = paths![1]!;
      stderrPath = paths![2]!;
      spoolFiles.add(stdoutPath);
      spoolFiles.add(stderrPath);
      expect(stdoutPath.replace(/\.stdout$/u, "")).toBe(stderrPath.replace(/\.stderr$/u, ""));
      expect(request.command).toContain("; ( exec su -s /bin/sh 'useagent-pi'");
      expect(request.command).toEndWith(") >&3 2>&4");
      if (storedStdout.byteLength === 0) storedStdout = readyOutput;
      command.exitCode = undefined;
      if (options.hangExecuteSessionCommand) await new Promise(() => {});
      if (options.deferExecuteSessionCommand) await executeRelease.promise;
      writerAlive = true;
      lifecycle.push("execute-session-command:done");
      return { cmdId: command.id };
    },
    async getSessionCommandLogs() {
      throw new Error("full stored-log reads are forbidden for Pi transport");
    },
    async sendSessionCommandInput(_sessionId: string, _commandId: string, data: string) {
      sent.push(data);
      appendResponse(JSON.parse(data) as { id: string; type: string });
    },
    async listSessions() {
      lifecycle.push("list-sessions");
      if (deleteAttempted && options.failInventoryAfterDelete) throw new Error("inventory timed out");
      return [...processSessionIds].map((sessionId) => ({ sessionId, commands: [] }));
    },
    async listPtySessions() {
      lifecycle.push("list-ptys");
      return [];
    },
    async killPtySession() {},
    async createPty() {
      throw new Error("process-session capable sandboxes must not create a PTY");
    },
  } as unknown as SandboxProcess;
  return {
    sandbox: {
      id: "daytona",
      providerKind: "daytona",
      cpu: 2,
      memory: 4,
      state: "started",
      process,
      fs: {} as SandboxHandle["fs"],
      async start() {},
      async delete() {},
      async getPreviewLink() {
        return { url: "https://example.test" };
      },
    },
    control: {
      sent,
      lifecycle,
      stdoutReadOffsets,
      stdoutReadLengths,
      appendStdout(stdout) {
        const bytes = typeof stdout === "string" ? Buffer.from(stdout) : stdout;
        storedStdout = Buffer.concat([storedStdout, bytes]);
      },
      appendStderr(stderr) {
        storedStderr = Buffer.concat([storedStderr, Buffer.from(stderr)]);
      },
      interruptNextStdoutReadAt(offset) {
        interruptedStdoutOffsets.add(offset);
      },
      releaseCreate() {
        createRelease.resolve();
      },
      releaseExecute() {
        executeRelease.resolve();
      },
      writerAlive() {
        return writerAlive;
      },
      exitProcess(exitCode) {
        command.exitCode = exitCode;
        writerAlive = false;
      },
    },
  };
}

function exactProcessSessionBurst(): string {
  const targetBytes = 15_457_260;
  const frames: string[] = [];
  const encoder = new RpcFrameEncoder();
  const add = (frame: object): void => {
    for (const line of encoder.encodeFrames(frame)) frames.push(line);
  };
  add({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1_048_576,
    maxReassembledFrameBytes: 67_108_864,
  });
  encoder.setProtocolVersion(2);
  add({ type: "agent_start" });
  const delta = "d".repeat(8_192);
  const thinking = "t".repeat(2 * 1024 * 1024);
  const text = "f".repeat(2 * 1024 * 1024) + "::PI_DIAG_TERMINAL::";
  const assistant = {
    role: "assistant",
    timestamp: 1_788_571_200_000,
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    content: [{ type: "thinking", thinking }, { type: "text", text }],
  };
  add({ type: "message_start", message: { role: "assistant", timestamp: 1_788_571_200_000, content: [] } });
  for (let index = 0; index < 512; index++) {
    add({
      type: "message_update",
      message: { role: "assistant", timestamp: 1_788_571_200_000 },
      assistantMessageEvent: { type: "thinking_delta", delta },
    });
  }
  add({ type: "message_end", message: assistant });
  add({ type: "turn_end", message: assistant, toolResults: [] });
  add({ type: "agent_end", isTerminal: true, messages: [assistant] });
  add({ type: "diagnostic_end", marker: "PI_DIAG_AFTER_AGENT_END" });
  const burst = frames.join("");
  expect(Buffer.byteLength(burst)).toBe(targetBytes);
  expect(frames).toHaveLength(551);
  expect(new Bun.CryptoHasher("sha256").update(burst).digest("hex"))
    .toBe("8d6956e1e9c182b024a5abe56b9bc4e9f7a368b4f1b11ec3b86376f3b792666e");
  return burst;
}

describe("Pi RPC frame parsing", () => {
  test("requires authoritative per-command status for the process-session transport", () => {
    expect(processSessionTransportAvailable({
      sendSessionCommandInput: async () => {},
    } as unknown as SandboxProcess)).toBe(false);
    expect(processSessionTransportAvailable({
      getSessionCommand: async (_sessionId: string, commandId: string) => ({ id: commandId }),
      sendSessionCommandInput: async () => {},
    } as unknown as SandboxProcess)).toBe(true);
  });

  test("restart cleanup deletes only namespaced Pi sessions and legacy Pi PTYs", async () => {
    const sandboxId = "retained-daytona";
    const owned = `${piProcessSessionPrefix(sandboxId)}00000000-0000-4000-8000-000000000000`;
    const deleted: string[] = [];
    const killed: string[] = [];
    const commands: string[] = [];
    const actions: string[] = [];
    const sandbox = {
      id: sandboxId,
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.includes("-printf")) {
            actions.push("inventory-spool");
            return { exitCode: 0, result: `${owned}.stdout\n${owned}.stderr\n` };
          }
          actions.push("remove-spool");
          return { exitCode: 0, result: "" };
        },
        sendSessionCommandInput: async () => {},
        listSessions: async () => [
          ...(deleted.includes(owned) ? [] : [{ sessionId: owned, commands: [] }]),
          { sessionId: "user-terminal-process", commands: [] },
        ],
        deleteSession: async (sessionId: string) => {
          actions.push("delete-session");
          deleted.push(sessionId);
        },
        listPtySessions: async () => [
          { id: "useagent-pi-legacy-writer" },
          { id: "user-terminal-pty" },
        ],
        killPtySession: async (sessionId: string) => {
          actions.push("kill-pty");
          killed.push(sessionId);
        },
      },
    } as unknown as SandboxHandle;

    await cleanupOwnedPiTransports(sandbox);

    expect(deleted).toEqual([owned]);
    expect(killed).toEqual(["useagent-pi-legacy-writer"]);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain(`${owned}.stdout`);
    expect(commands[1]).toContain(`${owned}.stderr`);
    expect(commands[1]).not.toContain("*");
    expect(commands[1]).not.toContain(".jsonl");
    expect(actions).toEqual(["inventory-spool", "delete-session", "kill-pty", "remove-spool"]);
    expect(deleted).toHaveLength(1);
    expect(killed).toHaveLength(1);
  });

  test("restart cleanup fails closed when process-session inventory is unavailable", async () => {
    const sandbox = {
      id: "retained-daytona",
      process: {
        followSessionCommandLogs: async () => {},
        sendSessionCommandInput: async () => {},
      },
    } as unknown as SandboxHandle;

    await expect(cleanupOwnedPiTransports(sandbox))
      .rejects.toThrow("Pi process-session cleanup capability is unavailable");
  });

  test("restart cleanup bounds hung inventory and deletion", async () => {
    const owned = `${piProcessSessionPrefix("retained-daytona")}00000000-0000-4000-8000-000000000000`;
    const base = {
      id: "retained-daytona",
      process: {
        followSessionCommandLogs: async () => {},
        sendSessionCommandInput: async () => {},
        executeCommand: async () => ({ exitCode: 0, result: "" }),
        listPtySessions: async () => [],
        killPtySession: async () => {},
      },
    };
    const hungInventory = {
      ...base,
      process: {
        ...base.process,
        listSessions: () => new Promise<never>(() => {}),
        deleteSession: async () => {},
      },
    } as unknown as SandboxHandle;
    await expect(cleanupOwnedPiTransports(hungInventory, { timeoutMs: 5 }))
      .rejects.toThrow("Pi remote cleanup timed out");

    const hungDelete = {
      ...base,
      process: {
        ...base.process,
        listSessions: async () => [{ sessionId: owned, commands: [] }],
        deleteSession: () => new Promise<never>(() => {}),
      },
    } as unknown as SandboxHandle;
    await expect(cleanupOwnedPiTransports(hungDelete, { timeoutMs: 5 }))
      .rejects.toThrow("Pi remote cleanup timed out");
  });

  test("expired cleanup deadlines dispatch no remote operation", async () => {
    let inventoryCalls = 0;
    let commandCalls = 0;
    const sandbox = {
      id: "retained-daytona",
      process: {
        executeCommand: async () => {
          commandCalls += 1;
          return { exitCode: 0, result: "" };
        },
        sendSessionCommandInput: async () => {},
        listSessions: async () => {
          inventoryCalls += 1;
          return [];
        },
        listPtySessions: async () => [],
        deleteSession: async () => {},
        killPtySession: async () => {},
      },
    } as unknown as SandboxHandle;

    await expect(cleanupOwnedPiTransports(sandbox, { timeoutMs: 0 }))
      .rejects.toThrow("Pi remote cleanup timed out");
    expect(inventoryCalls).toBe(0);
    expect(commandCalls).toBe(0);
  });

  test("a timed-out old-session deletion never dispatches spool removal for a future id", async () => {
    const oldSession = `${piProcessSessionPrefix("retained-daytona")}00000000-0000-4000-8000-000000000000`;
    const futureSession = `${piProcessSessionPrefix("retained-daytona")}11111111-1111-4111-8111-111111111111`;
    const releaseDelete = Promise.withResolvers<void>();
    const commands: string[] = [];
    const sandbox = {
      id: "retained-daytona",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return command.includes("-printf")
            ? { exitCode: 0, result: `${oldSession}.stdout\n${oldSession}.stderr\n` }
            : { exitCode: 0, result: "" };
        },
        sendSessionCommandInput: async () => {},
        listSessions: async () => [{ sessionId: oldSession, commands: [] }],
        listPtySessions: async () => [],
        deleteSession: async () => { await releaseDelete.promise; },
        killPtySession: async () => {},
      },
    } as unknown as SandboxHandle;

    await expect(cleanupOwnedPiTransports(sandbox, { timeoutMs: 5 }))
      .rejects.toThrow("Pi remote cleanup timed out");
    releaseDelete.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("-printf");
    expect(commands[0]).not.toStartWith("rm -f -- ");
    expect(commands.join(" ")).not.toContain(futureSession);
  });

  test("a retry removes captured orphan spools after a transient legacy PTY failure", async () => {
    const sandboxId = "retained-daytona";
    const oldSession = `${piProcessSessionPrefix(sandboxId)}00000000-0000-4000-8000-000000000000`;
    const sessions = new Set([oldSession]);
    const spoolFiles = new Set([`${oldSession}.stdout`, `${oldSession}.stderr`]);
    let ptyPresent = true;
    let failPtyOnce = true;
    const removals: string[] = [];
    const sandbox = {
      id: sandboxId,
      process: {
        sendSessionCommandInput: async () => {},
        listSessions: async () => [...sessions].map((sessionId) => ({ sessionId, commands: [] })),
        listPtySessions: async () => ptyPresent ? [{ id: "useagent-pi-legacy-writer" }] : [],
        deleteSession: async (sessionId: string) => { sessions.delete(sessionId); },
        killPtySession: async () => {
          if (failPtyOnce) {
            failPtyOnce = false;
            throw new Error("transient PTY failure");
          }
          ptyPresent = false;
        },
        executeCommand: async (command: string) => {
          if (command.includes("-printf")) {
            return { exitCode: 0, result: [...spoolFiles].join("\n") };
          }
          removals.push(command);
          for (const file of [...spoolFiles]) {
            if (command.includes(file)) spoolFiles.delete(file);
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await expect(cleanupOwnedPiTransports(sandbox)).rejects.toThrow("transient PTY failure");
    expect(sessions.size).toBe(0);
    expect(spoolFiles.size).toBe(2);
    expect(removals).toEqual([]);

    await cleanupOwnedPiTransports(sandbox);
    expect(spoolFiles.size).toBe(0);
    expect(removals).toHaveLength(1);
  });

  test("cleanup discovers and removes a crash orphan with no remaining session", async () => {
    const sandboxId = "retained-daytona";
    const orphan = `${piProcessSessionPrefix(sandboxId)}00000000-0000-4000-8000-000000000000`;
    const commands: string[] = [];
    const sandbox = {
      id: sandboxId,
      process: {
        sendSessionCommandInput: async () => {},
        listSessions: async () => [],
        listPtySessions: async () => [],
        deleteSession: async () => {},
        killPtySession: async () => {},
        executeCommand: async (command: string) => {
          commands.push(command);
          return command.includes("-printf")
            ? { exitCode: 0, result: `${orphan}.stdout\n${orphan}.stderr\n` }
            : { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await cleanupOwnedPiTransports(sandbox);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain(`${orphan}.stdout`);
    expect(commands[1]).toContain(`${orphan}.stderr`);
    expect(commands[1]).not.toContain(".jsonl");
  });

  test("a late exact removal preserves a replacement UUID absent from its snapshot", async () => {
    const sandboxId = "retained-daytona";
    const oldSession = `${piProcessSessionPrefix(sandboxId)}00000000-0000-4000-8000-000000000000`;
    const replacement = `${piProcessSessionPrefix(sandboxId)}11111111-1111-4111-8111-111111111111`;
    const files = new Set([`${oldSession}.stdout`, `${oldSession}.stderr`]);
    const releaseRemoval = Promise.withResolvers<void>();
    const sandbox = {
      id: sandboxId,
      process: {
        sendSessionCommandInput: async () => {},
        listSessions: async () => [],
        listPtySessions: async () => [],
        deleteSession: async () => {},
        killPtySession: async () => {},
        executeCommand: async (command: string) => {
          if (command.includes("-printf")) {
            return { exitCode: 0, result: [...files].join("\n") };
          }
          await releaseRemoval.promise;
          for (const file of [...files]) {
            if (command.includes(file)) files.delete(file);
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await expect(cleanupOwnedPiTransports(sandbox, { timeoutMs: 5 }))
      .rejects.toThrow("Pi remote cleanup timed out");
    files.add(`${replacement}.stdout`);
    files.add(`${replacement}.stderr`);
    releaseRemoval.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(files).toEqual(new Set([`${replacement}.stdout`, `${replacement}.stderr`]));
  });

  test("cleanup rejects invalid or over-limit spool inventories before mutation", async () => {
    const sandboxId = "retained-daytona";
    const prefix = piProcessSessionPrefix(sandboxId);
    let deletes = 0;
    const inventoryResults = [
      `${prefix}not-a-uuid.stdout`,
      Array.from({ length: 257 }, (_, index) =>
        `${prefix}00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}.stdout`
      ).join("\n"),
    ];
    const sandbox = {
      id: sandboxId,
      process: {
        sendSessionCommandInput: async () => {},
        listSessions: async () => [],
        listPtySessions: async () => [],
        deleteSession: async () => { deletes += 1; },
        killPtySession: async () => {},
        executeCommand: async () => ({ exitCode: 0, result: inventoryResults.shift() ?? "" }),
      },
    } as unknown as SandboxHandle;

    await expect(cleanupOwnedPiTransports(sandbox)).rejects.toThrow("inventory is invalid");
    await expect(cleanupOwnedPiTransports(sandbox)).rejects.toThrow("inventory exceeds the cleanup limit");
    expect(deletes).toBe(0);
  });

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
    const manager = new DefaultPiBridgeManager(5, 5);
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

  test("reads the exact 551-frame spool with bounded offset reads and resumes an interrupted offset", async () => {
    const burst = exactProcessSessionBurst();
    const { sandbox, control } = processSessionSandbox({ initialStdout: Buffer.from(burst) });
    control.interruptNextStdoutReadAt(2 * 256 * 1024);
    const delivered: Buffer[] = [];
    const processSessionId = `${piProcessSessionPrefix(sandbox.id)}00000000-0000-4000-8000-000000000000`;
    const transport = new ProcessSessionPiRpcTransport(
      sandbox.process,
      processSessionId,
      "exec su -s /bin/sh 'useagent-pi' -c 'exec pi --mode rpc'",
      (data) => delivered.push(Buffer.from(data)),
    );

    await transport.start();
    await waitUntil(() => delivered.length === 551);
    const reconstructed = Buffer.concat(delivered);
    expect(reconstructed.byteLength).toBe(15_457_260);
    expect(createHash("sha256").update(reconstructed).digest("hex"))
      .toBe("8d6956e1e9c182b024a5abe56b9bc4e9f7a368b4f1b11ec3b86376f3b792666e");
    expect(control.stdoutReadLengths.every((length) => length <= 256 * 1024)).toBe(true);
    expect(control.stdoutReadOffsets.filter((offset) => offset === 2 * 256 * 1024)).toHaveLength(2);
    expect(control.writerAlive()).toBe(true);
    const terminalWhileAlive = await Promise.race([
      transport.waitForTermination().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
    ]);
    expect(terminalWhileAlive).toBe(false);

    control.exitProcess(0);
    expect(await transport.waitForTermination()).toEqual({ exitCode: 0 });
    await transport.teardown();
    expect(control.lifecycle.indexOf("delete-session"))
      .toBeLessThan(control.lifecycle.indexOf("remove-spool"));
  });

  test("preserves UTF-8 across bounded spool reads and legitimate replacement characters", async () => {
    const { sandbox, control } = processSessionSandbox();
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox,
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
    const frames: Array<Record<string, unknown>> = [];
    session.subscribe((frame) => frames.push(frame as Record<string, unknown>));
    await waitUntil(() => control.stdoutReadLengths.at(-1) === 0);
    const prefix = '{"type":"diagnostic","text":"';
    const unicodeText = "x".repeat(256 * 1024 - Buffer.byteLength(prefix) - 1) + "🚀 after";
    const unicodeFrame = JSON.stringify({ type: "diagnostic", text: unicodeText }) + "\n";
    control.appendStdout(unicodeFrame);
    await waitUntil(() => frames.length === 1);
    expect(frames).toEqual([{ type: "diagnostic", text: unicodeText }]);

    const replacementFrame = JSON.stringify({ type: "diagnostic", text: "literal � value" }) + "\n";
    control.appendStdout(replacementFrame);
    await waitUntil(() => frames.length === 2);
    expect(frames).toEqual([
      { type: "diagnostic", text: unicodeText },
      { type: "diagnostic", text: "literal � value" },
    ]);
    const continuedFrame = JSON.stringify({ type: "diagnostic", text: "continued" }) + "\n";
    control.appendStdout(continuedFrame);
    await waitUntil(() => frames.length === 3);
    expect(frames.at(-1)).toEqual({ type: "diagnostic", text: "continued" });
    await session.dispose();
  });

  test("leaves a stored non-LF tail outside the prefix until the physical frame completes", async () => {
    const { sandbox, control } = processSessionSandbox();
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox,
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
    const frames: Array<Record<string, unknown>> = [];
    session.subscribe((frame) => frames.push(frame as Record<string, unknown>));
    const frame = JSON.stringify({ type: "diagnostic", text: "partial 🚀 frame" }) + "\n";
    const splitAt = frame.indexOf("🚀");

    control.appendStdout(frame.slice(0, splitAt));
    await waitUntil(() => control.stdoutReadLengths.at(-1) === Buffer.byteLength(frame.slice(0, splitAt)));
    expect(frames).toEqual([]);

    control.appendStdout(frame.slice(splitAt));
    await waitUntil(() => frames.length === 1);
    expect(frames).toEqual([{ type: "diagnostic", text: "partial 🚀 frame" }]);
    await session.dispose();
  });

  test("drains every remaining bounded page after observing process exit", async () => {
    const { sandbox, control } = processSessionSandbox();
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox,
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
    const output = [
      ...Array.from({ length: 3 }, (_, index) =>
        JSON.stringify({ type: "diagnostic", index, text: "x".repeat(300_000) }) + "\n"
      ),
      JSON.stringify({ type: "agent_end", isTerminal: true, messages: [] }) + "\n",
    ].join("");
    expect(Buffer.byteLength(output)).toBeGreaterThan(3 * 256 * 1024);
    control.appendStdout(output);
    control.exitProcess(0);

    await waitUntil(() => control.lifecycle.includes("delete-session"));
    expect(frames.filter((frame) => (frame as { type?: string }).type === "diagnostic"))
      .toHaveLength(3);
    expect(frames).toContainEqual({ type: "agent_end", isTerminal: true, messages: [] });
    expect(control.stdoutReadLengths.every((length) => length <= 256 * 1024)).toBe(true);
  });

  test("fails closed when the process exits without a native terminal frame", async () => {
    const { sandbox, control } = processSessionSandbox();
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox,
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

    control.exitProcess(0);
    await waitUntil(() => frames.some((frame) =>
      (frame as { type?: string }).type === "rpc_frame_error"
    ));
    await waitUntil(() => control.lifecycle.includes("delete-session"));
    expect(frames).toContainEqual({
      type: "rpc_frame_error",
      error: "Pi RPC frame decode failed: Pi RPC process exited unexpectedly (code 0)",
    });
    expect(manager.get(session.sessionFile)).toBeUndefined();
  });

  test("backs off idle spool polling and wakes promptly for repeated native input", async () => {
    const { sandbox, control } = processSessionSandbox();
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox,
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
    await waitUntil(() => control.stdoutReadLengths.at(-1) === 0);
    const idleBaseline = control.stdoutReadOffsets.length;
    const operationBaseline = control.lifecycle.length;
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(control.stdoutReadOffsets.length - idleBaseline).toBeLessThanOrEqual(4);
    expect(control.lifecycle.length - operationBaseline).toBeLessThanOrEqual(12);

    for (let index = 0; index < 25; index++) {
      await session.command({ kind: "steer", text: `turn-${index}` });
    }
    expect(control.sent).toHaveLength(28);
    expect(control.stdoutReadLengths.every((length) => length <= 256 * 1024)).toBe(true);
    await session.dispose();
  });

  test("fails with a clear error and tears down when a spool exceeds its hard quota", async () => {
    const { sandbox, control } = processSessionSandbox({ reportedStdoutSize: 256 * 1024 * 1024 + 1 });
    const manager = new DefaultPiBridgeManager();

    await expect(manager.ensure({
      sandbox,
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
    })).rejects.toThrow("Pi RPC stdout spool exceeded 268435456 bytes");
    await waitUntil(() => control.lifecycle.includes("remove-spool"));
    expect(control.lifecycle.indexOf("delete-session"))
      .toBeLessThan(control.lifecycle.indexOf("remove-spool"));
  });

  test("fails and deletes a process session when a live physical frame exceeds the cap", async () => {
    const { sandbox, control } = processSessionSandbox();
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox,
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

    const oversized = "x".repeat(MAX_RPC_FRAME_BYTES + 1);
    expect(() => control.appendStdout(oversized)).not.toThrow();
    await waitUntil(() => control.lifecycle.includes("delete-session"));
    expect(manager.get(session.sessionFile)).toBeUndefined();
  });

  test("keeps native resume fenced when process-session deletion fails", async () => {
    const { sandbox, control } = processSessionSandbox({ failDelete: true });
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

    await expect(first.dispose()).rejects.toThrow("delete rejected");
    expect(control.lifecycle).not.toContain("remove-spool");
    await expect(manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    })).rejects.toThrow("Pi RPC remote teardown failed; refusing native resume");
    expect(control.lifecycle.filter((value) => value === "execute-session-command")).toHaveLength(1);
  });

  test("keeps the spool and resume fence when post-delete inventory times out", async () => {
    const { sandbox, control } = processSessionSandbox({
      noOpDelete: true,
      failInventoryAfterDelete: true,
    });
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

    await expect(first.dispose()).rejects.toThrow("inventory timed out");
    expect(control.lifecycle).not.toContain("remove-spool");
    await expect(manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    })).rejects.toThrow("Pi RPC remote teardown failed; refusing native resume");
    expect(control.lifecycle.filter((value) => value === "execute-session-command")).toHaveLength(1);
  });

  test("registers a resume fence before an uncertain process-session launch", async () => {
    const { sandbox, control } = processSessionSandbox({
      failDelete: true,
      hangExecuteSessionCommand: true,
    });
    const manager = new DefaultPiBridgeManager(5, 5);
    const runtime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const resumeSessionFile = "/home/useagent-pi/agent/sessions/existing.jsonl";

    await expect(manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile,
    })).rejects.toThrow("Pi RPC remote teardown timed out; refusing native resume");
    await expect(manager.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile,
    })).rejects.toThrow("Pi RPC remote teardown timed out; refusing native resume");

    expect(control.lifecycle.filter((value) => value === "create-session")).toHaveLength(1);
    expect(control.lifecycle.filter((value) => value === "execute-session-command")).toHaveLength(1);
    expect(control.lifecycle.filter((value) => value === "delete-session")).toHaveLength(0);
  });

  test("teardown waits for a deferred process-session create before deleting", async () => {
    const { sandbox, control } = processSessionSandbox({ deferCreateSession: true });
    const manager = new DefaultPiBridgeManager(5, 5);
    const startup = manager.ensure({
      sandbox,
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
      resumeSessionFile: "/sessions/existing.jsonl",
    });

    await expect(startup).rejects.toThrow("Pi RPC remote teardown timed out; refusing native resume");
    expect(control.lifecycle).not.toContain("delete-session");
    control.releaseCreate();
    await waitUntil(() => control.lifecycle.includes("delete-session"));
    expect(control.lifecycle).not.toContain("execute-session-command");
    expect(control.writerAlive()).toBe(false);
  });

  test("teardown waits for a deferred execute response and then deletes the late writer", async () => {
    const { sandbox, control } = processSessionSandbox({ deferExecuteSessionCommand: true });
    const manager = new DefaultPiBridgeManager(5, 5);
    const startup = manager.ensure({
      sandbox,
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
      resumeSessionFile: "/sessions/existing.jsonl",
    });

    await expect(startup).rejects.toThrow("Pi RPC remote teardown timed out; refusing native resume");
    expect(control.lifecycle).not.toContain("delete-session");
    control.releaseExecute();
    await waitUntil(() => control.lifecycle.includes("delete-session"));
    expect(control.lifecycle.indexOf("execute-session-command:done"))
      .toBeLessThan(control.lifecycle.indexOf("delete-session"));
    expect(control.writerAlive()).toBe(false);
  });

  test("a new manager deletes the old owned process session before launching a replacement", async () => {
    const { sandbox, control } = processSessionSandbox();
    const runtime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const managerA = new DefaultPiBridgeManager();
    const first = await managerA.ensure({ sandbox, workdir: "/work", runtime });
    const managerB = new DefaultPiBridgeManager();

    const replacement = await managerB.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    });
    const creates = control.lifecycle.filter((value) => value.startsWith("create:"));
    const firstDelete = control.lifecycle.indexOf(`delete:${creates[0]?.slice("create:".length)}`);
    const secondCreate = control.lifecycle.indexOf(creates[1]!);

    expect(creates).toHaveLength(2);
    expect(creates[0]).toStartWith(`create:${piProcessSessionPrefix(sandbox.id)}`);
    expect(creates[1]).toStartWith(`create:${piProcessSessionPrefix(sandbox.id)}`);
    expect(creates[1]).not.toBe(creates[0]);
    expect(firstDelete).toBeGreaterThan(-1);
    expect(firstDelete).toBeLessThan(secondCreate);
    await replacement.dispose();
  });

  test("a new manager does not launch when deletion of the old owned process session fails", async () => {
    const options = { failDelete: false };
    const { sandbox, control } = processSessionSandbox(options);
    const runtime = {
      model: { provider: "openai" as const, modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
      fingerprint: "runtime",
      knowledgeTools: false,
      executable: "/opt/useagent/pi-runtime/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    };
    const managerA = new DefaultPiBridgeManager();
    const first = await managerA.ensure({ sandbox, workdir: "/work", runtime });
    options.failDelete = true;
    const managerB = new DefaultPiBridgeManager();

    await expect(managerB.ensure({
      sandbox,
      workdir: "/work",
      runtime,
      resumeSessionFile: first.sessionFile,
    })).rejects.toThrow("delete rejected");
    expect(control.lifecycle.filter((value) => value.startsWith("create:"))).toHaveLength(1);
  });
});
