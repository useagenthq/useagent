import type { SandboxHandle } from "../sandboxes/provider";
import {
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
  type RunStageTimer,
} from "../runs/run-timing";

export const T3_ENVIRONMENT_PORT = 37_733;
export const T3_RUNTIME_GENERATION_LABEL = "skynet.runtime";
export const T3_RUNTIME_GENERATION = "t3-v3";
export const T3_CUBE_WARM_POOL_NAME = T3_RUNTIME_GENERATION;
const T3_ENVIRONMENT_PROCESS_SESSION = "skynet-t3-environment";
export const T3_ENVIRONMENT_HOME = "$HOME/.skynet/t3";
export const T3_ENVIRONMENT_WORKDIR = "$HOME/work";
const T3_READINESS_DEADLINE_MS = 60_000;
const T3_READINESS_DELAY_MS = 100;
const T3_STOP_DEADLINE_MS = 15_000;
const DEFAULT_T3_FIRST_ACTIVITY_TIMEOUT_MS = 45_000;
const DEFAULT_T3_NO_PROGRESS_TIMEOUT_MS = 120_000;
type TimingRecorder = Pick<RunStageTimer, "begin">;
type T3EnvironmentSandbox = Pick<SandboxHandle, "id"> & {
  readonly process: Pick<
    SandboxHandle["process"],
    "createSession" | "deleteSession" | "executeCommand" | "executeSessionCommand"
  >;
};

export interface T3EnvironmentRuntime {
  readonly sandboxId: string;
  readonly port: number;
  readonly home: string;
  readonly workdir: string;
}

const environmentOperations = new Map<string | T3EnvironmentSandbox, Promise<T3EnvironmentRuntime>>();

export function t3EnvironmentEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.T3_ENVIRONMENT_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function buildT3EnvironmentReadinessCommand(): string {
  return `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${T3_ENVIRONMENT_PORT}/api/auth/session`;
}

export function t3FirstActivityTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(env.T3_FIRST_ACTIVITY_TIMEOUT_MS?.trim());
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_T3_FIRST_ACTIVITY_TIMEOUT_MS;
}

export function t3NoProgressTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(env.T3_NO_PROGRESS_TIMEOUT_MS?.trim());
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_T3_NO_PROGRESS_TIMEOUT_MS;
}

export function buildT3EnvironmentLaunchCommand(): string {
  return [
    "set -eu",
    `export T3CODE_HOME="${T3_ENVIRONMENT_HOME}"`,
    "export T3CODE_MODE=web",
    "export T3CODE_HOST=0.0.0.0",
    `export T3CODE_PORT=${T3_ENVIRONMENT_PORT}`,
    "export T3_CODEX_REQUIRED_MCP_SERVERS=skynet-knowledge",
    "export T3CODE_NO_BROWSER=true",
    "export T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false",
    "export T3CODE_LOG_WS_EVENTS=false",
    `mkdir -p "${T3_ENVIRONMENT_HOME}" "${T3_ENVIRONMENT_WORKDIR}"`,
    // Org secrets are deliberately NOT sourced into the T3 process environment:
    // the codex provider adapter composes child/session environments from the
    // T3 process env, and foreign variables there broke the codex subscription
    // dial (proven by the 2026-08-18 release-gate failure). Tool shells receive
    // secrets through rc-file hooks installed by materializeSecretFiles.
    `exec t3 serve --host 0.0.0.0 --port ${T3_ENVIRONMENT_PORT} --base-dir "$T3CODE_HOME" --no-browser "${T3_ENVIRONMENT_WORKDIR}"`,
  ].join("\n");
}

async function t3EnvironmentHealthy(sandbox: T3EnvironmentSandbox): Promise<boolean> {
  try {
    const probe = await sandbox.process.executeCommand(
      buildT3EnvironmentReadinessCommand(),
      undefined,
      undefined,
      5,
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

async function deleteT3EnvironmentSessionIfPresent(sandbox: T3EnvironmentSandbox): Promise<void> {
  try {
    await sandbox.process.deleteSession(T3_ENVIRONMENT_PROCESS_SESSION);
  } catch {
    // An absent or stale process session is already in the desired state.
  }
}

async function provisionT3Environment(
  sandbox: T3EnvironmentSandbox,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<T3EnvironmentRuntime> {
  const endReadiness = timing?.begin(RUN_TIMING_STAGES.runtimeReadiness);
  try {
    if (signal.aborted) throw new Error("T3 environment start aborted");
    const alreadyHealthy = await t3EnvironmentHealthy(sandbox);
    if (!alreadyHealthy) {
      await deleteT3EnvironmentSessionIfPresent(sandbox);
      await sandbox.process.createSession(T3_ENVIRONMENT_PROCESS_SESSION);
      const launch = await sandbox.process.executeSessionCommand(
        T3_ENVIRONMENT_PROCESS_SESSION,
        {
          command: buildT3EnvironmentLaunchCommand(),
          runAsync: true,
          suppressInputEcho: true,
        },
        30,
      );
      if ((launch.exitCode ?? 0) !== 0) {
        throw new Error("T3 environment process failed to start");
      }

      const deadline = Date.now() + T3_READINESS_DEADLINE_MS;
      let ready = false;
      while (!signal.aborted && Date.now() < deadline) {
        ready = await t3EnvironmentHealthy(sandbox);
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, T3_READINESS_DELAY_MS));
      }
      if (signal.aborted) throw new Error("T3 environment start aborted");
      if (!ready) {
        throw new Error("T3 environment failed readiness");
      }
    }

    endReadiness?.(alreadyHealthy ? RUN_TIMING_OUTCOMES.ready : RUN_TIMING_OUTCOMES.repaired);
    return {
      sandboxId: sandbox.id,
      port: T3_ENVIRONMENT_PORT,
      home: T3_ENVIRONMENT_HOME,
      workdir: T3_ENVIRONMENT_WORKDIR,
    };
  } catch (error) {
    endReadiness?.(signal.aborted ? RUN_TIMING_OUTCOMES.aborted : RUN_TIMING_OUTCOMES.failure);
    throw error;
  }
}

/** Serialize the resident T3 environment lifecycle per sandbox. Desktop, warm
 * pool, and the first run may all discover a cold Cube at the same time; only
 * one of them may replace the environment process. */
export async function ensureT3Environment(
  sandbox: T3EnvironmentSandbox,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<T3EnvironmentRuntime> {
  const key = sandbox.id || sandbox;
  const previous = environmentOperations.get(key);
  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed predecessor must not poison the sandbox's lifecycle queue.
    }
    return provisionT3Environment(sandbox, signal, timing);
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
async function killT3ServerProcess(sandbox: T3EnvironmentSandbox): Promise<void> {
  const command = [
    "set +e",
    "if command -v pkill >/dev/null 2>&1; then pkill -KILL -f '[t]3 serve';" +
      " else for pid in $(ps -eo pid=,args= | awk '/[t]3 serve/{print $1}');" +
      ' do kill -KILL "$pid"; done; fi',
    "true",
  ].join("\n");
  await sandbox.process.executeCommand(command, undefined, undefined, 10).catch(() => {});
}

/** Stop the resident T3 server and wait until it is confirmed down, so a
 * follow-up start binds a free port and boots against the current settings.json
 * instead of the readiness probe passing on the still-dying old process.
 * Bounded: throws an explicit error if the process never stops responding. */
async function stopT3Environment(
  sandbox: T3EnvironmentSandbox,
  signal: AbortSignal,
): Promise<void> {
  await deleteT3EnvironmentSessionIfPresent(sandbox);
  await killT3ServerProcess(sandbox);
  const deadline = Date.now() + T3_STOP_DEADLINE_MS;
  while (!signal.aborted) {
    if (!(await t3EnvironmentHealthy(sandbox))) return;
    if (Date.now() >= deadline) {
      throw new Error("T3 environment did not stop for restart");
    }
    await new Promise((resolve) => setTimeout(resolve, T3_READINESS_DELAY_MS));
  }
  throw new Error("T3 environment restart aborted");
}

/** Restart the resident T3 server for a sandbox: force it down, then bring it
 * back up through the ordinary provisioning path. Codex subscription runs need
 * this so T3 reads the per-run relay config (patched into settings.json) at boot
 * instead of racing its asynchronous settings-watch reconcile; otherwise the
 * turn binds to the pre-reconcile, relay-less codex instance and falls back to a
 * local, unauthenticated app-server. Idempotent (a cold environment simply
 * starts) and bounded (both the stop and readiness waits fail closed). */
export async function restartT3Environment(
  sandbox: T3EnvironmentSandbox,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<T3EnvironmentRuntime> {
  await stopT3Environment(sandbox, signal);
  return ensureT3Environment(sandbox, signal, timing);
}

export async function prewarmT3Environment(
  sandbox: T3EnvironmentSandbox,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>> = process.env,
  timing?: TimingRecorder,
): Promise<void> {
  if (!t3EnvironmentEnabled(env)) {
    const endReadiness = timing?.begin(RUN_TIMING_STAGES.runtimeReadiness);
    endReadiness?.(RUN_TIMING_OUTCOMES.disabled);
    return;
  }
  await ensureT3Environment(sandbox, signal, timing);
}
