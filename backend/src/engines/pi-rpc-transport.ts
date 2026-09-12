import { createHash } from "node:crypto";
import { MAX_RPC_FRAME_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { SandboxHandle, SandboxProcess, SandboxPtyHandle } from "../sandboxes/provider";

const PROCESS_SESSION_READ_BYTES = 256 * 1024;
const PROCESS_SESSION_READ_RETRY_MS = 15_000;
const PROCESS_SESSION_READ_TIMEOUT_SECONDS = 2;
const PROCESS_SESSION_STDERR_LIMIT = 16_384;
// This is an observed-size fail-closed quota, not a kernel limit: a fast writer can
// overshoot between polls. A process-wide ulimit would also cap Pi's user-file tools.
const PROCESS_SESSION_SPOOL_LIMIT_BYTES = 256 * 1024 * 1024;
const PROCESS_SESSION_IDLE_BACKOFF_MAX_MS = 3_000;
const PROCESS_SESSION_SPOOL_INVENTORY_LIMIT = 256;
const PI_CLEANUP_TIMEOUT_MS = 8_000;
const LEGACY_PI_PTY_PREFIX = "useagent-pi-";
const PI_RPC_OUTPUT_DIR = "/root/.useagent/pi-rpc-output";

class PiRpcSpoolProtocolError extends Error {}

export function piProcessSessionPrefix(sandboxId: string): string {
  const owner = createHash("sha256").update(sandboxId).digest("hex").slice(0, 16);
  return `useagent-pi-ps-${owner}-`;
}

export function processSessionTransportAvailable(process: SandboxProcess): boolean {
  return typeof process.getSessionCommand === "function" &&
    typeof process.sendSessionCommandInput === "function";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ownedSpoolPaths(processSessionId: string): { stdout: string; stderr: string } {
  if (!/^useagent-pi-ps-[a-f0-9]{16}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(processSessionId)) {
    throw new Error("Pi process-session id is not in the owned namespace");
  }
  return {
    stdout: `${PI_RPC_OUTPUT_DIR}/${processSessionId}.stdout`,
    stderr: `${PI_RPC_OUTPUT_DIR}/${processSessionId}.stderr`,
  };
}

function spoolLaunchCommand(command: string, paths: { stdout: string; stderr: string }): string {
  return `umask 077; install -d -m 700 ${shellQuote(PI_RPC_OUTPUT_DIR)}; ` +
    `exec 3>${shellQuote(paths.stdout)} 4>${shellQuote(paths.stderr)}; ( ${command} ) >&3 2>&4`;
}

function spoolReadCommand(path: string, offset: number, waitForData: boolean): string {
  const wait = waitForData
    ? `i=0; while [ "$(stat -c %s -- ${shellQuote(path)} 2>/dev/null)" = ${offset} ] && [ "$i" -lt 10 ]; do sleep 0.05; i=$((i + 1)); done; `
    : "";
  return `${wait}size=$(stat -c %s -- ${shellQuote(path)}) || exit 41; ` +
    `length=$((size - ${offset})); [ "$length" -ge 0 ] || exit 42; ` +
    `[ "$length" -le ${PROCESS_SESSION_READ_BYTES} ] || length=${PROCESS_SESSION_READ_BYTES}; ` +
    `printf '{"size":%s,"length":%s,"data":"' "$size" "$length"; ` +
    `dd if=${shellQuote(path)} iflag=skip_bytes,count_bytes skip=${offset} ` +
    `count="$length" status=none | base64 | tr -d '\\n'; ` +
    `printf '"}'`;
}

function exactSpoolRemovalCommand(paths: { stdout: string; stderr: string }): string {
  return `rm -f -- ${shellQuote(paths.stdout)} ${shellQuote(paths.stderr)}`;
}

function spoolInventoryCommand(processPrefix: string): string {
  const inventory = `find ${shellQuote(PI_RPC_OUTPUT_DIR)} -maxdepth 1 -type f ` +
    `\\( -name ${shellQuote(`${processPrefix}*.stdout`)} -o ` +
    `-name ${shellQuote(`${processPrefix}*.stderr`)} \\) -printf '%f\\n' | ` +
    `head -n ${PROCESS_SESSION_SPOOL_INVENTORY_LIMIT + 1}`;
  return `if [ -d ${shellQuote(PI_RPC_OUTPUT_DIR)} ]; then ` +
    `/bin/bash -o pipefail -c ${shellQuote(inventory)}; fi`;
}

function parseSpoolInventory(result: string, processPrefix: string): string[] {
  const basenames = result.split("\n").filter(Boolean);
  if (basenames.length > PROCESS_SESSION_SPOOL_INVENTORY_LIMIT) {
    throw new Error("Pi owned spool inventory exceeds the cleanup limit");
  }
  const expected = new RegExp(
    `^${processPrefix}[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.(?:stdout|stderr)$`,
    "u",
  );
  for (const basename of basenames) {
    if (!expected.test(basename)) throw new Error("Pi owned spool inventory is invalid");
  }
  return basenames.map((basename) => `${PI_RPC_OUTPUT_DIR}/${basename}`);
}

function capturedSpoolRemovalCommand(paths: readonly string[]): string {
  return `rm -f -- ${paths.map(shellQuote).join(" ")}`;
}

/** Delete only useAgent-owned Pi writers from a retained Daytona sandbox.
 * Missing inventory or deletion authority is an unsafe unknown, so fail closed. */
export async function cleanupOwnedPiTransports(
  sandbox: SandboxHandle,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const process = sandbox.process;
  if (typeof process.sendSessionCommandInput !== "function") return;
  if (
    typeof process.listSessions !== "function" ||
    typeof process.listPtySessions !== "function" ||
    typeof process.killPtySession !== "function"
  ) {
    throw new Error("Pi process-session cleanup capability is unavailable");
  }
  const deadline = Date.now() + (options.timeoutMs ?? PI_CLEANUP_TIMEOUT_MS);
  const withinDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Pi remote cleanup timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Pi remote cleanup timed out")), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const [sessions, ptys] = await withinDeadline(() => Promise.all([
    process.listSessions!(),
    process.listPtySessions!(),
  ]));
  const processPrefix = piProcessSessionPrefix(sandbox.id);
  const ownedSessions = sessions.filter(({ sessionId }) => sessionId.startsWith(processPrefix));
  for (const session of ownedSessions) ownedSpoolPaths(session.sessionId);
  const spoolInventory = await withinDeadline(() => process.executeCommand(
    spoolInventoryCommand(processPrefix),
    undefined,
    undefined,
    Math.max(1, Math.ceil((deadline - Date.now()) / 1_000)),
  ));
  if (spoolInventory.exitCode !== 0 || typeof spoolInventory.result !== "string") {
    throw new Error("Pi owned spool inventory failed");
  }
  const capturedSpoolPaths = parseSpoolInventory(spoolInventory.result, processPrefix);
  for (const session of ownedSessions) {
    await withinDeadline(() => process.deleteSession(session.sessionId));
  }
  const remainingSessions = await withinDeadline(() => process.listSessions!());
  for (const session of ownedSessions) {
    if (remainingSessions.some(({ sessionId }) => sessionId === session.sessionId)) {
      throw new Error("Pi process-session deletion could not be confirmed");
    }
  }
  for (const session of ptys) {
    if (!session.id.startsWith(LEGACY_PI_PTY_PREFIX)) continue;
    await withinDeadline(() => process.killPtySession!(session.id));
  }
  if (capturedSpoolPaths.length > 0) {
    const cleanup = await withinDeadline(() => process.executeCommand(
      capturedSpoolRemovalCommand(capturedSpoolPaths),
      undefined,
      undefined,
      Math.max(1, Math.ceil((deadline - Date.now()) / 1_000)),
    ));
    if (cleanup.exitCode !== 0) throw new Error("Pi owned spool cleanup failed");
  }
}

export interface PiRpcTransport {
  waitForConnection(): Promise<void>;
  waitForTermination(): Promise<{ exitCode?: number; error?: string }>;
  sendInput(data: string): Promise<void>;
  teardown(): Promise<void>;
}

export class PtyPiRpcTransport implements PiRpcTransport {
  constructor(private readonly pty: SandboxPtyHandle) {}

  waitForConnection(): Promise<void> {
    return this.pty.waitForConnection();
  }

  waitForTermination(): Promise<{ exitCode?: number; error?: string }> {
    return this.pty.waitForTermination();
  }

  sendInput(data: string): Promise<void> {
    return this.pty.sendInput(data);
  }

  async teardown(): Promise<void> {
    await this.pty.kill();
    const termination = await this.pty.waitForTermination();
    if (
      typeof termination.exitCode !== "number" ||
      !Number.isSafeInteger(termination.exitCode)
    ) {
      throw new Error("Pi RPC remote exit could not be confirmed");
    }
    void this.pty.disconnect().catch(() => {});
  }
}

export class ProcessSessionPiRpcTransport implements PiRpcTransport {
  #connectedResolve!: () => void;
  #connected = new Promise<void>((resolve) => {
    this.#connectedResolve = resolve;
  });
  #terminationResolve!: (result: { exitCode?: number; error?: string }) => void;
  #termination = new Promise<{ exitCode?: number; error?: string }>((resolve) => {
    this.#terminationResolve = resolve;
  });
  #stdoutOffset = 0;
  #stderrOffset = 0;
  #stdoutObservedSize = 0;
  #stderrObservedSize = 0;
  #stdoutFrameBuffer = Buffer.alloc(0);
  #stderrTail = "";
  #tearingDown = false;
  #failed = false;
  #commandId: string | undefined;
  #startPromise: Promise<void> | undefined;
  #idleDelayMs = 0;
  #wakePending = false;
  #wakeResolve: (() => void) | undefined;
  readonly #spoolPaths: { stdout: string; stderr: string };

  constructor(
    private readonly process: SandboxProcess,
    private readonly processSessionId: string,
    private readonly command: string,
    private readonly onData: (data: Uint8Array) => void,
  ) {
    this.#spoolPaths = ownedSpoolPaths(processSessionId);
  }

  async start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.startOnce();
    return this.#startPromise;
  }

  private async startOnce(): Promise<void> {
    await this.process.createSession(this.processSessionId);
    if (this.#tearingDown) return;
    const command = await this.process.executeSessionCommand(this.processSessionId, {
      command: spoolLaunchCommand(this.command, this.#spoolPaths),
      runAsync: true,
      suppressInputEcho: true,
    });
    if (this.#tearingDown) return;
    this.#commandId = command.cmdId;
    this.#connectedResolve();
    void this.readUntilExit(command.cmdId);
  }

  waitForConnection(): Promise<void> {
    return this.#connected;
  }

  waitForTermination(): Promise<{ exitCode?: number; error?: string }> {
    return this.#termination;
  }

  async sendInput(data: string): Promise<void> {
    if (!this.#commandId) throw new Error("Pi RPC process-session command is not ready");
    await this.process.sendSessionCommandInput!(this.processSessionId, this.#commandId, data);
    this.wakeReader();
  }

  async teardown(): Promise<void> {
    this.#tearingDown = true;
    this.wakeReader();
    await this.#startPromise?.catch(() => {});
    await this.process.deleteSession(this.processSessionId);
    if (typeof this.process.listSessions !== "function") {
      throw new Error("Pi RPC process-session deletion confirmation is unavailable");
    }
    const sessions = await this.process.listSessions();
    if (sessions.some(({ sessionId }) => sessionId === this.processSessionId)) {
      throw new Error("Pi RPC process-session deletion could not be confirmed");
    }
    const removal = await this.process.executeCommand(
      exactSpoolRemovalCommand(this.#spoolPaths),
      undefined,
      undefined,
      PROCESS_SESSION_READ_TIMEOUT_SECONDS,
    );
    if (removal.exitCode !== 0) throw new Error("Pi RPC spool cleanup failed");
    this.#terminationResolve({});
  }

  private async readUntilExit(commandId: string): Promise<void> {
    while (!this.#tearingDown && !this.#failed) {
      try {
        const stdoutBytes = await this.readStdout(true);
        const stderrBytes = await this.readStderr(false);
        if (this.#tearingDown) return;
        const command = await this.process.getSessionCommand!(this.processSessionId, commandId);
        if (command.exitCode === undefined) {
          if (stdoutBytes === 0 && stderrBytes === 0) await this.waitForIdleBackoff();
          else this.#idleDelayMs = 0;
          continue;
        }
        while (true) {
          const stdoutBytes = await this.readStdout(false);
          const stderrBytes = await this.readStderr(false);
          if (stdoutBytes === 0 && stderrBytes === 0) break;
        }
        if (this.#stdoutFrameBuffer.byteLength !== 0) {
          this.fail("Pi RPC process exited with an incomplete stdout frame");
          return;
        }
        this.#terminationResolve({ exitCode: command.exitCode });
        return;
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : "unknown read failure";
        this.fail(cause instanceof PiRpcSpoolProtocolError
          ? detail
          : `Pi RPC process-session output failed: ${detail}`);
      }
    }
  }

  private async readStdout(waitForData: boolean): Promise<number> {
    const bytes = await this.readSpool("stdout", this.#stdoutOffset, waitForData);
    if (bytes.byteLength === 0) return 0;
    this.#stdoutOffset += bytes.byteLength;
    this.#stdoutFrameBuffer = Buffer.concat([this.#stdoutFrameBuffer, bytes]);
    while (true) {
      const newline = this.#stdoutFrameBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_RPC_FRAME_BYTES) {
        throw new Error("Pi RPC spooled stdout frame exceeds the transport limit");
      }
      this.onData(this.#stdoutFrameBuffer.subarray(0, newline + 1));
      this.#stdoutFrameBuffer = this.#stdoutFrameBuffer.subarray(newline + 1);
    }
    if (this.#stdoutFrameBuffer.byteLength > MAX_RPC_FRAME_BYTES) {
      throw new Error("Pi RPC spooled stdout frame exceeds the transport limit");
    }
    return bytes.byteLength;
  }

  private async readStderr(waitForData: boolean): Promise<number> {
    const bytes = await this.readSpool("stderr", this.#stderrOffset, waitForData);
    if (bytes.byteLength === 0) return 0;
    this.#stderrOffset += bytes.byteLength;
    this.#stderrTail = (this.#stderrTail + bytes.toString("utf8")).slice(-PROCESS_SESSION_STDERR_LIMIT);
    return bytes.byteLength;
  }

  private async readSpool(
    stream: "stdout" | "stderr",
    offset: number,
    waitForData: boolean,
  ): Promise<Buffer> {
    const deadline = Date.now() + PROCESS_SESSION_READ_RETRY_MS;
    let lastError = "read failed";
    while (!this.#tearingDown) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${stream} retrieval timed out: ${lastError}`);
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          this.process.executeCommand(
            spoolReadCommand(this.#spoolPaths[stream], offset, waitForData),
            undefined,
            undefined,
            PROCESS_SESSION_READ_TIMEOUT_SECONDS,
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("read command timed out")), remaining);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        if (result.exitCode !== 0 || typeof result.result !== "string") {
          throw new Error(`read command exited ${String(result.exitCode)}`);
        }
        const parsed = JSON.parse(result.result) as Record<string, unknown>;
        const size = parsed.size;
        const length = parsed.length;
        const data = parsed.data;
        if (
          typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
          typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
          length > PROCESS_SESSION_READ_BYTES || typeof data !== "string"
        ) {
          throw new PiRpcSpoolProtocolError("read command returned invalid metadata");
        }
        if (size > PROCESS_SESSION_SPOOL_LIMIT_BYTES) {
          throw new PiRpcSpoolProtocolError(
            `Pi RPC ${stream} spool exceeded ${PROCESS_SESSION_SPOOL_LIMIT_BYTES} bytes`,
          );
        }
        const observedSize = stream === "stdout" ? this.#stdoutObservedSize : this.#stderrObservedSize;
        if (size < observedSize || size < offset || length !== Math.min(size - offset, PROCESS_SESSION_READ_BYTES)) {
          throw new PiRpcSpoolProtocolError("read command returned inconsistent size metadata");
        }
        const bytes = Buffer.from(data, "base64");
        if (bytes.byteLength !== length || bytes.toString("base64") !== data) {
          throw new PiRpcSpoolProtocolError("read command returned an invalid byte payload");
        }
        if (stream === "stdout") this.#stdoutObservedSize = size;
        else this.#stderrObservedSize = size;
        return bytes;
      } catch (cause) {
        if (cause instanceof PiRpcSpoolProtocolError) throw cause;
        lastError = cause instanceof Error ? cause.message : "read failed";
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
      }
    }
    return Buffer.alloc(0);
  }

  private wakeReader(): void {
    this.#idleDelayMs = 0;
    this.#wakePending = true;
    this.#wakeResolve?.();
  }

  private async waitForIdleBackoff(): Promise<void> {
    if (this.#wakePending) {
      this.#wakePending = false;
      return;
    }
    this.#idleDelayMs = Math.min(
      this.#idleDelayMs === 0 ? 100 : this.#idleDelayMs * 2,
      PROCESS_SESSION_IDLE_BACKOFF_MAX_MS,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        this.#wakeResolve = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(resolve, this.#idleDelayMs);
      });
    } finally {
      this.#wakeResolve = undefined;
      this.#wakePending = false;
    }
  }

  private fail(error: string): void {
    if (this.#failed || this.#tearingDown) return;
    this.#failed = true;
    this.#terminationResolve({ error });
  }
}
