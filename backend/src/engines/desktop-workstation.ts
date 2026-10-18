import { SANDBOX_STATE_HOME } from "../sandboxes/sandbox-names";
import { BROWSER_CDP_ENDPOINT, BROWSER_DISPLAY } from "./browser-mcp";
import {
  BROWSER_LAUNCH_SCRIPT,
  desktopCdpRelayProbeCommand,
  providerCdpRelayProbeCommand,
} from "./desktop-cdp-relay";

export const DESKTOP_PORT = 6080;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const DESKTOP_REQUIRED_BINARIES = [
  "Xorg",
  "budgie-daemon",
  "budgie-panel",
  "budgie-wm",
  "dbus-launch",
  "dconf",
  "gnome-terminal",
  "node",
  "pcmanfm",
  "pgrep",
  "websockify",
  "x11vnc",
  "xdotool",
  "xdpyinfo",
] as const;

/** The settings daemon lives outside PATH on Debian. */
export const DESKTOP_SETTINGS_DAEMON = "/usr/libexec/gsd-xsettings";

export function rfbProbeCommand(): string {
  // curl's telnet transport exits 28 after reading the banner when x11vnc keeps
  // the protocol socket open. A direct socket read gives the readiness check
  // one unambiguous success condition and no shell-pipeline exit-code trap.
  return "python3 -c \"import socket; s=socket.create_connection(('127.0.0.1',5900),1); assert s.recv(4)==b'RFB '\"";
}

/** The desktop session is whole: window manager, panel, daemon and the desktop icons. */
export function desktopSessionProbeCommand(): string {
  return ["budgie-wm", "budgie-panel", "budgie-daemon", "pcmanfm"]
    .map((process) => `pgrep -x ${process} >/dev/null`)
    .join(" && ");
}

/** The session script: Budgie's components started directly under one session bus. Budgie's own
 *  session manager needs logind and polkit, which a sandbox does not have. */
export function buildDesktopSessionScript(): string {
  return [
    "#!/bin/sh",
    `${DESKTOP_SETTINGS_DAEMON} >"${SANDBOX_STATE_HOME}/gsd-xsettings.log" 2>&1 &`,
    `budgie-daemon >"${SANDBOX_STATE_HOME}/budgie-daemon.log" 2>&1 &`,
    `budgie-wm >"${SANDBOX_STATE_HOME}/budgie-wm.log" 2>&1 &`,
    'for i in $(seq 1 80); do xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && break; sleep 0.25; done',
    `budgie-panel >"${SANDBOX_STATE_HOME}/budgie-panel.log" 2>&1 &`,
    `pcmanfm --desktop --profile useagent >"${SANDBOX_STATE_HOME}/pcmanfm.log" 2>&1 &`,
    "wait",
    "",
  ].join("\n");
}

const LEGACY_CHROME_PIPE_PIDS_COMMAND =
  "ps -eo pid=,comm=,args= | awk '$2 ~ /(chrome|chromium)/ && /--remote-debugging-pipe/ {print $1}'";
const LEGACY_CHROME_PIPE_GONE_COMMAND = `test -z "$(${LEGACY_CHROME_PIPE_PIDS_COMMAND})"`;
const CDP_PORT_CLOSED_COMMAND =
  "python3 -c \"import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(1 if s.connect_ex(('127.0.0.1',9222)) == 0 else 0)\"";

/** Chrome's own background traffic to Google (component updates, push, account listing,
 *  metrics, sync, DNS over HTTPS) stays off in customer sandboxes; pages the agent opens are
 *  unaffected. Measured on the image's Chromium 152 with a net log: none of it is left. */
export const BROWSER_PRIVACY_FLAGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--no-pings",
  "--metrics-recording-only",
  "--disable-domain-reliability",
  "--disable-breakpad",
  "--disable-features=DnsOverHttps,OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater," +
    // The AI Mode eligibility check Chrome sends to its default search engine at startup.
    "AimEnabled,AimServerEligibilityEnabled,AimServerRequestOnStartupEnabled,AimServerRequestOnIdentityChangeEnabled",
  // Chrome has no switch that turns off push (GCM: checkin, registration and the persistent
  // connection to port 5228) or its own Google account listing (ListAccounts at startup and
  // every 24 h), so their endpoints point at a closed local port: none of it leaves the sandbox.
  // Signing in to Google sites in a page still works; web push notifications do not.
  "--gcm-checkin-url=http://127.0.0.1:9/checkin",
  "--gcm-registration-url=http://127.0.0.1:9/register",
  "--gcm-mcs-endpoint=https://127.0.0.1:9",
  "--gaia-url=http://127.0.0.1:9",
] as const;

/** The same lockdown as managed policy, which also binds a browser started any other way. */
export const BROWSER_MANAGED_POLICY = {
  MetricsReportingEnabled: false,
  // Standard protection stays on: the agent opens arbitrary sites and sometimes signs in.
  SafeBrowsingProtectionLevel: 1,
  ComponentUpdatesEnabled: false,
  BackgroundModeEnabled: false,
  SyncDisabled: true,
  DnsOverHttpsMode: "off",
  BrowserNetworkTimeQueriesEnabled: false,
  SearchSuggestEnabled: false,
  NetworkPredictionOptions: 2,
  UrlKeyedAnonymizedDataCollectionEnabled: false,
  SpellCheckServiceEnabled: false,
  TranslateEnabled: false,
  AlternateErrorPagesEnabled: false,
  PasswordLeakDetectionEnabled: false,
  DomainReliabilityAllowed: false,
} as const;

/** Chromium and Chrome read their managed policy from these directories. */
export const BROWSER_POLICY_DIRECTORIES = ["/etc/chromium/policies/managed", "/etc/opt/chrome/policies/managed"] as const;

/** Write the policy as root, through sudo on a non-root layout; never fatal. */
export function buildBrowserPolicyCommand(): string {
  const json = JSON.stringify(BROWSER_MANAGED_POLICY);
  const write = BROWSER_POLICY_DIRECTORIES
    .map((directory) => `mkdir -p ${directory} && printf '%s' ${shellQuote(json)} >${directory}/useagent.json`)
    .join(" && ");
  return `{ ${write}; } 2>/dev/null || sudo -n sh -c ${shellQuote(write)} 2>/dev/null || true`;
}

/** The one-shot Chrome start the launcher runs first and the relay runs on demand. */
export function buildBrowserLaunchScript(): string {
  return [
    "#!/bin/sh",
    `export DISPLAY=${BROWSER_DISPLAY}`,
    `mkdir -p "${SANDBOX_STATE_HOME}/browser-profile"`,
    "browser=$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null)",
    // --password-store=basic: never reach for the desktop keyring. Saving a password the
    // agent or a user typed otherwise raises gnome-keyring's system prompt, which dims
    // the whole sandbox screen behind a dialog nobody asked for.
    'exec "$browser" --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --password-store=basic ' +
      `${BROWSER_PRIVACY_FLAGS.join(" ")} ` +
      "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 " +
      "'--remote-allow-origins=*' " +
      `--user-data-dir="${SANDBOX_STATE_HOME}/browser-profile" --restore-last-session --start-maximized about:blank ` +
      `>>"${SANDBOX_STATE_HOME}/chrome.log" 2>&1`,
    "",
  ].join("\n");
}

/** One long-lived process group owns the virtual display, Budgie workstation, browser,
 * VNC server, and noVNC bridge. The browser is deliberately NOT owned by an MCP
 * child, so restarting OpenCode/Claude/Codex or their MCP transport cannot close
 * the user's tabs. Chrome remains loopback-only. The provider-facing relay admits
 * only bounded page CDP routes and requires a per-sandbox bearer token in addition
 * to the provider preview credential. x11vnc also remains loopback-only and reaches
 * the browser through useAgent's authenticated same-origin desktop proxy. */
export function buildDesktopLaunchCommand(): string {
  return [
    "set -eu",
    `export DISPLAY=${BROWSER_DISPLAY}`,
    `mkdir -p "${SANDBOX_STATE_HOME}"`,
    // Chrome's background traffic is locked down by managed policy before any browser starts.
    buildBrowserPolicyCommand(),
    // Any earlier desktop goes first: the one whose pid is recorded (its process group) and
    // every service by name, so a relaunch never stacks on a live display. Names only, and
    // the browser and relay by their binaries: this shell's own command text has the same words.
    `old=$(cat "${SANDBOX_STATE_HOME}/desktop.pid" 2>/dev/null || true)`,
    '[ -n "$old" ] && [ "$old" != "$$" ] && { kill -TERM -- "-$old" 2>/dev/null || true; }',
    "for name in websockify x11vnc budgie-panel budgie-wm budgie-daemon pcmanfm gsd-xsettings dbus-launch; do pkill -x $name 2>/dev/null || true; done",
    "ps -eo pid=,comm=,args= | awk '$2 ~ /^(node|chrome|chromium)/ && /(cdp-relay\\.mjs|--remote-debugging-port=9222)/ {print $1}' | xargs -r kill -TERM 2>/dev/null || true",
    "pkill -x Xorg 2>/dev/null || true",
    "for i in $(seq 1 40); do xdpyinfo -display :1 >/dev/null 2>&1 || break; sleep 0.25; done",
    "xdpyinfo -display :1 >/dev/null 2>&1 && { pkill -KILL -x Xorg 2>/dev/null || true; sleep 0.5; }",
    // Xorg clears a stale lock itself; on a non-root image the lock is root's and stays.
    "rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true",
    `echo $$ >"${SANDBOX_STATE_HOME}/desktop.pid"`,
    "export XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Budgie:GNOME LANG=C.UTF-8",
    // A system bus, best effort: the components only warn without one, but the terminal's service needs it.
    // On an unprivileged layout the bus must still be root's: system services such as UPower
    // (the panel's status applet) activate only through a root bus, so fall back to sudo.
    "pgrep -x dbus-daemon >/dev/null 2>&1 || { mkdir -p /run/dbus && dbus-daemon --system --fork; } >/dev/null 2>&1 || sudo -n sh -c 'mkdir -p /run/dbus && dbus-daemon --system --fork' >/dev/null 2>&1 || true",
    // A real X server on the dummy driver (1920x1080 at 60 Hz from the image's xorg.conf.d).
    `Xorg :1 -noreset -nolisten tcp -ac >"${SANDBOX_STATE_HOME}/xorg.log" 2>&1 &`,
    "for i in $(seq 1 40); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.25; done",
    "xdpyinfo -display :1 >/dev/null 2>&1",
    `printf '%s' ${shellQuote(buildDesktopSessionScript())} >"${SANDBOX_STATE_HOME}/desktop-session.sh"`,
    `chmod +x "${SANDBOX_STATE_HOME}/desktop-session.sh"`,
    `dbus-launch --exit-with-session "${SANDBOX_STATE_HOME}/desktop-session.sh" >"${SANDBOX_STATE_HOME}/desktop-session.log" 2>&1 &`,
    `for i in $(seq 1 120); do ${desktopSessionProbeCommand()} && break; sleep 0.25; done`,
    desktopSessionProbeCommand(),
    // One-time migration from the old MCP-owned Chrome (`remote-debugging-pipe`).
    // Match only Chrome's process name so this shell cannot kill itself even
    // though its command text contains the same flag.
    `${LEGACY_CHROME_PIPE_PIDS_COMMAND} | xargs -r kill -TERM`,
    `for i in $(seq 1 20); do ${LEGACY_CHROME_PIPE_GONE_COMMAND} && ${CDP_PORT_CLOSED_COMMAND} && break; sleep 0.25; done`,
    LEGACY_CHROME_PIPE_GONE_COMMAND,
    CDP_PORT_CLOSED_COMMAND,
    // Chrome is started once here and on demand afterwards by the relay, when a
    // browser tool or the plane needs it. A window the user closes stays closed.
    `printf '%s' ${shellQuote(buildBrowserLaunchScript())} >"${BROWSER_LAUNCH_SCRIPT}"`,
    `chmod +x "${BROWSER_LAUNCH_SCRIPT}"`,
    `sh "${BROWSER_LAUNCH_SCRIPT}" &`,
    `for i in $(seq 1 80); do curl -fsS -m 1 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version && break; sleep 0.25; done`,
    `curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version`,
    `node "${SANDBOX_STATE_HOME}/cdp-relay.mjs" >>"${SANDBOX_STATE_HOME}/cdp-relay.log" 2>&1 &`,
    `for i in $(seq 1 40); do ${desktopCdpRelayProbeCommand()} && break; sleep 0.25; done`,
    desktopCdpRelayProbeCommand(),
    `x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900 >"${SANDBOX_STATE_HOME}/x11vnc.log" 2>&1 &`,
    `for i in $(seq 1 40); do ${rfbProbeCommand()} && break; sleep 0.25; done`,
    rfbProbeCommand(),
    "exec websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900",
  ].join("\n");
}

/** The launcher as the file the image installs; the boot runs it once the runtime is warm. */
export function buildDesktopLaunchScript(): string {
  return `#!/bin/sh\n# useagent-desktop-launch: generated by backend/src/engines/desktop-workstation.ts; do not edit.\n${buildDesktopLaunchCommand()}\n`;
}

/** Marker under the sandbox state directory while the image's own desktop boot is still running. */
export const DESKTOP_BOOT_MARKER_NAME = "desktop-boot";

/** The desktop is ready without a running browser: the relay starts one when it is needed. */
export function buildDesktopReadinessCommand(): string {
  return (
    `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html && ` +
    `${rfbProbeCommand()} && ` +
    `${desktopSessionProbeCommand()} && ` +
    `${desktopCdpRelayProbeCommand()} && ` +
    providerCdpRelayProbeCommand()
  );
}
