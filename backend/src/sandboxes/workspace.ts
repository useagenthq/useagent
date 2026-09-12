import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { posix } from "node:path";
import { resolveSandboxBindingForSandbox } from "./binding";
import { isSandboxProviderKind, SANDBOX_PROVIDER_KINDS } from "./plugins";
import { sandboxRuntimeLayout } from "./provider";

const INSPECTION_SCREENSHOT_DIRECTORIES = new Set([
  ...SANDBOX_PROVIDER_KINDS.map((kind) => `${sandboxRuntimeLayout(kind).workdir}/screenshots`),
  // Historical capture location: retain the privacy restriction, not a publish alias.
  "/home/daytona/work/screenshots",
]);

export function requiresScreenshotProofPurpose(path: string): boolean {
  return INSPECTION_SCREENSHOT_DIRECTORIES.has(posix.dirname(path))
    && /^screenshot-\d+\.png$/.test(posix.basename(path));
}

export async function resolveAttachedSandboxWorkspaceRoot(input: {
  readonly sandboxId: string;
  readonly sandboxProvider: SandboxProviderKind | null;
}): Promise<string> {
  const kind = input.sandboxProvider
    ?? (await resolveSandboxBindingForSandbox(input.sandboxId)).kind;
  if (!isSandboxProviderKind(kind)) {
    throw new Error(`recorded sandbox provider ${kind} is unsupported`);
  }
  return sandboxRuntimeLayout(kind).workdir;
}
