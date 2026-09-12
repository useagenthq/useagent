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
import { dbSandboxLabelStore, type SandboxLabelStore } from "./sandbox-labels";

/**
 * Box (box.ascii.dev) behind the sandbox provider contract, over its public
 * REST API with no SDK. A Box is a Linux VM running as `user` with a work
 * directory at /home/user, sync command execution capped at 600 s, a file
 * read/write API scoped to /home/user and /tmp, and per-port HTTPS hosting
 * whose access token travels as a `_token` query parameter.
 *
 * What Box does not have, and how this provider handles it:
 * - labels: kept in the control plane (sandbox_labels), never inside the box
 * - idle auto-stop: Box's ttlSeconds is absolute (from create/resume), so the
 *   auto-delete interval bounds a box's life and cleanup deletes explicitly
 * - PTY: interactive terminals report themselves unsupported
 * - computer use: not offered (no screenshot/mouse API)
 */

export const BOX_API_URL = "https://ascii.dev/api/box/v1";
export const BOX_HOSTING_DOMAIN = "on.ascii.dev";
export const BOX_MACHINE_TYPES = ["small", "default", "large"] as const;
export type BoxMachineType = (typeof BOX_MACHINE_TYPES)[number];
/** Box caps ttlSeconds at 30 days. */
export const BOX_TTL_MAX_SECONDS = 2_592_000;

export interface BoxApiConfig {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly machineType: BoxMachineType;
  /** Optional Box environment (account secrets bundle) to create from. */
  readonly environment?: string;
}

export type BoxFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface BoxProviderOptions {
  readonly fetchImpl?: BoxFetch;
  readonly labels?: SandboxLabelStore;
  readonly sleep?: (ms: number) => Promise<void>;
}

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
const SYNC_COMMAND_CAP_SECONDS = 600;
const READY_POLL_MS = 2_000;
const READY_TIMEOUT_MS = 240_000;
const ARCHIVE_SETTLE_TIMEOUT_MS = 120_000;
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

/**
 * A hosted-port URL authenticates through its `_token` query parameter. The
 * link exposes the origin as `url` (callers append paths to it) and the token
 * as `query`, which callers add to every request via `previewRequestUrl`.
 */
export function boxPreviewLink(hostedUrl: string): SandboxPreviewLink {
  const url = new URL(hostedUrl);
  const token = url.searchParams.get("_token");
  const origin = `${url.protocol}//${url.host}`;
  return token ? { url: origin, token, query: { _token: token } } : { url: origin };
}

/** Box's absolute ttlSeconds from the contract's minutes; null disables auto-archive. */
export function boxTtlSeconds(options: Pick<SandboxCreateOptions, "autoDeleteInterval">): number | null {
  if (!options.autoDeleteInterval || options.autoDeleteInterval <= 0) return null;
  return Math.min(Math.round(options.autoDeleteInterval * 60), BOX_TTL_MAX_SECONDS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class BoxApi {
  constructor(
    private readonly config: BoxApiConfig,
    private readonly fetchImpl: BoxFetch,
    readonly sleep: (ms: number) => Promise<void>,
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
      await this.sleep(READY_POLL_MS);
    }
  }

  /** An archiving box cannot be resumed until it has settled. */
  async waitUntilSettled(id: string): Promise<BoxRecord> {
    const deadline = Date.now() + ARCHIVE_SETTLE_TIMEOUT_MS;
    for (;;) {
      const box = await this.box(id);
      if (box.state !== "archiving") return box;
      if (Date.now() >= deadline) throw new BoxApiError(504, "box_archiving", `Box ${id} is still archiving after ${ARCHIVE_SETTLE_TIMEOUT_MS / 1000}s`);
      await this.sleep(READY_POLL_MS);
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

class BoxProcess implements SandboxProcess {
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
    await this.api.command(this.boxId, `mkdir -p ${q(dir)}`, 30);
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
      await this.api.sleep(LONG_POLL_MS);
    }
    const log = await this.api.readFile(this.boxId, `${dir}/log`).catch(() => Buffer.alloc(0));
    return { exitCode: exitCode ?? 124, result: log.toString("utf8") };
  }

  private sessionDir(sessionId: string): string {
    return `${STATE_DIR}/sessions/${sessionId}`;
  }

  async createSession(sessionId: string): Promise<void> {
    await this.api.command(this.boxId, `mkdir -p ${q(this.sessionDir(sessionId))}`, 30);
  }

  /** Kill every process group the session started (pid files), then drop its directory. */
  async deleteSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await this.api.command(
      this.boxId,
      `for f in ${q(dir)}/*.pid; do [ -e "$f" ] || continue; p=$(cat "$f"); kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; done; rm -rf ${q(dir)}`,
      30,
    );
  }

  async getSession(sessionId: string): Promise<SandboxSession> {
    const result = await this.api.command(this.boxId, `ls ${q(this.sessionDir(sessionId))} 2>/dev/null`, 30);
    const commands = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".pid"))
      .map((line) => ({ id: line.slice(0, -".pid".length) }));
    return { commands };
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
    const dir = this.sessionDir(sessionId);
    await this.api.writeFile(this.boxId, `${dir}/${commandId}.sh`, Buffer.from(request.command));
    // setsid makes the script a process-group leader; the pid file lets deleteSession kill the whole group.
    await this.api.detach(
      this.boxId,
      `USEAGENT_SESSION_ID=${sessionId} USEAGENT_COMMAND_ID=${commandId} nohup setsid sh ${q(`${dir}/${commandId}.sh`)} </dev/null >${q(`${dir}/${commandId}.log`)} 2>&1 & echo $! >${q(`${dir}/${commandId}.pid`)}`,
    );
    return { cmdId: commandId, exitCode: 0 };
  }

  async getSessionCommandLogs(sessionId: string, commandId: string): Promise<{ output: string; stdout: string; stderr: string }> {
    const log = await this.api
      .readFile(this.boxId, `${this.sessionDir(sessionId)}/${commandId}.log`)
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
  readonly providerKind = "box" as const;
  readonly cpu: number;
  readonly memory: number;
  state: string;
  labels: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;

  constructor(
    private readonly api: BoxApi,
    private readonly labelStore: SandboxLabelStore,
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
    const settled = await this.api.waitUntilSettled(this.id);
    if (settled.state === "archived") {
      await this.api.request("POST", `/boxes/${encodeURIComponent(this.id)}/resume`);
    }
    const ready = await this.api.waitUntilReady(this.id);
    this.state = boxSandboxState(ready.state);
  }

  async delete(): Promise<void> {
    await this.api.request("DELETE", `/boxes/${encodeURIComponent(this.id)}`);
    await this.labelStore.remove(this.id).catch(() => {});
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
  private readonly labels: SandboxLabelStore;

  constructor(
    private readonly config: BoxApiConfig,
    options: BoxProviderOptions,
  ) {
    this.api = new BoxApi(config, options.fetchImpl ?? ((input, init) => fetch(input, init)), options.sleep ?? defaultSleep);
    this.labels = options.labels ?? dbSandboxLabelStore("box");
  }

  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    const created = await this.api.request<{ box: BoxRecord }>(
      "POST",
      "/boxes",
      {
        type: this.config.machineType,
        // Absolute, not idle: the delete interval bounds the box's life.
        ttlSeconds: boxTtlSeconds(options),
        ...(options.envVars && Object.keys(options.envVars).length > 0 ? { env: options.envVars } : {}),
        ...(options.snapshot ? { from: options.snapshot } : {}),
        ...(this.config.environment ? { environment: this.config.environment } : {}),
      },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    const labels = options.labels ?? {};
    // Labels are the trust anchor: recorded before anything can run in the box.
    await this.labels.write(created.box.id, labels);
    const ready = await this.api.waitUntilReady(created.box.id);
    return new BoxSandboxHandle(this.api, this.labels, ready, labels);
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    const record = await this.api.box(sandboxId);
    const labels = (await this.labels.read([record.id])).get(record.id) ?? {};
    return new BoxSandboxHandle(this.api, this.labels, record, labels);
  }

  async *list(): AsyncIterable<SandboxHandle> {
    let cursor: string | null = null;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const payload: { boxes?: BoxRecord[]; pageInfo?: { nextCursor?: string | null }; nextCursor?: string | null } =
        await this.api.request("GET", `/boxes${query}`);
      const records = payload.boxes ?? [];
      const labels = await this.labels.read(records.map((record) => record.id));
      for (const record of records) yield new BoxSandboxHandle(this.api, this.labels, record, labels.get(record.id) ?? {});
      cursor = payload.pageInfo?.nextCursor ?? payload.nextCursor ?? null;
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
}

export function boxSandboxProvider(config: BoxApiConfig, options: BoxProviderOptions = {}): SandboxProvider {
  return new BoxProvider(config, options);
}
