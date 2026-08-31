import {
  Sandbox as E2BSandbox,
  type CommandHandle,
  type SandboxInfo,
  type SandboxOpts,
} from "e2b";
import type {
  SandboxCreateOptions,
  SandboxExecuteResult,
  SandboxFileSystem,
  SandboxHandle,
  SandboxProcess,
  SandboxProvider,
  SandboxPtyHandle,
  SandboxSession,
} from "./provider";
import type { SandboxInventory } from "@useagent/sandbox-contract";
import { buildCubeRuntimeIdentityPreflightCommand } from "../engines/runtime-environment";

interface CubeConnectionOptions {
  apiKey?: string;
  apiUrl: string;
  debug: boolean;
  domain: string;
  requestTimeoutMs: number;
  validateApiKey: false;
}

const DEFAULT_READINESS_ATTEMPTS = 20;
const DEFAULT_READINESS_DELAY_MS = 250;

interface CubeCommandFailure {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cubeCommandFailure(error: unknown): CubeCommandFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<CubeCommandFailure>;
  return typeof candidate.exitCode === "number" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string"
    ? {
        exitCode: candidate.exitCode,
        stdout: candidate.stdout,
        stderr: candidate.stderr,
      }
    : null;
}

async function runCubeCommand(
  sandbox: E2BSandbox,
  command: string,
  options: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CubeCommandFailure> {
  try {
    return await sandbox.commands.run(command, options);
  } catch (error) {
    const failure = cubeCommandFailure(error);
    if (failure) return failure;
    throw error;
  }
}

function requireDnsHostname(value: string, envName: string): string {
  if (!/^[a-z0-9.-]+$/i.test(value)) {
    throw new Error(`${envName} must be a DNS hostname`);
  }
  return value;
}

async function waitForCubeReadiness(
  sandbox: SandboxHandle,
  domain: string,
): Promise<void> {
  const attempts = positiveInteger(
    process.env.CUBE_READINESS_ATTEMPTS,
    DEFAULT_READINESS_ATTEMPTS,
  );
  const delayMs = positiveInteger(
    process.env.CUBE_READINESS_RETRY_DELAY_MS,
    DEFAULT_READINESS_DELAY_MS,
  );
  const previewHost = `readiness.${requireDnsHostname(domain, "CUBE_SANDBOX_DOMAIN")}`;
  const publicHost = requireDnsHostname(
    process.env.CUBE_READINESS_PUBLIC_HOST?.trim() || "github.com",
    "CUBE_READINESS_PUBLIC_HOST",
  );

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const probe = await sandbox.process.executeCommand(
        `${buildCubeRuntimeIdentityPreflightCommand()} >/dev/null && ` +
          `getent hosts ${previewHost} >/dev/null 2>&1 && getent hosts ${publicHost} >/dev/null 2>&1`,
        undefined,
        undefined,
        5,
      );
      if (probe.exitCode === 0) return;
    } catch {
      // Cube's envd and resolver can become reachable independently; retry both
      // through the next command probe rather than declaring the VM ready.
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Cube sandbox ${sandbox.id} did not reach root identity/workspace and command/DNS readiness`,
  );
}

async function assertCubeRuntimeIdentity(sandbox: SandboxHandle): Promise<void> {
  const probe = await sandbox.process.executeCommand(
    buildCubeRuntimeIdentityPreflightCommand(),
    undefined,
    undefined,
    5,
  );
  if (probe.exitCode !== 0) {
    throw new Error("Cube sandbox did not reach root identity/workspace");
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trustedProxyIngress(): boolean {
  const value = process.env.CUBE_PROXY_TRUSTED_INGRESS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function cubeConnectionOptions(apiKey: string): CubeConnectionOptions {
  const configuredPort = positiveInteger(process.env.CUBE_PROXY_PORT_HTTP, 0);
  const scheme =
    process.env.CUBE_PROXY_SCHEME?.trim().toLowerCase() ||
    (configuredPort === 443 ? "https" : "http");
  if (scheme !== "http" && scheme !== "https") {
    throw new Error("CUBE_PROXY_SCHEME must be http or https");
  }
  const expectedPort = scheme === "https" ? 443 : 80;
  const proxyPort = configuredPort || expectedPort;
  if (proxyPort !== expectedPort) {
    throw new Error(
      `Cube E2B adapter requires the public proxy on ${scheme} port ${expectedPort}; got ${proxyPort}`,
    );
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    apiUrl: (process.env.CUBE_API_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, ""),
    debug: scheme === "http",
    domain: process.env.CUBE_SANDBOX_DOMAIN?.trim() || "cube.app",
    requestTimeoutMs: positiveInteger(process.env.CUBE_REQUEST_TIMEOUT_MS, 30_000),
    validateApiKey: false,
  };
}

function cubeState(state: SandboxInfo["state"]): string {
  return state === "running" ? "started" : state;
}

function sessionDirectory(sessionId: string): string {
  return `/tmp/skynet-cube-sessions/${Buffer.from(sessionId).toString("hex")}`;
}

/** Session id a live process was stamped with. Reads the legacy SKYNET_ name
 *  too: processes started by the pre-rename release survive the cutover
 *  deploy, and matching only the new name would leak them past deleteSession
 *  and hide them from getSession. New processes are stamped USEAGENT_* only -
 *  drop the legacy read once the cutover release has cycled every resident
 *  and warm-pool sandbox. */
function processSessionId(envs: Record<string, string | undefined>): string | undefined {
  return envs.USEAGENT_SESSION_ID ?? envs.SKYNET_SESSION_ID;
}

class CubeProcess implements SandboxProcess {
  constructor(private readonly sandbox: () => Promise<E2BSandbox>) {}

  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSeconds?: number,
  ): Promise<SandboxExecuteResult> {
    const sandbox = await this.sandbox();
    const result = await runCubeCommand(sandbox, command, {
      ...(cwd ? { cwd } : {}),
      ...(env ? { envs: env } : {}),
      ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}),
    });
    return {
      exitCode: result.exitCode,
      result: `${result.stdout}${result.stderr}`,
    };
  }

  async createSession(sessionId: string): Promise<void> {
    const sandbox = await this.sandbox();
    await sandbox.commands.run(`mkdir -p ${sessionDirectory(sessionId)}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sandbox = await this.sandbox();
    const processes = await sandbox.commands.list();
    await Promise.all(
      processes
        .filter((process) => processSessionId(process.envs) === sessionId)
        .map((process) => sandbox.commands.kill(process.pid).catch(() => false)),
    );
    await sandbox.commands.run(`rm -rf ${sessionDirectory(sessionId)}`);
  }

  async getSession(sessionId: string): Promise<SandboxSession> {
    const sandbox = await this.sandbox();
    const processes = await sandbox.commands.list();
    return {
      commands: processes
        .filter((process) => processSessionId(process.envs) === sessionId)
        .map((process) => ({
          id: process.envs.USEAGENT_COMMAND_ID ?? process.envs.SKYNET_COMMAND_ID ?? String(process.pid),
        })),
    };
  }

  async executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean },
    timeoutSeconds?: number,
  ): Promise<{ cmdId: string; output?: string; stdout?: string; stderr?: string; exitCode?: number }> {
    const sandbox = await this.sandbox();
    await this.createSession(sessionId);
    if (!request.runAsync) {
      const result = await runCubeCommand(sandbox, request.command, {
        ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}),
      });
      return {
        cmdId: crypto.randomUUID(),
        output: `${result.stdout}${result.stderr}`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }

    const commandId = crypto.randomUUID();
    const directory = sessionDirectory(sessionId);
    const script = `${directory}/${commandId}.sh`;
    const log = `${directory}/${commandId}.log`;
    await sandbox.files.write(script, request.command);
    await sandbox.commands.run(`nohup setsid sh ${script} </dev/null >${log} 2>&1 &`, {
      envs: {
        USEAGENT_COMMAND_ID: commandId,
        USEAGENT_SESSION_ID: sessionId,
      },
    });
    return { cmdId: commandId, exitCode: 0 };
  }

  async getSessionCommandLogs(
    sessionId: string,
    commandId: string,
  ): Promise<{ output: string; stdout: string; stderr: string }> {
    const sandbox = await this.sandbox();
    const log = `${sessionDirectory(sessionId)}/${commandId}.log`;
    const output = await sandbox.files.read(log).catch(() => "");
    return { output, stdout: output, stderr: "" };
  }

  async createPty(options: {
    cols: number;
    rows: number;
    cwd?: string;
    envs?: Record<string, string>;
    onData: (data: Uint8Array) => void | Promise<void>;
  }): Promise<SandboxPtyHandle> {
    const sandbox = await this.sandbox();
    const handle = await sandbox.pty.create({
      cols: options.cols,
      rows: options.rows,
      onData: options.onData,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.envs ? { envs: options.envs } : {}),
    });
    return cubePtyHandle(sandbox, handle);
  }
}

function cubePtyHandle(sandbox: E2BSandbox, handle: CommandHandle): SandboxPtyHandle {
  const encoder = new TextEncoder();
  return {
    waitForConnection: async () => {},
    sendInput: (data) =>
      sandbox.pty.sendInput(
        handle.pid,
        typeof data === "string" ? encoder.encode(data) : data,
      ),
    resize: (cols, rows) => sandbox.pty.resize(handle.pid, { cols, rows }),
    disconnect: () => handle.disconnect(),
    kill: () => handle.kill(),
  };
}

class CubeFileSystem implements SandboxFileSystem {
  constructor(private readonly sandbox: () => Promise<E2BSandbox>) {}

  async getFileDetails(path: string): Promise<{ size?: number }> {
    const sandbox = await this.sandbox();
    const info = await sandbox.files.getInfo(path);
    return { size: info.size };
  }

  async downloadFile(path: string): Promise<Buffer> {
    const sandbox = await this.sandbox();
    return Buffer.from(await sandbox.files.read(path, { format: "bytes" }));
  }

  async uploadFile(file: Buffer, remotePath: string): Promise<void> {
    const sandbox = await this.sandbox();
    await sandbox.files.write(remotePath, new Blob([new Uint8Array(file)]));
  }
}

class CubeSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  readonly labels: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;
  state: string;
  private sandbox: E2BSandbox | null;

  constructor(
    info: SandboxInfo,
    private readonly connection: CubeConnectionOptions,
    sandbox: E2BSandbox | null,
  ) {
    this.id = info.sandboxId;
    this.cpu = info.cpuCount;
    this.memory = info.memoryMB / 1024;
    this.labels = info.metadata;
    this.state = cubeState(info.state);
    this.sandbox = sandbox;
    const connect = () => this.connected();
    this.process = new CubeProcess(connect);
    this.fs = new CubeFileSystem(connect);
  }

  private async connected(): Promise<E2BSandbox> {
    if (!this.sandbox) {
      this.sandbox = await E2BSandbox.connect(this.id, this.connection);
      this.state = "started";
    }
    return this.sandbox;
  }

  async start(): Promise<void> {
    await this.connected();
  }

  async delete(): Promise<void> {
    await E2BSandbox.kill(this.id, this.connection);
    this.sandbox = null;
    this.state = "deleted";
  }

  async getPreviewLink(port: number): Promise<{ url: string; token?: string }> {
    const sandbox = await this.connected();
    const scheme = this.connection.debug ? "http" : "https";
    return {
      url: `${scheme}://${sandbox.getHost(port)}`,
      token: sandbox.trafficAccessToken,
    };
  }
}

class CubeProvider implements SandboxProvider {
  private readonly connection: CubeConnectionOptions;

  constructor(apiKey: string) {
    this.connection = cubeConnectionOptions(apiKey);
  }

  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const template = options.snapshot?.trim() || process.env.CUBE_TEMPLATE_ID?.trim();
    if (!template) throw new Error("CUBE_TEMPLATE_ID is required when SANDBOX_PROVIDER=cube");
    const timeoutMinutes = options.autoStopInterval && options.autoStopInterval > 0
      ? options.autoStopInterval
      : positiveInteger(process.env.SANDBOX_AUTO_STOP_MIN, 30);
    // Cube rejects shell bootstrap variables such as BASH_ENV at its API
    // boundary. useAgent explicitly sources the protected dotenv when each
    // engine boots, so this compatibility-only variable is unnecessary here.
    // Preserve every runtime/gateway variable the caller supplied.
    const envs = options.envVars
      ? Object.fromEntries(
          Object.entries(options.envVars).filter(([name]) => name !== "BASH_ENV"),
        )
      : undefined;
    const createOptions: SandboxOpts = {
      ...this.connection,
      envs,
      metadata: options.labels,
      // The E2B JS SDK does not attach Cube's per-sandbox traffic token to its
      // envd RPC requests. Keep Cube's token gate on by default; a single-host
      // deployment may instead trust an IP-restricted reverse proxy in front of
      // a firewall-blocked CubeProxy data plane.
      network: { allowPublicTraffic: trustedProxyIngress() },
      lifecycle: { onTimeout: "pause", autoResume: true },
      secure: true,
      timeoutMs: timeoutMinutes * 60_000,
    };
    const sandbox = await E2BSandbox.create(template, createOptions);
    const info = await E2BSandbox.getInfo(sandbox.sandboxId, this.connection);
    const handle = new CubeSandboxHandle(info, this.connection, sandbox);
    try {
      await waitForCubeReadiness(handle, this.connection.domain);
      return handle;
    } catch (error) {
      await handle.delete().catch(() => undefined);
      throw error;
    }
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    const info = await E2BSandbox.getInfo(sandboxId, this.connection);
    const handle = new CubeSandboxHandle(info, this.connection, null);
    try {
      await assertCubeRuntimeIdentity(handle);
      return handle;
    } catch (error) {
      await handle.delete().catch(() => undefined);
      throw error;
    }
  }

  async *list(): AsyncIterable<SandboxHandle> {
    const paginator = E2BSandbox.list(this.connection);
    while (paginator.hasNext) {
      const items = await paginator.nextItems();
      for (const info of items) yield new CubeSandboxHandle(info, this.connection, null);
    }
  }

  async inventory(): Promise<SandboxInventory> {
    let activeSandboxes = 0;
    let pausedSandboxes = 0;
    for await (const sandbox of this.list()) {
      if (sandbox.state === "running" || sandbox.state === "started") activeSandboxes += 1;
      else if (sandbox.state === "paused") pausedSandboxes += 1;
    }

    const token = process.env.CUBE_OPS_ACCESS_TOKEN?.trim();
    if (!token) return { activeSandboxes, pausedSandboxes };
    const base = (process.env.CUBE_OPS_URL?.trim() || "http://127.0.0.1:12088/opsapi/v1")
      .replace(/\/+$/, "");
    const response = await fetch(`${base}/nodes`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Cube node inventory failed: HTTP ${response.status}`);
    const raw = await response.json();
    if (!Array.isArray(raw)) throw new Error("Cube node inventory returned a non-array payload");
    const nodes = raw.map((value) => {
      const node = value as Record<string, unknown>;
      const allocatable = node.allocatable as Record<string, unknown> | undefined;
      return {
        id: String(node.nodeID ?? ""),
        ready: node.healthy === true,
        schedulingDisabled: node.schedulingDisabled === true,
        allocatableCpuMillicores: Number(allocatable?.cpuMilli ?? 0),
        allocatableMemoryMib: Number(allocatable?.memoryMB ?? 0),
      };
    }).filter((node) => node.id.length > 0);
    return {
      nodes,
      readyNodes: nodes.filter((node) => node.ready && !node.schedulingDisabled).length,
      allocatableCpuMillicores: nodes.reduce((sum, node) => sum + node.allocatableCpuMillicores, 0),
      allocatableMemoryMib: nodes.reduce((sum, node) => sum + node.allocatableMemoryMib, 0),
      activeSandboxes,
      pausedSandboxes,
    };
  }
}

export function cubeSandboxProvider(apiKey: string): SandboxProvider {
  return new CubeProvider(apiKey);
}
