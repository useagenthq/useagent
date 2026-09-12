import { type SandboxEnv, SandboxCredentialError, type SandboxProviderPlugin } from "@useagent/sandbox-contract";
import { type DaytonaApiConfig, daytonaPreviewAuthHeaders, daytonaSandboxProvider } from "./provider";
import { validateDaytonaConnection } from "./validate";

export function daytonaApiConfig(apiKey: string, env: SandboxEnv): DaytonaApiConfig {
  return {
    apiKey,
    apiUrl: env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api",
    target: env.DAYTONA_TARGET ?? "us",
  };
}

function isPrivateIpLiteral(rawHostname: string): boolean {
  // WHATWG URLs report IPv6 literals in brackets ("[::1]").
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return hostname === "::1" || hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd");
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return true;
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

/** Everything the control plane needs to run work on Daytona. */
export const daytonaPlugin: SandboxProviderPlugin<DaytonaApiConfig> = {
  kind: "daytona",
  label: "Daytona",
  credentialEnv: "DAYTONA_API_KEY",
  credentialRequired: true,
  templateEnv: "DAYTONA_SNAPSHOT",
  home: "/home/daytona",
  runsAsRoot: true,
  previewAuthHeaders: daytonaPreviewAuthHeaders,
  configFromEnv: daytonaApiConfig,
  template(env, fallback) {
    return env[fallback.envName]?.trim() || fallback.value;
  },
  createProvider(config) {
    return daytonaSandboxProvider(config);
  },
  async validateCredential(input) {
    // Daytona validation is the snapshot lookup itself; there is nothing to prove without one.
    const snapshotName = input.snapshotName?.trim();
    if (!snapshotName) {
      throw new SandboxCredentialError("snapshot_not_found", 404, "Daytona validation needs a snapshot name");
    }
    await validateDaytonaConnection({ apiKey: input.apiKey, snapshotName });
  },
  previewHostProblem(url, env) {
    if (env.NODE_ENV !== "test" && url.protocol !== "https:") {
      return "Daytona exec-server preview must use HTTPS";
    }
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "metadata.google.internal" ||
      isPrivateIpLiteral(hostname)
    ) {
      return "Codex exec-server preview host is unavailable";
    }
    return null;
  },
};
