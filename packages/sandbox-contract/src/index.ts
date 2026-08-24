// The provider-neutral sandbox contract for useAgent.
//
// This package declares the shape of a remote workstation - how the platform
// creates, gets and lists sandboxes and drives their process/filesystem/PTY,
// preview, screen-recording and (optional) computer-use surfaces - WITHOUT
// naming or importing any concrete provider. The Daytona and Cube adapters, the
// warm pools, and the env-coupled `sandboxProvider()`/`sandboxProviderKind()`
// selectors live in the backend and implement these interfaces; the conformance
// harness runs there against live providers.
//
// Keep this file a pure leaf: types only, zero imports, zero runtime, so any
// runtime can depend on the contract without pulling server code.

export type SandboxProviderKind = "daytona" | "cube";

export interface SandboxExecuteResult {
  result?: string;
  exitCode?: number;
}

export interface SandboxSession {
  commands: Array<{ id: string }>;
}

export interface SandboxPtyHandle {
  waitForConnection(): Promise<void>;
  sendInput(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<unknown>;
  disconnect(): Promise<void>;
  kill(): Promise<unknown>;
}

export interface SandboxProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSeconds?: number,
  ): Promise<SandboxExecuteResult>;
  createSession(sessionId: string): Promise<unknown>;
  deleteSession(sessionId: string): Promise<unknown>;
  getSession(sessionId: string): Promise<SandboxSession>;
  executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    timeoutSeconds?: number,
  ): Promise<{ cmdId: string; output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
  ): Promise<{ output?: string; stdout?: string; stderr?: string }>;
  createPty(options: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
    envs?: Record<string, string>;
    onData: (data: Uint8Array) => void | Promise<void>;
  }): Promise<SandboxPtyHandle>;
}

export interface SandboxFileSystem {
  getFileDetails(path: string): Promise<{ size?: number }>;
  downloadFile(path: string): Promise<Buffer>;
  uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
}

export interface SandboxRecording {
  durationSeconds?: number;
  fileName: string;
  filePath: string;
  id: string;
  startTime: string;
  status: string;
}

export interface SandboxComputerUse {
  start(): Promise<unknown>;
  readonly mouse: {
    click(x: number, y: number, button?: string, double?: boolean): Promise<unknown>;
    move(x: number, y: number): Promise<unknown>;
    drag(
      startX: number,
      startY: number,
      endX: number,
      endY: number,
      button?: string,
    ): Promise<unknown>;
    scroll(x: number, y: number, direction: "up" | "down", amount?: number): Promise<boolean>;
  };
  readonly keyboard: {
    type(text: string, delay?: number): Promise<void>;
    press(key: string, modifiers?: string[]): Promise<void>;
    hotkey(keys: string): Promise<void>;
  };
  readonly screenshot: {
    takeFullScreen(showCursor?: boolean): Promise<{ screenshot?: string; sizeBytes?: number }>;
  };
  readonly display: {
    getInfo(): Promise<{
      displays?: Array<{ height?: number; isActive?: boolean; width?: number }>;
    }>;
  };
  readonly recording: {
    start(label?: string): Promise<SandboxRecording>;
    stop(id: string): Promise<SandboxRecording>;
  };
}

export interface SandboxPreviewLink {
  url: string;
  token?: string;
}

export interface SandboxHandle {
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  state?: string;
  labels?: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  /** Native computer-use access when the provider exposes it. Cube intentionally
   * omits it and the trusted gateway drives the workstation through X11. */
  readonly computerUse?: SandboxComputerUse;
  start(): Promise<void>;
  delete(): Promise<void>;
  getPreviewLink(port: number): Promise<SandboxPreviewLink>;
}

export interface SandboxCreateOptions {
  snapshot?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
}

/**
 * Point-in-time capacity + inventory telemetry for a provider, used by the fleet
 * capacity policy to reason about multi-node headroom without a second scheduler.
 * All fields are optional: a provider reports what it can observe and omits the
 * rest. cpu is millicores (2000 = 2 vCPU); memory is MiB. Aggregate across all
 * compute nodes the provider manages.
 */
export interface SandboxInventory {
  /** Compute nodes/hosts that are ready to place sandboxes on. */
  readyNodes?: number;
  /** Sum of allocatable cpu (millicores) across ready nodes. */
  allocatableCpuMillicores?: number;
  /** Sum of allocatable memory (MiB) across ready nodes. */
  allocatableMemoryMib?: number;
  /** Sandboxes currently running. */
  activeSandboxes?: number;
  /** Sandboxes paused/stopped but still resident. */
  pausedSandboxes?: number;
  /** Observed sandbox-create latency (ms), e.g. a recent p50. */
  createLatencyMs?: number;
  /** Warm-pool sandboxes ready to claim instantly. */
  warmPoolReady?: number;
  /** Sandboxes that failed to create or were OOM-killed recently. */
  failedOrOom?: number;
}

export interface SandboxProvider {
  create(options?: SandboxCreateOptions): Promise<SandboxHandle>;
  get(sandboxId: string): Promise<SandboxHandle>;
  list(): AsyncIterable<SandboxHandle>;
  /**
   * OPTIONAL capacity/inventory telemetry. Providers that can observe node-level
   * headroom (multi-node Cube) implement this; single-node or telemetry-less
   * providers omit it and the fleet policy falls back to the declared-host
   * budget. Never called on the hot request path.
   */
  inventory?(): Promise<SandboxInventory>;
}
