import type { Sandbox } from "@daytona/sdk";

export const DESKTOP_PORT = 6080;
export const PLAYWRIGHT_MCP_VERSION = "0.0.79";

const DESKTOP_PROCESS_SESSION = "skynet-desktop";
const DISPLAY = ":1";
const BROWSER_CDP_ENDPOINT = "http://127.0.0.1:9222";

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
    `export DISPLAY=${DISPLAY}`,
    "mkdir -p \"$HOME/.skynet\"",
    "Xvfb :1 -screen 0 1440x900x24 -ac -nolisten tcp >\"$HOME/.skynet/xvfb.log\" 2>&1 &",
    "for i in $(seq 1 40); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.25; done",
    "xdpyinfo -display :1 >/dev/null 2>&1",
    "if command -v startxfce4 >/dev/null 2>&1; then",
    "  startxfce4 >\"$HOME/.skynet/desktop-session.log\" 2>&1 &",
    "elif command -v openbox >/dev/null 2>&1; then",
    "  openbox >\"$HOME/.skynet/desktop-session.log\" 2>&1 &",
    "fi",
    // One-time migration from the old MCP-owned Chrome (`remote-debugging-pipe`).
    // Match only Chrome's process name so this shell cannot kill itself even
    // though its command text contains the same flag.
    "ps -eo pid=,comm=,args= | awk '$2 ~ /(chrome|chromium)/ && /--remote-debugging-pipe/ {print $1}' | xargs -r kill -TERM",
    "sleep 1",
    'browser=$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null)',
    'mkdir -p "$HOME/.skynet/browser-profile"',
    '"$browser" --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check ' +
      '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 ' +
      "'--remote-allow-origins=*' " +
      '--user-data-dir="$HOME/.skynet/browser-profile" --restore-last-session --window-size=1440,900 about:blank ' +
      '>"$HOME/.skynet/chrome.log" 2>&1 &',
    `for i in $(seq 1 80); do curl -fsS -m 1 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version && break; sleep 0.25; done`,
    `curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version`,
    "x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900 >\"$HOME/.skynet/x11vnc.log\" 2>&1 &",
    "exec websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900",
  ].join("\n");
}

function browserArgs(workdir: string): string[] {
  return [
    "--cdp-endpoint",
    BROWSER_CDP_ENDPOINT,
    "--caps",
    "vision",
    "--image-responses",
    "allow",
    "--output-dir",
    `${workdir}/.skynet-browser`,
    "--viewport-size",
    "1440x900",
  ];
}

/** ACP's protocol-native stdio MCP descriptor. Environment is an array in the
 * ACP schema, not an object as in Claude/OpenCode config files. */
export function acpBrowserMcpServer(
  home: string,
  workdir: string,
): Record<string, unknown> {
  return {
    name: "skynet-browser",
    command: `${home}/.local/bin/playwright-mcp`,
    args: browserArgs(workdir),
    env: [{ name: "DISPLAY", value: DISPLAY }],
  };
}

/** OpenCode v1 local-MCP descriptor. The executable and profile paths are
 * absolute because OpenCode config does not shell-expand $HOME. */
export function opencodeBrowserMcpConfig(
  home: string,
  workdir: string,
): Record<string, unknown> {
  return {
    type: "local",
    command: [`${home}/.local/bin/playwright-mcp`, ...browserArgs(workdir)],
    enabled: true,
    environment: { DISPLAY },
  };
}

async function localDesktopHealthy(sandbox: Sandbox): Promise<boolean> {
  const probe = await sandbox.process
    .executeCommand(
      `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html`,
      undefined,
      undefined,
      10,
    )
    .catch(() => null);
  if (probe?.exitCode !== 0) return false;
  const browser = await sandbox.process
    .executeCommand(
      `curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version`,
      undefined,
      undefined,
      10,
    )
    .catch(() => null);
  return browser?.exitCode === 0;
}

async function provisionSandboxDesktopView(
  sandbox: Sandbox,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  const probe = await sandbox.process.executeCommand(
    'mkdir -p ~/work; browser=$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true); ' +
      'missing=""; for bin in Xvfb xdpyinfo x11vnc websockify; do command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"; done; ' +
      'printf "HOME=%s\\nBROWSER=%s\\nMISSING=%s\\n" "$HOME" "$browser" "$missing"',
    undefined,
    undefined,
    20,
  );
  const output = probe.result ?? "";
  const home = /^HOME=(.*)$/m.exec(output)?.[1]?.trim() || "/home/daytona";
  const workdir = `${home}/work`;
  const browserExecutable = /^BROWSER=(.*)$/m.exec(output)?.[1]?.trim() || null;
  const missing = /^MISSING=(.*)$/m.exec(output)?.[1]?.trim() || "";
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

  if (!(await localDesktopHealthy(sandbox))) {
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

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !signal.aborted) {
    if (await localDesktopHealthy(sandbox)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const available = !signal.aborted && (await localDesktopHealthy(sandbox));
  if (!available || !browserExecutable) {
    return {
      available,
      browserTools: false,
      home,
      workdir,
      browserExecutable,
      reason: signal.aborted
        ? "run aborted while starting desktop"
        : !available
          ? "noVNC failed readiness"
          : "no supported browser executable",
    };
  }

  return {
    available: true,
    browserTools: false,
    home,
    workdir,
    browserExecutable,
  };
}

async function provisionSandboxDesktop(
  sandbox: Sandbox,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  const desktop = await provisionSandboxDesktopView(sandbox, signal);
  if (!desktop.available || !desktop.browserExecutable) return desktop;

  const install = await sandbox.process.executeCommand(
    `export PATH="$HOME/.local/bin:$PATH"; ` +
      `[ -x "$HOME/.local/bin/playwright-mcp" ] || ` +
      `npm install -g --prefix "$HOME/.local" --silent "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" >/dev/null 2>&1; ` +
      `[ -x "$HOME/.local/bin/playwright-mcp" ]`,
    undefined,
    undefined,
    300,
  );
  const browserTools = install.exitCode === 0;
  return {
    ...desktop,
    browserTools,
    ...(!browserTools ? { reason: "Playwright MCP installation failed" } : {}),
  };
}

/** Make only the user-visible noVNC surface ready. This intentionally skips the
 * Playwright MCP installation: opening Desktop must never wait on an agent-tool
 * dependency that the iframe does not use. */
export async function ensureSandboxDesktopView(
  sandbox: Sandbox,
  signal: AbortSignal,
): Promise<SandboxDesktop> {
  try {
    return await provisionSandboxDesktopView(sandbox, signal);
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
  sandbox: Sandbox,
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
