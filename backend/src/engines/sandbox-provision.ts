import type { SandboxCreateOptions, SandboxHandle } from "../sandboxes/provider";
import type { SandboxBinding } from "../sandboxes/binding";
import { sandboxPlugin } from "../sandboxes/plugins";
import type { SandboxResourceTarget } from "./daytona-resources";
import type { EngineRunContext } from "./types";
import { errorMessage } from "../util/error-message";
import { noteLostWorkspace } from "./workspace-continuity";

export interface SandboxProvisionInput {
  readonly ctx: EngineRunContext;
  readonly binding: Pick<SandboxBinding, "kind" | "provider">;
  /** The template to create from; "" means the provider's base image. */
  readonly snapshot: string;
  readonly chip: string;
  readonly create: Omit<SandboxCreateOptions, "snapshot">;
  readonly resourceTarget: SandboxResourceTarget;
  /** Test seam for the lost-workspace note (it reads the database). */
  readonly noteLostWorkspace?: typeof noteLostWorkspace;
}

export interface ProvisionedSandbox {
  readonly sandbox: SandboxHandle;
  /** False when the sandbox started from the provider's base image (nothing preinstalled is trusted). */
  readonly fromTemplate: boolean;
}

/**
 * Create a fresh sandbox for a run, the one place every engine goes through.
 *
 * The provider's template state is checked first when the provider can report
 * it: an absent snapshot fails with its name and no fallback, an inactive one is
 * activated with a visible step while the wait runs, and any other failure
 * carries the provider's own reason. The base image is used only when the
 * plugin declares base-image resources that meet the run's target; the old bare
 * catch fell back to a 1 vCPU image unconditionally and then failed the resource
 * check, which hid every snapshot problem behind a message about CPU and RAM.
 */
export async function provisionSandbox(input: SandboxProvisionInput): Promise<ProvisionedSandbox> {
  const { ctx, binding, snapshot, chip, create, resourceTarget } = input;
  const plugin = sandboxPlugin(binding.kind);
  await (input.noteLostWorkspace ?? noteLostWorkspace)(ctx);
  if (!snapshot) return { sandbox: await binding.provider.create(create), fromTemplate: false };

  let problem: string | null = null;
  if (binding.provider.ensureTemplate) {
    const status = await binding.provider.ensureTemplate(snapshot, {
      onActivating: async () => {
        await ctx.emit({ kind: "task", label: "Activating sandbox image, this can take a few minutes…", chip });
      },
    });
    if (status.state === "absent") {
      throw new Error(`snapshot ${snapshot} is not in this ${plugin.label} org`);
    }
    if (status.state !== "active") {
      problem = `snapshot ${snapshot} is ${status.state}${status.detail ? ` (${status.detail})` : ""}`;
    }
  }
  if (!problem) {
    try {
      return { sandbox: await binding.provider.create({ ...create, snapshot }), fromTemplate: true };
    } catch (error) {
      problem = `${plugin.label} could not create a sandbox from snapshot ${snapshot}: ${errorMessage(error)}`;
    }
  }

  const base = plugin.baseImageResources;
  if (!base || base.cpu < resourceTarget.cpu || base.memory < resourceTarget.memory) {
    throw new Error(problem);
  }
  await ctx.emit({
    kind: "task",
    label: `${problem}; starting from the ${plugin.label} base image instead`,
    chip: "warning",
  });
  return { sandbox: await binding.provider.create(create), fromTemplate: false };
}
