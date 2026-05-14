import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  buildDesktopLaunchCommand,
  ensureSandboxDesktop,
  ensureSandboxDesktopView,
} from "./desktop";

describe("shared sandbox desktop", () => {
  test("launches a private VNC server behind the existing websockify preview", () => {
    const command = buildDesktopLaunchCommand();

    expect(command).toContain("Xvfb :1");
    expect(command).toContain("--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222");
    expect(command).toContain('--user-data-dir="$HOME/.skynet/browser-profile"');
    expect(command).toContain("--restore-last-session");
    expect(command).toContain("--remote-debugging-pipe");
    expect(command).toContain("http://127.0.0.1:9222/json/version");
    expect(command).toContain("--disable-gpu");
    expect(command).toContain("while true; do");
    expect(command).toContain('>>"$HOME/.skynet/chrome.log" 2>&1 || true');
    expect(command).toContain("x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900");
    expect(command).toContain("socket.create_connection(('127.0.0.1',5900),1)");
    expect(command).toContain("s.recv(4)==b'RFB '");
    expect(command).toContain("websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900");
    expect(command).not.toContain("0.0.0.0:5900");
    expect(command).not.toContain("&;");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("degrades the capability when Daytona provisioning fails", async () => {
    const sandbox = {
      process: {
        executeCommand: async () => {
          throw new Error("sensitive provider failure");
        },
      },
    } as unknown as SandboxHandle;

    await expect(ensureSandboxDesktop(sandbox, new AbortController().signal)).resolves.toEqual({
      available: false,
      browserTools: false,
      home: "/home/daytona",
      workdir: "/home/daytona/work",
      browserExecutable: null,
      reason: "desktop provisioning failed",
    });
  });

  test("readies the user-visible desktop without installing agent browser tools", async () => {
    const commands: string[] = [];
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.includes('printf "HOME=')) {
            return {
              exitCode: 0,
              result:
                "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=1\nRFB=1\nCDP=1\nMCP=0\n",
            };
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      ensureSandboxDesktopView(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({
      available: true,
      browserTools: false,
      browserExecutable: "/usr/bin/chromium",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("/vnc.html");
    expect(commands[0]).toContain("socket.create_connection(('127.0.0.1',5900),1)");
    expect(commands[0]).toContain("/json/version");
    expect(commands).not.toEqual(expect.arrayContaining([expect.stringContaining("npm install")]));
  });

  test("repairs the desktop when noVNC, RFB, or CDP is unhealthy", async () => {
    for (const firstHealth of [
      "VNC=1\nRFB=1\nCDP=0",
      "VNC=1\nRFB=0\nCDP=1",
      "VNC=0\nRFB=1\nCDP=1",
    ]) {
      const commands: string[] = [];
      const deleted: string[] = [];
      const created: string[] = [];
      const launched: string[] = [];
      let healthChecks = 0;
      const sandbox = {
        process: {
          executeCommand: async (command: string) => {
            commands.push(command);
            if (command.includes('printf "HOME=')) {
              return {
                exitCode: 0,
                result: `HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\n${firstHealth}\n`,
              };
            }
            healthChecks += 1;
            return { exitCode: 0, result: "" };
          },
          deleteSession: async (name: string) => deleted.push(name),
          createSession: async (name: string) => created.push(name),
          executeSessionCommand: async (name: string, input: { command: string }) => {
            launched.push(`${name}:${input.command}`);
            return { id: "desktop-command" };
          },
        },
      } as unknown as SandboxHandle;

      await expect(
        ensureSandboxDesktopView(sandbox, new AbortController().signal),
      ).resolves.toMatchObject({
        available: true,
        browserTools: false,
        browserExecutable: "/usr/bin/chromium",
      });
      expect(deleted).toEqual(["skynet-browser-mcp", "skynet-desktop"]);
      expect(created).toEqual(["skynet-desktop"]);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toContain("Xvfb :1");
      expect(healthChecks).toBe(1);
      expect(commands.at(-1)).toContain("/vnc.html");
      expect(commands.at(-1)).toContain("socket.create_connection(('127.0.0.1',5900),1)");
      expect(commands.at(-1)).toContain("/json/version");
    }
  });

  test("serializes an engine repair with a concurrent Desktop-pane repair", async () => {
    const created: string[] = [];
    const deleted: string[] = [];
    let desktopHealthy = false;
    let desktopLaunches = 0;
    const sandbox = {
      id: "sandbox-concurrent-desktop",
      process: {
        executeCommand: async (command: string) => {
          if (command.startsWith("mkdir -p ~/work")) {
            // Leave a real scheduling window in which an unlocked second caller
            // would observe the same cold state and launch a competing repair.
            const wasHealthy = desktopHealthy;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              exitCode: 0,
              result: wasHealthy
                ? "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=1\nRFB=1\nCDP=1\nMCP=1\n"
                : "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=0\nRFB=0\nCDP=0\nMCP=1\n",
            };
          }
          if (command.includes("skynet-browser-guard-ping")) {
            return { exitCode: 0, result: "" };
          }
          if (command.includes("localhost:8931/mcp")) {
            return { exitCode: 0, result: "400" };
          }
          return { exitCode: desktopHealthy ? 0 : 1, result: "" };
        },
        deleteSession: async (name: string) => deleted.push(name),
        createSession: async (name: string) => created.push(name),
        executeSessionCommand: async (name: string) => {
          if (name === "skynet-desktop") {
            desktopLaunches += 1;
            desktopHealthy = true;
          }
          return { cmdId: `${name}-command` };
        },
      },
    } as unknown as SandboxHandle;

    const signal = new AbortController().signal;
    const [view, tools] = await Promise.all([
      ensureSandboxDesktopView(sandbox, signal),
      ensureSandboxDesktop(sandbox, signal),
    ]);

    expect(view.available).toBe(true);
    expect(tools).toMatchObject({ available: true, browserTools: true });
    expect(desktopLaunches).toBe(1);
    expect(created.filter((name) => name === "skynet-desktop")).toHaveLength(1);
    expect(deleted.filter((name) => name === "skynet-desktop")).toHaveLength(1);
  });
});
