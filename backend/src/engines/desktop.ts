import type { SandboxHandle } from "../sandboxes/provider";
import {
  BROWSER_CDP_ENDPOINT,
  BROWSER_DISPLAY,
  ensureResidentBrowserMcp,
  PLAYWRIGHT_MCP_VERSION,
} from "./browser-mcp";

export const DESKTOP_PORT = 6080;

const DESKTOP_PROCESS_SESSION = "skynet-desktop";
const BROWSER_MCP_PROCESS_SESSION = "skynet-browser-mcp";
const desktopViewOperations = new Map<string | object, Promise<SandboxDesktop>>();

function rfbProbeCommand(): string {
  // curl's telnet transport exits 28 after reading the banner when x11vnc keeps
  // the protocol socket open. A direct socket read gives the readiness check
  // one unambiguous success condition and no shell-pipeline exit-code trap.
  return "python3 -c \"import socket; s=socket.create_connection(('127.0.0.1',5900),1); assert s.recv(4)==b'RFB '\"";
}

export interface SandboxDesktop {
  readonly available: boolean;
  readonly browserTools: boolean;
  readonly home: string;
  readonly workdir: string;
  readonly browserExecutable: string | null;
  readonly reason?: string;
}

/** One long-lived process group owns the virtual display, browser, window manager,
 * VNC server, and noVNC bridge. The browser is deliberately NOT owned by an MCP
 * child: every harness attaches to its loopback-only CDP endpoint, so restarting
 * OpenCode/Claude/Codex or their MCP transport cannot close the user's tabs.
 * x11vnc listens on loopback only; the browser reaches websockify through
 * Skynet's authenticated same-origin desktop proxy. */
export function buildDesktopLaunchCommand(): string {
  return [
    "set -eu",
    `export DISPLAY=${BROWSER_DISPLAY}`,
    'mkdir -p "$HOME/.skynet"',
    'Xvfb :1 -screen 0 1440x900x24 -ac -nolisten tcp >"$HOME/.skynet/xvfb.log" 2>&1 &',
    "for i in $(seq 1 40); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.25; done",
    "xdpyinfo -display :1 >/dev/null 2>&1",
    "if command -v startxfce4 >/dev/null 2>&1; then",
    '  startxfce4 >"$HOME/.skynet/desktop-session.log" 2>&1 &',
    "elif command -v openbox >/dev/null 2>&1; then",
    '  openbox >"$HOME/.skynet/desktop-session.log" 2>&1 &',
    "fi",
    // One-time migration from the old MCP-owned Chrome (`remote-debugging-pipe`).
    // Match only Chrome's process name so this shell cannot kill itself even
    // though its command text contains the same flag.
    "ps -eo pid=,comm=,args= | awk '$2 ~ /(chrome|chromium)/ && /--remote-debugging-pipe/ {print $1}' | xargs -r kill -TERM",
    "sleep 1",
    "browser=$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null)",
    'mkdir -p "$HOME/.skynet/browser-profile"',
    // Chrome can be killed by a renderer/browser crash on large dynamic sites.
    // Keep its lifecycle under the desktop process session so the next MCP call
    // can reconnect to CDP instead of retrying ECONNREFUSED until the run dies.
    "(",
    "  while true; do",
    '    "$browser" --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check ' +
      "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 " +
      "'--remote-allow-origins=*' " +
      '--user-data-dir="$HOME/.skynet/browser-profile" --restore-last-session --window-size=1440,900 about:blank ' +
      '>>"$HOME/.skynet/chrome.log" 2>&1 || true',
    "    sleep 0.5",
    "  done",
    ") &",
    `for i in $(seq 1 80); do curl -fsS -m 1 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version && break; sleep 0.25; done`,
    `curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version`,
    'x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900 >"$HOME/.skynet/x11vnc.log" 2>&1 &',
    `for i in $(seq 1 40); do ${rfbProbeCommand()} && break; sleep 0.25; done`,
    rfbProbeCommand(),
    "exec websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900",
  ].join("\n");
}

async function localDesktopHealthy(sandbox: SandboxHandle): Promise<boolean> {
  const probe = await sandbox.process
    .executeCommand(
      `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html && ` +
        `${rfbProbeCommand()} && ` +
        `curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version`,
      undefined,
      undefined,
      10,
    )
    .catch(() => null);
  return probe?.exitCode === 0;
}

async function provisionSandboxDesktopView(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  const probe = await sandbox.process.executeCommand(
    "mkdir -p ~/work; browser=$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true); " +
      'missing=""; for bin in Xvfb xdpyinfo x11vnc websockify; do command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"; done; ' +
      `vnc=0; curl -fsS -m 3 -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html && vnc=1; ` +
      `rfb=0; ${rfbProbeCommand()} && rfb=1; ` +
      `cdp=0; curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version && cdp=1; ` +
      'mcp=0; [ -x "$HOME/.local/bin/playwright-mcp" ] && mcp=1; ' +
      'printf "HOME=%s\\nBROWSER=%s\\nMISSING=%s\\nVNC=%s\\nRFB=%s\\nCDP=%s\\nMCP=%s\\n" "$HOME" "$browser" "$missing" "$vnc" "$rfb" "$cdp" "$mcp"',
    undefined,
    undefined,
    20,
  );
  const output = probe.result ?? "";
  const home = /^HOME=(.*)$/m.exec(output)?.[1]?.trim() || "/home/daytona";
  const workdir = `${home}/work`;
  const browserExecutable = /^BROWSER=(.*)$/m.exec(output)?.[1]?.trim() || null;
  const missing = /^MISSING=(.*)$/m.exec(output)?.[1]?.trim() || "";
  const healthy = /^VNC=1$/m.test(output) && /^RFB=1$/m.test(output) && /^CDP=1$/m.test(output);
  const browserTools = /^MCP=1$/m.test(output);
  if ((probe.exitCode ?? 1) !== 0 || missing) {
    return {
      available: false,
      browserTools: false,
      home,
      workdir,
      browserExecutable,
      reason: missing ? `missing desktop binaries:${missing}` : "desktop prerequisite probe failed",
    };
  }
  if (!browserExecutable) {
    return {
      available: false,
      browserTools: false,
      home,
      workdir,
      browserExecutable,
      reason: "no supported browser executable",
    };
  }

  if (!healthy) {
    // The resident MCP may still hold a CDP connection to the browser we are
    // about to replace. Stop it first so the next engine turn receives one
    // clean MCP generation attached to the new Chrome process.
    await sandbox.process.deleteSession(BROWSER_MCP_PROCESS_SESSION).catch(() => {});
    await sandbox.process.deleteSession(DESKTOP_PROCESS_SESSION).catch(() => {});
    await sandbox.process.createSession(DESKTOP_PROCESS_SESSION);
    await sandbox.process.executeSessionCommand(
      DESKTOP_PROCESS_SESSION,
      {
        command: buildDesktopLaunchCommand(),
        runAsync: true,
        suppressInputEcho: true,
      },
      30,
    );
  }

  let available = healthy;
  if (!available) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !signal.aborted) {
      available = await localDesktopHealthy(sandbox);
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  available = !signal.aborted && available;
  if (!available) {
    return {
      available,
      browserTools: false,
      home,
      workdir,
      browserExecutable,
      reason: signal.aborted
        ? "run aborted while starting desktop"
        : "noVNC, RFB, or browser CDP failed readiness",
    };
  }

  return {
    available: true,
    browserTools,
    home,
    workdir,
    browserExecutable,
  };
}

/** The engine and the Desktop iframe can discover the same cold sandbox at the
 * same time. Serialize only the view lifecycle repair per sandbox: without this,
 * two callers can both delete/recreate `skynet-desktop`, and the second repair
 * kills Chrome underneath the first caller's already-running MCP tool. Browser
 * MCP installation stays outside this lock so opening Desktop never waits for
 * an unrelated npm install on genuinely old snapshots. */
async function serializedDesktopView(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  const key: string | object = sandbox.id || sandbox;
  const previous = desktopViewOperations.get(key);
  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed repair must not poison the per-sandbox queue. The next caller
      // gets one independent opportunity to reconcile the desktop lifecycle.
    }
    return await provisionSandboxDesktopView(sandbox, signal);
  })();
  desktopViewOperations.set(key, operation);
  try {
    return await operation;
  } finally {
    if (desktopViewOperations.get(key) === operation) {
      desktopViewOperations.delete(key);
    }
  }
}

async function provisionSandboxDesktop(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  const desktop = await serializedDesktopView(sandbox, signal);
  if (!desktop.available || !desktop.browserExecutable) return desktop;
  let installed = desktop.browserTools;
  if (!installed) {
    const install = await sandbox.process.executeCommand(
      `export PATH="$HOME/.local/bin:$PATH"; ` +
        `[ -x "$HOME/.local/bin/playwright-mcp" ] || ` +
        `npm install -g --prefix "$HOME/.local" --silent "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" >/dev/null 2>&1; ` +
        `[ -x "$HOME/.local/bin/playwright-mcp" ]`,
      undefined,
      undefined,
      300,
    );
    installed = install.exitCode === 0;
  }
  const browserTools =
    installed && (await ensureResidentBrowserMcp(sandbox, desktop.workdir, signal));
  return {
    ...desktop,
    browserTools,
    ...(!browserTools
      ? {
          reason: installed
            ? "resident browser MCP failed readiness"
            : "Playwright MCP installation failed",
        }
      : {}),
  };
}

/** Make only the user-visible noVNC surface ready. This intentionally skips the
 * Playwright MCP installation: opening Desktop must never wait on an agent-tool
 * dependency that the iframe does not use. */
export async function ensureSandboxDesktopView(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  try {
    return await serializedDesktopView(sandbox, signal);
  } catch {
    return {
      available: false,
      browserTools: false,
      home: "/home/daytona",
      workdir: "/home/daytona/work",
      browserExecutable: null,
      reason: "desktop provisioning failed",
    };
  }
}

/** Provision a truthful desktop resource in any engine sandbox. Failure is a
 * capability degradation, not a coding-run failure: callers advertise
 * `desktop:false` and continue the agent turn. */
export async function ensureSandboxDesktop(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  try {
    return await provisionSandboxDesktop(sandbox, signal);
  } catch {
    return {
      available: false,
      browserTools: false,
      home: "/home/daytona",
      workdir: "/home/daytona/work",
      browserExecutable: null,
      reason: "desktop provisioning failed",
    };
  }
}
