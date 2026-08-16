import type { SandboxHandle } from "../sandboxes/provider";
import {
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
  type RunStageTimer,
  type RunTimingOutcome,
} from "../runs/run-timing";
import { BROWSER_CDP_ENDPOINT, ensureResidentBrowserMcp, PLAYWRIGHT_MCP_VERSION } from "./browser-mcp";
import {
  buildDesktopLaunchCommand,
  buildDesktopReadinessCommand,
  DESKTOP_PORT,
  DESKTOP_REQUIRED_BINARIES,
  rfbProbeCommand,
  xfceSessionProbeCommand,
} from "./desktop-workstation";
import {
  desktopCdpRelayProbeCommand,
  ensureDesktopCdpRelayFiles,
  providerCdpRelayProbeCommand,
} from "./desktop-cdp-relay";

export {
  buildDesktopLaunchCommand,
  buildDesktopReadinessCommand,
  DESKTOP_PORT,
  DESKTOP_REQUIRED_BINARIES,
} from "./desktop-workstation";

const DESKTOP_PROCESS_SESSION = "skynet-desktop";
const BROWSER_MCP_PROCESS_SESSION = "skynet-browser-mcp";
const desktopViewOperations = new Map<string | SandboxHandle, Promise<SandboxDesktop>>();

type TimingRecorder = Pick<RunStageTimer, "begin">;

export interface SandboxDesktop {
  readonly available: boolean;
  readonly browserTools: boolean;
  readonly home: string;
  readonly workdir: string;
  readonly browserExecutable: string | null;
  readonly reason?: string;
}

async function localDesktopHealthy(sandbox: SandboxHandle): Promise<boolean> {
  try {
    const probe = await sandbox.process.executeCommand(
      buildDesktopReadinessCommand(),
      undefined,
      undefined,
      10,
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

async function deleteDesktopSessionIfPresent(
  sandbox: SandboxHandle,
  sessionId: string,
): Promise<void> {
  try {
    await sandbox.process.deleteSession(sessionId);
  } catch {
    // An absent or stale process session is already in the desired state.
  }
}

function desktopProvisioningFailure(): SandboxDesktop {
  return {
    available: false,
    browserTools: false,
    home: "/home/daytona",
    workdir: "/home/daytona/work",
    browserExecutable: null,
    reason: "desktop provisioning failed",
  };
}

async function provisionSandboxDesktopView(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<SandboxDesktop> {
  const endReadiness = timing?.begin(RUN_TIMING_STAGES.desktopReadiness);
  const finish = (outcome: RunTimingOutcome, result: SandboxDesktop): SandboxDesktop => {
    endReadiness?.(outcome);
    return result;
  };
  try {
    const probe = await sandbox.process.executeCommand(
      "mkdir -p ~/work ~/.skynet; browser=$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true); " +
        `missing=""; for bin in ${DESKTOP_REQUIRED_BINARIES.join(" ")}; do command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"; done; ` +
        `vnc=0; curl -fsS -m 3 -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html && vnc=1; ` +
        `rfb=0; ${rfbProbeCommand()} && rfb=1; ` +
        `cdp=0; curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version && cdp=1; ` +
        `cdp_relay=0; ${desktopCdpRelayProbeCommand()} && ${providerCdpRelayProbeCommand()} && cdp_relay=1; ` +
        `xfce=0; ${xfceSessionProbeCommand()} && xfce=1; ` +
        'mcp=0; [ -x "$HOME/.local/bin/playwright-mcp" ] && mcp=1; ' +
        'printf "HOME=%s\\nBROWSER=%s\\nMISSING=%s\\nVNC=%s\\nRFB=%s\\nCDP=%s\\nCDP_RELAY=%s\\nXFCE=%s\\nMCP=%s\\n" "$HOME" "$browser" "$missing" "$vnc" "$rfb" "$cdp" "$cdp_relay" "$xfce" "$mcp"',
      undefined,
      undefined,
      20,
    );
    const output = probe.result ?? "";
    const home = /^HOME=(.*)$/m.exec(output)?.[1]?.trim() || "/home/daytona";
    const workdir = `${home}/work`;
    await ensureDesktopCdpRelayFiles(sandbox, home);
    const browserExecutable = /^BROWSER=(.*)$/m.exec(output)?.[1]?.trim() || null;
    const missing = /^MISSING=(.*)$/m.exec(output)?.[1]?.trim() || "";
    const healthy =
      /^VNC=1$/m.test(output) &&
      /^RFB=1$/m.test(output) &&
      /^CDP=1$/m.test(output) &&
      /^CDP_RELAY=1$/m.test(output) &&
      /^XFCE=1$/m.test(output);
    const browserTools = /^MCP=1$/m.test(output);
    if ((probe.exitCode ?? 1) !== 0 || missing) {
      return finish(RUN_TIMING_OUTCOMES.unavailable, {
        available: false,
        browserTools: false,
        home,
        workdir,
        browserExecutable,
        reason: missing ? `missing desktop binaries:${missing}` : "desktop prerequisite probe failed",
      });
    }
    if (!browserExecutable) {
      return finish(RUN_TIMING_OUTCOMES.unavailable, {
        available: false,
        browserTools: false,
        home,
        workdir,
        browserExecutable,
        reason: "no supported browser executable",
      });
    }

    const requiredRepair = !healthy;
    if (!healthy) {
      // The resident MCP may still hold a CDP connection to the browser we are
      // about to replace. Stop it first so the next engine turn receives one
      // clean MCP generation attached to the new Chrome process.
      await deleteDesktopSessionIfPresent(sandbox, BROWSER_MCP_PROCESS_SESSION);
      await deleteDesktopSessionIfPresent(sandbox, DESKTOP_PROCESS_SESSION);
      await sandbox.process.createSession(DESKTOP_PROCESS_SESSION);
      await sandbox.process.executeSessionCommand(
        DESKTOP_PROCESS_SESSION,
        {
          command: buildDesktopLaunchCommand(),
          runAsync: true,
          suppressInputEcho: true,
        },
        30,
      );
    }

    let available = healthy;
    if (!available) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !signal.aborted) {
        available = await localDesktopHealthy(sandbox);
        if (available) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    available = !signal.aborted && available;
    if (!available) {
      return finish(signal.aborted ? RUN_TIMING_OUTCOMES.aborted : RUN_TIMING_OUTCOMES.unavailable, {
        available,
        browserTools: false,
        home,
        workdir,
        browserExecutable,
        reason: signal.aborted
          ? "run aborted while starting desktop"
          : "noVNC, RFB, XFCE, or browser CDP failed readiness",
      });
    }

    return finish(requiredRepair ? RUN_TIMING_OUTCOMES.repaired : RUN_TIMING_OUTCOMES.ready, {
      available: true,
      browserTools,
      home,
      workdir,
      browserExecutable,
    });
  } catch (error) {
    endReadiness?.(signal.aborted ? RUN_TIMING_OUTCOMES.aborted : RUN_TIMING_OUTCOMES.failure);
    throw error;
  }
}

/** The engine and the Desktop iframe can discover the same cold sandbox at the
 * same time. Serialize only the view lifecycle repair per sandbox: without this,
 * two callers can both delete/recreate `skynet-desktop`, and the second repair
 * kills Chrome underneath the first caller's already-running MCP tool. Browser
 * MCP installation stays outside this lock so opening Desktop never waits for
 * an unrelated npm install on genuinely old snapshots. */
async function serializedDesktopView(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<SandboxDesktop> {
  const key = sandbox.id || sandbox;
  const previous = desktopViewOperations.get(key);
  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed repair must not poison the per-sandbox queue. The next caller
      // gets one independent opportunity to reconcile the desktop lifecycle.
    }
    return provisionSandboxDesktopView(sandbox, signal, timing);
  })();
  desktopViewOperations.set(key, operation);
  try {
    return await operation;
  } finally {
    if (desktopViewOperations.get(key) === operation) {
      desktopViewOperations.delete(key);
    }
  }
}

async function provisionSandboxDesktop(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<SandboxDesktop> {
  const desktop = await serializedDesktopView(sandbox, signal, timing);
  if (!desktop.available || !desktop.browserExecutable) return desktop;
  let installed = desktop.browserTools;
  const endMcpReadiness = timing?.begin(RUN_TIMING_STAGES.desktopMcpReadiness);
  try {
    if (!installed) {
      const install = await sandbox.process.executeCommand(
        `export PATH="$HOME/.local/bin:$PATH"; ` +
          `[ -x "$HOME/.local/bin/playwright-mcp" ] || ` +
          `npm install -g --prefix "$HOME/.local" --silent "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" >/dev/null 2>&1; ` +
          `[ -x "$HOME/.local/bin/playwright-mcp" ]`,
        undefined,
        undefined,
        300,
      );
      installed = install.exitCode === 0;
    }
    const browserTools =
      installed && (await ensureResidentBrowserMcp(sandbox, desktop.workdir, signal));
    endMcpReadiness?.(
      browserTools ? RUN_TIMING_OUTCOMES.ready : RUN_TIMING_OUTCOMES.unavailable,
    );
    return {
      ...desktop,
      browserTools,
      ...(!browserTools
        ? {
            reason: installed
              ? "resident browser MCP failed readiness"
              : "Playwright MCP installation failed",
          }
        : {}),
    };
  } catch (error) {
    endMcpReadiness?.(
      signal.aborted ? RUN_TIMING_OUTCOMES.aborted : RUN_TIMING_OUTCOMES.failure,
    );
    throw error;
  }
}

/** Make only the user-visible noVNC surface ready. This intentionally skips the
 * Playwright MCP installation: opening Desktop must never wait on an agent-tool
 * dependency that the iframe does not use. */
export async function ensureSandboxDesktopView(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<SandboxDesktop> {
  try {
    return await serializedDesktopView(sandbox, signal, timing);
  } catch {
    return desktopProvisioningFailure();
  }
}

/** Provision a truthful desktop resource in any engine sandbox. Failure is a
 * capability degradation, not a coding-run failure: callers advertise
 * `desktop:false` and continue the agent turn. */
export async function ensureSandboxDesktop(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  timing?: TimingRecorder,
): Promise<SandboxDesktop> {
  try {
    return await provisionSandboxDesktop(sandbox, signal, timing);
  } catch {
    return desktopProvisioningFailure();
  }
}
