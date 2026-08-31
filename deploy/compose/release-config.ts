export interface ComposeReleaseConfig {
  readonly color: "blue" | "green";
  readonly commit: string;
  readonly publicGatewayUrl: string;
  readonly images: {
    readonly backend: string;
    readonly gateway: string;
    readonly frontend: string;
  };
  readonly ports: {
    readonly backend: number;
    readonly gateway: number;
    readonly frontend: number;
  };
}

const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const PORTS = {
  blue: { backend: 3201, gateway: 3202, frontend: 3400 },
  green: { backend: 3211, gateway: 3212, frontend: 3410 },
} as const;

export function productionComposeReleaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): ComposeReleaseConfig {
  const color = env.USEAGENT_RELEASE_COLOR;
  if (color !== "blue" && color !== "green") {
    throw new Error("USEAGENT_RELEASE_COLOR must be blue or green");
  }
  const commit = env.USEAGENT_RELEASE_COMMIT?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("USEAGENT_RELEASE_COMMIT must be an exact Git commit");
  }
  const rawPublicGatewayUrl = env.USEAGENT_GATEWAY_PUBLIC_URL?.trim() ?? "";
  let publicGatewayUrl: URL;
  try {
    publicGatewayUrl = new URL(rawPublicGatewayUrl);
  } catch {
    throw new Error("USEAGENT_GATEWAY_PUBLIC_URL must be an absolute HTTPS origin");
  }
  if (
    publicGatewayUrl.protocol !== "https:" ||
    publicGatewayUrl.username ||
    publicGatewayUrl.password ||
    publicGatewayUrl.pathname !== "/" ||
    publicGatewayUrl.search ||
    publicGatewayUrl.hash
  ) {
    throw new Error("USEAGENT_GATEWAY_PUBLIC_URL must be an absolute HTTPS origin");
  }
  const image = (name: "BACKEND" | "GATEWAY" | "FRONTEND"): string => {
    const value = env[`USEAGENT_${name}_IMAGE`]?.trim() ?? "";
    if (!IMAGE_DIGEST.test(value)) {
      throw new Error(`USEAGENT_${name}_IMAGE must be an immutable sha256 reference`);
    }
    return value;
  };
  const expectedPorts = PORTS[color];
  const port = (name: "BACKEND" | "GATEWAY" | "FRONTEND"): number => {
    const value = Number(env[`USEAGENT_${name}_PORT`]);
    const expected = expectedPorts[name.toLowerCase() as keyof typeof expectedPorts];
    if (value !== expected) {
      throw new Error(`USEAGENT_${name}_PORT must be ${expected} for ${color}`);
    }
    return value;
  };
  return {
    color,
    commit,
    publicGatewayUrl: publicGatewayUrl.origin,
    images: {
      backend: image("BACKEND"),
      gateway: image("GATEWAY"),
      frontend: image("FRONTEND"),
    },
    ports: {
      backend: port("BACKEND"),
      gateway: port("GATEWAY"),
      frontend: port("FRONTEND"),
    },
  };
}
