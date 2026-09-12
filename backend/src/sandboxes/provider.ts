import type { SandboxPreviewLink, SandboxProvider, SandboxProviderKind } from "@useagent/sandbox-contract";
import { BOX_API_URL, BOX_MACHINE_TYPES, type BoxApiConfig, type BoxMachineType, boxSandboxProvider } from "./box-provider";
import { cubeSandboxProvider } from "./cube-provider";
import { daytonaSandboxProvider } from "./daytona-provider";

// The provider-neutral sandbox contract now lives in @useagent/sandbox-contract.
// Re-export every symbol so existing importers of this module keep their paths
// unchanged; the env-coupled selectors and the Daytona/Cube adapter wiring stay
// here in the backend.
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

export function sandboxProviderKind(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxProviderKind {
  const value = env.SANDBOX_PROVIDER?.trim().toLowerCase() || "daytona";
  if (value !== "daytona" && value !== "cube" && value !== "box") {
    throw new Error("SANDBOX_PROVIDER must be daytona, cube, or box");
  }
  return value;
}

export function sandboxProviderApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const kind = sandboxProviderKind(env);
  if (kind === "cube") {
    return env.CUBE_API_KEY?.trim() ?? "";
  }
  if (kind === "box") {
    return env.BOX_API_KEY?.trim() || undefined;
  }
  return env.DAYTONA_API_KEY?.trim() || undefined;
}

/** What every preview consumer keeps from a link: origin, header token, mandatory query. */
export interface PreviewLinkBase {
  readonly baseUrl: string;
  readonly token: string;
  readonly query?: Readonly<Record<string, string>>;
}

export function previewLinkBase(link: SandboxPreviewLink): PreviewLinkBase {
  return { baseUrl: link.url.replace(/\/+$/, ""), token: link.token ?? "", query: link.query };
}

/**
 * The request URL for a preview link: the link's mandatory query (Box's
 * `_token`) merged into whatever the caller built. Daytona and Cube links
 * carry no query, so the URL comes back untouched.
 */
export function previewRequestUrl(
  link: Pick<SandboxPreviewLink, "query"> | null | undefined,
  url: string,
): string {
  const query = link?.query;
  if (!query || Object.keys(query).length === 0) return url;
  const target = new URL(url);
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
  return target.toString();
}

export function sandboxPreviewHeaders(
  token: string,
  provider?: SandboxProviderKind,
): Record<string, string> {
  if (!token) return {};
  const kind = provider ?? sandboxProviderKind();
  // Box hosted ports carry their access token in the URL itself.
  if (kind === "box") return {};
  return kind === "daytona"
    ? { "x-daytona-preview-token": token }
    : {
        "cube-traffic-access-token": token,
        "e2b-traffic-access-token": token,
      };
}

export function sandboxTemplate(
  daytonaEnvName: string,
  daytonaFallback: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const kind = sandboxProviderKind(env);
  if (kind === "cube") {
    const template = env.CUBE_TEMPLATE_ID?.trim();
    if (!template) throw new Error("CUBE_TEMPLATE_ID is required when SANDBOX_PROVIDER=cube");
    return template;
  }
  // Box: an optional snapshot to create from; empty means the base image.
  if (kind === "box") return env.BOX_SNAPSHOT?.trim() ?? "";
  return env[daytonaEnvName]?.trim() || daytonaFallback;
}

const daytonaTarget = (): string => process.env.DAYTONA_TARGET ?? "us";
const daytonaApiUrl = (): string =>
  process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api";

export function boxApiConfig(
  apiKey: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): BoxApiConfig {
  const machine = env.BOX_MACHINE_TYPE?.trim().toLowerCase() || "default";
  if (!(BOX_MACHINE_TYPES as readonly string[]).includes(machine)) {
    throw new Error(`BOX_MACHINE_TYPE must be one of ${BOX_MACHINE_TYPES.join(", ")}`);
  }
  const environment = env.BOX_ENVIRONMENT?.trim();
  return {
    apiKey,
    apiUrl: env.BOX_API_URL?.trim().replace(/\/+$/, "") || BOX_API_URL,
    machineType: machine as BoxMachineType,
    ...(environment ? { environment } : {}),
  };
}

export function sandboxProvider(apiKey = sandboxProviderApiKey()): SandboxProvider {
  const kind = sandboxProviderKind();
  if (kind === "cube") return cubeSandboxProvider(apiKey ?? "");
  if (kind === "box") {
    if (!apiKey) throw new Error("BOX_API_KEY is required when SANDBOX_PROVIDER=box");
    return boxSandboxProvider(boxApiConfig(apiKey));
  }
  if (!apiKey) throw new Error("DAYTONA_API_KEY is required when SANDBOX_PROVIDER=daytona");
  return daytonaSandboxProvider(daytonaApiConfig(apiKey));
}

/** Backward-compatible name for external callers while the internal call sites migrate. */
export const daytonaProvider = sandboxProvider;

export interface DaytonaApiConfig {
  apiKey: string;
  apiUrl: string;
  target: string;
}

export function daytonaApiConfig(apiKey: string): DaytonaApiConfig {
  return { apiKey, apiUrl: daytonaApiUrl(), target: daytonaTarget() };
}
