export type RelationshipWriteMode = "off" | "shadow" | "on";

const MAX_CANARY_ORGS = 100;
const ORG_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function enumEnv<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = process.env[name]?.trim().toLowerCase();
  return value && values.includes(value as T) ? value as T : fallback;
}

export function threadRelationshipWriteMode(): RelationshipWriteMode {
  return enumEnv("THREAD_RELATIONSHIPS_WRITE", ["off", "shadow", "on"] as const, "off");
}

export function productChildCanaryOrgIds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<string> {
  const raw = env.PRODUCT_CHILD_CANARY_ORG_IDS?.trim();
  if (!raw) return new Set();
  const ids = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (ids.length > MAX_CANARY_ORGS || ids.some((id) => !ORG_ID_RE.test(id))) {
    throw new Error("PRODUCT_CHILD_CANARY_ORG_IDS must be a comma-separated list of at most 100 bounded org ids");
  }
  return new Set(ids);
}

function canaryEnabled(
  orgId: string | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Boolean(orgId && productChildCanaryOrgIds(env).has(orgId));
}

export function threadRelationshipReadEnabled(
  orgId?: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.THREAD_RELATIONSHIPS_READ?.trim().toLowerCase();
  return value === "read" || canaryEnabled(orgId, env);
}

/** Product child threads, and with them the child composer: messaging a child
 *  thread is part of the feature, never a separate switch. */
export function productChildThreadsEnabled(
  orgId?: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.PRODUCT_CHILD_THREADS?.trim().toLowerCase();
  return value === "on" || canaryEnabled(orgId, env);
}

export function assertThreadRelationshipRolloutConfig(): void {
  const write = threadRelationshipWriteMode();
  const read = threadRelationshipReadEnabled();
  const children = productChildThreadsEnabled();
  const canaryOrgs = productChildCanaryOrgIds();
  if (children && (write === "off" || !read)) {
    throw new Error("PRODUCT_CHILD_THREADS=on requires THREAD_RELATIONSHIPS_WRITE=shadow|on and THREAD_RELATIONSHIPS_READ=read");
  }
  if (canaryOrgs.size > 0 && write === "off") {
    throw new Error("PRODUCT_CHILD_CANARY_ORG_IDS requires THREAD_RELATIONSHIPS_WRITE=shadow|on");
  }
}
