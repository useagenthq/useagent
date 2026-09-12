import type {
  SandboxEnv,
  SandboxPreviewLink,
  SandboxProvider,
  SandboxProviderKind,
  SandboxProviderPorts,
} from "@useagent/sandbox-contract";
import { type DaytonaApiConfig, daytonaApiConfig as daytonaApiConfigFor } from "@useagent/sandbox-daytona";
import { buildRuntimeIdentityPreflightCommand } from "../engines/runtime-environment";
import { SANDBOX_PROVIDER_KINDS, isSandboxProviderKind, sandboxPlugin } from "./plugins";
import { dbSandboxLabelStore } from "./sandbox-labels";

// The provider-neutral sandbox contract lives in @useagent/sandbox-contract and
// every vendor is a plugin package (see ./plugins). This module is the
// env-coupled selector layer the rest of the backend imports; it never names
// a vendor itself.
export type {
  SandboxComputerUse,
  SandboxCreateOptions,
  SandboxExecuteResult,
  SandboxFileSystem,
  SandboxHandle,
  SandboxPreviewLink,
  SandboxProcess,
  SandboxProvider,
  SandboxProviderKind,
  SandboxPtyHandle,
  SandboxRecording,
  SandboxSession,
} from "@useagent/sandbox-contract";
export { boxApiConfig } from "@useagent/sandbox-box";
export type { DaytonaApiConfig };

export interface SandboxRuntimeLayout {
  readonly home: string;
  readonly workdir: string;
  readonly runsAsRoot: boolean;
  readonly bunExecutable?: string;
}

export function sandboxRuntimeLayout(kind: SandboxProviderKind): SandboxRuntimeLayout {
  const plugin = sandboxPlugin(kind);
  return { ...plugin.runtime, runsAsRoot: plugin.runsAsRoot };
}

export function sandboxProviderKind(env: SandboxEnv = process.env): SandboxProviderKind {
  const value = env.SANDBOX_PROVIDER?.trim().toLowerCase() || "daytona";
  if (!isSandboxProviderKind(value)) {
    throw new Error(`SANDBOX_PROVIDER must be ${SANDBOX_PROVIDER_KINDS.join(", ")}`);
  }
  return value;
}

export function sandboxProviderApiKey(env: SandboxEnv = process.env): string | undefined {
  const plugin = sandboxPlugin(sandboxProviderKind(env));
  const value = env[plugin.credentialEnv]?.trim();
  // A provider that works without a key (local Cube) still gets an empty string.
  return value || (plugin.credentialRequired ? undefined : "");
}

/** Headers a preview token travels in, for this deployment's provider unless a kind is given. */
export function sandboxPreviewHeaders(token: string, provider?: SandboxProviderKind): Record<string, string> {
  return sandboxPlugin(provider ?? sandboxProviderKind()).previewAuthHeaders(token);
}

/** What every preview consumer keeps from a link: origin, token, auth headers. */
export interface PreviewLinkBase {
  readonly baseUrl: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly clientQuery?: Readonly<Record<string, string>>;
}

/** A link's base for consumers; a link without headers falls back to this deployment's provider. */
export function previewLinkBase(link: SandboxPreviewLink): PreviewLinkBase {
  const token = link.token ?? "";
  return {
    baseUrl: link.url.replace(/\/+$/, ""),
    token,
    headers: link.headers ?? sandboxPreviewHeaders(token),
    ...(link.clientQuery ? { clientQuery: link.clientQuery } : {}),
  };
}

/** The template new sandboxes start from for one lane (`templateEnv` names the operator variable; the
 *  plugin keeps the default behind it), or "" for the provider's base image. */
export function sandboxTemplate(templateEnv: string, env: SandboxEnv = process.env): string {
  return sandboxPlugin(sandboxProviderKind(env)).template(env, templateEnv);
}

/** The control-plane ports a provider of `kind` gets: durable labels and the runtime readiness probe. */
export function sandboxProviderPorts(kind: SandboxProviderKind): SandboxProviderPorts {
  return {
    labels: dbSandboxLabelStore(kind),
    identityPreflightCommand: buildRuntimeIdentityPreflightCommand(sandboxRuntimeLayout(kind)),
  };
}

/** A provider of `kind` for a given key (env or a user's stored credential). */
export function sandboxProviderFor(kind: SandboxProviderKind, apiKey: string, env: SandboxEnv = process.env): SandboxProvider {
  const plugin = sandboxPlugin(kind);
  return plugin.createProvider(plugin.configFromEnv(apiKey, env), sandboxProviderPorts(kind));
}

export function sandboxProvider(apiKey = sandboxProviderApiKey()): SandboxProvider {
  const kind = sandboxProviderKind();
  if (apiKey === undefined) {
    throw new Error(`${sandboxPlugin(kind).credentialEnv} is required when SANDBOX_PROVIDER=${kind}`);
  }
  return sandboxProviderFor(kind, apiKey);
}

/** Backward-compatible name for external callers while the internal call sites migrate. */
export const daytonaProvider = sandboxProvider;

export function daytonaApiConfig(apiKey: string): DaytonaApiConfig {
  return daytonaApiConfigFor(apiKey, process.env);
}
