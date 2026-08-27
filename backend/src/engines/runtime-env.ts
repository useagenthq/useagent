/**
 * Operator env migration for the runtime engine lane.
 *
 * The lane's operator variables are being renamed from their legacy
 * vendor-prefixed names (T3_*) to RUNTIME_* names. Deployment-safe dual-read:
 * the NEW name wins when set; the legacy name keeps existing production env
 * files working unchanged. Once production env (and provisioning scripts)
 * are migrated to the RUNTIME_* names, delete the legacy fallbacks and inline
 * the plain env reads again.
 */
export function operatorEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  legacyName: string,
): string | undefined {
  return env[name] ?? env[legacyName];
}
