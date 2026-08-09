import { describe, expect, test } from "bun:test";
import type { Sandbox } from "@daytona/sdk";
import {
  PLAYWRIGHT_MCP_VERSION,
  acpBrowserMcpServer,
  buildDesktopLaunchCommand,
  ensureSandboxDesktop,
  opencodeBrowserMcpConfig,
} from "./desktop";

describe("shared sandbox desktop", () => {
  test("launches a private VNC server behind the existing websockify preview", () => {
    const command = buildDesktopLaunchCommand();

    expect(command).toContain("Xvfb :1");
    expect(command).toContain("x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900");
    expect(command).toContain("websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900");
    expect(command).not.toContain("0.0.0.0:5900");
    expect(command).not.toContain("&;");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("ACP receives one pinned local Playwright MCP bound to the visible display", () => {
    const server = acpBrowserMcpServer("/home/daytona", "/home/daytona/work", "/usr/bin/chromium");

    expect(server).toEqual({
      name: "skynet-browser",
      command: "/home/daytona/.local/bin/playwright-mcp",
      args: [
        "--executable-path",
        "/usr/bin/chromium",
        "--no-sandbox",
        "--user-data-dir",
        "/home/daytona/.skynet/browser-profile",
        "--output-dir",
        "/home/daytona/work/.skynet-browser",
        "--viewport-size",
        "1440x900",
      ],
      env: [{ name: "DISPLAY", value: ":1" }],
    });
  });

  test("OpenCode receives the same browser MCP and persistent profile", () => {
    const config = opencodeBrowserMcpConfig("/root", "/root/work", "/usr/bin/google-chrome");

    expect(config).toMatchObject({
      type: "local",
      enabled: true,
      environment: { DISPLAY: ":1" },
    });
    expect(config.command).toEqual(expect.arrayContaining([
      "/root/.local/bin/playwright-mcp",
      "--executable-path",
      "/usr/bin/google-chrome",
    ]));
    expect(JSON.stringify(config)).toContain("/root/.skynet/browser-profile");
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
});
