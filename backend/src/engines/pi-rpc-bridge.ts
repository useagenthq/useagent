import type { NativeBridgeCommand } from "@useagent/agent-harness/bridge";
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionEventFrame,
  RpcSubagentMessagesResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
  MAX_RPC_FRAME_BYTES,
  RpcFrameDecoder,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { SandboxHandle, SandboxPtyHandle } from "../sandboxes/provider";
import { PI_CODING_AGENT_VERSION, type PreparedPiRuntime } from "./pi-runtime-config";

const RPC_REQUEST_TIMEOUT_MS = 30_000;
const RPC_CHILD_TRANSCRIPT_TIMEOUT_MS = 2_000;
const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface PendingRequest {
  readonly resolve: (value: RpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type PiRpcFrameListener = (frame: unknown) => void;
type PiRpcCommandInput = RpcCommand extends infer Command
  ? Command extends { id?: string }
    ? Omit<Command, "id">
    : never
  : never;

export interface PiBridgeSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sandboxId: string;
  readonly fingerprint: string;
  subscribe(listener: PiRpcFrameListener): () => void;
  command(command: NativeBridgeCommand): Promise<void>;
  readSubagentMessages?(selector: {
    readonly subagentId?: string;
    readonly sessionFile?: string;
    readonly fromByte?: number;
  }): Promise<RpcSubagentMessagesResult>;
  reconcileCompletedChild?(frame: unknown): (() => Promise<readonly unknown[]>) | null;
  dispose(): Promise<void>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePiRpcFrameLine(line: string): Record<string, unknown> | null {
  const normalized = line.replace(ANSI_CSI_SEQUENCE, "").trim();
  if (!normalized.startsWith("{")) return null;
  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch (cause) {
    throw new Error("invalid Pi RPC JSON frame", { cause });
  }
}

class LivePiBridgeSession implements PiBridgeSession {
  #buffer = "";
  #decoder = new RpcFrameDecoder();
  #textDecoder = new TextDecoder();
  #textEncoder = new TextEncoder();
  #nextId = 0;
  #readyResolve!: () => void;
  #ready = new Promise<void>((resolve) => {
    this.#readyResolve = resolve;
  });
  #pending = new Map<string, PendingRequest>();
  #listeners = new Set<PiRpcFrameListener>();
  #initialFrames: unknown[] = [];
  #childTranscriptCursors = new Map<string, number>();
  #disposed = false;

  private constructor(
    private readonly pty: SandboxPtyHandle,
    readonly sandboxId: string,
    readonly fingerprint: string,
    readonly sessionId: string,
    readonly sessionFile: string,
  ) {}

  static async start(input: {
    readonly sandbox: SandboxHandle;
    readonly workdir: string;
    readonly runtime: PreparedPiRuntime;
    readonly resumeSessionFile?: string;
  }): Promise<LivePiBridgeSession> {
    let instance: LivePiBridgeSession | undefined;
    const pty = await input.sandbox.process.createPty({
      id: `useagent-pi-${crypto.randomUUID()}`,
      cols: 240,
      rows: 50,
      cwd: input.workdir,
      onData(data) {
        instance?.ingest(data);
      },
    });
    instance = new LivePiBridgeSession(
      pty,
      input.sandbox.id,
      input.runtime.fingerprint,
      "pending",
      input.resumeSessionFile ?? "pending",
    );
    await pty.waitForConnection();
    const resume = input.resumeSessionFile
      ? ` --resume ${shellQuote(input.resumeSessionFile)}`
      : "";
    const piCommand =
      `exec env -i HOME=${shellQuote(input.runtime.home)} PATH=/usr/local/bin:/usr/bin:/bin ` +
      `PI_CODING_AGENT_DIR=${shellQuote(`${input.runtime.home}/agent`)} ` +
      `${shellQuote(input.runtime.bunExecutable)} ${shellQuote(input.runtime.executable)} ` +
      `--mode rpc --cwd ${shellQuote(input.workdir)} ` +
      `--model ${shellQuote(input.runtime.model.selector)} --no-title --no-lsp ` +
      `--no-extensions --no-skills --no-rules --auto-approve ` +
      `--tools read,write,bash,task${resume}`;
    const command =
      `stty -echo -onlcr -icanon min 1 time 0; exec su -s /bin/sh ${shellQuote(input.runtime.runAsUser)} ` +
      `-c ${shellQuote(piCommand)}`;
    await pty.sendInput(`${command}\n`);
    try {
      await Promise.race([
        instance.#ready,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Pi ${PI_CODING_AGENT_VERSION} RPC readiness timed out`)),
          RPC_REQUEST_TIMEOUT_MS,
        )),
      ]);
      const negotiation = await instance.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const negotiationData = "data" in negotiation ? objectValue(negotiation.data) : null;
      if (negotiationData?.protocolVersion !== 2) {
        throw new Error("Pi RPC protocol v2 negotiation failed");
      }
      await instance.request({ type: "set_subagent_subscription", level: "events" });
      const state = await instance.request({ type: "get_state" });
      const data = "data" in state ? state.data as Record<string, unknown> : undefined;
      const sessionId = typeof data?.sessionId === "string" ? data.sessionId : null;
      const sessionFile = typeof data?.sessionFile === "string" ? data.sessionFile : null;
      if (!sessionId || !sessionFile) throw new Error("Pi RPC did not report a persistent session");
      Object.defineProperties(instance, {
        sessionId: { value: sessionId },
        sessionFile: { value: sessionFile },
      });
      return instance;
    } catch (error) {
      await instance.dispose();
      throw error;
    }
  }

  subscribe(listener: PiRpcFrameListener): () => void {
    this.#listeners.add(listener);
    for (const frame of this.#initialFrames) listener(frame);
    this.#initialFrames = [];
    return () => this.#listeners.delete(listener);
  }

  async command(command: NativeBridgeCommand): Promise<void> {
    if (command.kind === "prompt") {
      const result = await this.request({ type: "prompt", message: command.text });
      const data = "data" in result ? result.data as Record<string, unknown> : undefined;
      if (data?.agentInvoked === false) {
        for (const listener of this.#listeners) {
          listener({ type: "prompt_result", agentInvoked: false });
        }
      }
      return;
    }
    if (command.kind === "steer") {
      await this.request({ type: "steer", message: command.text });
      return;
    }
    if (command.kind === "follow_up") {
      await this.request({ type: "follow_up", message: command.text });
      return;
    }
    await this.request({ type: "abort" });
  }

  async readSubagentMessages(selector: {
    readonly subagentId?: string;
    readonly sessionFile?: string;
    readonly fromByte?: number;
  }): Promise<RpcSubagentMessagesResult> {
    const result = await this.request(
      { type: "get_subagent_messages", ...selector },
      RPC_CHILD_TRANSCRIPT_TIMEOUT_MS,
    );
    if (result.success !== true || result.command !== "get_subagent_messages") {
      throw new Error("Pi RPC returned an invalid child transcript response");
    }
    return result.data;
  }

  reconcileCompletedChild(frame: unknown): (() => Promise<readonly unknown[]>) | null {
    const value = objectValue(frame);
    const payload = objectValue(value?.payload);
    const childId = typeof payload?.id === "string" ? payload.id : null;
    const status = typeof payload?.status === "string" ? payload.status : null;
    if (
      value?.type !== "subagent_lifecycle" ||
      !childId ||
      !status ||
      !["completed", "failed", "aborted"].includes(status)
    ) {
      return null;
    }
    return () => this.reconcileChildMessages(childId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi RPC session disposed"));
    }
    this.#pending.clear();
    this.#childTranscriptCursors.clear();
    await this.pty.kill().catch(() => {});
    await this.pty.disconnect().catch(() => {});
  }

  private async reconcileChildMessages(childId: string): Promise<readonly unknown[]> {
    let cursor = this.#childTranscriptCursors.get(childId) ?? 0;
    const frames: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await this.readSubagentMessages({ subagentId: childId, fromByte: cursor });
      if (page.reset) cursor = 0;
      for (const message of page.messages) {
        frames.push({
          type: "subagent_event",
          payload: { id: childId, event: { type: "message_end", message } },
        });
      }
      const advanced = page.nextByte > cursor;
      cursor = page.nextByte;
      this.#childTranscriptCursors.set(childId, cursor);
      if (advanced) continue;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return frames;
  }

  private async request(
    command: PiRpcCommandInput,
    timeoutMs = RPC_REQUEST_TIMEOUT_MS,
  ): Promise<RpcResponse> {
    if (this.#disposed) throw new Error("Pi RPC session is disposed");
    const id = `pi-${++this.#nextId}`;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC ${String(command.type)} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.pty.sendInput(`${JSON.stringify({ ...command, id })}\n`);
    } catch (cause) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
    const result = await response;
    if (result.success === false) {
      throw new Error(typeof result.error === "string" ? result.error : "Pi RPC command failed");
    }
    return result;
  }

  private failProtocol(cause: unknown): void {
    const detail = cause instanceof Error ? cause.message : "unknown decoder failure";
    const error = new Error(`Pi RPC frame decode failed: ${detail}`);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    const frame = { type: "rpc_frame_error", error: error.message };
    if (this.#listeners.size === 0) this.#initialFrames = [frame];
    else for (const listener of this.#listeners) listener(frame);
    void this.dispose();
  }

  private ingest(data: Uint8Array): void {
    this.#buffer += this.#textDecoder.decode(data, { stream: true }).replaceAll("\r", "");
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (this.#textEncoder.encode(this.#buffer).byteLength > MAX_RPC_FRAME_BYTES) {
          this.failProtocol(new Error("Pi RPC physical frame exceeds the transport limit"));
        }
        return;
      }
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (this.#textEncoder.encode(line).byteLength > MAX_RPC_FRAME_BYTES) {
        this.failProtocol(new Error("Pi RPC physical frame exceeds the transport limit"));
        return;
      }
      let parsed: Record<string, unknown> | null;
      try {
        parsed = parsePiRpcFrameLine(line);
      } catch (error) {
        this.failProtocol(error);
        return;
      }
      if (!parsed) continue;
      let frame: Record<string, unknown> | undefined;
      try {
        frame = this.#decoder.push(parsed) as Record<string, unknown> | undefined;
      } catch (error) {
        this.#decoder = new RpcFrameDecoder();
        this.failProtocol(error);
        return;
      }
      if (!frame) continue;
      if (frame.type === "ready") {
        this.#readyResolve();
        continue;
      }
      const id = typeof frame.id === "string" ? frame.id : null;
      if (frame.type === "response" && !id) {
        this.failProtocol(new Error("Pi RPC response is missing its request id"));
        return;
      }
      if (frame.type === "response" && id) {
        const pending = this.#pending.get(id);
        if (!pending) continue;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(frame as unknown as RpcResponse);
        continue;
      }
      if (this.#listeners.size === 0 && frame.type === "available_commands_update") {
        this.#initialFrames = [frame];
      }
      for (const listener of this.#listeners) listener(frame as unknown as RpcSessionEventFrame);
    }
  }
}

export interface PiBridgeManager {
  ensure(input: {
    readonly sandbox: SandboxHandle;
    readonly workdir: string;
    readonly runtime: PreparedPiRuntime;
    readonly resumeSessionFile?: string;
  }): Promise<PiBridgeSession>;
  get(sessionFile: string): PiBridgeSession | undefined;
  remove(sessionFile: string): Promise<void>;
}

export class DefaultPiBridgeManager implements PiBridgeManager {
  #sessions = new Map<string, PiBridgeSession>();

  async ensure(input: {
    readonly sandbox: SandboxHandle;
    readonly workdir: string;
    readonly runtime: PreparedPiRuntime;
    readonly resumeSessionFile?: string;
  }): Promise<PiBridgeSession> {
    const existing = input.resumeSessionFile ? this.#sessions.get(input.resumeSessionFile) : undefined;
    if (
      existing &&
      existing.sandboxId === input.sandbox.id &&
      existing.fingerprint === input.runtime.fingerprint
    ) {
      return existing;
    }
    if (existing) await this.remove(existing.sessionFile);
    const session = await LivePiBridgeSession.start(input);
    this.#sessions.set(session.sessionFile, session);
    return session;
  }

  get(sessionFile: string): PiBridgeSession | undefined {
    return this.#sessions.get(sessionFile);
  }

  async remove(sessionFile: string): Promise<void> {
    const session = this.#sessions.get(sessionFile);
    if (!session) return;
    this.#sessions.delete(sessionFile);
    await session.dispose();
  }
}

export const piBridgeManager = new DefaultPiBridgeManager();
