import type {
  SandboxCreateOptions,
  SandboxExecuteResult,
  SandboxDesktopAccess,
  SandboxFileSystem,
  SandboxHandle,
  SandboxInventory,
  SandboxPreviewLink,
  SandboxProcess,
  SandboxProvider,
  SandboxPtyHandle,
  SandboxLabelStore,
  SandboxProviderPorts,
  SandboxSession,
  SandboxTemplateStatus,
} from "@useagent/sandbox-contract";
import {
  SandboxNotFoundError,
  SandboxTerminalUnavailableError,
  memorySandboxLabelStore,
} from "@useagent/sandbox-contract";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export type BoxProviderOptions = Pick<SandboxProviderPorts, "fetchImpl" | "labels" | "sleep"> & {
  readonly now?: () => number;
};

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

interface BoxNamedSnapshot {
  readonly name: string;
  readonly status: "saving" | "ready" | "failed";
  readonly error?: string;
}

const HOME_DIR = "/home/user";
const WORK_DIR = `${HOME_DIR}/work`;
const STATE_DIR = `${HOME_DIR}/.useagent`;
const NATIVE_DESKTOP_PORT = 6080;
const SYNC_COMMAND_CAP_SECONDS = 600;
// The hosted request path can close at roughly 30 seconds even though the API
// accepts a larger command timeout. Longer work must use the detached poller.
const RELIABLE_SYNC_COMMAND_SECONDS = 30;
const READY_POLL_MS = 2_000;
const READY_TIMEOUT_MS = 240_000;
const DESKTOP_READY_TIMEOUT_MS = 120_000;
const ARCHIVE_SETTLE_TIMEOUT_MS = 120_000;
const TEMPLATE_READY_TIMEOUT_MS = 300_000;
const LONG_POLL_MS = 1_000;
const BOX_CLI_HOME_PREFIX = "useagent-box-pty-";
const BOX_CLI_CONFIG = '{\n  "api_url": "https://ascii.dev",\n  "channel": "ascii-prod"\n}\n';

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
 * A hosted port's `_token` is not accepted per request: the first visit
 * answers 302 + a `_port_auth` cookie, and every later request needs that
 * cookie. The link therefore carries the cookie value as its token and the
 * cookie header as its headers; `url` is the bare origin.
 */
export function boxPreviewLink(origin: string, portAuthCookie: string | null): SandboxPreviewLink {
  return portAuthCookie
    ? { url: origin, token: portAuthCookie, headers: { cookie: `_port_auth=${portAuthCookie}` } }
    : { url: origin };
}

export function parsePortAuthCookie(setCookie: string | null): string | null {
  return /(?:^|,\s*)_port_auth=([^;,\s]+)/.exec(setCookie ?? "")?.[1] ?? null;
}

/** Box's absolute ttlSeconds from the contract's minutes; null disables auto-archive. */
export function boxTtlSeconds(options: Pick<SandboxCreateOptions, "autoDeleteInterval">): number | null {
  if (!options.autoDeleteInterval || options.autoDeleteInterval <= 0) return null;
  return Math.min(Math.round(options.autoDeleteInterval * 60), BOX_TTL_MAX_SECONDS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BOX_CLI = "box";

/**
 * Why an interactive terminal cannot be opened from this server, or null. Box
 * has no PTY API; the shell rides the Box CLI's `box ssh`, so the CLI must be on
 * the useAgent server's PATH. Declared up front so the product can say so instead
 * of failing the WebSocket on every attempt.
 */
export function boxCliProblem(which: (binary: string) => string | null = (binary) => Bun.which(binary)): string | null {
  return which(BOX_CLI)
    ? null
    : "Box terminals need the Box CLI (box) installed on the useAgent server; commands and files still work";
}

export function boxPtyLoginArgv(apiKey: string): string[] {
  return ["box", "login", apiKey, "--json"];
}

export function boxPtyKeygenArgv(home: string): string[] {
  return [
    "ssh-keygen",
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    join(home, ".ssh", "ascii-box_ed25519"),
  ];
}

export function boxPtySshArgv(boxId: string): string[] {
  // Omitting COMMAND is what makes the Box CLI allocate an actual remote TTY.
  return ["box", "ssh", boxId];
}

export function boxPtyBootstrapCommand(readyMarker: string, cwd = WORK_DIR): string {
  const encodedMarker = Buffer.from(readyMarker, "utf8").toString("base64");
  return [
    "export TERM=xterm-256color",
    `cd ${q(cwd)} 2>/dev/null || cd ~`,
    `printf '%s' ${q(encodedMarker)} | base64 -d`,
    "printf '\\n'",
  ].join("; ") + "\n";
}

export function boxPtyEnv(
  home: string,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TERM: base.TERM ?? "xterm-256color",
  };
}

export async function createBoxPtyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), BOX_CLI_HOME_PREFIX));
  const configDir = join(home, ".config", "ascii", "box");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "config.json"), BOX_CLI_CONFIG, { mode: 0o600 });
  return home;
}

export function removeBoxPtyHome(home: string): Promise<void> {
  return rm(home, { recursive: true, force: true });
}

interface BoxPtyTerminal {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BoxPtySubprocess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly killed: boolean;
  kill(): void;
}

export interface BoxPtyReadyGate {
  readonly ready: Promise<void>;
  push(data: Uint8Array): void;
  fail(error: Error): void;
}

/** Suppress Box CLI bootstrap chatter until the remote shell prints its marker. */
export function boxPtyReadyGate(
  marker: string,
  onData: (data: Uint8Array) => void | Promise<void>,
): BoxPtyReadyGate {
  const markerBytes = Buffer.from(marker);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let pending = Buffer.alloc(0);
  let settled = false;
  const deliver = (data: Uint8Array): void => {
    try {
      void Promise.resolve(onData(data)).catch(() => {
        console.warn("[box-pty] data callback failed");
      });
    } catch {
      // A consumer failure must not escape the terminal callback and crash the
      // process that owns every other sandbox session.
      console.warn("[box-pty] data callback failed");
    }
  };
  return {
    ready: promise,
    push(data) {
      if (settled) {
        deliver(data);
        return;
      }
      pending = Buffer.concat([pending, Buffer.from(data)]);
      const markerAt = pending.indexOf(markerBytes);
      if (markerAt < 0) return;
      settled = true;
      let visible = pending.subarray(markerAt + markerBytes.length);
      while (visible[0] === 10 || visible[0] === 13) visible = visible.subarray(1);
      pending = Buffer.alloc(0);
      resolve();
      if (visible.length > 0) deliver(visible);
    },
    fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    },
  };
}

export function boxPtyHandle(
  terminal: BoxPtyTerminal,
  subprocess: BoxPtySubprocess,
  cleanup: () => Promise<void>,
  ready: Promise<void> = Promise.resolve(),
): SandboxPtyHandle {
  let cleanupPromise: Promise<void> | undefined;
  let terminalClosed = false;
  const cleanOnce = (): Promise<void> => (cleanupPromise ??= cleanup());
  const closeTerminal = (): void => {
    if (terminalClosed) return;
    terminalClosed = true;
    terminal.close();
  };
  const termination = subprocess.exited.then(
    (exitCode) => {
      closeTerminal();
      return { exitCode };
    },
    () => {
      closeTerminal();
      return { error: "Box PTY termination failed" };
    },
  );
  const stop = async (): Promise<void> => {
    if (subprocess.exitCode === null && !subprocess.killed) subprocess.kill();
    closeTerminal();
    await subprocess.exited;
    await cleanOnce();
  };
  void subprocess.exited.finally(() => {
    closeTerminal();
    return cleanOnce();
  }).catch(() => {});
  return {
    waitForConnection: () => ready,
    waitForTermination: () => termination,
    sendInput: async (data) => {
      terminal.write(data);
    },
    resize: async (cols, rows) => {
      terminal.resize(cols, rows);
    },
    disconnect: stop,
    kill: stop,
  };
}

class BoxApi {
  constructor(
    private readonly config: BoxApiConfig,
    private readonly fetchImpl: BoxFetch,
    readonly sleep: (ms: number) => Promise<void>,
    readonly now: () => number,
  ) {}

  get apiKey(): string {
    return this.config.apiKey;
  }

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

  async namedSnapshot(name: string): Promise<BoxNamedSnapshot> {
    const payload = await this.request<{ snapshot: BoxNamedSnapshot }>(
      "GET",
      `/named-snapshots/${encodeURIComponent(name)}`,
    );
    return payload.snapshot;
  }

  async saveNamedSnapshot(boxId: string, name: string): Promise<BoxNamedSnapshot> {
    const payload = await this.request<{ snapshot: BoxNamedSnapshot }>(
      "POST",
      "/named-snapshots",
      { boxId, name },
    );
    return payload.snapshot;
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

  /** Visit the hosted URL once with its `_token`; the 302 carries the port-auth cookie. */
  async portAuth(hostedUrl: string): Promise<SandboxPreviewLink> {
    const url = new URL(hostedUrl);
    const token = url.searchParams.get("_token");
    const origin = `${url.protocol}//${url.host}`;
    if (!token) return boxPreviewLink(origin, null);
    const response = await this.fetchImpl(`${origin}/?_token=${encodeURIComponent(token)}`, { method: "GET", redirect: "manual" });
    await response.text().catch(() => "");
    const cookie = parsePortAuthCookie(response.headers.get("set-cookie"));
    if (!cookie) throw new BoxApiError(502, "port_auth_missing", `Box hosted port did not issue a port-auth cookie (${response.status})`);
    return boxPreviewLink(origin, cookie);
  }

  /** Box owns its workstation and VNC lifecycle. Request the native noVNC
   *  stream, poll its documented provisioning state, exchange the upstream
   *  bearer token for a server-side cookie, and retain only the VNC password
   *  as browser-visible proxy state. */
  async desktop(id: string): Promise<SandboxPreviewLink> {
    const deadline = Date.now() + DESKTOP_READY_TIMEOUT_MS;
    for (;;) {
      const payload = await this.request<{
        desktopUrl?: string | null;
        provisioning?: boolean;
      }>("POST", `/boxes/${encodeURIComponent(id)}/desktop?vnc=1`, {
        publicAccess: false,
      });
      if (payload.desktopUrl) {
        const url = new URL(payload.desktopUrl);
        const password = url.searchParams.get("password")?.trim() ?? "";
        const authenticated = await this.portAuth(payload.desktopUrl);
        return {
          ...authenticated,
          ...(password ? { clientQuery: { password } } : {}),
        };
      }
      if (!payload.provisioning || Date.now() >= deadline) {
        throw new BoxApiError(
          504,
          "desktop_not_ready",
          `Box ${id} desktop was not ready after ${DESKTOP_READY_TIMEOUT_MS / 1000}s`,
        );
      }
      await this.sleep(READY_POLL_MS);
    }
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
    timeoutSeconds = RELIABLE_SYNC_COMMAND_SECONDS,
  ): Promise<SandboxExecuteResult> {
    const composed = composeBoxCommand(command, cwd, env);
    if (timeoutSeconds <= RELIABLE_SYNC_COMMAND_SECONDS) {
      const result = await this.api.command(this.boxId, composed, timeoutSeconds);
      return {
        exitCode: result.timedOut ? 124 : (result.exitCode ?? undefined),
        result: `${result.stdout}${result.stderr}`,
      };
    }
    // Past the reliable sync window: run detached, poll the exit marker, read the log.
    const id = crypto.randomUUID();
    const dir = `${STATE_DIR}/cmd/${id}`;
    const runPath = `${dir}/run.sh`;
    const launchPath = `${dir}/launch.sh`;
    const pidPath = `${dir}/pid`;
    const exitPath = `${dir}/exit`;
    const logPath = `${dir}/log`;
    await this.api.command(this.boxId, `mkdir -p ${q(dir)}`, 30);
    let launchAttempted = false;
    let completed = false;
    try {
      const remoteTimeoutSeconds = Math.min(
        Math.max(1, Math.round(timeoutSeconds)),
        SYNC_COMMAND_CAP_SECONDS,
      );
      const launchScript = [
        "#!/bin/sh",
        "set +e",
        `cleanup() { rm -f ${q(runPath)} ${q(launchPath)}; }`,
        "trap cleanup EXIT HUP INT TERM",
        `printf '%s\\n' "$$" > ${q(pidPath)}`,
        `command=$(cat ${q(runPath)})`,
        `rm -f ${q(runPath)}`,
        `timeout --foreground --signal=TERM --kill-after=5s ${remoteTimeoutSeconds}s ` +
          `sh -c "$command" >${q(logPath)} 2>&1`,
        "code=$?",
        `printf '%s\\n' "$code" > ${q(exitPath)}`,
        "exit 0",
        "",
      ].join("\n");
      await this.api.writeFile(this.boxId, runPath, Buffer.from(composed));
      await this.api.writeFile(this.boxId, launchPath, Buffer.from(launchScript));
      launchAttempted = true;
      await this.api.detach(
        this.boxId,
        `cd ${q(HOME_DIR)} && nohup setsid sh ${q(launchPath)} </dev/null >/dev/null 2>&1 &`,
      );
      const deadline = this.api.now() + timeoutSeconds * 1000;
      let exitCode: number | undefined;
      while (this.api.now() < deadline) {
        const marker = await this.api.readFile(this.boxId, exitPath).catch(() => null);
        if (marker) {
          exitCode = Number.parseInt(marker.toString("utf8").trim(), 10);
          if (Number.isNaN(exitCode)) exitCode = undefined;
          completed = exitCode !== undefined && exitCode !== 124 && exitCode !== 137;
          break;
        }
        await this.api.sleep(LONG_POLL_MS);
      }
      const log = await this.api.readFile(this.boxId, logPath).catch(() => Buffer.alloc(0));
      return { exitCode: exitCode ?? 124, result: log.toString("utf8") };
    } finally {
      if (launchAttempted && !completed) {
        await this.api.command(
          this.boxId,
          `i=0; while ! test -s ${q(pidPath)} && ! test -s ${q(exitPath)} && ` +
            `test "$i" -lt 50; do i=$((i + 1)); sleep 0.1; done; ` +
            `if test -s ${q(exitPath)}; then ` +
            `code=$(cat ${q(exitPath)}); case "$code" in 124|137) :;; *[!0-9]*|'') :;; *) exit 0;; esac; fi; ` +
            `if test -s ${q(pidPath)}; then ` +
            `p=$(cat ${q(pidPath)}); case "$p" in *[!0-9]*|'') exit 1;; esac; ` +
            `kill -TERM -- "-$p" 2>/dev/null || true; ` +
            `i=0; while kill -0 -- "-$p" 2>/dev/null && test "$i" -lt 10; do ` +
            `i=$((i + 1)); sleep 0.1; done; ` +
            `kill -KILL -- "-$p" 2>/dev/null || true; fi`,
          30,
        ).catch(() => {});
      }
      await this.api.command(this.boxId, `rm -rf ${q(dir)}`, 30).catch(() => {});
    }
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
    const base = `${dir}/${commandId}`;
    await this.api.writeFile(this.boxId, `${base}.sh`, Buffer.from(request.command));
    // The launcher records its own pid from inside the new session (setsid may fork, so
    // the caller's $! is not reliable); that pid is the group deleteSession kills.
    await this.api.writeFile(
      this.boxId,
      `${base}.launch.sh`,
      Buffer.from(
        [
          `echo $$ >${q(`${base}.pid`)}`,
          `export USEAGENT_SESSION_ID=${q(sessionId)} USEAGENT_COMMAND_ID=${q(commandId)}`,
          `exec sh ${q(`${base}.sh`)}`,
          "",
        ].join("\n"),
      ),
    );
    await this.api.detach(
      this.boxId,
      `cd ${q(HOME_DIR)} && nohup setsid sh ${q(`${base}.launch.sh`)} </dev/null >${q(`${base}.log`)} 2>&1 &`,
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

  async createPty(options: {
    cols: number;
    rows: number;
    cwd?: string;
    onData: (data: Uint8Array) => void | Promise<void>;
  }): Promise<SandboxPtyHandle> {
    const problem = boxCliProblem();
    if (problem) throw new SandboxTerminalUnavailableError(problem);
    const home = await createBoxPtyHome();
    const env = boxPtyEnv(home);
    try {
      const login = Bun.spawn(boxPtyLoginArgv(this.api.apiKey), {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await login.exited) !== 0) {
        throw new Error("Box CLI login failed");
      }

      const sshDir = join(home, ".ssh");
      await mkdir(sshDir, { recursive: true, mode: 0o700 });
      const keygen = Bun.spawn(boxPtyKeygenArgv(home), {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await keygen.exited) !== 0) {
        throw new Error("Box terminal identity setup failed");
      }

      const readyMarker = `__USEAGENT_PTY_READY_${crypto.randomUUID()}__`;
      const gate = boxPtyReadyGate(readyMarker, options.onData);
      const terminal = new Bun.Terminal({
        cols: options.cols,
        rows: options.rows,
        data: (_terminal, data) => {
          gate.push(data);
        },
      });
      try {
        const subprocess = Bun.spawn(boxPtySshArgv(this.boxId), { env, terminal });
        terminal.write(boxPtyBootstrapCommand(readyMarker, options.cwd));
        void subprocess.exited.then((code) => {
          gate.fail(new Error(`Box terminal exited before the shell was ready (${code})`));
        });
        return boxPtyHandle(
          terminal,
          subprocess,
          () => removeBoxPtyHome(home),
          gate.ready,
        );
      } catch (error) {
        terminal.close();
        throw error;
      }
    } catch (error) {
      await removeBoxPtyHome(home);
      throw error;
    }
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
  readonly desktop: SandboxDesktopAccess;

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
    this.desktop = {
      display: ":0",
      home: HOME_DIR,
      workdir: WORK_DIR,
      browserExecutable: null,
      start: async () => {
        await this.api.desktop(this.id);
      },
    };
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
    // Box refuses a delete unless the target id is echoed in this header.
    await this.api.request("DELETE", `/boxes/${encodeURIComponent(this.id)}`, undefined, { "X-Ascii-Confirm-Delete": this.id });
    await this.labelStore.remove(this.id).catch(() => {});
    this.state = "deleted";
  }

  async getPreviewLink(port: number): Promise<SandboxPreviewLink> {
    if (port === NATIVE_DESKTOP_PORT) return this.api.desktop(this.id);
    const payload = await this.api.request<{ url?: string }>("POST", `/boxes/${encodeURIComponent(this.id)}/host`, { port });
    if (!payload.url) throw new BoxApiError(502, "host_url_missing", `Box did not return a hosted URL for port ${port}`);
    return this.api.portAuth(payload.url);
  }
}

class BoxProvider implements SandboxProvider {
  private readonly api: BoxApi;
  private readonly labels: SandboxLabelStore;

  constructor(
    private readonly config: BoxApiConfig,
    options: BoxProviderOptions,
  ) {
    this.api = new BoxApi(
      config,
      options.fetchImpl ?? ((input, init) => fetch(input, init)),
      options.sleep ?? defaultSleep,
      options.now ?? Date.now,
    );
    // Labels are the trust anchor; the control plane passes its durable store. Without one (tests,
    // dry runs) they live in this process only.
    this.labels = options.labels ?? memorySandboxLabelStore();
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
    let ready: BoxRecord;
    try {
      ready = await this.api.waitUntilReady(created.box.id);
    } catch (error) {
      // Never leave a half-created box (or its label row) behind.
      await this.api
        .request("DELETE", `/boxes/${encodeURIComponent(created.box.id)}`, undefined, { "X-Ascii-Confirm-Delete": created.box.id })
        .catch(() => {});
      await this.labels.remove(created.box.id).catch(() => {});
      throw error;
    }
    return new BoxSandboxHandle(this.api, this.labels, ready, labels);
  }

  async saveTemplate(sourceSandboxId: string, name: string): Promise<SandboxTemplateStatus> {
    let snapshot: BoxNamedSnapshot | null = null;
    try {
      snapshot = await this.api.namedSnapshot(name);
    } catch (error) {
      if (!(error instanceof BoxApiError) || error.status !== 404) throw error;
    }
    if (!snapshot || snapshot.status === "failed") {
      snapshot = await this.api.saveNamedSnapshot(sourceSandboxId, name);
    }
    const deadline = Date.now() + TEMPLATE_READY_TIMEOUT_MS;
    while (snapshot.status === "saving" && Date.now() < deadline) {
      await this.api.sleep(READY_POLL_MS);
      snapshot = await this.api.namedSnapshot(name);
    }
    if (snapshot.status === "ready") return { name, state: "active" };
    return {
      name,
      state: "error",
      detail: snapshot.error ?? `template did not become ready within ${TEMPLATE_READY_TIMEOUT_MS / 1000}s`,
    };
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    let record: BoxRecord;
    try {
      record = await this.api.box(sandboxId);
    } catch (error) {
      if (error instanceof BoxApiError && error.status === 404 && error.code === "not_found") {
        throw new SandboxNotFoundError(error);
      }
      throw error;
    }
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
