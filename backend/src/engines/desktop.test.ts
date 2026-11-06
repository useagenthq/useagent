import { describe, expect, test } from "bun:test";
import type {
  SandboxFileSystem,
  SandboxHandle,
  SandboxProcess,
} from "../sandboxes/provider";
import {
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
  type RunStageTimer,
  type RunTimingOutcome,
} from "../runs/run-timing";
import {
  buildDesktopLaunchCommand,
  buildDesktopReadinessCommand,
  DESKTOP_REQUIRED_BINARIES,
  ensureSandboxDesktop,
  ensureSandboxDesktopView,
  desktopUnavailableStep,
} from "./desktop";
import {
  BROWSER_MANAGED_POLICY,
  BROWSER_POLICY_DIRECTORIES,
  BROWSER_PRIVACY_FLAGS,
  buildBrowserLaunchScript,
} from "./desktop-workstation";
import { SANDBOX_NAME_PREFIX, SANDBOX_STATE_HOME } from "../sandboxes/sandbox-names";

function relayFileSystem(): SandboxFileSystem {
  const files = new Map<string, Buffer>();
  return {
    getFileDetails: async (path: string) => ({ size: files.get(path)?.byteLength }),
    downloadFile: async (path: string) => {
      const file = files.get(path);
      if (!file) throw new Error("missing file");
      return file;
    },
    uploadFile: async (file: Buffer, path: string) => {
      files.set(path, file);
    },
  };
}

function sandboxFixture(
  id: string,
  process: Pick<SandboxProcess, "executeCommand"> & Partial<SandboxProcess>,
): SandboxHandle {
  return {
    id,
    cpu: 1,
    memory: 1,
    process: {
      createSession: async () => {},
      deleteSession: async () => {},
      getSession: async () => ({ commands: [] }),
      executeSessionCommand: async () => ({ cmdId: "unused" }),
      getSessionCommandLogs: async () => ({}),
      createPty: async () => ({
        waitForConnection: async () => {},
        waitForTermination: async () => new Promise(() => {}),
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      }),
      ...process,
    },
    fs: relayFileSystem(),
    start: async () => {},
    delete: async () => {},
    getPreviewLink: async () => ({ url: "http://sandbox.invalid" }),
  };
}

describe("shared sandbox desktop", () => {
  test("launches a private VNC server behind the existing websockify preview", () => {
    const command = buildDesktopLaunchCommand();

    expect(command).toContain("Xorg :1 -noreset -nolisten tcp -ac");
    // An earlier desktop, the boot's or a previous repair's, is stopped before anything starts.
    const stop = command.indexOf('kill -TERM -- "-$old"');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(command.indexOf("Xorg :1 -noreset"));
    expect(command).toContain("pkill -x Xorg 2>/dev/null || true");
    expect(command).toContain("for name in websockify x11vnc budgie-panel budgie-wm budgie-daemon pcmanfm gsd-xsettings dbus-launch; do pkill -x $name");
    expect(command).toContain("$2 ~ /^(node|chrome|chromium)/ && /(cdp-relay\\.mjs|--remote-debugging-port=9222)/");
    expect(command).toContain(`echo $$ >"${SANDBOX_STATE_HOME}/desktop.pid"`);
    expect(command).toContain("rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true");
    expect(command).toContain(`dbus-launch --exit-with-session "${SANDBOX_STATE_HOME}/desktop-session.sh"`);
    expect(command).toContain("budgie-wm >");
    expect(command).toContain("pcmanfm --desktop --profile useagent");
    expect(command).toContain("XDG_SESSION_TYPE=x11");
    expect(command).toContain("--start-maximized");
    expect(command).not.toContain("openbox");
    expect(command).toContain("--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222");
    expect(command).toContain(`--user-data-dir="${SANDBOX_STATE_HOME}/browser-profile"`);
    expect(command).toContain("--restore-last-session");
    expect(command).toContain("--remote-debugging-pipe");
    expect(command).not.toContain("\nsleep 1\n");
    const launchLines = command.split("\n");
    const legacyDrainProbeIndex = launchLines.findIndex(
      (line) => line.includes("connect_ex(('127.0.0.1',9222))"),
    );
    const legacyDrainProbe = launchLines[legacyDrainProbeIndex];
    expect(legacyDrainProbe).toContain("for i in $(seq 1 20)");
    expect(legacyDrainProbe).toContain("--remote-debugging-pipe");
    expect(legacyDrainProbe).toContain("&& break; sleep 0.25; done");
    expect(launchLines[legacyDrainProbeIndex + 1]).toContain("--remote-debugging-pipe");
    expect(launchLines[legacyDrainProbeIndex + 2]).toContain("connect_ex(('127.0.0.1',9222))");
    expect(launchLines[legacyDrainProbeIndex + 3]).toStartWith("printf '%s' '#!/bin/sh");
    // Chrome starts once and comes back on demand through the relay; no restart loop.
    expect(command).toContain(`sh "${SANDBOX_STATE_HOME}/browser-launch.sh" &`);
    expect(command).not.toContain("while true");
    expect(command).toContain("http://127.0.0.1:9222/json/version");
    expect(command).toContain(`node "${SANDBOX_STATE_HOME}/cdp-relay.mjs"`);
    expect(command).toContain("--disable-gpu");
    expect(command).toContain(`>>"${SANDBOX_STATE_HOME}/chrome.log" 2>&1`);
    expect(command).toContain("x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900");
    expect(command).toContain("socket.create_connection(('127.0.0.1',5900),1)");
    expect(command).toContain("s.recv(4)==b'RFB '");
    expect(command).toContain("websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900");
    expect(command).not.toContain("0.0.0.0:5900");
    expect(command).not.toContain("&;");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("requires the complete workstation in desktop readiness", () => {
    const command = buildDesktopReadinessCommand();

    expect(command).toContain("/vnc.html");
    // A closed browser is not a broken desktop: readiness asks the relay for its health only.
    expect(command).toContain("/healthz");
    expect(command).not.toContain("9222/json/version");
    expect(command).toContain('00000000:4B16');
    for (const process of [
      "budgie-wm",
      "budgie-panel",
      "budgie-daemon",
      "pcmanfm",
    ]) {
      expect(command).toContain(`pgrep -x ${process}`);
    }
    expect(DESKTOP_REQUIRED_BINARIES).toContain("xdotool");
    expect(DESKTOP_REQUIRED_BINARIES).toContain("node");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("degrades the capability when Daytona provisioning fails", async () => {
    const sandbox = sandboxFixture("sandbox-provision-failure", {
        executeCommand: async () => {
          throw new Error("sensitive provider failure");
        },
    });

    await expect(ensureSandboxDesktop(sandbox, new AbortController().signal)).resolves.toEqual({
      available: false,
      browserTools: false,
      home: "/home/daytona",
      workdir: "/home/daytona/work",
      browserExecutable: null,
      reason: "desktop provisioning failed",
    });
  });

  test("uses a provider-owned desktop instead of provisioning a competing workstation", async () => {
    let starts = 0;
    const sandbox: SandboxHandle = {
      ...sandboxFixture("sandbox-native-desktop", {
        executeCommand: async () => {
          throw new Error("the generic desktop path must not run");
        },
      }),
      desktop: {
        display: ":0",
        home: "/home/user",
        workdir: "/home/user/work",
        browserExecutable: null,
        start: async () => {
          starts += 1;
        },
      },
    };

    await expect(
      ensureSandboxDesktopView(sandbox, new AbortController().signal),
    ).resolves.toEqual({
      available: true,
      browserTools: false,
      home: "/home/user",
      workdir: "/home/user/work",
      browserExecutable: null,
    });
    expect(starts).toBe(1);
  });

  test("readies the user-visible desktop without installing agent browser tools", async () => {
    const commands: string[] = [];
    const spans: { stage: string; outcome?: RunTimingOutcome }[] = [];
    const timing = {
      begin: (stage: string) => (outcome?: RunTimingOutcome) => {
        spans.push({ stage, outcome });
      },
    } satisfies Pick<RunStageTimer, "begin">;
    const sandbox = sandboxFixture("sandbox-ready-view", {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.includes('printf "HOME=')) {
            return {
              exitCode: 0,
              result:
                "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=1\nRFB=1\nCDP=1\nCDP_RELAY=1\nSESSION=1\nMCP=0\n",
            };
          }
          return { exitCode: 0, result: "" };
        },
    });

    await expect(
      ensureSandboxDesktopView(sandbox, new AbortController().signal, timing),
    ).resolves.toMatchObject({
      available: true,
      browserTools: false,
      browserExecutable: "/usr/bin/chromium",
    });
    expect(spans).toEqual([
      { stage: RUN_TIMING_STAGES.desktopReadiness, outcome: RUN_TIMING_OUTCOMES.ready },
    ]);
    const probe = commands.find((command) => command.includes('printf "HOME='));
    expect(probe).toContain("/vnc.html");
    expect(probe).toContain("socket.create_connection(('127.0.0.1',5900),1)");
    expect(probe).toContain("/json/version");
    for (const binary of [
      "Xorg",
      "budgie-wm",
      "budgie-panel",
      "budgie-daemon",
      "pcmanfm",
      "gnome-terminal",
      "dconf",
    ]) {
      expect(probe).toContain(binary);
    }
    expect(commands).not.toEqual(expect.arrayContaining([expect.stringContaining("npm install")]));
  });

  test("repairs the desktop when noVNC, RFB, the session, or the relay is unhealthy, and not for a closed browser", async () => {
    for (const firstHealth of [
      // A browser that is not running is not a fault: the relay starts it on the next browser use.
      "VNC=1\nRFB=1\nCDP=0\nCDP_RELAY=1\nSESSION=1",
      "VNC=1\nRFB=0\nCDP=1\nCDP_RELAY=1\nSESSION=1",
      "VNC=0\nRFB=1\nCDP=1\nCDP_RELAY=1\nSESSION=1",
      "VNC=1\nRFB=1\nCDP=1\nCDP_RELAY=1\nSESSION=0",
      "VNC=1\nRFB=1\nCDP=1\nCDP_RELAY=0\nSESSION=1",
    ]) {
      const commands: string[] = [];
      const deleted: string[] = [];
      const created: string[] = [];
      const launched: string[] = [];
      let healthChecks = 0;
      const sandbox = sandboxFixture(`sandbox-repair-${firstHealth}`, {
          executeCommand: async (command: string) => {
            commands.push(command);
            if (command.includes('printf "HOME=')) {
              return {
                exitCode: 0,
                result: `HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\n${firstHealth}\n`,
              };
            }
            if (command.includes("/vnc.html")) healthChecks += 1;
            return { exitCode: 0, result: "" };
          },
          deleteSession: async (name: string) => deleted.push(name),
          createSession: async (name: string) => created.push(name),
          executeSessionCommand: async (name: string, input: { command: string }) => {
            launched.push(`${name}:${input.command}`);
            return { cmdId: "desktop-command" };
          },
      });

      await expect(
        ensureSandboxDesktopView(sandbox, new AbortController().signal),
      ).resolves.toMatchObject({
        available: true,
        browserTools: false,
        browserExecutable: "/usr/bin/chromium",
      });
      if (firstHealth.includes("CDP=0")) {
        expect(launched).toHaveLength(0);
        expect(created).toEqual([]);
        continue;
      }
      expect(deleted).toEqual([`${SANDBOX_NAME_PREFIX}-browser-mcp`, `${SANDBOX_NAME_PREFIX}-desktop`]);
      expect(created).toEqual([`${SANDBOX_NAME_PREFIX}-desktop`]);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toContain("Xorg :1");
      expect(healthChecks).toBe(1);
      expect(commands.at(-1)).toContain("/vnc.html");
      expect(commands.at(-1)).toContain("socket.create_connection(('127.0.0.1',5900),1)");
      expect(commands.at(-1)).toContain("/healthz");
    }
  });

  test("waits for a desktop the image is still booting instead of starting a second one", async () => {
    let healthChecks = 0;
    const launched: string[] = [];
    const sandbox = sandboxFixture("sandbox-booting-desktop", {
      executeCommand: async (command: string) => {
        if (command.includes('printf "HOME=')) {
          return {
            exitCode: 0,
            result: "HOME=/root\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=0\nRFB=0\nCDP=0\nCDP_RELAY=0\nSESSION=0\nMCP=0\nDESKTOP_BOOT=1\n",
          };
        }
        if (command.includes("/vnc.html")) {
          healthChecks += 1;
          return { exitCode: healthChecks >= 2 ? 0 : 1, result: "" };
        }
        return { exitCode: 0, result: "" };
      },
      deleteSession: async () => {},
      createSession: async () => {},
      executeSessionCommand: async (_name: string, input: { command: string }) => {
        launched.push(input.command);
        return { cmdId: "desktop-command" };
      },
    });

    await expect(
      ensureSandboxDesktopView(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({ available: true, browserExecutable: "/usr/bin/chromium" });
    expect(launched).toEqual([]);
    expect(healthChecks).toBe(2);
  });

  test("repairs when stale desktop sessions are already absent", async () => {
    let launched = false;
    const sandbox = sandboxFixture("sandbox-missing-desktop-sessions", {
        executeCommand: async (command: string) => {
          if (command.includes('printf "HOME=')) {
            return {
              exitCode: 0,
              result:
                "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=0\nRFB=0\nCDP=0\nCDP_RELAY=0\nSESSION=0\nMCP=0\n",
            };
          }
          if (command.startsWith(`chmod 700 "${SANDBOX_STATE_HOME}"`)) {
            return { exitCode: 0, result: "" };
          }
          return { exitCode: launched ? 0 : 1, result: "" };
        },
        deleteSession: async () => {
          throw new Error("session not found");
        },
        createSession: async () => {},
        executeSessionCommand: async () => {
          launched = true;
          return { cmdId: "desktop-command" };
        },
    });

    await expect(
      ensureSandboxDesktopView(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({ available: true, browserExecutable: "/usr/bin/chromium" });
    expect(launched).toBe(true);
  });

  test("serializes an engine repair with a concurrent Desktop-pane repair", async () => {
    const created: string[] = [];
    const deleted: string[] = [];
    let desktopHealthy = false;
    let desktopLaunches = 0;
    const sandbox = sandboxFixture("sandbox-concurrent-desktop", {
        executeCommand: async (command: string) => {
          if (command.startsWith("mkdir -p ~/work")) {
            // Leave a real scheduling window in which an unlocked second caller
            // would observe the same cold state and launch a competing repair.
            const wasHealthy = desktopHealthy;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              exitCode: 0,
              result: wasHealthy
                ? "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=1\nRFB=1\nCDP=1\nCDP_RELAY=1\nSESSION=1\nMCP=1\n"
                : "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=0\nRFB=0\nCDP=0\nCDP_RELAY=0\nSESSION=0\nMCP=1\n",
            };
          }
          if (command.includes("useagent-browser-guard-ping")) {
            return { exitCode: 0, result: "" };
          }
          if (command.includes("localhost:8931/mcp")) {
            return { exitCode: 0, result: "400" };
          }
          if (command.startsWith(`chmod 700 "${SANDBOX_STATE_HOME}"`)) {
            return { exitCode: 0, result: "" };
          }
          return { exitCode: desktopHealthy ? 0 : 1, result: "" };
        },
        deleteSession: async (name: string) => deleted.push(name),
        createSession: async (name: string) => created.push(name),
        executeSessionCommand: async (name: string) => {
          if (name === `${SANDBOX_NAME_PREFIX}-desktop`) {
            desktopLaunches += 1;
            desktopHealthy = true;
          }
          return { cmdId: `${name}-command` };
        },
    });

    const signal = new AbortController().signal;
    const [view, tools] = await Promise.all([
      ensureSandboxDesktopView(sandbox, signal),
      ensureSandboxDesktop(sandbox, signal),
    ]);

    expect(view.available).toBe(true);
    expect(tools).toMatchObject({ available: true, browserTools: true });
    expect(desktopLaunches).toBe(1);
    expect(created.filter((name) => name === `${SANDBOX_NAME_PREFIX}-desktop`)).toHaveLength(1);
    expect(deleted.filter((name) => name === `${SANDBOX_NAME_PREFIX}-desktop`)).toHaveLength(1);
  });
});

describe("desktopUnavailableStep", () => {
  test("is a boot-lane task row on the engine chip, never a warning, and names the reason", () => {
    const step = desktopUnavailableStep("claude", { reason: "missing desktop binaries:xdotool" });
    expect(step).toEqual({
      kind: "task",
      chip: "claude",
      label: "Desktop and computer-use tools are not attached to this run (missing desktop binaries: xdotool)",
    });
    expect(desktopUnavailableStep("opencode", {})).toEqual({
      kind: "task",
      chip: "opencode",
      label: "Desktop and computer-use tools are not attached to this run",
    });
  });
});

describe("desktop browser keyring", () => {
  test("Chrome never uses the desktop keyring, whose system prompt dims the whole screen", () => {
    expect(buildBrowserLaunchScript()).toContain("--password-store=basic");
  });
});

describe("desktop browser background traffic", () => {
  test("every Chrome the desktop starts runs without its background traffic to Google", () => {
    const launch = buildBrowserLaunchScript();
    for (const flag of [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-pings",
      "--metrics-recording-only",
      "--disable-domain-reliability",
      "--gcm-checkin-url=http://127.0.0.1:9/checkin",
      "--gcm-registration-url=http://127.0.0.1:9/register",
      "--gcm-mcs-endpoint=https://127.0.0.1:9",
      "--gaia-url=http://127.0.0.1:9",
    ] as const) {
      expect(BROWSER_PRIVACY_FLAGS).toContain(flag);
      expect(launch).toContain(` ${flag} `);
    }
    // One --disable-features switch: Chrome keeps only the last one it is given.
    expect(launch.match(/--disable-features=/g)).toHaveLength(1);
    expect(launch).toMatch(/--disable-features=DnsOverHttps,[^ ]*,AimServerRequestOnStartupEnabled[, ]/);
  });

  test("the launcher writes the managed policy for Chromium and Chrome before any browser starts", () => {
    const command = buildDesktopLaunchCommand();
    const policyAt = command.indexOf("/etc/chromium/policies/managed/useagent.json");
    expect(policyAt).toBeGreaterThan(-1);
    expect(policyAt).toBeLessThan(command.indexOf(`sh "${SANDBOX_STATE_HOME}/browser-launch.sh" &`));
    for (const directory of BROWSER_POLICY_DIRECTORIES) {
      const written = new RegExp(`printf '%s' '([^']+)' >${directory}/useagent\\.json`).exec(command);
      expect(written).not.toBeNull();
      expect(JSON.parse(written![1]!)).toEqual(BROWSER_MANAGED_POLICY);
    }
    expect(BROWSER_MANAGED_POLICY).toMatchObject({
      MetricsReportingEnabled: false,
      SafeBrowsingProtectionLevel: 1,
      ComponentUpdatesEnabled: false,
      SyncDisabled: true,
      DnsOverHttpsMode: "off",
      BrowserNetworkTimeQueriesEnabled: false,
    });
    // A failed write never stops the desktop.
    expect(command).toContain("2>/dev/null || true");
    expect(Bun.spawnSync(["sh", "-n", "-c", command]).exitCode).toBe(0);
  });
});
