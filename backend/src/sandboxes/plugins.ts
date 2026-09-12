import type { SandboxProviderKind, SandboxProviderPlugin } from "@useagent/sandbox-contract";
import { boxPlugin } from "@useagent/sandbox-box";
import { cubePlugin } from "@useagent/sandbox-cube";
import { daytonaPlugin } from "@useagent/sandbox-daytona";

/**
 * Every sandbox vendor the control plane can run work on. Each entry is a
 * package that owns its API client, env config, credential validation,
 * preview auth and runtime layout; nothing else in the backend switches on a
 * vendor name. Adding a vendor = one package + one line here.
 */
export const SANDBOX_PLUGINS: Readonly<Record<SandboxProviderKind, SandboxProviderPlugin<unknown>>> = {
  daytona: daytonaPlugin,
  cube: cubePlugin,
  box: boxPlugin,
};

export const SANDBOX_PROVIDER_KINDS = Object.keys(SANDBOX_PLUGINS) as readonly SandboxProviderKind[];

export function isSandboxProviderKind(value: string): value is SandboxProviderKind {
  return Object.hasOwn(SANDBOX_PLUGINS, value);
}

export function sandboxPlugin(kind: SandboxProviderKind): SandboxProviderPlugin<unknown> {
  return SANDBOX_PLUGINS[kind];
}
