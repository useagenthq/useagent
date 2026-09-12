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
// Keep this file a pure leaf with zero imports or external runtime dependencies, so any
// runtime can depend on the contract without pulling server code.

export type SandboxProviderKind = "daytona" | "cube" | "box";

/** A provider's top-level metadata lookup proved that the sandbox itself is absent. */
export class SandboxNotFoundError extends Error {
  constructor(cause?: unknown) {
    super("The sandbox does not exist", { cause });
    this.name = "SandboxNotFoundError";
  }
}

export interface SandboxExecuteResult {
  result?: string;
  exitCode?: number;
}

export interface SandboxSession {
  sessionId?: string;
  commands: Array<{ id: string; exitCode?: number }>;
}

export interface SandboxPtyHandle {
  waitForConnection(): Promise<void>;
  /** Resolves when the PTY process or its transport closes. This does not imply model success. */
  waitForTermination(): Promise<{ exitCode?: number; error?: string }>;
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
  /** Optional authoritative status for one process-session command. */
  getSessionCommand?(sessionId: string, commandId: string): Promise<{ id: string; exitCode?: number }>;
  executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    timeoutSeconds?: number,
  ): Promise<{ cmdId: string; output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
  ): Promise<{ output?: string; stdout?: string; stderr?: string }>;
  /** Optional live-only log callback. Callers must not assume reconnect replay,
   * byte offsets, or durable recovery semantics. */
  followSessionCommandLogs?(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;
  /** Optional interactive process-session input. Providers without it continue
   * to use the PTY transport. */
  sendSessionCommandInput?(sessionId: string, commandId: string, data: string): Promise<void>;
  listSessions?(): Promise<Array<SandboxSession & { sessionId: string }>>;
  listPtySessions?(): Promise<Array<{ id: string }>>;
  killPtySession?(sessionId: string): Promise<void>;
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
  /** Origin (no path, no query); callers append paths to it. */
  url: string;
  token?: string;
  /** Request headers every request to this link must carry: the provider's
   *  token header (Daytona, Cube) or Box's port-auth cookie. Providers fill
   *  this; consumers send it as-is. */
  headers?: Readonly<Record<string, string>>;
  /** Provider-issued values that the browser-side preview client must see in
   *  its own same-origin URL (for example a VNC password). The control plane
   *  injects these at the authenticated proxy boundary; providers never expose
   *  their upstream bearer token here. */
  clientQuery?: Readonly<Record<string, string>>;
}

/** A provider-owned desktop lifecycle. Providers with a native workstation
 *  implement this so shared consumers do not install a competing X/VNC stack. */
export interface SandboxDesktopAccess {
  readonly display: string;
  readonly home: string;
  readonly workdir: string;
  readonly browserExecutable?: string | null;
  start(): Promise<void>;
}

export interface SandboxHandle {
  readonly id: string;
  /** Which provider this handle talks to; lets callers pick preview auth without a lookup. */
  readonly providerKind?: SandboxProviderKind;
  readonly cpu: number;
  readonly memory: number;
  state?: string;
  labels?: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  /** Native computer-use access when the provider exposes it. Cube intentionally
   * omits it and the trusted gateway drives the workstation through X11. */
  readonly computerUse?: SandboxComputerUse;
  /** Native desktop lifecycle when the provider already owns the workstation. */
  readonly desktop?: SandboxDesktopAccess;
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
  /** Per-node placement headroom. When present, admission requires one ready,
   * schedulable node to fit the whole request; aggregate totals are not enough. */
  nodes?: readonly {
    id: string;
    ready: boolean;
    schedulingDisabled?: boolean;
    allocatableCpuMillicores: number;
    allocatableMemoryMib: number;
  }[];
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

export type SandboxTemplateState = "active" | "activating" | "inactive" | "absent" | "error";

/** What a provider knows about a named template (snapshot/image) before a create. */
export interface SandboxTemplateStatus {
  readonly name: string;
  readonly state: SandboxTemplateState;
  /** Provider wording for a state other than active (the raw state name, an error reason, how long activation ran). */
  readonly detail?: string;
}

export interface SandboxProvider {
  create(options?: SandboxCreateOptions): Promise<SandboxHandle>;
  get(sandboxId: string): Promise<SandboxHandle>;
  list(): AsyncIterable<SandboxHandle>;
  /**
   * OPTIONAL: report a template's state before creating from it and, when the
   * provider parks unused templates (Daytona deactivates an idle snapshot),
   * wake it and wait a bounded time for it to become active. `onActivating`
   * fires once when a wait starts so the caller can show a step. Providers
   * whose templates have no lifecycle omit it and the caller goes straight to
   * create.
   */
  ensureTemplate?(
    name: string,
    options?: { readonly onActivating?: () => void | Promise<void> },
  ): Promise<SandboxTemplateStatus>;
  /** Freeze one sandbox's filesystem as a reusable named template. */
  saveTemplate?(
    sourceSandboxId: string,
    name: string,
  ): Promise<SandboxTemplateStatus>;
  /**
   * OPTIONAL capacity/inventory telemetry. Providers that can observe node-level
   * headroom (multi-node Cube) implement this; single-node or telemetry-less
   * providers omit it and the fleet policy falls back to the declared-host
   * budget. Never called on the hot request path.
   */
  inventory?(): Promise<SandboxInventory>;
}

// ---------------------------------------------------------------------------
// Provider plugins. Every vendor integration is a package that exports one
// SandboxProviderPlugin; the control plane keeps a registry of them and never
// switches on a vendor name itself.
// ---------------------------------------------------------------------------

export type SandboxEnv = Readonly<Record<string, string | undefined>>;

/**
 * Control-plane label storage for providers that have no label API of their
 * own. Labels are the credential-generation and run-attribution trust anchor,
 * so they never live inside the sandbox.
 */
export interface SandboxLabelStore {
  read(sandboxIds: readonly string[]): Promise<Map<string, Record<string, string>>>;
  write(sandboxId: string, labels: Record<string, string>): Promise<void>;
  remove(sandboxId: string): Promise<void>;
}

/** Process-local label store for tests and dry runs. */
export function memorySandboxLabelStore(): SandboxLabelStore {
  const store = new Map<string, Record<string, string>>();
  return {
    async read(sandboxIds) {
      return new Map(sandboxIds.flatMap((id) => (store.has(id) ? [[id, store.get(id)!] as const] : [])));
    },
    async write(sandboxId, labels) {
      store.set(sandboxId, { ...labels });
    },
    async remove(sandboxId) {
      store.delete(sandboxId);
    },
  };
}

/** What the control plane hands a plugin when it builds a provider. */
export interface SandboxProviderPorts {
  readonly labels?: SandboxLabelStore;
  readonly fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Shell probe that exits 0 once the runtime identity and workspace are ready; providers that verify readiness run it. */
  readonly identityPreflightCommand?: string;
}

export interface SandboxCredentialInput {
  readonly apiKey: string;
  readonly snapshotName?: string;
}

/** A stored-credential validation failure, with the HTTP status the API should answer. */
export class SandboxCredentialError extends Error {
  constructor(
    readonly code: SandboxCredentialCode,
    readonly httpStatus: 401 | 403 | 404 | 429 | 503,
    message: string = code,
  ) {
    super(message);
    this.name = "SandboxCredentialError";
  }
}

/** Codes every plugin's credential validation reports, with the API status for each. */
export type SandboxCredentialCode = "authentication_failed" | "forbidden" | "snapshot_not_found" | "rate_limited" | "provider_unavailable";

export function sandboxCredentialStatus(code: SandboxCredentialCode): 401 | 403 | 404 | 429 | 503 {
  switch (code) {
    case "authentication_failed":
      return 401;
    case "forbidden":
      return 403;
    case "snapshot_not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "provider_unavailable":
      return 503;
  }
}

/** True for a SandboxCredentialError from any copy of this package (file: installs may duplicate the class). */
export function isSandboxCredentialError(value: unknown): value is SandboxCredentialError {
  return value instanceof Error && value.name === "SandboxCredentialError" && typeof (value as { httpStatus?: unknown }).httpStatus === "number";
}

/** A provider declared that it cannot open an interactive terminal from this server; the message says why. */
export class SandboxTerminalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTerminalUnavailableError";
  }
}

/** True for a SandboxTerminalUnavailableError from any copy of this package. */
export function isSandboxTerminalUnavailableError(value: unknown): value is SandboxTerminalUnavailableError {
  return value instanceof Error && value.name === "SandboxTerminalUnavailableError";
}

export interface SandboxProviderPlugin<Config = unknown> {
  readonly kind: SandboxProviderKind;
  /** Product name for UI and logs. */
  readonly label: string;
  /** Environment variable that carries the deployment-wide API key. */
  readonly credentialEnv: string;
  /** Whether the provider cannot work without that key (a local Cube can). */
  readonly credentialRequired: boolean;
  /** Environment variable naming the snapshot/template new sandboxes start from, if the provider has one. */
  readonly templateEnv?: string;
  /** Resources of the provider's base image (what a create without a template yields), when it has one. The
   *  control plane falls back to the base image only when this meets the run's resource target. */
  readonly baseImageResources?: { readonly cpu: number; readonly memory: number };
  /** Why an interactive terminal cannot be opened on this provider from this server, or null when it can. */
  interactiveTerminalProblem?(): string | null;
  /** Home of the runtime user inside this provider's sandboxes. */
  readonly home: string;
  /** Whether commands run as root (decides where root-only paths may be used). */
  readonly runsAsRoot: boolean;
  /** Exact identity used by shared resident harnesses. This can differ from
   *  `home` when a root provider keeps ordinary agent work under another home. */
  readonly runtime: {
    readonly home: string;
    readonly workdir: string;
    /** Provider-baked Bun used by resident runtimes, when exact-version verified. */
    readonly bunExecutable?: string;
  };
  /** Headers a preview link's token must travel in (token header, or Box's port-auth cookie). */
  previewAuthHeaders(token: string): Record<string, string>;
  /** Vendor config from the environment; throws on invalid settings. */
  configFromEnv(apiKey: string, env: SandboxEnv): Config;
  /** The snapshot/template new sandboxes are created from; "" means the provider's base image.
   *  `templateEnv` names the operator variable for the lane being provisioned (the plugin's own
   *  `templateEnv` when omitted); a plugin with several lanes keeps its defaults per variable. */
  template(env: SandboxEnv, templateEnv?: string): string;
  createProvider(config: Config, ports?: SandboxProviderPorts): SandboxProvider;
  /** Validate a user-supplied key (and optional snapshot) without creating anything; throws SandboxCredentialError. */
  validateCredential?(input: SandboxCredentialInput, ports?: SandboxProviderPorts): Promise<void>;
  /** Null when `url` is a preview host this provider issues; otherwise why it is refused. */
  previewHostProblem(url: URL, env: SandboxEnv): string | null;
}
