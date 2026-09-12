/**
 * Bots are part of the product: on for every org unless the operator turns them
 * off with `BOTS=off` (also `0` or `false`). There is no canary allowlist; the
 * structural guards on handoffs (self, cycle, depth, caps) are what make the
 * surface safe to run everywhere, not a rollout switch.
 */
export function botsEnabled(
  _orgId: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = (env.BOTS ?? "").trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}
