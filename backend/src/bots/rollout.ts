/**
 * Bots ship dark. `BOTS=1|on|true` enables the surface for every org;
 * `BOTS_ORG_IDS=org_a,org_b` enables it for a canary allowlist only. Mirrors
 * the product-child rollout switches so the deploy gate reads one grammar.
 */
export function botsEnabled(
  orgId: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = (env.BOTS ?? "").trim().toLowerCase();
  if (value === "1" || value === "on" || value === "true") return true;
  if (!orgId) return false;
  const allowlist = (env.BOTS_ORG_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return allowlist.includes(orgId);
}
