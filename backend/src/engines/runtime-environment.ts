import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { sandboxPlugin } from "../sandboxes/plugins";
import { operatorEnv } from "./runtime-env";
import { TOOL_GATEWAY_SERVER_NAME } from "../knowledge/gateway/descriptor";
import {
  ensureNativeRuntimeArtifact,
  NATIVE_RUNTIME_ARTIFACT,
  nativeRuntimeExecutable,
} from "./native-runtime-artifact";
import {
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
  type RunStageTimer,
} from "../runs/run-timing";

export const RUNTIME_ENVIRONMENT_PORT = 37_733;
export const RUNTIME_GENERATION_LABEL = "useagent.runtime";
// Native wire/session compatibility, not the application release number. The
// pinned fork is the same v8 runtime already deployed; exact distribution bytes
// are verified separately. A future incompatible generation needs an explicit
// workspace-preserving upgrade, never delete-and-recreate of retained threads.
const DEFAULT_RUNTIME_GENERATION = "useagent-runtime-v8";

export function runtimeGeneration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const generation = env.USEAGENT_RUNTIME_GENERATION?.trim() || DEFAULT_RUNTIME_GENERATION;
  if (!/^useagent-runtime-v[0-9]+$/.test(generation)) {
    throw new Error("USEAGENT_RUNTIME_GENERATION must be useagent-runtime-v<number>");
  }
  return generation;
}

export const RUNTIME_GENERATION = runtimeGeneration();
export const RUNTIME_CUBE_WARM_POOL_NAME = RUNTIME_GENERATION;
// Frozen VALUE: warm sandboxes already carry a process session under this name;
// renaming the string would strand their resident server processes.
const RUNTIME_ENVIRONMENT_PROCESS_SESSION = "skynet-t3-environment";
// Frozen VALUE: the runtime binary's base-dir, baked into sandbox templates
// (auth cookies, settings.json, and caches all live under it).
export const RUNTIME_ENVIRONMENT_HOME = "$HOME/.skynet/t3";
export const RUNTIME_ENVIRONMENT_WORKDIR = "/root/work";
export const RUNTIME_SANDBOX_HOME = "/root";
const RUNTIME_MCP_SERVER_MARKER = `${RUNTIME_ENVIRONMENT_HOME}/.useagent-required-mcp`;
const RUNTIME_READINESS_DEADLINE_MS = 60_000;
const RUNTIME_READINESS_DELAY_MS = 100;
const RUNTIME_STOP_DEADLINE_MS = 15_000;
const DEFAULT_FIRST_ACTIVITY_TIMEOUT_MS = 45_000;
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 600_000;
type TimingRecorder = Pick<RunStageTimer, "begin">;
type RuntimeEnvironmentSandbox = Pick<SandboxHandle, "id" | "providerKind"> & {
  readonly fs?: Pick<SandboxHandle["fs"], "uploadFile">;
  readonly process: Pick<
    SandboxHandle["process"],
    "createSession" | "deleteSession" | "executeCommand" | "executeSessionCommand"
  >;
};

export interface RuntimeEnvironment {
  readonly sandboxId: string;
  readonly port: number;
  readonly home: string;
  readonly workdir: string;
}

const environmentOperations = new Map<string | RuntimeEnvironmentSandbox, Promise<RuntimeEnvironment>>();

const ROOT_RUNTIME_LAYOUT: SandboxRuntimeLayout = {
  home: RUNTIME_SANDBOX_HOME,
  workdir: RUNTIME_ENVIRONMENT_WORKDIR,
  runsAsRoot: true,
};

function runtimeEnvironmentLayout(sandbox: RuntimeEnvironmentSandbox): SandboxRuntimeLayout {
  if (!sandbox.providerKind) return ROOT_RUNTIME_LAYOUT;
  const plugin = sandboxPlugin(sandbox.providerKind);
  return { ...plugin.runtime, runsAsRoot: plugin.runsAsRoot };
}

export function runtimeEnvironmentEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = operatorEnv(env, "RUNTIME_ENVIRONMENT_ENABLED", "T3_ENVIRONMENT_ENABLED")
    ?.trim()
    .toLowerCase();
  return value === "1" || value === "true";
}

export function buildRuntimeEnvironmentReadinessCommand(): string {
  return [
    `test "$(cat \"${RUNTIME_MCP_SERVER_MARKER}\" 2>/dev/null)" = "${TOOL_GATEWAY_SERVER_NAME}"`,
    `test "$(cat \"${RUNTIME_ENVIRONMENT_HOME}/.useagent-native-runtime\" 2>/dev/null)" = "${NATIVE_RUNTIME_ARTIFACT.archiveSha256}:${NATIVE_RUNTIME_ARTIFACT.dependencyLockSha256}"`,
    `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${RUNTIME_ENVIRONMENT_PORT}/api/auth/session`,
  ].join(" && ");
}

export function buildRuntimeIdentityPreflightCommand(
  layout: SandboxRuntimeLayout = {
    home: RUNTIME_SANDBOX_HOME,
    workdir: RUNTIME_ENVIRONMENT_WORKDIR,
    runsAsRoot: true,
  },
): string {
  return [
    "set -eu",
    ...(layout.runsAsRoot ? ['test "$(id -u)" = "0"'] : ['test "$(id -u)" != "0"']),
    `test "${"$HOME"}" = "${layout.home}"`,
    `mkdir -p "${layout.workdir}"`,
    `test "$(cd "${layout.workdir}" && pwd -P)" = "${layout.workdir}"`,
    `test -w "${layout.workdir}"`,
    `printf '%s\\n' "${layout.workdir}"`,
  ].join("\n");
}

export async function resolveRuntimeWorkspaceRoot(
  sandbox: Pick<RuntimeEnvironmentSandbox, "process">,
  layout: SandboxRuntimeLayout = {
    home: RUNTIME_SANDBOX_HOME,
    workdir: RUNTIME_ENVIRONMENT_WORKDIR,
    runsAsRoot: true,
  },
): Promise<string> {
  const result = await sandbox.process.executeCommand(
    buildRuntimeIdentityPreflightCommand(layout),
    undefined,
    undefined,
    10,
  );
  const workdir = result.result?.trim();
  if ((result.exitCode ?? 1) !== 0 || workdir !== layout.workdir) {
    throw new Error(
      `Sandbox runtime identity contract failed (requires ${layout.runsAsRoot ? "uid=0" : "non-root uid"}, HOME=${layout.home}, workspaceRoot=${layout.workdir} writable)`,
    );
  }
  return workdir;
}

export function runtimeFirstActivityTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(
    operatorEnv(env, "RUNTIME_FIRST_ACTIVITY_TIMEOUT_MS", "T3_FIRST_ACTIVITY_TIMEOUT_MS")?.trim(),
  );
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_FIRST_ACTIVITY_TIMEOUT_MS;
}

export function runtimeNoProgressTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(
    operatorEnv(env, "RUNTIME_NO_PROGRESS_TIMEOUT_MS", "T3_NO_PROGRESS_TIMEOUT_MS")?.trim(),
  );
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_NO_PROGRESS_TIMEOUT_MS;
}

export function runtimeCodexChildForwardingEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = operatorEnv(
    env,
    "RUNTIME_CODEX_CHILD_EVENT_FORWARDING",
    "T3_CODEX_CHILD_EVENT_FORWARDING",
  )?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export function buildRuntimeEnvironmentLaunchCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT,
): string {
  const runtimeHome = `${layout.home}/.skynet/t3`;
  const localBin = `${layout.home}/.local/bin`;
  return [
    "set -eu",
    `export HOME="${layout.home}"`,
    `export PATH="${localBin}:$PATH"`,
    `export T3CODE_HOME="${runtimeHome}"`,
    "export T3CODE_MODE=web",
    "export T3CODE_HOST=0.0.0.0",
    `export T3CODE_PORT=${RUNTIME_ENVIRONMENT_PORT}`,
    `export T3_CODEX_REQUIRED_MCP_SERVERS=${TOOL_GATEWAY_SERVER_NAME}`,
    // The embedded T3 Codex adapter suppresses child-thread notifications by
    // default. Keep a separate operator kill switch from graph READ/SHADOW.
    ...(runtimeCodexChildForwardingEnabled(env)
      ? [
          "export RUNTIME_CODEX_CHILD_EVENT_FORWARDING=true",
          "export T3_CODEX_CHILD_EVENT_FORWARDING=true",
        ]
      : []),
    "export T3CODE_NO_BROWSER=true",
    "export T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false",
    "export T3CODE_LOG_WS_EVENTS=false",
    `mkdir -p "${runtimeHome}" "${layout.workdir}"`,
    `test -x "${nativeRuntimeExecutable(layout)}"`,
    `printf '%s\\n' "${TOOL_GATEWAY_SERVER_NAME}" > "${runtimeHome}/.useagent-required-mcp"`,
    `printf '%s\\n' "${NATIVE_RUNTIME_ARTIFACT.archiveSha256}:${NATIVE_RUNTIME_ARTIFACT.dependencyLockSha256}" > "${runtimeHome}/.useagent-native-runtime"`,
    // Org secrets are deliberately NOT sourced into the T3 process environment:
    // the codex provider adapter composes child/session environments from the
    // T3 process env, and foreign variables there broke the codex subscription
    // dial (proven by the 2026-08-18 release-gate failure). Tool shells receive
    // secrets through rc-file hooks installed by materializeSecretFiles.
    `exec "${nativeRuntimeExecutable(layout)}" serve --host 0.0.0.0 --port ${RUNTIME_ENVIRONMENT_PORT} --base-dir "$T3CODE_HOME" --no-browser "${layout.workdir}"`,
  ].join("\n");
}

async function runtimeEnvironmentHealthy(sandbox: RuntimeEnvironmentSandbox): Promise<boolean> {
  try {
    const probe = await sandbox.process.executeCommand(
      buildRuntimeEnvironmentReadinessCommand(),
      undefined,
      undefined,
      5,
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

async function deleteRuntimeEnvironmentSessionIfPresent(sandbox: RuntimeEnvironmentSandbox): Promise<void> {
  try {
    await sandbox.process.deleteSession(RUNTIME_ENVIRONMENT_PROCESS_SESSION);
  } catch {
    // An absent or stale process session is already in the desired state.
  }
}

async function provisionRuntimeEnvironment(
  sandbox: RuntimeEnvironmentSandbox,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<RuntimeEnvironment> {
  const endReadiness = timing?.begin(RUN_TIMING_STAGES.runtimeReadiness);
  try {
    const layout = runtimeEnvironmentLayout(sandbox);
    if (signal.aborted) throw new Error("Provider runtime start aborted");
    await ensureNativeRuntimeArtifact(sandbox, layout, signal);
    const alreadyHealthy = await runtimeEnvironmentHealthy(sandbox);
    if (!alreadyHealthy) {
      // A healthy old binary can still own the port even when provenance fails.
      await stopRuntimeEnvironment(sandbox, signal);
      await deleteRuntimeEnvironmentSessionIfPresent(sandbox);
      await sandbox.process.createSession(RUNTIME_ENVIRONMENT_PROCESS_SESSION);
      const launch = await sandbox.process.executeSessionCommand(
        RUNTIME_ENVIRONMENT_PROCESS_SESSION,
        {
          command: buildRuntimeEnvironmentLaunchCommand(process.env, layout),
          runAsync: true,
          suppressInputEcho: true,
        },
        30,
      );
      if ((launch.exitCode ?? 0) !== 0) {
        throw new Error("Provider runtime process failed to start");
      }

      const deadline = Date.now() + RUNTIME_READINESS_DEADLINE_MS;
      let ready = false;
      while (!signal.aborted && Date.now() < deadline) {
        ready = await runtimeEnvironmentHealthy(sandbox);
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, RUNTIME_READINESS_DELAY_MS));
      }
      if (signal.aborted) throw new Error("Provider runtime start aborted");
      if (!ready) {
        throw new Error("Provider runtime failed readiness");
      }
    }

    endReadiness?.(alreadyHealthy ? RUN_TIMING_OUTCOMES.ready : RUN_TIMING_OUTCOMES.repaired);
    return {
      sandboxId: sandbox.id,
      port: RUNTIME_ENVIRONMENT_PORT,
      home: `${layout.home}/.skynet/t3`,
      workdir: layout.workdir,
    };
  } catch (error) {
    endReadiness?.(signal.aborted ? RUN_TIMING_OUTCOMES.aborted : RUN_TIMING_OUTCOMES.failure);
    throw error;
  }
}

/** Serialize the resident T3 environment lifecycle per sandbox. Desktop, warm
 * pool, and the first run may all discover a cold Cube at the same time; only
 * one of them may replace the environment process. */
export async function ensureRuntimeEnvironment(
  sandbox: RuntimeEnvironmentSandbox,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<RuntimeEnvironment> {
  const key = sandbox.id || sandbox;
  const previous = environmentOperations.get(key);
  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed predecessor must not poison the sandbox's lifecycle queue.
    }
    return provisionRuntimeEnvironment(sandbox, signal, timing);
  })();
  environmentOperations.set(key, operation);
  try {
    return await operation;
  } finally {
    if (environmentOperations.get(key) === operation) {
      environmentOperations.delete(key);
    }
  }
}

/** Kill the resident T3 server process directly. It is launched setsid-detached,
 * so it is reparented to init and no longer appears in the cube session
 * manager's tracked process list; `deleteSession` therefore cannot reach it and
 * the readiness endpoint keeps answering. Match it by command line instead. The
 * `[t]3 serve` pattern deliberately does not match the shell running this
 * command. `pkill` ships in the T3 image; `ps` + `kill` is the fallback. SIGKILL
 * keeps the stop prompt and deterministic for a restart. */
async function killRuntimeServerProcess(sandbox: RuntimeEnvironmentSandbox): Promise<void> {
  const command = [
    "set +e",
    "if command -v pkill >/dev/null 2>&1; then pkill -KILL -f '([t]3 serve|[b]in.mjs serve --host 0.0.0.0 --port 37733)';" +
      " else for pid in $(ps -eo pid=,args= | awk '/[t]3 serve|[b]in.mjs serve --host 0.0.0.0 --port 37733/{print $1}');" +
      ' do kill -KILL "$pid"; done; fi',
    "true",
  ].join("\n");
  await sandbox.process.executeCommand(command, undefined, undefined, 10).catch(() => {});
}

/** Stop the resident T3 server and wait until it is confirmed down, so a
 * follow-up start binds a free port and boots against the current settings.json
 * instead of the readiness probe passing on the still-dying old process.
 * Bounded: throws an explicit error if the process never stops responding. */
async function stopRuntimeEnvironment(
  sandbox: RuntimeEnvironmentSandbox,
  signal: AbortSignal,
): Promise<void> {
  await deleteRuntimeEnvironmentSessionIfPresent(sandbox);
  await killRuntimeServerProcess(sandbox);
  const deadline = Date.now() + RUNTIME_STOP_DEADLINE_MS;
  while (!signal.aborted) {
    const probe = await sandbox.process.executeCommand(
      `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${RUNTIME_ENVIRONMENT_PORT}/api/auth/session`,
      undefined, undefined, 5,
    );
    if (probe.exitCode !== 0) return;
    if (Date.now() >= deadline) {
      throw new Error("Provider runtime did not stop for restart");
    }
    await new Promise((resolve) => setTimeout(resolve, RUNTIME_READINESS_DELAY_MS));
  }
  throw new Error("Provider runtime restart aborted");
}

/** Restart the resident T3 server for a sandbox: force it down, then bring it
 * back up through the ordinary provisioning path. Codex subscription runs need
 * this so T3 reads the per-run relay config (patched into settings.json) at boot
 * instead of racing its asynchronous settings-watch reconcile; otherwise the
 * turn binds to the pre-reconcile, relay-less codex instance and falls back to a
 * local, unauthenticated app-server. Idempotent (a cold environment simply
 * starts) and bounded (both the stop and readiness waits fail closed). */
export async function restartRuntimeEnvironment(
  sandbox: RuntimeEnvironmentSandbox,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<RuntimeEnvironment> {
  await stopRuntimeEnvironment(sandbox, signal);
  return ensureRuntimeEnvironment(sandbox, signal, timing);
}

export async function prewarmRuntimeEnvironment(
  sandbox: RuntimeEnvironmentSandbox,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>> = process.env,
  timing?: TimingRecorder,
): Promise<void> {
  if (!runtimeEnvironmentEnabled(env)) {
    const endReadiness = timing?.begin(RUN_TIMING_STAGES.runtimeReadiness);
    endReadiness?.(RUN_TIMING_OUTCOMES.disabled);
    return;
  }
  await ensureRuntimeEnvironment(sandbox, signal, timing);
}
