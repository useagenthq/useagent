import { Daytona } from "@daytona/sdk";
import type {
  DaytonaApiConfig,
  SandboxComputerUse,
  SandboxCreateOptions,
  SandboxFileSystem,
  SandboxHandle,
  SandboxPreviewLink,
  SandboxProcess,
  SandboxProvider,
  SandboxPtyHandle,
  SandboxRecording,
} from "./provider";

export interface DaytonaSandboxPort {
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  state?: string;
  labels?: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  readonly computerUse: SandboxComputerUse;
  start(timeout?: number): Promise<void>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
  getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
}

export interface DaytonaClientPort {
  create(options?: SandboxCreateOptions): Promise<DaytonaSandboxPort>;
  get(sandboxId: string): Promise<DaytonaSandboxPort>;
  list(): AsyncIterable<DaytonaSandboxPort>;
}

class DaytonaProcess implements SandboxProcess {
  constructor(private readonly source: SandboxProcess) {}

  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSeconds?: number,
  ) {
    const result = await this.source.executeCommand(command, cwd, env, timeoutSeconds);
    return { result: result.result, exitCode: result.exitCode };
  }

  async createSession(sessionId: string): Promise<unknown> {
    return await this.source.createSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<unknown> {
    return await this.source.deleteSession(sessionId);
  }

  async getSession(sessionId: string) {
    const session = await this.source.getSession(sessionId);
    return { commands: session.commands.map(({ id }) => ({ id })) };
  }

  async executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    timeoutSeconds?: number,
  ) {
    const result = await this.source.executeSessionCommand(sessionId, request, timeoutSeconds);
    return {
      cmdId: result.cmdId,
      output: result.output,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  async getSessionCommandLogs(sessionId: string, commandId: string) {
    const logs = await this.source.getSessionCommandLogs(sessionId, commandId);
    return { output: logs.output, stdout: logs.stdout, stderr: logs.stderr };
  }

  async createPty(options: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
    envs?: Record<string, string>;
    onData: (data: Uint8Array) => void | Promise<void>;
  }): Promise<SandboxPtyHandle> {
    const pty = await this.source.createPty(options);
    return {
      waitForConnection: () => pty.waitForConnection(),
      sendInput: (data) => pty.sendInput(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      disconnect: () => pty.disconnect(),
      kill: () => pty.kill(),
    };
  }
}

class DaytonaFileSystem implements SandboxFileSystem {
  constructor(private readonly source: SandboxFileSystem) {}

  async getFileDetails(path: string): Promise<{ size?: number }> {
    const details = await this.source.getFileDetails(path);
    return { size: details.size };
  }

  async downloadFile(path: string): Promise<Buffer> {
    return Buffer.from(await this.source.downloadFile(path));
  }

  async uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void> {
    await this.source.uploadFile(file, remotePath, timeout);
  }
}

function normalizeRecording(value: SandboxRecording): SandboxRecording {
  return {
    durationSeconds: value.durationSeconds,
    fileName: value.fileName,
    filePath: value.filePath,
    id: value.id,
    startTime: value.startTime,
    status: value.status,
  };
}

class DaytonaComputerUse implements SandboxComputerUse {
  readonly mouse;
  readonly keyboard;
  readonly screenshot;
  readonly display;
  readonly recording;

  constructor(private readonly source: SandboxComputerUse) {
    this.mouse = {
      click: (x: number, y: number, button?: string, double?: boolean) =>
        source.mouse.click(x, y, button, double),
      move: (x: number, y: number) => source.mouse.move(x, y),
      drag: (
        startX: number,
        startY: number,
        endX: number,
        endY: number,
        button?: string,
      ) => source.mouse.drag(startX, startY, endX, endY, button),
      scroll: (x: number, y: number, direction: "up" | "down", amount?: number) =>
        source.mouse.scroll(x, y, direction, amount),
    };
    this.keyboard = {
      type: (text: string, delay?: number) => source.keyboard.type(text, delay),
      press: (key: string, modifiers?: string[]) => source.keyboard.press(key, modifiers),
      hotkey: (keys: string) => source.keyboard.hotkey(keys),
    };
    this.screenshot = {
      takeFullScreen: async (showCursor?: boolean) => {
        const screenshot = await source.screenshot.takeFullScreen(showCursor);
        return { screenshot: screenshot.screenshot, sizeBytes: screenshot.sizeBytes };
      },
    };
    this.display = {
      getInfo: async () => {
        const display = await source.display.getInfo();
        return {
          displays: display.displays?.map(({ height, isActive, width }) => ({
            height,
            isActive,
            width,
          })),
        };
      },
    };
    this.recording = {
      start: async (label?: string) => normalizeRecording(await source.recording.start(label)),
      stop: async (id: string) => normalizeRecording(await source.recording.stop(id)),
    };
  }

  async start(): Promise<unknown> {
    return await this.source.start();
  }
}

export class DaytonaSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  readonly labels?: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  readonly computerUse: SandboxComputerUse;
  state?: string;

  constructor(private readonly sandbox: DaytonaSandboxPort) {
    this.id = sandbox.id;
    this.cpu = sandbox.cpu;
    this.memory = sandbox.memory;
    this.labels = sandbox.labels;
    this.state = sandbox.state;
    this.process = new DaytonaProcess(sandbox.process);
    this.fs = new DaytonaFileSystem(sandbox.fs);
    this.computerUse = new DaytonaComputerUse(sandbox.computerUse);
  }

  async start(): Promise<void> {
    await this.sandbox.start();
    this.state = this.sandbox.state ?? "started";
  }

  async delete(): Promise<void> {
    await this.sandbox.delete(undefined, true);
    this.state = "destroyed";
  }

  async getPreviewLink(port: number): Promise<SandboxPreviewLink> {
    const link = await this.sandbox.getPreviewLink(port);
    return {
      url: link.url,
      token: link.token,
    };
  }
}

export class DaytonaProvider implements SandboxProvider {
  constructor(private readonly client: DaytonaClientPort) {}

  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    return new DaytonaSandboxHandle(await this.client.create(options));
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    return new DaytonaSandboxHandle(await this.client.get(sandboxId));
  }

  async *list(): AsyncIterable<SandboxHandle> {
    for await (const sandbox of this.client.list()) yield new DaytonaSandboxHandle(sandbox);
  }
}

function daytonaClient(config: DaytonaApiConfig): DaytonaClientPort {
  const client = new Daytona(config);
  return {
    create: async (options) => await client.create(options),
    get: async (sandboxId) => await client.get(sandboxId),
    async *list() {
      for await (const sandbox of client.list()) yield sandbox;
    },
  };
}

export function daytonaSandboxProvider(
  config: DaytonaApiConfig,
  client: DaytonaClientPort = daytonaClient(config),
): SandboxProvider {
  return new DaytonaProvider(client);
}
