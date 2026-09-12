import type {
  SandboxCreateOptions,
  SandboxExecuteResult,
  SandboxFileSystem,
  SandboxHandle,
  SandboxInventory,
  SandboxPreviewLink,
  SandboxProcess,
  SandboxProvider,
  SandboxPtyHandle,
  SandboxSession,
} from "@useagent/sandbox-contract";

/**
 * Box (box.ascii.dev) behind the sandbox provider contract, over its public
 * REST API with no SDK. A Box is a Linux VM with a work directory at
 * /home/user, sync command execution capped at 600 s, a file read/write API,
 * and per-port HTTPS hosting; there is no PTY, label, or computer-use API, so
 * labels are persisted as a file inside the box and interactive terminals
 * report themselves unsupported instead of pretending.
 */

export const BOX_API_URL = "https://ascii.dev/api/box/v1";
export const BOX_HOSTING_DOMAIN = "on.ascii.dev";
export const BOX_MACHINE_TYPES = ["small", "default", "large"] as const;
export type BoxMachineType = (typeof BOX_MACHINE_TYPES)[number];

export interface BoxApiConfig {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly machineType: BoxMachineType;
  /** Optional Box environment (account secrets bundle) to create from. */
  readonly environment?: string;
}

export type BoxFetch = (input: string, init: RequestInit) => Promise<Response>;

export class BoxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BoxApiError";
  }
}

interface BoxRecord {
  readonly id: string;
  readonly state: string;
  readonly vcpu?: number;
  readonly memoryGB?: number;
  readonly url?: string | null;
  readonly subdomain?: string | null;
}

const WORK_DIR = "/home/user";
const STATE_DIR = `${WORK_DIR}/.useagent`;
const LABELS_PATH = `${STATE_DIR}/labels.json`;
const SYNC_COMMAND_CAP_SECONDS = 600;
const DEFAULT_TTL_SECONDS = 3600;
const READY_POLL_MS = 2_000;
const READY_TIMEOUT_MS = 240_000;
const LONG_POLL_MS = 1_000;

const READY_STATES: ReadonlySet<string> = new Set(["ready", "idle", "running"]);
const ARCHIVED_STATES: ReadonlySet<string> = new Set(["archiving", "archived"]);

/** Box lifecycle -> the states the engines already understand. */
export function boxSandboxState(state: string): string {
  if (READY_STATES.has(state)) return "started";
  if (ARCHIVED_STATES.has(state)) return "archived";
  if (state === "error") return "error";
  return "pending";
}

const q = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** One shell line: exported env, cwd, then the command in its own subshell. */
export function composeBoxCommand(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
): string {
  const exports = Object.entries(env ?? {})
    .map(([key, value]) => `export ${key}=${q(value)};`)
    .join(" ");
  const enter = cwd ? `cd ${q(cwd)} && ` : "";
  return `${exports}${exports ? " " : ""}${enter}(${command})`;
}

/** A hosted-port URL carries its access token as `_token`; surface both. */
export function boxPreviewLink(url: string): SandboxPreviewLink {
  try {
    const token = new URL(url).searchParams.get("_token");
    return token ? { url, token } : { url };
  } catch {
    return { url };
  }
}

class BoxApi {
  constructor(
    private readonly config: BoxApiConfig,
    private readonly fetchImpl: BoxFetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    if (!response.ok || payload.ok === false) {
      const code = typeof payload.code === "string" ? payload.code : `http_${response.status}`;
      const message = typeof payload.message === "string" ? payload.message : `Box API ${method} ${path} failed (${response.status})`;
      throw new BoxApiError(response.status, code, message);
    }
    return payload as T;
  }

  async box(id: string): Promise<BoxRecord> {
    const payload = await this.request<{ box: BoxRecord }>("GET", `/boxes/${encodeURIComponent(id)}`);
    return payload.box;
  }

  async waitUntilReady(id: string): Promise<BoxRecord> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const box = await this.box(id);
      if (READY_STATES.has(box.state)) return box;
      if (box.state === "error") throw new BoxApiError(500, "box_error", `Box ${id} entered the error state`);
      if (Date.now() >= deadline) throw new BoxApiError(504, "box_not_ready", `Box ${id} was not ready after ${READY_TIMEOUT_MS / 1000}s (${box.state})`);
      await sleep(READY_POLL_MS);
    }
  }

  async command(
    id: string,
    command: string,
    timeoutSeconds: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    const payload = await this.request<{
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      timedOut?: boolean;
    }>("POST", `/boxes/${encodeURIComponent(id)}/commands`, {
      command,
      timeoutSeconds: Math.min(Math.max(1, Math.round(timeoutSeconds)), SYNC_COMMAND_CAP_SECONDS),
      detached: false,
    });
    return {
      stdout: payload.stdout ?? "",
      stderr: payload.stderr ?? "",
      exitCode: payload.exitCode ?? null,
      timedOut: payload.timedOut === true,
    };
  }

  async detach(id: string, command: string): Promise<void> {
    await this.request("POST", `/boxes/${encodeURIComponent(id)}/commands`, { command, timeoutSeconds: 30, detached: true });
  }

  async readFile(id: string, path: string): Promise<Buffer> {
    const payload = await this.request<{ content?: string; encoding?: string }>(
      "GET",
      `/boxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}&encoding=base64`,
    );
    return Buffer.from(payload.content ?? "", payload.encoding === "utf8" ? "utf8" : "base64");
  }

  async writeFile(id: string, path: string, content: Buffer): Promise<void> {
    await this.request("PUT", `/boxes/${encodeURIComponent(id)}/files`, {
      path,
      content: content.toString("base64"),
      encoding: "base64",
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class BoxProcess implements SandboxProcess {
  private readonly sessions = new Map<string, Set<string>>();

  constructor(
    private readonly api: BoxApi,
    private readonly boxId: string,
  ) {}

  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSeconds = SYNC_COMMAND_CAP_SECONDS,
  ): Promise<SandboxExecuteResult> {
    const composed = composeBoxCommand(command, cwd, env);
    if (timeoutSeconds <= SYNC_COMMAND_CAP_SECONDS) {
      const result = await this.api.command(this.boxId, composed, timeoutSeconds);
      return {
        exitCode: result.timedOut ? 124 : (result.exitCode ?? undefined),
        result: `${result.stdout}${result.stderr}`,
      };
    }
    // Past the sync cap: run detached, poll the exit marker, read the log.
    const id = crypto.randomUUID();
    const dir = `${STATE_DIR}/cmd/${id}`;
    await this.api.writeFile(this.boxId, `${dir}/run.sh`, Buffer.from(composed));
    await this.api.detach(
      this.boxId,
      `nohup sh -c 'sh ${q(`${dir}/run.sh`)} >${q(`${dir}/log`)} 2>&1; echo $? >${q(`${dir}/exit`)}' </dev/null >/dev/null 2>&1 &`,
    );
    const deadline = Date.now() + timeoutSeconds * 1000;
    let exitCode: number | undefined;
    while (Date.now() < deadline) {
      const marker = await this.api.readFile(this.boxId, `${dir}/exit`).catch(() => null);
      if (marker) {
        exitCode = Number.parseInt(marker.toString("utf8").trim(), 10);
        if (Number.isNaN(exitCode)) exitCode = undefined;
        break;
      }
      await sleep(LONG_POLL_MS);
    }
    const log = await this.api.readFile(this.boxId, `${dir}/log`).catch(() => Buffer.alloc(0));
    return { exitCode: exitCode ?? 124, result: log.toString("utf8") };
  }

  async createSession(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Set());
    await this.api.command(this.boxId, `mkdir -p ${q(`${STATE_DIR}/sessions/${sessionId}`)}`, 30);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.api.command(
      this.boxId,
      `pkill -f ${q(`USEAGENT_SESSION_ID=${sessionId}`)} >/dev/null 2>&1; rm -rf ${q(`${STATE_DIR}/sessions/${sessionId}`)}`,
      30,
    );
  }

  async getSession(sessionId: string): Promise<SandboxSession> {
    return { commands: [...(this.sessions.get(sessionId) ?? [])].map((id) => ({ id })) };
  }

  async executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    timeoutSeconds = SYNC_COMMAND_CAP_SECONDS,
  ): Promise<{ cmdId: string; output?: string; stdout?: string; stderr?: string; exitCode?: number }> {
    await this.createSession(sessionId);
    if (!request.runAsync) {
      const result = await this.api.command(this.boxId, request.command, timeoutSeconds);
      return {
        cmdId: crypto.randomUUID(),
        output: `${result.stdout}${result.stderr}`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.timedOut ? 124 : (result.exitCode ?? undefined),
      };
    }
    const commandId = crypto.randomUUID();
    const dir = `${STATE_DIR}/sessions/${sessionId}`;
    await this.api.writeFile(this.boxId, `${dir}/${commandId}.sh`, Buffer.from(request.command));
    await this.api.detach(
      this.boxId,
      `USEAGENT_SESSION_ID=${sessionId} USEAGENT_COMMAND_ID=${commandId} nohup setsid sh ${q(`${dir}/${commandId}.sh`)} </dev/null >${q(`${dir}/${commandId}.log`)} 2>&1 &`,
    );
    this.sessions.get(sessionId)?.add(commandId);
    return { cmdId: commandId, exitCode: 0 };
  }

  async getSessionCommandLogs(sessionId: string, commandId: string): Promise<{ output: string; stdout: string; stderr: string }> {
    const log = await this.api
      .readFile(this.boxId, `${STATE_DIR}/sessions/${sessionId}/${commandId}.log`)
      .catch(() => Buffer.alloc(0));
    const output = log.toString("utf8");
    return { output, stdout: output, stderr: "" };
  }

  async createPty(): Promise<SandboxPtyHandle> {
    throw new Error("Box sandboxes do not support interactive terminals yet; commands and files work, the terminal panel does not");
  }
}

class BoxFileSystem implements SandboxFileSystem {
  constructor(
    private readonly api: BoxApi,
    private readonly boxId: string,
  ) {}

  async getFileDetails(path: string): Promise<{ size?: number }> {
    const result = await this.api.command(this.boxId, `stat -c %s ${q(path)}`, 30);
    if (result.exitCode !== 0) throw new Error(`Box file not found: ${path}`);
    const size = Number.parseInt(result.stdout.trim(), 10);
    return Number.isNaN(size) ? {} : { size };
  }

  downloadFile(path: string): Promise<Buffer> {
    return this.api.readFile(this.boxId, path);
  }

  uploadFile(file: Buffer, remotePath: string): Promise<void> {
    return this.api.writeFile(this.boxId, remotePath, file);
  }
}

class BoxSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly cpu: number;
  readonly memory: number;
  state: string;
  labels: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;

  constructor(
    private readonly api: BoxApi,
    record: BoxRecord,
    labels: Record<string, string>,
  ) {
    this.id = record.id;
    this.cpu = record.vcpu ?? 0;
    this.memory = record.memoryGB ?? 0;
    this.state = boxSandboxState(record.state);
    this.labels = labels;
    this.process = new BoxProcess(api, record.id);
    this.fs = new BoxFileSystem(api, record.id);
  }

  async start(): Promise<void> {
    const current = await this.api.box(this.id);
    if (ARCHIVED_STATES.has(current.state)) {
      await this.api.request("POST", `/boxes/${encodeURIComponent(this.id)}/resume`);
    }
    const ready = await this.api.waitUntilReady(this.id);
    this.state = boxSandboxState(ready.state);
  }

  async delete(): Promise<void> {
    await this.api.request("DELETE", `/boxes/${encodeURIComponent(this.id)}`);
    this.state = "deleted";
  }

  async getPreviewLink(port: number): Promise<SandboxPreviewLink> {
    const payload = await this.api.request<{ url?: string }>("POST", `/boxes/${encodeURIComponent(this.id)}/host`, { port });
    if (!payload.url) throw new BoxApiError(502, "host_url_missing", `Box did not return a hosted URL for port ${port}`);
    return boxPreviewLink(payload.url);
  }
}

class BoxProvider implements SandboxProvider {
  private readonly api: BoxApi;

  constructor(
    private readonly config: BoxApiConfig,
    fetchImpl: BoxFetch,
  ) {
    this.api = new BoxApi(config, fetchImpl);
  }

  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const created = await this.api.request<{ box: BoxRecord }>(
      "POST",
      "/boxes",
      {
        type: this.config.machineType,
        ttlSeconds: options.autoStopInterval ? options.autoStopInterval * 60 : DEFAULT_TTL_SECONDS,
        ...(options.envVars && Object.keys(options.envVars).length > 0 ? { env: options.envVars } : {}),
        ...(options.snapshot ? { from: options.snapshot } : {}),
        ...(this.config.environment ? { environment: this.config.environment } : {}),
      },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    const ready = await this.api.waitUntilReady(created.box.id);
    const labels = options.labels ?? {};
    if (Object.keys(labels).length > 0) {
      await this.api.writeFile(ready.id, LABELS_PATH, Buffer.from(JSON.stringify(labels)));
    }
    return new BoxSandboxHandle(this.api, ready, labels);
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    const record = await this.api.box(sandboxId);
    const labels = READY_STATES.has(record.state) ? await this.readLabels(record.id) : {};
    return new BoxSandboxHandle(this.api, record, labels);
  }

  async *list(): AsyncIterable<SandboxHandle> {
    let cursor: string | null = null;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const payload: { boxes?: BoxRecord[]; nextCursor?: string | null } = await this.api.request("GET", `/boxes${query}`);
      for (const record of payload.boxes ?? []) yield new BoxSandboxHandle(this.api, record, {});
      cursor = payload.nextCursor ?? null;
    } while (cursor);
  }

  async inventory(): Promise<SandboxInventory> {
    let active = 0;
    let paused = 0;
    for await (const box of this.list()) {
      if (box.state === "started") active += 1;
      else if (box.state === "archived") paused += 1;
    }
    return { activeSandboxes: active, pausedSandboxes: paused };
  }

  private async readLabels(id: string): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse((await this.api.readFile(id, LABELS_PATH)).toString("utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    } catch {
      return {};
    }
  }
}

export function boxSandboxProvider(
  config: BoxApiConfig,
  fetchImpl: BoxFetch = (input, init) => fetch(input, init),
): SandboxProvider {
  return new BoxProvider(config, fetchImpl);
}
