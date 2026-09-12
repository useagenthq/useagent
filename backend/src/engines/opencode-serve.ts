import { type PreviewLinkBase, type SandboxHandle, previewLinkBase } from "../sandboxes/provider";
import type { OpenCodeRuntimeServer } from "./opencode-runtime-config";
import type { OpenCodeThreadServer } from "./opencode-runtime";
import type { EngineRunContext } from "./types";
import { shq } from "./repo-prep";
import { truncate } from "./util";
import { nextPollDelayMs } from "../util/startup";
import { errorMessage } from "../util/error-message";
import {
  SECRET_DOTENV_PATH,
  sandboxSecretMode,
  sandboxSecretSourceCommand,
} from "../secrets/inject";

// ---------------------------------------------------------------------------
// The resident `opencode serve` process inside a thread's sandbox: which
// launcher to use, how to (re)start it, and how to tell it is alive. The
// adapter in opencode-server.ts owns the turn; this module owns the process.
// ---------------------------------------------------------------------------

export const SERVE_PORT = 4096;
export const OPENCODE_VERSION = "1.18.7";
export const SERVER_PROCESS_SESSION = "skynet-opencode-serve";
const LAUNCHER_PROBE_SECONDS = 8;

export interface OpencodeLauncher {
  /** Boot through `npx opencode-ai@<pinned>` instead of the sandbox's own `opencode`. */
  readonly npx: boolean;
  /** Why the npx path was taken; null when the preinstalled binary is used. */
  readonly reason: string | null;
}

/**
 * Whether the sandbox's preinstalled `opencode` actually runs. Box's base image
 * ships a launcher shim whose fallback points back at itself, so `opencode serve`
 * never listens and the run used to die at the readiness deadline. A binary that
 * cannot answer `--version` within a few seconds is treated as unusable and the
 * pinned npx bootstrap (proven on Box) is used instead.
 */
export async function probeOpencodeLauncher(
  sandbox: Pick<SandboxHandle, "process">,
): Promise<OpencodeLauncher> {
  let result: { readonly result?: string; readonly exitCode?: number };
  try {
    result = await sandbox.process.executeCommand(
      `export PATH=$HOME/.local/bin:$PATH; ` +
        `if ! command -v opencode >/dev/null 2>&1; then echo MISSING; exit 0; fi; ` +
        `bound=""; command -v timeout >/dev/null 2>&1 && bound="timeout ${LAUNCHER_PROBE_SECONDS}"; ` +
        `if $bound opencode --version >/dev/null 2>&1; then echo OK; else echo HUNG; fi`,
      undefined,
      undefined,
      LAUNCHER_PROBE_SECONDS + 10,
    );
  } catch (error) {
    return { npx: true, reason: `the preinstalled opencode could not be probed (${errorMessage(error)})` };
  }
  const verdict = (result.result ?? "").trim().split(/\s+/).at(-1);
  if (verdict === "OK") return { npx: false, reason: null };
  return {
    npx: true,
    reason: verdict === "MISSING"
      ? "no opencode binary is installed in this sandbox"
      : `the preinstalled opencode does not answer --version within ${LAUNCHER_PROBE_SECONDS}s (a broken launcher shim)`,
  };
}

/**
 * One launcher decision per turn, made lazily so a warm turn that never starts
 * a process pays nothing. A sandbox started from the provider's base image skips
 * the probe; otherwise the probe runs once and the timeline says when the npx
 * bootstrap is taken and why.
 */
export function opencodeLauncherFor(
  sandbox: Pick<SandboxHandle, "process">,
  ctx: Pick<EngineRunContext, "emit">,
  options: { readonly baseImage: boolean },
): () => Promise<OpencodeLauncher> {
  let decided: Promise<OpencodeLauncher> | null = null;
  return () =>
    (decided ??= (async () => {
      const launcher: OpencodeLauncher = options.baseImage
        ? { npx: true, reason: "the sandbox started from the provider's base image" }
        : await probeOpencodeLauncher(sandbox);
      if (launcher.npx) {
        await ctx.emit({
          kind: "task",
          label: `Bootstrapping opencode-ai@${OPENCODE_VERSION} with npx: ${launcher.reason}`,
          chip: "warning",
        });
      }
      return launcher;
    })());
}

export async function opencodeHealthStatus(
  server: PreviewLinkBase,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetch(`${server.baseUrl}/global/health`, {
      headers: { ...server.headers },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    return status;
  } catch {
    return null;
  }
}

function isHealthy(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

export async function reuseHealthyResidentServer(
  cached: OpenCodeThreadServer | null,
  sandboxId: string,
  signal: AbortSignal,
): Promise<OpenCodeRuntimeServer | null> {
  if (!cached || cached.sandboxId !== sandboxId) return null;
  return isHealthy(await opencodeHealthStatus(cached, signal)) ? cached : null;
}

/** Stop the resident process and prove its preview endpoint is no longer serving
 * before a restart. Swallowing delete errors can otherwise let ensureServer
 * observe the old healthy process and dispatch with stale config or secrets. */
export async function stopServerForConfigReload(
  sandbox: SandboxHandle,
  server: OpenCodeRuntimeServer,
  signal: AbortSignal,
): Promise<void> {
  let deletionFailed = false;
  try {
    await sandbox.process.deleteSession(SERVER_PROCESS_SESSION);
  } catch {
    deletionFailed = true;
  }
  const deadline = Date.now() + 10_000;
  do {
    if (!isHealthy(await opencodeHealthStatus(server, signal))) return;
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  } while (!signal.aborted && Date.now() < deadline);
  throw new Error(
    deletionFailed
      ? "OpenCode config fallback could not stop the resident server"
      : "OpenCode resident server remained healthy after stop",
  );
}

/** Boot (or confirm) `opencode serve` inside the sandbox and resolve its
 *  preview endpoint + the sandbox user's workdir. Idempotent per sandbox.
 *
 *  Startup and readiness are deliberately separate operations. Keeping a shell
 *  probe loop inside one Daytona command lets repeated slow probes consume the
 *  daemon's entire execution timeout and yields an opaque 408. The backend can
 *  instead poll OpenCode's real health endpoint through the same preview link
 *  used for the session, with one bounded fetch per attempt.
 *
 *  A healthy resident process survives turns and is reused, EXCEPT when the
 *  caller asks for a restart: the process sources the org secret dotenv only at
 *  launch, so a secret added after it started never reaches it until it is
 *  relaunched (the audit's warm-thread secret gap). */
export async function ensureServer(
  sandbox: SandboxHandle,
  launcher: () => Promise<OpencodeLauncher>,
  signal: AbortSignal,
  secretSourceCommand = sandboxSecretSourceCommand(),
  options: { readonly restart?: boolean } = {},
): Promise<OpenCodeRuntimeServer> {
  const homeResult = await sandbox.process.executeCommand(
    'mkdir -p ~/work && printf %s "$HOME"',
    undefined,
    undefined,
    15,
  );
  if ((homeResult.exitCode ?? 1) !== 0) throw new Error("opencode workspace preparation failed");
  const home = homeResult.result?.trim() || "/home/daytona";
  const server = { ...previewLinkBase(await sandbox.getPreviewLink(SERVE_PORT)), workdir: `${home}/work` };

  // The liveness probe already proves a resident process is serving, so return
  // immediately and skip the readiness poll's redundant first probe. Only when
  // the sandbox was stopped/restarted (probe not 2xx), or the caller needs a
  // fresh environment, do we recreate the dedicated background session:
  // executeCommand is synchronous even with shell `&`, whereas an async session
  // command is the provider's supported long-lived-process primitive.
  const healthy = isHealthy(await opencodeHealthStatus(server, signal));
  if (healthy && !options.restart) return server;
  if (healthy) await stopServerForConfigReload(sandbox, server, signal);
  const { npx } = await launcher();
  const bin = npx ? `npx -y opencode-ai@${OPENCODE_VERSION}` : "opencode";
  await sandbox.process.deleteSession(SERVER_PROCESS_SESSION).catch(() => {});
  await sandbox.process.createSession(SERVER_PROCESS_SESSION);
  await sandbox.process.executeSessionCommand(
    SERVER_PROCESS_SESSION,
    {
      command: `${secretSourceCommand} && cd ${shq(`${home}/work`)} && exec ${bin} serve --hostname 0.0.0.0 --port ${SERVE_PORT}`,
      runAsync: true,
      suppressInputEcho: true,
    },
    30,
  );

  const deadline = Date.now() + 120_000;
  let lastStatus: number | null = null;
  // Bounded exponential polling: a server that is ready in 200ms is seen in
  // ~200ms instead of at the next full-second tick; the overall deadline is
  // unchanged.
  let pollDelay: number | null = null;
  while (Date.now() < deadline && !signal.aborted) {
    lastStatus = await opencodeHealthStatus(server, signal);
    if (isHealthy(lastStatus)) return server;
    const delay = nextPollDelayMs(pollDelay);
    pollDelay = delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (signal.aborted) throw new Error("opencode run aborted (timeout)");
  let logs: { output?: string; stderr?: string; stdout?: string } | null = null;
  try {
    const session = await sandbox.process.getSession(SERVER_PROCESS_SESSION);
    const command = session.commands.at(-1);
    if (command?.id) {
      logs = await sandbox.process.getSessionCommandLogs(SERVER_PROCESS_SESSION, command.id);
    }
  } catch {
    // Readiness already failed. Logs are diagnostic only and must not mask the
    // stable, redacted error below.
  }
  const safeTail = (logs?.output ?? logs?.stderr ?? logs?.stdout ?? "")
    .replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<capability>")
    .trim();
  throw new Error(
    `opencode serve failed readiness${lastStatus ? ` (HTTP ${lastStatus})` : ""}: ${
      safeTail ? truncate(safeTail, 200) : "the runtime never listened (empty session log)"
    }`,
  );
}

/** Prime a newly created warm-pool sandbox's OpenCode executable and preview
 * route without retaining a process that predates run-scoped secret
 * materialization. The real turn still starts a clean server after writing its
 * 0600 dotenv. */
export async function prewarmOpenCodeRuntime(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  const mode = sandboxSecretMode();
  const secretFile = mode === "compatibility"
    ? SECRET_DOTENV_PATH.startsWith("$HOME/")
      ? `"$HOME/${SECRET_DOTENV_PATH.slice("$HOME/".length)}"`
      : shq(SECRET_DOTENV_PATH)
    : null;
  const prepared = await sandbox.process.executeCommand(
    secretFile
      ? `mkdir -p "$(dirname ${secretFile})" "$HOME/work" && ` +
        `chmod 700 "$(dirname ${secretFile})" && ` +
        `touch ${secretFile} && chmod 600 ${secretFile}`
      : `mkdir -p "$HOME/work"`,
    undefined,
    undefined,
    15,
  );
  if ((prepared.exitCode ?? 1) !== 0) {
    throw new Error("OpenCode prewarm workspace preparation failed");
  }
  try {
    await ensureServer(sandbox, () => probeOpencodeLauncher(sandbox), signal, sandboxSecretSourceCommand(mode));
  } finally {
    await sandbox.process.deleteSession(SERVER_PROCESS_SESSION).catch(() => {});
  }
}
