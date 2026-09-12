import type { SandboxEnv, SandboxProviderPlugin, SandboxProviderPorts } from "@useagent/sandbox-contract";
import {
  BOX_API_URL,
  BOX_HOSTING_DOMAIN,
  BOX_MACHINE_TYPES,
  type BoxApiConfig,
  type BoxMachineType,
  boxCliProblem,
  boxSandboxProvider,
} from "./provider";
import { validateBoxConnection } from "./validate";

export function boxApiConfig(apiKey: string, env: SandboxEnv): BoxApiConfig {
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

/** Everything the control plane needs to run work on Box. */
export const boxPlugin: SandboxProviderPlugin<BoxApiConfig> = {
  kind: "box",
  label: "Box",
  credentialEnv: "BOX_API_KEY",
  credentialRequired: true,
  templateEnv: "BOX_SNAPSHOT",
  // Boxes run as `user`; /root is not writable.
  home: "/home/user",
  runsAsRoot: false,
  runtime: {
    home: "/home/user",
    workdir: "/home/user/work",
    bunExecutable: "/usr/local/bin/bun",
  },
  previewAuthHeaders(token): Record<string, string> {
    // The hosted-port token was exchanged for the port-auth cookie at link time.
    if (!token) return {};
    return { cookie: `_port_auth=${token}` };
  },
  configFromEnv: boxApiConfig,
  template(env) {
    // Optional snapshot to create from; empty means Box's base image.
    return env.BOX_SNAPSHOT?.trim() ?? "";
  },
  interactiveTerminalProblem() {
    return boxCliProblem();
  },
  createProvider(config, ports: SandboxProviderPorts = {}) {
    return boxSandboxProvider(config, ports);
  },
  validateCredential(input, ports = {}) {
    return validateBoxConnection(input, { fetchImpl: ports.fetchImpl });
  },
  previewHostProblem(url, env) {
    const domain = env.BOX_HOSTING_DOMAIN?.trim().toLowerCase() || BOX_HOSTING_DOMAIN;
    if (url.protocol !== "https:" || !url.hostname.toLowerCase().endsWith(`.${domain}`)) {
      return "Codex exec-server preview is outside the Box hosting domain";
    }
    return null;
  },
};
