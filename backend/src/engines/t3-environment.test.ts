import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  buildT3EnvironmentLaunchCommand,
  buildT3EnvironmentReadinessCommand,
  ensureT3Environment,
  prewarmT3Environment,
  T3_ENVIRONMENT_PORT,
  t3EnvironmentEnabled,
} from "./t3-environment";

describe("T3 Cube environment", () => {
  test("is opt-in until hosted parity is proven", () => {
    expect(t3EnvironmentEnabled({})).toBe(false);
    expect(t3EnvironmentEnabled({ T3_ENVIRONMENT_ENABLED: "false" })).toBe(false);
    expect(t3EnvironmentEnabled({ T3_ENVIRONMENT_ENABLED: "1" })).toBe(true);
    expect(t3EnvironmentEnabled({ T3_ENVIRONMENT_ENABLED: "TRUE" })).toBe(true);
  });

  test("launches one isolated headless environment inside the Cube workstation", () => {
    const command = buildT3EnvironmentLaunchCommand();

    expect(command).toContain('export T3CODE_HOME="$HOME/.skynet/t3"');
    expect(command).toContain("export T3CODE_HOST=0.0.0.0");
    expect(command).toContain(`export T3CODE_PORT=${T3_ENVIRONMENT_PORT}`);
    expect(command).toContain("export T3_CODEX_REQUIRED_MCP_SERVERS=skynet-knowledge");
    expect(command).toContain("export T3CODE_NO_BROWSER=true");
    expect(command).toContain('exec t3 serve --host 0.0.0.0 --port 37733 --base-dir "$T3CODE_HOME"');
    expect(command).toContain('"$HOME/work"');
    expect(command).not.toContain("@latest");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("uses a loopback readiness probe", () => {
    const command = buildT3EnvironmentReadinessCommand();

    expect(command).toContain(`http://127.0.0.1:${T3_ENVIRONMENT_PORT}/api/auth/session`);
    expect(command).not.toContain("0.0.0.0");
  });

  test("reuses a healthy resident environment without restarting it", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "cube-t3-healthy",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      ensureT3Environment(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({ sandboxId: "cube-t3-healthy", port: T3_ENVIRONMENT_PORT });
    expect(commands).toEqual([buildT3EnvironmentReadinessCommand()]);
  });

  test("repairs an unhealthy resident environment and proves readiness", async () => {
    const deleted: string[] = [];
    const created: string[] = [];
    const launched: string[] = [];
    let probes = 0;
    const sandbox = {
      id: "cube-t3-cold",
      process: {
        executeCommand: async () => ({ exitCode: probes++ === 0 ? 1 : 0, result: "" }),
        deleteSession: async (name: string) => deleted.push(name),
        createSession: async (name: string) => created.push(name),
        executeSessionCommand: async (name: string, request: { command: string }) => {
          launched.push(`${name}:${request.command}`);
          return { cmdId: "t3-command", exitCode: 0 };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      ensureT3Environment(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({ sandboxId: "cube-t3-cold", port: T3_ENVIRONMENT_PORT });
    expect(deleted).toEqual(["skynet-t3-environment"]);
    expect(created).toEqual(["skynet-t3-environment"]);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain("exec t3 serve");
    expect(probes).toBe(2);
  });

  test("does no work while the migration flag is disabled", async () => {
    let calls = 0;
    const sandbox = {
      process: {
        executeCommand: async () => {
          calls += 1;
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await prewarmT3Environment(sandbox, new AbortController().signal, {});
    expect(calls).toBe(0);
  });
});
