import { type SandboxProvider } from "../sandboxes/provider";
import { forgetLiveThreadSandbox } from "../engines/sandbox-runtime";
import { piBridgeManager } from "../engines/pi-rpc-bridge";
import {
  clearThreadSandbox,
  getRunForOrg,
  getThreadSandboxForOrg,
  threadHasActiveRuns,
} from "./repo";
import { withThreadLifecycleLock } from "./thread-lifecycle-lock";
import { parseProviderSessionBinding } from "@useagent/agent-harness/canonical";
import {
  PersonalSandboxConnectionUnavailableError,
  resolveSandboxBindingForSandbox,
} from "../sandboxes/binding";

export type SandboxReleaseResult =
  | { ok: true; released: false; reason: "no_sandbox" }
  | { ok: true; released: false; reason: "connection_revoked"; sandboxId: string }
  | { ok: true; released: true; sandboxId: string }
  | { ok: false; reason: "not_found" | "thread_active" | "provider_error" };

interface SandboxReleaseDeps {
  readonly provider?: SandboxProvider;
  readonly removePiBridge?: (sessionFile: string) => Promise<void>;
}

/**
 * Explicitly release a settled thread's sandbox.
 *
 * Normal product threads stay warm for fast resume. Test/eval callers use this
 * endpoint when they are done, avoiding a fleet leak without weakening normal
 * retention. The durable mapping is cleared only after provider deletion (or an
 * authoritative provider listing proves the sandbox is already absent).
 */
export async function releaseRunSandbox(
  orgId: string,
  runId: string,
  deps: SandboxReleaseDeps = {},
): Promise<SandboxReleaseResult> {
  const run = await getRunForOrg(orgId, runId);
  if (!run) return { ok: false, reason: "not_found" };

  const released = await withThreadLifecycleLock(orgId, run.threadId, async (tx) => {
    const lockedRun = await getRunForOrg(orgId, runId, tx);
    if (!lockedRun) return { ok: false as const, reason: "not_found" as const };
    if (await threadHasActiveRuns(orgId, lockedRun.threadId, tx)) {
      return { ok: false as const, reason: "thread_active" as const };
    }
    const sandboxId = await getThreadSandboxForOrg(orgId, lockedRun.threadId, tx);
    if (!sandboxId) return { ok: true as const, released: false as const, reason: "no_sandbox" as const };

    let provider: SandboxProvider;
    try {
      provider = deps.provider ?? (await resolveSandboxBindingForSandbox(sandboxId)).provider;
    } catch (error) {
      if (!(error instanceof PersonalSandboxConnectionUnavailableError)) {
        return { ok: false as const, reason: "provider_error" as const };
      }
      // The personal connection that created it is gone: nothing can delete it, but the
      // thread must not stay pinned to an unreachable sandbox.
      const cleared = await clearThreadSandbox(orgId, lockedRun.threadId, sandboxId, tx);
      if (cleared === 0) return { ok: false as const, reason: "provider_error" as const };
      return { ok: true as const, released: false as const, reason: "connection_revoked" as const, sandboxId };
    }
    try {
      const sandbox = await provider.get(sandboxId);
      await sandbox.delete();
    } catch {
      const live = new Set<string>();
      try {
        for await (const sandbox of provider.list()) live.add(sandbox.id);
      } catch {
        return { ok: false as const, reason: "provider_error" as const };
      }
      if (live.has(sandboxId)) return { ok: false as const, reason: "provider_error" as const };
    }

    const cleared = await clearThreadSandbox(orgId, lockedRun.threadId, sandboxId, tx);
    if (cleared === 0) return { ok: false as const, reason: "provider_error" as const };
    return {
      ok: true as const,
      released: true as const,
      sandboxId,
      threadId: lockedRun.threadId,
      engine: lockedRun.engine,
      engineSessionId: lockedRun.engineSessionId,
      providerSession: lockedRun.providerSession,
    };
  });

  if (released.ok && released.released) {
    forgetLiveThreadSandbox(released.threadId, released.sandboxId);
    const binding = parseProviderSessionBinding(released.providerSession);
    const piSessionId = binding?.provider === "pi"
      ? binding.nativeSessionId
      : released.engine === "pi"
        ? released.engineSessionId
        : null;
    if (piSessionId) {
      const removePiBridge = deps.removePiBridge ?? ((sessionFile: string) =>
        piBridgeManager.remove(sessionFile));
      await removePiBridge(piSessionId).catch((error) => {
        console.warn("[sandbox-release] failed to remove Pi bridge", {
          runId,
          error: error instanceof Error ? error.message : "unknown error",
        });
      });
    }
    return { ok: true, released: true, sandboxId: released.sandboxId };
  }
  return released;
}
