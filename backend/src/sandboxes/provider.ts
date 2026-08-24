import type { SandboxProvider, SandboxProviderKind } from "@useagent/sandbox-contract";
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
  if (value !== "daytona" && value !== "cube") {
    throw new Error("SANDBOX_PROVIDER must be daytona or cube");
  }
  return value;
}

export function sandboxProviderApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (sandboxProviderKind(env) === "cube") {
    return env.CUBE_API_KEY?.trim() ?? "";
  }
  return env.DAYTONA_API_KEY?.trim() || undefined;
}

export function sandboxPreviewHeaders(
  token: string,
  provider?: SandboxProviderKind,
): Record<string, string> {
  if (!token) return {};
  return (provider ?? sandboxProviderKind()) === "daytona"
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
  if (sandboxProviderKind(env) === "cube") {
    const template = env.CUBE_TEMPLATE_ID?.trim();
    if (!template) throw new Error("CUBE_TEMPLATE_ID is required when SANDBOX_PROVIDER=cube");
    return template;
  }
  return env[daytonaEnvName]?.trim() || daytonaFallback;
}

const daytonaTarget = (): string => process.env.DAYTONA_TARGET ?? "us";
const daytonaApiUrl = (): string =>
  process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api";

export function sandboxProvider(apiKey = sandboxProviderApiKey()): SandboxProvider {
  if (sandboxProviderKind() === "cube") return cubeSandboxProvider(apiKey ?? "");
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
