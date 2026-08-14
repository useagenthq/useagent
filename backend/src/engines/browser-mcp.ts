import type { SandboxHandle } from "../sandboxes/provider";

export const PLAYWRIGHT_MCP_VERSION = "0.0.79";
export const BROWSER_DISPLAY = ":1";
export const BROWSER_CDP_ENDPOINT = "http://127.0.0.1:9222";

const CDP_RESULT_MARKER = "__SKYNET_CDP_RESULT__";

/** Evaluate a bounded expression in the visible Chromium page without exposing
 * the browser's loopback-only CDP port outside its sandbox. This is a trusted
 * control-plane primitive used for readiness checks, not a provider-specific
 * agent tool. */
export async function evaluateVisibleBrowserPage<T>(
  sandbox: SandboxHandle,
  expression: string,
  timeoutSeconds = 10,
): Promise<T> {
  const script = `
(async () => {
const targets = await fetch(${JSON.stringify(`${BROWSER_CDP_ENDPOINT}/json/list`)}).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && !String(target.url || "").startsWith("devtools://"));
if (!page?.webSocketDebuggerUrl) throw new Error("visible browser page is unavailable");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 5000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
});
const id = 1;
socket.send(JSON.stringify({
  id,
  method: "Runtime.evaluate",
  params: { expression: ${JSON.stringify(expression)}, awaitPromise: true, returnByValue: true },
}));
const message = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP evaluation timed out")), 5000);
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    if (value.id !== id) return;
    clearTimeout(timer);
    resolve(value);
  });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP evaluation failed")); }, { once: true });
});
socket.close();
if (message.error) throw new Error(message.error.message || "CDP evaluation failed");
if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.text || "browser expression failed");
process.stdout.write(${JSON.stringify(CDP_RESULT_MARKER)} + JSON.stringify(message.result?.result?.value));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const evaluated = await sandbox.process.executeCommand(
    `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`,
    undefined,
    undefined,
    timeoutSeconds,
  );
  const output = evaluated.result ?? "";
  const marker = output.lastIndexOf(CDP_RESULT_MARKER);
  if ((evaluated.exitCode ?? 1) !== 0 || marker < 0) {
    throw new Error(output.trim() || "browser inspection failed");
  }
  return JSON.parse(output.slice(marker + CDP_RESULT_MARKER.length)) as T;
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
