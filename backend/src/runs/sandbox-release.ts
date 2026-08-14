import { sandboxProvider, type SandboxProvider } from "../sandboxes/provider";
import { forgetAcpThreadRelays } from "../engines/acp-server";
import { forgetOpenCodeThreadServer } from "../engines/opencode-runtime";
import { forgetLiveThreadSandbox } from "../engines/sandbox-runtime";
import {
  clearThreadSandbox,
  getRunForOrg,
  getThreadSandboxForOrg,
  threadHasActiveRuns,
} from "./repo";
import { withThreadLifecycleLock } from "./thread-lifecycle-lock";

export type SandboxReleaseResult =
  | { ok: true; released: false; reason: "no_sandbox" }
  | { ok: true; released: true; sandboxId: string }
  | { ok: false; reason: "not_found" | "thread_active" | "provider_error" };

interface SandboxReleaseDeps {
  readonly provider?: SandboxProvider;
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

    const provider = deps.provider ?? sandboxProvider();
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
    };
  });

  if (released.ok && released.released) {
    forgetLiveThreadSandbox(released.threadId, released.sandboxId);
    forgetOpenCodeThreadServer(released.threadId);
    forgetAcpThreadRelays(released.threadId);
    return { ok: true, released: true, sandboxId: released.sandboxId };
  }
  return released;
}
