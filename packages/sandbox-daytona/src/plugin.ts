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
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    if (!hostname.includes(":")) return false; // a DNS name, even one starting with "fd"
    if (hostname === "::1" || hostname === "::") return true;
    // IPv4-mapped: WHATWG serializes "::ffff:127.0.0.1" as "::ffff:7f00:1"; accept both spellings.
    const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(hostname);
    if (dotted) return isPrivateIpLiteral(dotted[1]!);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
    if (hex) {
      const [hi, lo] = [Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16)];
      return isPrivateIpLiteral(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd");
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The product snapshots new sandboxes start from when the operator sets nothing.
 * This is the one place the pins live: set `DAYTONA_SNAPSHOT` (OpenCode, Pi and
 * the CLI lane; a root image) and `DAYTONA_ACP_SNAPSHOT` (Claude and Codex over
 * ACP; a non-root image) in the deployment env to move off them. Both defaults
 * are active in the product org today; `skynet-agent-v23` also exists there but
 * lacks the desktop binaries the Browser surface needs. A snapshot that goes
 * unused for about two weeks is deactivated by Daytona; the provider reactivates
 * it on the next create (see `ensureTemplate`).
 */
export const DAYTONA_SNAPSHOT_DEFAULTS: Readonly<Record<string, string>> = {
  DAYTONA_SNAPSHOT: "skynet-agent-v17",
  DAYTONA_ACP_SNAPSHOT: "skynet-acp-v3",
};

/** Everything the control plane needs to run work on Daytona. */
export const daytonaPlugin: SandboxProviderPlugin<DaytonaApiConfig> = {
  kind: "daytona",
  label: "Daytona",
  credentialEnv: "DAYTONA_API_KEY",
  credentialRequired: true,
  templateEnv: "DAYTONA_SNAPSHOT",
  // Daytona's default image is 1 vCPU / 1 GiB: far below the product target, so
  // a snapshot failure never silently lands there unless the operator lowered
  // SANDBOX_CPU / SANDBOX_MEMORY_GIB to fit it.
  baseImageResources: { cpu: 1, memory: 1 },
  home: "/home/daytona",
  runsAsRoot: true,
  previewAuthHeaders: daytonaPreviewAuthHeaders,
  configFromEnv: daytonaApiConfig,
  template(env, templateEnv = "DAYTONA_SNAPSHOT") {
    const configured = env[templateEnv]?.trim();
    if (configured) return configured;
    const fallback = DAYTONA_SNAPSHOT_DEFAULTS[templateEnv];
    if (!fallback) throw new Error(`Daytona has no default snapshot for ${templateEnv}`);
    return fallback;
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
