export const DEFAULT_DEV_AUTH_SECRET = "dev-skynet-secret-change-me";

export function runtimeDevModeEnabled(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const explicit = source.SKYNET_DEV_MODE;
  if (explicit !== undefined) return explicit === "true";
  return (source.NODE_ENV ?? "development") !== "production";
}

/** Side-effect-free auth key-material resolver for cryptographic fallbacks.
 * Public gateway configurations require dedicated roots before these fallbacks
 * are reachable. */
export function authSecretMaterial(
  source: Record<string, string | undefined> = process.env,
): string {
  const configured = source.BETTER_AUTH_SECRET?.trim();
  if (configured) return configured;
  if (runtimeDevModeEnabled(source)) return DEFAULT_DEV_AUTH_SECRET;
  throw new Error("BETTER_AUTH_SECRET is required when SKYNET_DEV_MODE is off");
}
