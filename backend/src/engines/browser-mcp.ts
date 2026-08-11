import type { SandboxHandle } from "../sandboxes/provider";

export const PLAYWRIGHT_MCP_VERSION = "0.0.79";
export const BROWSER_DISPLAY = ":1";
export const BROWSER_CDP_ENDPOINT = "http://127.0.0.1:9222";

const BROWSER_MCP_PROCESS_SESSION = "skynet-browser-mcp";
const BROWSER_MCP_PORT = 8931;
const BROWSER_MCP_URL = `http://localhost:${BROWSER_MCP_PORT}/mcp`;
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

async function browserMcpGuardHealthy(sandbox: SandboxHandle): Promise<boolean> {
  const ping = JSON.stringify({
    jsonrpc: "2.0",
    id: "skynet-browser-guard-ping",
    method: "ping",
    params: {},
  });
  const probe = await sandbox.process
    .executeCommand(
      `guard_session=$(cat ${BROWSER_MCP_GUARD_FILE} 2>/dev/null || true); ` +
        'test -n "$guard_session"; ' +
        `curl -fsS -m 2 -o /dev/null ` +
        "-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' " +
        '-H "Mcp-Session-Id: $guard_session" ' +
        `--data '${ping}' ${BROWSER_MCP_URL}`,
      undefined,
      undefined,
      10,
    )
    .catch(() => null);
  return probe?.exitCode === 0;
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
  let listening = await residentBrowserMcpListening(sandbox);
  if (listening && (await browserMcpGuardHealthy(sandbox))) return true;

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
