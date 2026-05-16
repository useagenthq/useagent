import { getThreadSandbox, setRunSandbox } from "../runs/repo";
import {
  sandboxProvider,
  sandboxProviderApiKey,
  sandboxProviderKind,
  type SandboxHandle,
} from "../sandboxes/provider";
import { claimCubeWarmSandbox } from "../sandboxes/cube-warm-pool";
import {
  providerGatewaySandboxIsCurrent,
  providerGatewaySandboxLabels,
} from "../provider-gateway/sandbox-config";
import { persistSandboxBeforeExecution } from "./util";
import type { EngineRunContext } from "./types";
import {
  forgetLiveThreadSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "./sandbox-runtime";
import {
  assertSandboxResources,
  resolveSandboxResourceTarget,
  sandboxMeetsResourceTarget,
} from "./daytona-resources";

export interface ThreadSandboxLease {
  readonly sandbox: SandboxHandle;
  readonly reused: boolean;
  readonly retained: boolean;
  readonly releaseAfterRun: boolean;
}

export interface ThreadSandboxOptions {
  readonly snapshot: string;
  readonly chip: string;
  readonly warmPool?: string | false;
  readonly labels?: Readonly<Record<string, string>>;
  readonly requiredLabels?: Readonly<Record<string, string>>;
}

function hasRequiredLabels(
  sandbox: SandboxHandle,
  required: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!required) return true;
  return Object.entries(required).every(([name, value]) => sandbox.labels?.[name] === value);
}

async function resolveRetainedSandbox(
  ctx: EngineRunContext,
  options: ThreadSandboxOptions,
): Promise<SandboxHandle | null> {
  if (!ctx.threadId) return null;
  const sandboxId = await getThreadSandbox(ctx.threadId);
  if (!sandboxId) return null;
  try {
    const cached = getLiveThreadSandbox(ctx.threadId);
    const provider = sandboxProvider(sandboxProviderApiKey());
    const sandbox = cached?.id === sandboxId ? cached : await provider.get(sandboxId);
    const state = (sandbox as { state?: string }).state;
    if (state === "stopped" || state === "paused" || state === "archived") {
      await sandbox.start();
    } else if (state !== "started") {
      throw new Error("retained sandbox is not startable");
    }
    if (!(await providerGatewaySandboxIsCurrent(sandbox))) {
      await sandbox.delete().catch(() => {});
      throw new Error("retained sandbox uses an obsolete credential generation");
    }
    if (!hasRequiredLabels(sandbox, options.requiredLabels)) {
      await sandbox.delete().catch(() => {});
      throw new Error("retained sandbox does not match the requested runtime generation");
    }
    return sandbox;
  } catch {
    forgetLiveThreadSandbox(ctx.threadId, sandboxId);
    return null;
  }
}

export async function acquireThreadSandbox(
  ctx: EngineRunContext,
  options: ThreadSandboxOptions,
): Promise<ThreadSandboxLease> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) throw new Error("sandbox provider credentials are unavailable");
  const provider = sandboxProvider(apiKey);
  const resourceTarget = resolveSandboxResourceTarget();
  let sandbox = await resolveRetainedSandbox(ctx, options);
  let reused = sandbox !== null;

  if (sandbox && !sandboxMeetsResourceTarget(sandbox, resourceTarget)) {
    const staleId = sandbox.id;
    await sandbox.delete().catch(() => {});
    if (ctx.threadId) forgetLiveThreadSandbox(ctx.threadId, staleId);
    sandbox = null;
    reused = false;
  }

  if (!sandbox) {
    await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: options.chip });
    if (sandboxProviderKind() === "cube" && options.warmPool !== false) {
      sandbox = await claimCubeWarmSandbox(options.warmPool || undefined);
      reused = sandbox !== null;
    }
    if (!sandbox) {
      sandbox = await provider.create({
        snapshot: options.snapshot,
        labels: {
          ...providerGatewaySandboxLabels(ctx.runId),
          ...options.labels,
        },
        autoStopInterval: Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30),
        autoDeleteInterval: Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320),
      });
    }
  }

  assertSandboxResources(sandbox, resourceTarget);
  await persistSandboxBeforeExecution({
    runId: ctx.runId,
    sandboxId: sandbox.id,
    reused,
    persist: setRunSandbox,
    deleteFreshSandbox: () => sandbox.delete(),
  });
  if (ctx.threadId) rememberLiveThreadSandbox(ctx.threadId, sandbox);
  return {
    sandbox,
    reused,
    retained: Boolean(ctx.threadId),
    releaseAfterRun: !ctx.threadId,
  };
}
