import { getThreadSandbox, setRunSandbox } from "../runs/repo";
import { type SandboxHandle } from "../sandboxes/provider";
import { claimCubeWarmSandbox } from "../sandboxes/cube-warm-pool";
import {
  providerGatewaySandboxIsCurrent,
  providerGatewaySandboxLabels,
} from "../provider-gateway/sandbox-config";
import { RUN_TIMING_OUTCOMES, RUN_TIMING_STAGES } from "../runs/run-timing";
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
import { bindingRecord, resolveSandboxBindingForRun, resolveSandboxBindingForSandbox, resolveSandboxBindingForThread, type SandboxBinding } from "../sandboxes/binding";

export interface ThreadSandboxLease {
  readonly sandbox: SandboxHandle;
  readonly binding: SandboxBinding;
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

export function sandboxHasRequiredLabels(
  sandbox: Pick<SandboxHandle, "labels">,
  required: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!required) return true;
  return Object.entries(required).every(([name, value]) => sandbox.labels?.[name] === value);
}

/**
 * Re-attach to a thread's retained sandbox: resolve the binding that created it
 * (a user's computer or the deployment's provider), wake it if it was stopped,
 * and refuse one whose credential generation is obsolete. Throws when the
 * sandbox cannot be reused; callers then provision fresh. Shared by every
 * engine so the reuse rules exist once.
 */
export async function reviveRetainedSandbox(
  ctx: EngineRunContext,
  sandboxId: string,
  options: { readonly chip: string; readonly onResume?: () => void },
): Promise<{ sandbox: SandboxHandle; binding: SandboxBinding }> {
  const cached = ctx.threadId ? getLiveThreadSandbox(ctx.threadId) : null;
  const binding = ctx.threadId && ctx.orgId
    ? await resolveSandboxBindingForThread(ctx.orgId, ctx.threadId)
    : await resolveSandboxBindingForSandbox(sandboxId);
  const sandbox = cached?.id === sandboxId ? cached : await binding.provider.get(sandboxId);
  const state = (sandbox as { state?: string }).state;
  if (state === "stopped" || state === "paused" || state === "archived") {
    await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${sandbox.id.slice(0, 8)}…`, chip: options.chip });
    await sandbox.start();
    options.onResume?.();
  } else if (state !== "started") {
    throw new Error(`unusable state: ${state}`);
  }
  if (!(await providerGatewaySandboxIsCurrent(sandbox))) {
    await sandbox.delete().catch(() => {});
    throw new Error("legacy sandbox credential generation");
  }
  return { sandbox, binding };
}

async function resolveRetainedSandbox(
  ctx: EngineRunContext,
  options: ThreadSandboxOptions,
): Promise<{ sandbox: SandboxHandle; binding: SandboxBinding } | null> {
  if (!ctx.threadId) return null;
  const sandboxId = await getThreadSandbox(ctx.threadId);
  if (!sandboxId) return null;
  try {
    const { sandbox, binding } = await reviveRetainedSandbox(ctx, sandboxId, { chip: options.chip });
    if (!sandboxHasRequiredLabels(sandbox, options.requiredLabels)) {
      await sandbox.delete().catch(() => {});
      throw new Error("retained sandbox does not match the requested runtime generation");
    }
    return { sandbox, binding };
  } catch {
    forgetLiveThreadSandbox(ctx.threadId, sandboxId);
    return null;
  }
}

export async function acquireThreadSandbox(
  ctx: EngineRunContext,
  options: ThreadSandboxOptions,
): Promise<ThreadSandboxLease> {
  const binding = await resolveSandboxBindingForRun(ctx);
  const provider = binding.provider;
  const resourceTarget = resolveSandboxResourceTarget();
  const endRetained = ctx.timing?.begin(RUN_TIMING_STAGES.sandboxRetained);
  let sandbox: SandboxHandle | null;
  // What gets recorded next to the sandbox id: the binding that actually produced it.
  let effectiveBinding: SandboxBinding = binding;
  try {
    const retained = await resolveRetainedSandbox(ctx, options);
    sandbox = retained?.sandbox ?? null;
    if (retained) effectiveBinding = retained.binding;
  } catch (error) {
    endRetained?.(RUN_TIMING_OUTCOMES.failure);
    throw error;
  }
  let reused = sandbox !== null;

  if (sandbox && !sandboxMeetsResourceTarget(sandbox, resourceTarget)) {
    const staleId = sandbox.id;
    await sandbox.delete().catch(() => {});
    if (ctx.threadId) forgetLiveThreadSandbox(ctx.threadId, staleId);
    sandbox = null;
    reused = false;
    effectiveBinding = binding;
  }
  endRetained?.(sandbox ? RUN_TIMING_OUTCOMES.hit : RUN_TIMING_OUTCOMES.miss);

  if (!sandbox) {
    await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: options.chip });
    if (binding.kind === "cube" && binding.credential === "env" && options.warmPool !== false) {
      const endWarmPool = ctx.timing?.begin(RUN_TIMING_STAGES.sandboxWarmPool);
      try {
        sandbox = await claimCubeWarmSandbox(options.warmPool || undefined);
        endWarmPool?.(sandbox ? RUN_TIMING_OUTCOMES.hit : RUN_TIMING_OUTCOMES.miss);
      } catch (error) {
        endWarmPool?.(RUN_TIMING_OUTCOMES.failure);
        throw error;
      }
      reused = sandbox !== null;
    }
    if (!sandbox) {
      const endCreate = ctx.timing?.begin(RUN_TIMING_STAGES.sandboxCreate);
      try {
        sandbox = await provider.create({
          snapshot: binding.credential === "user" ? (binding.snapshot ?? "") : options.snapshot,
          labels: {
            ...providerGatewaySandboxLabels(ctx.runId),
            ...options.labels,
          },
          autoStopInterval: Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30),
          autoDeleteInterval: Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320),
        });
        endCreate?.(RUN_TIMING_OUTCOMES.success);
      } catch (error) {
        endCreate?.(RUN_TIMING_OUTCOMES.failure);
        throw error;
      }
    }
  }

  assertSandboxResources(sandbox, resourceTarget);
  await persistSandboxBeforeExecution({
    runId: ctx.runId,
    sandboxId: sandbox.id,
    reused,
    persist: (runId, sandboxId) => setRunSandbox(runId, sandboxId, bindingRecord(effectiveBinding)),
    deleteFreshSandbox: () => sandbox.delete(),
  });
  if (ctx.threadId) rememberLiveThreadSandbox(ctx.threadId, sandbox);
  return {
    sandbox,
    binding: effectiveBinding,
    reused,
    retained: Boolean(ctx.threadId),
    releaseAfterRun: !ctx.threadId,
  };
}
