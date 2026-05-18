import { BROWSER_CDP_ENDPOINT, BROWSER_DISPLAY } from "./browser-mcp";
import {
  desktopCdpRelayProbeCommand,
  providerCdpRelayProbeCommand,
} from "./desktop-cdp-relay";

export const DESKTOP_PORT = 6080;

export const DESKTOP_REQUIRED_BINARIES = [
  "Xvfb",
  "dbus-launch",
  "bun",
  "pgrep",
  "startxfce4",
  "thunar",
  "websockify",
  "x11vnc",
  "xdotool",
  "xdpyinfo",
  "xfce4-clipman",
  "xfce4-panel",
  "xfce4-settings-manager",
  "xfce4-terminal",
  "xfdesktop",
  "xfwm4",
] as const;

export function rfbProbeCommand(): string {
  // curl's telnet transport exits 28 after reading the banner when x11vnc keeps
  // the protocol socket open. A direct socket read gives the readiness check
  // one unambiguous success condition and no shell-pipeline exit-code trap.
  return "python3 -c \"import socket; s=socket.create_connection(('127.0.0.1',5900),1); assert s.recv(4)==b'RFB '\"";
}

export function xfceSessionProbeCommand(): string {
  return ["xfce4-session", "xfwm4", "xfce4-panel", "xfdesktop", "xfce4-clipman"]
    .map((process) => `pgrep -x ${process} >/dev/null`)
    .join(" && ");
}

/** One long-lived process group owns the virtual display, XFCE workstation, browser,
 * VNC server, and noVNC bridge. The browser is deliberately NOT owned by an MCP
 * child, so restarting OpenCode/Claude/Codex or their MCP transport cannot close
 * the user's tabs. Chrome remains loopback-only. The provider-facing relay admits
 * only bounded page CDP routes and requires a per-sandbox bearer token in addition
 * to the provider preview credential. x11vnc also remains loopback-only and reaches
 * the browser through Skynet's authenticated same-origin desktop proxy. */
export function buildDesktopLaunchCommand(): string {
  return [
    "set -eu",
    `export DISPLAY=${BROWSER_DISPLAY}`,
    'mkdir -p "$HOME/.skynet"',
    'Xvfb :1 -screen 0 1440x900x24 -ac -nolisten tcp >"$HOME/.skynet/xvfb.log" 2>&1 &',
    "for i in $(seq 1 40); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.25; done",
    "xdpyinfo -display :1 >/dev/null 2>&1",
    'dbus-launch --exit-with-session startxfce4 >"$HOME/.skynet/desktop-session.log" 2>&1 &',
    // Minimal XFCE images do not always autostart the clipboard manager even
    // when the package is present. Start it explicitly before enforcing the
    // complete-workstation readiness contract.
    'xfce4-clipman >"$HOME/.skynet/clipman.log" 2>&1 &',
    `for i in $(seq 1 80); do ${xfceSessionProbeCommand()} && break; sleep 0.25; done`,
    xfceSessionProbeCommand(),
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
    'bun "$HOME/.skynet/cdp-relay.ts" >>"$HOME/.skynet/cdp-relay.log" 2>&1 &',
    `for i in $(seq 1 40); do ${desktopCdpRelayProbeCommand()} && break; sleep 0.25; done`,
    desktopCdpRelayProbeCommand(),
    'x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900 >"$HOME/.skynet/x11vnc.log" 2>&1 &',
    `for i in $(seq 1 40); do ${rfbProbeCommand()} && break; sleep 0.25; done`,
    rfbProbeCommand(),
    "exec websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900",
  ].join("\n");
}

export function buildDesktopReadinessCommand(): string {
  return (
    `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html && ` +
    `${rfbProbeCommand()} && ` +
    `${xfceSessionProbeCommand()} && ` +
    `curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version && ` +
    `${desktopCdpRelayProbeCommand()} && ` +
    providerCdpRelayProbeCommand()
  );
}
