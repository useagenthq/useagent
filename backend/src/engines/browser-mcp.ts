import {
  sandboxPreviewHeaders,
  type SandboxHandle,
} from "../sandboxes/provider";

export const PLAYWRIGHT_MCP_VERSION = "0.0.79";
export const BROWSER_DISPLAY = ":1";
export const BROWSER_CDP_ENDPOINT = "http://127.0.0.1:9222";

const BROWSER_CDP_PORT = 9222;
const CDP_TIMEOUT_MS = 10_000;

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly error?: { readonly message?: string };
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly frameId?: string;
  };
  readonly exceptionDetails?: { readonly text?: string };
}

export interface BrowserControlTransport {
  evaluate<T>(sandbox: SandboxHandle, expression: string): Promise<T>;
  navigate(sandbox: SandboxHandle, url: string): Promise<void>;
}

export type CdpSocket = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "close"
>;

class CdpConnection {
  private requestId = 0;

  private constructor(private readonly socket: WebSocket) {}

  static async connect(url: URL, headers: Record<string, string>): Promise<CdpConnection> {
    const socket = new WebSocket(url, { headers });
    await waitForCdpSocketOpen(socket);
    return new CdpConnection(socket);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
    const id = ++this.requestId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return await new Promise<CdpResponse>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.removeEventListener("message", receive);
        this.socket.removeEventListener("error", fail);
        this.socket.removeEventListener("close", fail);
      };
      const fail = (): void => {
        cleanup();
        reject(new Error("CDP request failed"));
      };
      const receive = (event: MessageEvent): void => {
        let response: CdpResponse;
        try {
          response = JSON.parse(String(event.data)) as CdpResponse;
        } catch {
          return;
        }
        if (response.id !== id) return;
        cleanup();
        if (response.error) reject(new Error(response.error.message || "CDP request failed"));
        else resolve(response);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("CDP request timed out"));
      }, CDP_TIMEOUT_MS);
      this.socket.addEventListener("message", receive);
      this.socket.addEventListener("error", fail, { once: true });
      this.socket.addEventListener("close", fail, { once: true });
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** Resolve only after a live CDP socket opens. Failed or timed-out sockets are
 * closed here so callers never lose ownership of an authenticated connection. */
export async function waitForCdpSocketOpen(
  socket: CdpSocket,
  timeoutMs = CDP_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
    };
    const opened = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      socket.close();
      reject(new Error("CDP connection failed"));
    };
    timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error("CDP connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
}

function externalCdpUrl(baseUrl: string, targetUrl: string): URL {
  const external = new URL(baseUrl);
  const target = new URL(targetUrl);
  external.protocol = external.protocol === "https:" ? "wss:" : "ws:";
  external.pathname = target.pathname;
  external.search = target.search;
  return external;
}

async function visibleCdpConnection(sandbox: SandboxHandle): Promise<CdpConnection> {
  const link = await sandbox.getPreviewLink(BROWSER_CDP_PORT);
  const baseUrl = link.url.replace(/\/+$/, "");
  const headers = sandboxPreviewHeaders(link.token ?? "");
  const response = await fetch(`${baseUrl}/json/list`, {
    headers,
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("browser control endpoint is unavailable");
  const targets = (await response.json()) as CdpTarget[];
  let visible: CdpConnection | null = null;
  for (const target of targets) {
    if (
      target.type !== "page" ||
      !target.webSocketDebuggerUrl ||
      target.url?.startsWith("devtools://")
    ) continue;
    let candidate: CdpConnection | null = null;
    try {
      candidate = await CdpConnection.connect(
        externalCdpUrl(baseUrl, target.webSocketDebuggerUrl),
        headers,
      );
      const state = await candidate.request("Runtime.evaluate", {
        expression: '({ visible: document.visibilityState === "visible", focused: document.hasFocus() })',
        returnByValue: true,
      });
      const value = state.result?.result?.value as { visible?: boolean; focused?: boolean } | undefined;
      if (value?.visible && value.focused) {
        visible?.close();
        return candidate;
      }
      if (value?.visible && !visible) visible = candidate;
      else candidate.close();
    } catch {
      candidate?.close();
    }
  }
  if (!visible) throw new Error("visible browser page is unavailable");
  return visible;
}

const productionBrowserControl: BrowserControlTransport = {
  async evaluate<T>(sandbox: SandboxHandle, expression: string) {
    const connection = await visibleCdpConnection(sandbox);
    try {
      const response = await connection.request("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text || "browser expression failed");
      }
      return response.result?.result?.value as T;
    } finally {
      connection.close();
    }
  },
  async navigate(sandbox: SandboxHandle, url: string) {
    const connection = await visibleCdpConnection(sandbox);
    try {
      await connection.request("Page.navigate", { url });
    } finally {
      connection.close();
    }
  },
};

let browserControlOverride: BrowserControlTransport | null = null;

export function setBrowserControlTransportForTest(
  transport: BrowserControlTransport | null,
): void {
  browserControlOverride = transport;
}

/** Evaluate a bounded expression over a host-owned CDP connection. The browser
 * preview credential and expression never enter sandbox shell commands. */
export async function evaluateVisibleBrowserPage<T>(
  sandbox: SandboxHandle,
  expression: string,
): Promise<T> {
  return await (browserControlOverride ?? productionBrowserControl).evaluate<T>(sandbox, expression);
}

/** Navigate the visible browser from the trusted host control plane. Secret
 * URLs travel only over the authenticated CDP transport, never via xdotool or
 * a sandbox process argument. */
export async function navigateVisibleBrowserPage(
  sandbox: SandboxHandle,
  url: string,
): Promise<void> {
  await (browserControlOverride ?? productionBrowserControl).navigate(sandbox, url);
}

const BROWSER_MCP_PROCESS_SESSION = "skynet-browser-mcp";
const BROWSER_MCP_PORT = 8931;
export const BROWSER_MCP_URL = `http://localhost:${BROWSER_MCP_PORT}/mcp`;
const BROWSER_MCP_GUARD_FILE = "$HOME/.skynet/browser-mcp-guard.session";

function browserArgs(workdir: string): string[] {
  return [
    "--cdp-endpoint",
    BROWSER_CDP_ENDPOINT,
    "--caps",
    "vision",
    "--image-responses",
    "allow",
    // Returning a complete accessibility tree after every click is both slow
    // and fragile on highly dynamic sites. The explicit browser_snapshot tool
    // remains available, while DOM actions return as soon as they settle.
    "--snapshot-mode",
    "none",
    "--timeout-action",
    "10000",
    "--timeout-navigation",
    "30000",
    "--timeout-settle",
    "300",
    "--output-dir",
    `${workdir}/.skynet-browser`,
    "--viewport-size",
    "1440x900",
  ];
}

/** Both ACP engines attach to one sandbox-resident MCP process. The browser
 * transport therefore survives agent/relay restarts instead of making Chrome
 * a transitive child of Claude, Codex, or OpenCode. */
export function acpBrowserMcpServer(): Record<string, unknown> {
  return {
    type: "http",
    name: "skynet-browser",
    url: BROWSER_MCP_URL,
  };
}

/** OpenCode consumes the same loopback-only resident MCP endpoint. */
export function opencodeBrowserMcpConfig(): Record<string, unknown> {
  return {
    type: "remote",
    url: BROWSER_MCP_URL,
    enabled: true,
  };
}

/** claude-agent-acp currently accepts session-scoped MCP descriptors without
 * reliably exposing them to Claude (upstream issue #883). Register the same
 * loopback endpoint in Claude Code's private user scope before the ACP session
 * is created. `alwaysLoad` turns a silent model-visible omission into a bounded
 * startup connection gate; the endpoint has no credentials and is reachable
 * only inside this thread's sandbox. */
export async function registerClaudeBrowserMcp(sandbox: SandboxHandle): Promise<boolean> {
  const config = JSON.stringify({
    type: "http",
    url: BROWSER_MCP_URL,
    alwaysLoad: true,
  });
  const command = [
    'export PATH="$HOME/.local/bin:$PATH"',
    `if claude mcp get skynet-browser 2>/dev/null | grep -Fq "URL: ${BROWSER_MCP_URL}"; then exit 0; fi`,
    "claude mcp remove skynet-browser --scope user >/dev/null 2>&1 || true",
    `claude mcp add-json --scope user skynet-browser '${config}'`,
  ].join("; ");
  const result = await sandbox.process
    .executeCommand(command, undefined, undefined, 30)
    .catch(() => null);
  return result?.exitCode === 0;
}

function browserMcpLaunchCommand(workdir: string): string {
  return [
    `export DISPLAY=${BROWSER_DISPLAY}`,
    `exec "$HOME/.local/bin/playwright-mcp" ${browserArgs(workdir).join(" ")} ` +
      `--host 127.0.0.1 --port ${BROWSER_MCP_PORT} --shared-browser-context`,
  ].join("\n");
}

async function residentBrowserMcpListening(sandbox: SandboxHandle): Promise<boolean> {
  const probe = await sandbox.process
    .executeCommand(
      // A body-less GET intentionally returns HTTP 400. curl without -f still
      // exits zero, which proves the loopback listener is alive without
      // creating an MCP session or mutating the browser.
      `curl -sS -m 2 -o /dev/null ${BROWSER_MCP_URL}`,
      undefined,
      undefined,
      10,
    )
    .catch(() => null);
  return probe?.exitCode === 0;
}

/** Playwright MCP closes an externally attached CDP browser when its last HTTP
 * client session disconnects. Harness clients are allowed to reconnect between
 * tool calls, so keep one loopback-only MCP session initialized for the life of
 * the resident server. It owns no credentials and makes no tool calls; it only
 * prevents transient harness transport churn from closing the user's tabs. */
function browserMcpGuardCommand(): string {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: "skynet-browser-guard-init",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "skynet-browser-guard", version: "1.0.0" },
    },
  });
  const initialized = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  return [
    'mkdir -p "$HOME/.skynet"',
    'guard_headers="$HOME/.skynet/browser-mcp-guard.headers"',
    'guard_body="$HOME/.skynet/browser-mcp-guard.body"',
    `curl -fsS -m 10 -D "$guard_headers" -o "$guard_body" ` +
      "-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' " +
      `--data '${initialize}' ${BROWSER_MCP_URL}`,
    'guard_session=$(awk \'tolower($1)=="mcp-session-id:" {gsub("\\r","",$2); print $2}\' "$guard_headers" | tail -1)',
    'test -n "$guard_session"',
    `curl -fsS -m 10 -o /dev/null ` +
      "-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' " +
      '-H "Mcp-Session-Id: $guard_session" ' +
      `--data '${initialized}' ${BROWSER_MCP_URL}`,
    `printf '%s\n' "$guard_session" > ${BROWSER_MCP_GUARD_FILE}`,
  ].join("; ");
}

type ResidentBrowserMcpStatus = "down" | "listening" | "healthy";

/** One sandbox command checks both the listener and its keepalive guard. Daytona
 * command setup is a meaningful warm-turn cost, so these dependent local probes
 * share one remote round trip while retaining the three distinct outcomes. */
async function residentBrowserMcpStatus(
  sandbox: SandboxHandle,
): Promise<ResidentBrowserMcpStatus> {
  const ping = JSON.stringify({
    jsonrpc: "2.0",
    id: "skynet-browser-guard-ping",
    method: "ping",
    params: {},
  });
  const probe = await sandbox.process
    .executeCommand(
      `if ! curl -sS -m 2 -o /dev/null ${BROWSER_MCP_URL}; then printf down; exit 0; fi; ` +
        `guard_session=$(cat ${BROWSER_MCP_GUARD_FILE} 2>/dev/null || true); ` +
        `if test -n "$guard_session" && curl -fsS -m 2 -o /dev/null ` +
        "-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' " +
        '-H "Mcp-Session-Id: $guard_session" ' +
        `--data '${ping}' ${BROWSER_MCP_URL}; then printf healthy; else printf listening; fi`,
      undefined,
      undefined,
      10,
    )
    .catch(() => null);
  if (probe?.exitCode !== 0) return "down";
  const status = probe.result?.trim().split(/\s+/).at(-1);
  return status === "healthy" || status === "listening" ? status : "down";
}

async function createBrowserMcpGuard(sandbox: SandboxHandle): Promise<boolean> {
  const result = await sandbox.process
    .executeCommand(browserMcpGuardCommand(), undefined, undefined, 20)
    .catch(() => null);
  return result?.exitCode === 0;
}

export async function ensureResidentBrowserMcp(
  sandbox: SandboxHandle,
  workdir: string,
  signal: AbortSignal,
): Promise<boolean> {
  const status = await residentBrowserMcpStatus(sandbox);
  if (status === "healthy") return true;
  let listening = status === "listening";

  if (!listening) {
    await sandbox.process.deleteSession(BROWSER_MCP_PROCESS_SESSION).catch(() => {});
    await sandbox.process.createSession(BROWSER_MCP_PROCESS_SESSION);
    await sandbox.process.executeSessionCommand(BROWSER_MCP_PROCESS_SESSION, {
      command: browserMcpLaunchCommand(workdir),
      runAsync: true,
    });
    for (let attempt = 0; attempt < 40 && !signal.aborted; attempt++) {
      listening = await residentBrowserMcpListening(sandbox);
      if (listening) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return !signal.aborted && listening && (await createBrowserMcpGuard(sandbox));
}
