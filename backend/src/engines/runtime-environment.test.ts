import { describe, expect, test } from "bun:test";
import type { SandboxProcess } from "../sandboxes/provider";
import {
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
  type RunStageTimer,
  type RunTimingOutcome,
} from "../runs/run-timing";
import {
  buildRuntimeEnvironmentLaunchCommand,
  buildRuntimeEnvironmentReadinessCommand,
  ensureRuntimeEnvironment,
  restartRuntimeEnvironment,
  prewarmRuntimeEnvironment,
  RUNTIME_ENVIRONMENT_PORT,
  runtimeFirstActivityTimeoutMs,
  runtimeNoProgressTimeoutMs,
  runtimeEnvironmentEnabled,
} from "./runtime-environment";

type RuntimeTestProcess = Pick<
  SandboxProcess,
  "createSession" | "deleteSession" | "executeCommand" | "executeSessionCommand"
>;

function runtimeSandbox(
  id: string,
  process: Pick<RuntimeTestProcess, "executeCommand"> & Partial<RuntimeTestProcess>,
): { readonly id: string; readonly process: RuntimeTestProcess } {
  return {
    id,
    process: {
      createSession: async () => {},
      deleteSession: async () => {},
      executeSessionCommand: async () => ({ cmdId: "unused" }),
      ...process,
    },
  };
}

describe("T3 Cube environment", () => {
  test("is opt-in until hosted parity is proven", () => {
    expect(runtimeEnvironmentEnabled({})).toBe(false);
    expect(runtimeEnvironmentEnabled({ T3_ENVIRONMENT_ENABLED: "false" })).toBe(false);
    expect(runtimeEnvironmentEnabled({ T3_ENVIRONMENT_ENABLED: "1" })).toBe(true);
    expect(runtimeEnvironmentEnabled({ T3_ENVIRONMENT_ENABLED: "TRUE" })).toBe(true);
    // Deployment-safe dual-read: the new operator name wins over the legacy one.
    expect(runtimeEnvironmentEnabled({ RUNTIME_ENVIRONMENT_ENABLED: "true" })).toBe(true);
    expect(
      runtimeEnvironmentEnabled({
        RUNTIME_ENVIRONMENT_ENABLED: "false",
        T3_ENVIRONMENT_ENABLED: "true",
      }),
    ).toBe(false);
  });

  test("bounds first-activity silence with an operator-tunable timeout", () => {
    expect(runtimeFirstActivityTimeoutMs({})).toBe(45_000);
    expect(runtimeFirstActivityTimeoutMs({ T3_FIRST_ACTIVITY_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(runtimeFirstActivityTimeoutMs({ T3_FIRST_ACTIVITY_TIMEOUT_MS: "0" })).toBe(45_000);
    expect(runtimeFirstActivityTimeoutMs({ T3_FIRST_ACTIVITY_TIMEOUT_MS: "nope" })).toBe(45_000);
    expect(runtimeFirstActivityTimeoutMs({ RUNTIME_FIRST_ACTIVITY_TIMEOUT_MS: "1200" })).toBe(1200);
  });

  test("bounds provider no-progress time with an operator-tunable timeout", () => {
    expect(runtimeNoProgressTimeoutMs({})).toBe(120_000);
    expect(runtimeNoProgressTimeoutMs({ T3_NO_PROGRESS_TIMEOUT_MS: "2500" })).toBe(2500);
    expect(runtimeNoProgressTimeoutMs({ T3_NO_PROGRESS_TIMEOUT_MS: "0" })).toBe(120_000);
    expect(runtimeNoProgressTimeoutMs({ T3_NO_PROGRESS_TIMEOUT_MS: "nah" })).toBe(120_000);
    expect(runtimeNoProgressTimeoutMs({ RUNTIME_NO_PROGRESS_TIMEOUT_MS: "3500" })).toBe(3500);
  });

  test("launches one isolated headless environment inside the Cube workstation", () => {
    const command = buildRuntimeEnvironmentLaunchCommand();

    expect(command).toContain('export T3CODE_HOME="$HOME/.skynet/t3"');
    expect(command).toContain("export T3CODE_HOST=0.0.0.0");
    expect(command).toContain(`export T3CODE_PORT=${RUNTIME_ENVIRONMENT_PORT}`);
    expect(command).toContain("export T3_CODEX_REQUIRED_MCP_SERVERS=skynet-knowledge");
    expect(command).toContain("export T3CODE_NO_BROWSER=true");
    expect(command).toContain('exec t3 serve --host 0.0.0.0 --port 37733 --base-dir "$T3CODE_HOME"');
    expect(command).toContain('"$HOME/work"');
    expect(command).not.toContain("@latest");
    // Org secrets must NEVER enter the T3 process environment (the codex
    // provider adapter builds child environments from it and foreign variables
    // broke the subscription dial). Tool shells get secrets via rc hooks
    // installed by materializeSecretFiles instead.
    expect(command).not.toContain("skynet-env.sh");
    expect(command).not.toContain("BASH_ENV");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("uses a loopback readiness probe", () => {
    const command = buildRuntimeEnvironmentReadinessCommand();

    expect(command).toContain(`http://127.0.0.1:${RUNTIME_ENVIRONMENT_PORT}/api/auth/session`);
    expect(command).not.toContain("0.0.0.0");
  });

  test("reuses a healthy resident environment without restarting it", async () => {
    const commands: string[] = [];
    const spans: { stage: string; outcome?: RunTimingOutcome }[] = [];
    const timing = {
      begin: (stage: string) => (outcome?: RunTimingOutcome) => {
        spans.push({ stage, outcome });
      },
    } satisfies Pick<RunStageTimer, "begin">;
    const sandbox = runtimeSandbox("cube-t3-healthy", {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
    });

    await expect(
      ensureRuntimeEnvironment(sandbox, new AbortController().signal, timing),
    ).resolves.toMatchObject({ sandboxId: "cube-t3-healthy", port: RUNTIME_ENVIRONMENT_PORT });
    expect(commands).toEqual([buildRuntimeEnvironmentReadinessCommand()]);
    expect(spans).toEqual([
      { stage: RUN_TIMING_STAGES.runtimeReadiness, outcome: RUN_TIMING_OUTCOMES.ready },
    ]);
  });

  test("repairs an unhealthy resident environment and proves readiness", async () => {
    const deleted: string[] = [];
    const created: string[] = [];
    const launched: string[] = [];
    let probes = 0;
    const sandbox = runtimeSandbox("cube-t3-cold", {
        executeCommand: async () => ({ exitCode: probes++ === 0 ? 1 : 0, result: "" }),
        deleteSession: async (name: string) => deleted.push(name),
        createSession: async (name: string) => created.push(name),
        executeSessionCommand: async (name: string, request: { command: string }) => {
          launched.push(`${name}:${request.command}`);
          return { cmdId: "t3-command", exitCode: 0 };
        },
    });

    await expect(
      ensureRuntimeEnvironment(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({ sandboxId: "cube-t3-cold", port: RUNTIME_ENVIRONMENT_PORT });
    expect(deleted).toEqual(["skynet-t3-environment"]);
    expect(created).toEqual(["skynet-t3-environment"]);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain("exec t3 serve");
    expect(probes).toBe(2);
  });

  test("restarts a healthy environment so it reloads settings, then proves readiness", async () => {
    // A codex subscription run patches its per-run relay config into settings.json
    // and must force the warm T3 server to reboot so it reads that config at boot.
    // The setsid-detached server is killed by command line (cube deleteSession
    // cannot reach it), so a health probe only reports down after that kill.
    let running = true;
    const deleted: string[] = [];
    const created: string[] = [];
    const launched: string[] = [];
    let killCommand: string | undefined;
    const sandbox = runtimeSandbox("cube-t3-restart", {
      executeCommand: async (command: string) => {
        if (command.includes("[t]3 serve")) {
          killCommand = command;
          running = false;
          return { exitCode: 0, result: "" };
        }
        return { exitCode: running ? 0 : 1, result: "" };
      },
      deleteSession: async (name: string) => {
        deleted.push(name);
      },
      createSession: async (name: string) => {
        created.push(name);
      },
      executeSessionCommand: async (name: string, request: { command: string }) => {
        launched.push(`${name}:${request.command}`);
        running = true;
        return { cmdId: "t3-command", exitCode: 0 };
      },
    });

    await expect(
      restartRuntimeEnvironment(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({ sandboxId: "cube-t3-restart", port: RUNTIME_ENVIRONMENT_PORT });
    // Force-stopped even though the environment was healthy: the server process is
    // killed directly by command line (self-safe pattern, cube deleteSession
    // cannot reach the detached process), the session directory is cleaned, then
    // it is relaunched.
    expect(killCommand).toContain("pkill");
    expect(killCommand).toContain("[t]3 serve");
    expect(deleted).toContain("skynet-t3-environment");
    expect(created).toEqual(["skynet-t3-environment"]);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain("exec t3 serve");
  });

  test("fails closed when a restart is aborted before the environment stops", async () => {
    const controller = new AbortController();
    controller.abort();
    const sandbox = runtimeSandbox("cube-t3-restart-aborted", {
      executeCommand: async () => ({ exitCode: 0, result: "" }),
    });

    await expect(
      restartRuntimeEnvironment(sandbox, controller.signal),
    ).rejects.toThrow("Provider runtime restart aborted");
  });

  test("repairs after a failed probe when the stale session is already absent", async () => {
    let probes = 0;
    let launches = 0;
    const sandbox = runtimeSandbox("cube-t3-missing-session", {
        executeCommand: async () => {
          if (probes++ === 0) throw new Error("probe transport failed");
          return { exitCode: 0, result: "" };
        },
        deleteSession: async () => {
          throw new Error("session not found");
        },
        createSession: async () => {},
        executeSessionCommand: async () => {
          launches += 1;
          return { cmdId: "t3-command", exitCode: 0 };
        },
    });

    await expect(
      ensureRuntimeEnvironment(sandbox, new AbortController().signal),
    ).resolves.toMatchObject({ sandboxId: "cube-t3-missing-session" });
    expect(probes).toBe(2);
    expect(launches).toBe(1);
  });

  test("does no work while the migration flag is disabled", async () => {
    let calls = 0;
    const sandbox = runtimeSandbox("cube-t3-disabled", {
        executeCommand: async () => {
          calls += 1;
          return { exitCode: 0, result: "" };
        },
    });

    await prewarmRuntimeEnvironment(sandbox, new AbortController().signal, {});
    expect(calls).toBe(0);
  });
});
