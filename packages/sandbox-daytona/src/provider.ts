import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";
import type {
  SandboxComputerUse,
  SandboxCreateOptions,
  SandboxFileSystem,
  SandboxHandle,
  SandboxPreviewLink,
  SandboxProcess,
  SandboxProvider,
  SandboxPtyHandle,
  SandboxRecording,
  SandboxTemplateStatus,
} from "@useagent/sandbox-contract";

export interface DaytonaApiConfig {
  apiKey: string;
  apiUrl: string;
  target: string;
}

/** Daytona preview links authenticate with the token in its own header. */
export function daytonaPreviewAuthHeaders(token: string): Record<string, string> {
  return token ? { "x-daytona-preview-token": token } : {};
}

export interface DaytonaSandboxPort {
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  state?: string;
  labels?: Record<string, string>;
  readonly process: DaytonaProcessPort;
  readonly fs: SandboxFileSystem;
  readonly computerUse: SandboxComputerUse;
  start(timeout?: number): Promise<void>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
  getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
}

export interface DaytonaPtyPort {
  readonly exitCode?: number;
  readonly error?: string;
  isConnected(): boolean;
  waitForConnection(): Promise<void>;
  wait(): Promise<{ exitCode?: number; error?: string }>;
  sendInput(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<unknown>;
  disconnect(): Promise<void>;
  kill(): Promise<unknown>;
}

export type DaytonaProcessPort = Omit<SandboxProcess, "createPty"> & {
  createPty(options: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
    envs?: Record<string, string>;
    onData: (data: Uint8Array) => void | Promise<void>;
  }): Promise<DaytonaPtyPort>;
};

/** The slice of a Daytona snapshot record the provider reads. */
export interface DaytonaSnapshotPort {
  readonly name: string;
  readonly state: string;
  readonly errorReason?: string | null;
}

export interface DaytonaClientPort {
  create(options?: SandboxCreateOptions): Promise<DaytonaSandboxPort>;
  get(sandboxId: string): Promise<DaytonaSandboxPort>;
  list(): AsyncIterable<DaytonaSandboxPort>;
  readonly snapshot: {
    /** Throws the SDK's not-found error when the org has no snapshot of that name. */
    get(name: string): Promise<DaytonaSnapshotPort>;
    activate(snapshot: DaytonaSnapshotPort): Promise<DaytonaSnapshotPort>;
  };
}

export interface DaytonaProviderOptions {
  /** How long ensureTemplate waits for an activating snapshot (activation took about two minutes in practice). */
  readonly activationTimeoutMs?: number;
  readonly activationPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 6 * 60_000;
const DEFAULT_ACTIVATION_POLL_MS = 5_000;
const PTY_TERMINATION_POLL_MS = 250;
const DAYTONA_PTY_CONNECTION_FAILED = "Daytona PTY connection failed";
const DAYTONA_PTY_TERMINATION_FAILED = "Daytona PTY termination failed";
const DAYTONA_PTY_TRANSPORT_CLOSED = "Daytona PTY transport closed before reporting termination";
const DAYTONA_PTY_DISCONNECTED = "Daytona PTY disconnected";
/** Daytona states a snapshot passes through on its way to active. */
const ACTIVATING_STATES: ReadonlySet<string> = new Set(["building", "pending", "pulling", "snapshotting"]);

function isSnapshotNotFound(error: unknown): boolean {
  return error instanceof DaytonaNotFoundError ||
    (error instanceof Error && /not found|does not exist/i.test(error.message));
}

class DaytonaProcess implements SandboxProcess {
  constructor(private readonly source: DaytonaProcessPort) {}

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
    let terminationPromise: Promise<{ exitCode?: number; error?: string }> | undefined;
    let terminationMonitor: ReturnType<typeof setInterval> | undefined;
    let terminationSettled = false;
    let settleTermination:
      | ((result: { exitCode?: number; error?: string }) => void)
      | undefined;
    const clearTerminationMonitor = (): void => {
      if (terminationMonitor === undefined) return;
      clearInterval(terminationMonitor);
      terminationMonitor = undefined;
    };
    const result = (
      exitCode: number | undefined,
      hasError = false,
    ): { exitCode?: number; error?: string } => ({
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(hasError ? { error: DAYTONA_PTY_TERMINATION_FAILED } : {}),
    });
    const inspectTermination = (): { exitCode?: number; error?: string } | undefined => {
      if (pty.exitCode !== undefined) return result(pty.exitCode, Boolean(pty.error));
      if (pty.error) return result(undefined, true);
      if (!pty.isConnected()) return { error: DAYTONA_PTY_TRANSPORT_CLOSED };
      return undefined;
    };
    const waitForTermination = (): Promise<{ exitCode?: number; error?: string }> => {
      if (terminationPromise) return terminationPromise;
      terminationPromise = new Promise((resolve) => {
        settleTermination = (termination) => {
          if (terminationSettled) return;
          terminationSettled = true;
          clearTerminationMonitor();
          resolve(termination);
        };
        void (async () => {
          try {
            await pty.waitForConnection();
          } catch {
            if (pty.exitCode !== undefined) {
              settleTermination?.(result(pty.exitCode, Boolean(pty.error)));
            } else if (pty.error) {
              settleTermination?.(result(undefined, true));
            } else {
              settleTermination?.({ error: DAYTONA_PTY_CONNECTION_FAILED });
            }
            return;
          }
          if (terminationSettled) return;

          const current = inspectTermination();
          if (current) {
            settleTermination?.(current);
            return;
          }

          void pty.wait().then(
            (termination) => settleTermination?.(
              result(termination.exitCode, Boolean(termination.error)),
            ),
            () => settleTermination?.(inspectTermination() ?? {
              error: DAYTONA_PTY_TERMINATION_FAILED,
            }),
          );
          terminationMonitor = setInterval(() => {
            const termination = inspectTermination();
            if (termination) settleTermination?.(termination);
          }, PTY_TERMINATION_POLL_MS);
          terminationMonitor.unref();

          const afterSubscribe = inspectTermination();
          if (afterSubscribe) settleTermination?.(afterSubscribe);
        })();
      });
      return terminationPromise;
    };
    return {
      waitForConnection: () => pty.waitForConnection(),
      waitForTermination,
      sendInput: (data) => pty.sendInput(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      disconnect: async () => {
        try {
          await pty.disconnect();
        } finally {
          clearTerminationMonitor();
          settleTermination?.({ error: DAYTONA_PTY_DISCONNECTED });
        }
      },
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
  readonly providerKind = "daytona" as const;
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
      headers: daytonaPreviewAuthHeaders(link.token ?? ""),
    };
  }
}

export class DaytonaProvider implements SandboxProvider {
  private readonly activationTimeoutMs: number;
  private readonly activationPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly client: DaytonaClientPort, options: DaytonaProviderOptions = {}) {
    this.activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    this.activationPollMs = options.activationPollMs ?? DEFAULT_ACTIVATION_POLL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    return new DaytonaSandboxHandle(await this.client.create(options));
  }

  /**
   * Daytona parks a snapshot nobody used for about two weeks as `inactive`, and
   * a create from it fails with a validation error the old code hid behind the
   * default image. Look the snapshot up first; wake an inactive one and wait a
   * bounded time (in practice a few minutes) for it to come back.
   */
  async ensureTemplate(
    name: string,
    options: { readonly onActivating?: () => void | Promise<void> } = {},
  ): Promise<SandboxTemplateStatus> {
    let snapshot: DaytonaSnapshotPort;
    try {
      snapshot = await this.client.snapshot.get(name);
    } catch (error) {
      if (isSnapshotNotFound(error)) return { name, state: "absent" };
      throw error;
    }
    if (snapshot.state === "active") return { name, state: "active" };
    if (!ACTIVATING_STATES.has(snapshot.state) && snapshot.state !== "inactive") {
      return { name, state: "error", detail: snapshot.errorReason?.trim() || snapshot.state };
    }
    await options.onActivating?.();
    if (snapshot.state === "inactive") {
      snapshot = await this.client.snapshot.activate(snapshot);
      if (snapshot.state === "active") return { name, state: "active" };
    }
    const startedAt = this.now();
    let state = snapshot.state;
    while (this.now() - startedAt < this.activationTimeoutMs) {
      await this.sleep(this.activationPollMs);
      const current = await this.client.snapshot.get(name);
      state = current.state;
      if (state === "active") return { name, state: "active" };
      if (!ACTIVATING_STATES.has(state)) {
        return { name, state: state === "inactive" ? "inactive" : "error", detail: current.errorReason?.trim() || state };
      }
    }
    const waited = Math.round((this.now() - startedAt) / 1000);
    return { name, state: "activating", detail: `still ${state} after ${waited}s` };
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
    snapshot: {
      get: async (name) => await client.snapshot.get(name),
      // The SDK activates by record, so re-read the live record before asking.
      activate: async (snapshot) => await client.snapshot.activate(await client.snapshot.get(snapshot.name)),
    },
  };
}

export function daytonaSandboxProvider(
  config: DaytonaApiConfig,
  client: DaytonaClientPort = daytonaClient(config),
  options: DaytonaProviderOptions = {},
): SandboxProvider {
  return new DaytonaProvider(client, options);
}
