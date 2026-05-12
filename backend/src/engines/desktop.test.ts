import { describe, expect, test } from "bun:test";
import type { Sandbox } from "@daytona/sdk";
import {
  PLAYWRIGHT_MCP_VERSION,
  acpBrowserMcpServer,
  buildDesktopLaunchCommand,
  ensureSandboxDesktop,
  ensureSandboxDesktopView,
  opencodeBrowserMcpConfig,
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
    expect(command).toContain("x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900");
    expect(command).toContain("websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900");
    expect(command).not.toContain("0.0.0.0:5900");
    expect(command).not.toContain("&;");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("ACP receives one pinned local Playwright MCP bound to the visible display", () => {
    const server = acpBrowserMcpServer("/home/daytona", "/home/daytona/work");

    expect(server).toEqual({
      name: "skynet-browser",
      command: "/home/daytona/.local/bin/playwright-mcp",
      args: [
        "--cdp-endpoint",
        "http://127.0.0.1:9222",
        "--caps",
        "vision",
        "--image-responses",
        "allow",
        "--output-dir",
        "/home/daytona/work/.skynet-browser",
        "--viewport-size",
        "1440x900",
      ],
      env: [{ name: "DISPLAY", value: ":1" }],
    });
  });

  test("OpenCode receives vision tools attached to the persistent Desktop browser", () => {
    const config = opencodeBrowserMcpConfig("/root", "/root/work");

    expect(config).toMatchObject({
      type: "local",
      enabled: true,
      environment: { DISPLAY: ":1" },
    });
    expect(config.command).toEqual(expect.arrayContaining([
      "/root/.local/bin/playwright-mcp",
      "--cdp-endpoint",
      "http://127.0.0.1:9222",
      "--caps",
      "vision",
    ]));
    expect(JSON.stringify(config)).toContain("/root/work/.skynet-browser");
    expect(PLAYWRIGHT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("degrades the capability when Daytona provisioning fails", async () => {
    const sandbox = {
      process: {
        executeCommand: async () => {
          throw new Error("sensitive provider failure");
        },
      },
    } as unknown as Sandbox;

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
          if (command.includes("printf \"HOME=")) {
            return {
              exitCode: 0,
              result:
                "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=1\nCDP=1\nMCP=0\n",
            };
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as Sandbox;

    await expect(
      ensureSandboxDesktopView(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({
      available: true,
      browserTools: false,
      browserExecutable: "/usr/bin/chromium",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("/vnc.html");
    expect(commands[0]).toContain("/json/version");
    expect(commands).not.toEqual(expect.arrayContaining([expect.stringContaining("npm install")]));
  });

  test("reuses a provisioned browser tool without a second sandbox command", async () => {
    const commands: string[] = [];
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return {
            exitCode: 0,
            result:
              "HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\nVNC=1\nCDP=1\nMCP=1\n",
          };
        },
      },
    } as unknown as Sandbox;

    await expect(
      ensureSandboxDesktop(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({
      available: true,
      browserTools: true,
      browserExecutable: "/usr/bin/chromium",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("playwright-mcp");
  });

  test("repairs the desktop when either the VNC or CDP endpoint is unhealthy", async () => {
    for (const firstHealth of ["VNC=1\nCDP=0", "VNC=0\nCDP=1"]) {
      const commands: string[] = [];
      const deleted: string[] = [];
      const created: string[] = [];
      const launched: string[] = [];
      let healthChecks = 0;
      const sandbox = {
        process: {
          executeCommand: async (command: string) => {
            commands.push(command);
            if (command.includes("printf \"HOME=")) {
              return {
                exitCode: 0,
                result:
                  `HOME=/home/daytona\nBROWSER=/usr/bin/chromium\nMISSING=\n${firstHealth}\n`,
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
      } as unknown as Sandbox;

      await expect(
        ensureSandboxDesktopView(sandbox, new AbortController().signal),
      ).resolves.toMatchObject({
        available: true,
        browserTools: false,
        browserExecutable: "/usr/bin/chromium",
      });
      expect(deleted).toEqual(["skynet-desktop"]);
      expect(created).toEqual(["skynet-desktop"]);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toContain("Xvfb :1");
      expect(healthChecks).toBe(1);
      expect(commands.at(-1)).toContain("/vnc.html");
      expect(commands.at(-1)).toContain("/json/version");
    }
  });
});
