const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MIN_SIGNING_SECRET_LENGTH = 32;

type GatewaySecretName =
  | "PROVIDER_GATEWAY_SECRET"
  | "TOOL_GATEWAY_SECRET"
  | "SECRETS_ENCRYPTION_KEY";

function devModeEnabled(env: Record<string, string | undefined>): boolean {
  const explicit = env.SKYNET_DEV_MODE;
  if (explicit !== undefined) return explicit === "true";
  return (env.NODE_ENV ?? "development") !== "production";
}

export function validateGatewayPublicUrl(
  raw: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("gateway public URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("gateway public URL must be a credential-free origin");
  }
  if (url.pathname !== "/") {
    throw new Error("gateway public URL must not include a path");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && devModeEnabled(env))) {
    throw new Error("gateway public URL requires HTTPS (HTTP is local-development loopback only)");
  }
  return url.origin;
}

function requireStrongDedicatedSecret(
  name: GatewaySecretName,
  env: Record<string, string | undefined>,
): string {
  const value = env[name]?.trim() ?? "";
  if (value.length < MIN_SIGNING_SECRET_LENGTH) {
    throw new Error(`${name} must be a dedicated secret of at least ${MIN_SIGNING_SECRET_LENGTH} characters`);
  }
  if (value === env.BETTER_AUTH_SECRET?.trim()) {
    throw new Error(`${name} must be independent from BETTER_AUTH_SECRET`);
  }
  return value;
}

export function assertGatewayCapabilitySecret(
  name: GatewaySecretName,
  env: Record<string, string | undefined> = process.env,
): void {
  requireStrongDedicatedSecret(name, env);
}

/** Validate the dedicated public process before it binds a port. */
export function assertGatewayRuntimeConfiguration(
  env: Record<string, string | undefined> = process.env,
): void {
  const configuredOrigins = [
    env.GATEWAY_PUBLIC_URL,
    env.PROVIDER_GATEWAY_PUBLIC_URL,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => validateGatewayPublicUrl(value, env));
  if (new Set(configuredOrigins).size > 1) {
    throw new Error("GATEWAY_PUBLIC_URL and PROVIDER_GATEWAY_PUBLIC_URL must use one gateway origin");
  }
  const providerSecret = requireStrongDedicatedSecret("PROVIDER_GATEWAY_SECRET", env);
  const toolSecret = requireStrongDedicatedSecret("TOOL_GATEWAY_SECRET", env);
  const encryptionSecret = requireStrongDedicatedSecret("SECRETS_ENCRYPTION_KEY", env);
  if (new Set([providerSecret, toolSecret, encryptionSecret]).size !== 3) {
    throw new Error("gateway signing and encryption secrets must be independent");
  }
  if (!devModeEnabled(env) && !env.GATEWAY_DATABASE_URL?.trim()) {
    throw new Error("GATEWAY_DATABASE_URL is required for the production gateway process");
  }
}
