import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  acpBrowserMcpServer,
  ensureResidentBrowserMcp,
  opencodeBrowserMcpConfig,
  PLAYWRIGHT_MCP_VERSION,
  registerClaudeBrowserMcp,
} from "./browser-mcp";

describe("resident browser MCP", () => {
  test("exposes one loopback endpoint to ACP", () => {
    expect(acpBrowserMcpServer()).toEqual({
      type: "http",
      name: "skynet-browser",
      url: "http://localhost:8931/mcp",
    });
  });

  test("exposes the same loopback endpoint to OpenCode", () => {
    expect(opencodeBrowserMcpConfig()).toEqual({
      type: "remote",
      url: "http://localhost:8931/mcp",
      enabled: true,
    });
    expect(PLAYWRIGHT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("registers the resident browser in Claude's user scope", async () => {
    const commands: string[] = [];
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "healthy" };
        },
      },
    } as unknown as SandboxHandle;

    await expect(registerClaudeBrowserMcp(sandbox)).resolves.toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("claude mcp get skynet-browser");
    expect(commands[0]).toContain("claude mcp add-json --scope user skynet-browser");
    expect(commands[0]).toContain('"url":"http://localhost:8931/mcp"');
    expect(commands[0]).toContain('"alwaysLoad":true');
  });

  test("degrades Claude browser tools when registration fails", async () => {
    const sandbox = {
      process: {
        executeCommand: async () => ({ exitCode: 1, result: "sensitive cli failure" }),
      },
    } as unknown as SandboxHandle;

    await expect(registerClaudeBrowserMcp(sandbox)).resolves.toBe(false);
  });

  test("reuses a healthy server and guard without restarting", async () => {
    const commands: string[] = [];
    const created: string[] = [];
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "healthy" };
        },
        createSession: async (name: string) => created.push(name),
      },
    } as unknown as SandboxHandle;

    await expect(
      ensureResidentBrowserMcp(sandbox, "/home/daytona/work", new AbortController().signal),
    ).resolves.toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("localhost:8931/mcp");
    expect(commands[0]).toContain("skynet-browser-guard-ping");
    expect(created).toEqual([]);
    expect(commands).not.toEqual(expect.arrayContaining([expect.stringContaining("npm install")]));
  });

  test("adds a guard to an existing server without restarting", async () => {
    const commands: string[] = [];
    const created: string[] = [];
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.includes("skynet-browser-guard-ping")) {
            return { exitCode: 0, result: "listening" };
          }
          return { exitCode: 0, result: "" };
        },
        createSession: async (name: string) => created.push(name),
      },
    } as unknown as SandboxHandle;

    await expect(
      ensureResidentBrowserMcp(sandbox, "/home/daytona/work", new AbortController().signal),
    ).resolves.toBe(true);
    expect(created).toEqual([]);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("localhost:8931/mcp");
    expect(commands[0]).toContain("skynet-browser-guard-ping");
    expect(commands[1]).toContain("skynet-browser-guard-init");
    expect(commands[1]).toContain("notifications/initialized");
    expect(commands[1]).toContain("browser-mcp-guard.session");
  });

  test("starts one server with explicit snapshots and bounded actions", async () => {
    const commands: string[] = [];
    const deleted: string[] = [];
    const created: string[] = [];
    const launched: string[] = [];
    let residentProbe = 0;
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.includes("skynet-browser-guard-init")) {
            return { exitCode: 0, result: "" };
          }
          if (command.includes("skynet-browser-guard-ping")) {
            return { exitCode: 0, result: "down" };
          }
          residentProbe += 1;
          return {
            exitCode: residentProbe === 1 ? 7 : 0,
            result: residentProbe === 1 ? "000" : "400",
          };
        },
        deleteSession: async (name: string) => deleted.push(name),
        createSession: async (name: string) => created.push(name),
        executeSessionCommand: async (name: string, input: { command: string }) => {
          launched.push(`${name}:${input.command}`);
          return { cmdId: "browser-mcp-command" };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      ensureResidentBrowserMcp(sandbox, "/home/daytona/work", new AbortController().signal),
    ).resolves.toBe(true);
    expect(deleted).toEqual(["skynet-browser-mcp"]);
    expect(created).toEqual(["skynet-browser-mcp"]);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain("--host 127.0.0.1 --port 8931");
    expect(launched[0]).toContain("--shared-browser-context");
    expect(launched[0]).toContain("--snapshot-mode none");
    expect(launched[0]).toContain("--caps vision");
    expect(launched[0]).toContain("--timeout-action 10000");
    expect(commands.at(-1)).toContain("skynet-browser-guard-init");
  });
});
