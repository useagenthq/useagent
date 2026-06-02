import type { NativeBridgeCommand } from "@useagent/agent-harness/bridge";
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionEventFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { SandboxHandle, SandboxPtyHandle } from "../sandboxes/provider";
import { PI_CODING_AGENT_VERSION, type PreparedPiRuntime } from "./pi-runtime-config";

const RPC_REQUEST_TIMEOUT_MS = 30_000;
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
  dispose(): Promise<void>;
}

function parsePiRpcFrameLine(line: string): Record<string, unknown> | null {
  const normalized = line.replace(ANSI_CSI_SEQUENCE, "").trim();
  if (!normalized.startsWith("{")) return null;
  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch {
    return null;
  }
}

class LivePiBridgeSession implements PiBridgeSession {
  #buffer = "";
  #nextId = 0;
  #readyResolve!: () => void;
  #ready = new Promise<void>((resolve) => {
    this.#readyResolve = resolve;
  });
  #pending = new Map<string, PendingRequest>();
  #listeners = new Set<PiRpcFrameListener>();
  #initialFrames: unknown[] = [];
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
      `stty -echo -onlcr; exec su -s /bin/sh ${shellQuote(input.runtime.runAsUser)} ` +
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

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi RPC session disposed"));
    }
    this.#pending.clear();
    await this.pty.kill().catch(() => {});
    await this.pty.disconnect().catch(() => {});
  }

  private async request(command: PiRpcCommandInput): Promise<RpcResponse> {
    if (this.#disposed) throw new Error("Pi RPC session is disposed");
    const id = `pi-${++this.#nextId}`;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC ${String(command.type)} timed out`));
      }, RPC_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
    });
    await this.pty.sendInput(`${JSON.stringify({ ...command, id })}\n`);
    const result = await response;
    if (result.success === false) {
      throw new Error(typeof result.error === "string" ? result.error : "Pi RPC command failed");
    }
    return result;
  }

  private ingest(data: Uint8Array): void {
    this.#buffer += new TextDecoder().decode(data, { stream: true }).replaceAll("\r", "");
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = parsePiRpcFrameLine(line);
      if (!frame) continue;
      if (frame.type === "ready") {
        this.#readyResolve();
        continue;
      }
      const id = typeof frame.id === "string" ? frame.id : null;
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
