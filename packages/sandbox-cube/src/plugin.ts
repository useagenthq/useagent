import type { SandboxProviderPlugin, SandboxProviderPorts } from "@useagent/sandbox-contract";
import { CUBE_SANDBOX_DOMAIN, cubePreviewAuthHeaders, cubeSandboxProvider } from "./provider";

export interface CubeApiConfig {
  readonly apiKey: string;
}

/** Everything the control plane needs to run work on Cube. */
export const cubePlugin: SandboxProviderPlugin<CubeApiConfig> = {
  kind: "cube",
  label: "Cube",
  credentialEnv: "CUBE_API_KEY",
  // A local Cube (loopback API, trusted ingress) runs without a key.
  credentialRequired: false,
  templateEnv: "CUBE_TEMPLATE_ID",
  // Cube templates run as root with the Daytona-shaped home the runner expects.
  home: "/home/daytona",
  runsAsRoot: true,
  runtime: { home: "/root", workdir: "/root/work" },
  previewAuthHeaders: cubePreviewAuthHeaders,
  configFromEnv(apiKey) {
    // Every other Cube setting is read from the process environment by the provider itself.
    return { apiKey };
  },
  template(env) {
    const template = env.CUBE_TEMPLATE_ID?.trim();
    if (!template) throw new Error("CUBE_TEMPLATE_ID is required when SANDBOX_PROVIDER=cube");
    return template;
  },
  createProvider(config, ports: SandboxProviderPorts = {}) {
    if (!ports.identityPreflightCommand) throw new Error("Cube provider needs identityPreflightCommand");
    return cubeSandboxProvider(config.apiKey, { identityPreflightCommand: ports.identityPreflightCommand });
  },
  previewHostProblem(url, env) {
    const domain = env.CUBE_SANDBOX_DOMAIN?.trim().toLowerCase() || CUBE_SANDBOX_DOMAIN;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      return "Codex exec-server preview is outside the Cube sandbox domain";
    }
    return null;
  },
};
