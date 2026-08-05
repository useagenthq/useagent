import { db } from "./db/client";
import { member, organization } from "./db/schema";

/**
 * Signup side-effects for better-auth. One job: give every newly-created user
 * (Google or email) their own organization on first sign-in, so they land in a
 * real tenant instead of borrowing the dev org. Single-team scope — one owner,
 * one org — mirroring the dev-seed insert shape (seed.ts).
 *
 * Best-effort: a failure here is logged but never aborts the signup. The org
 * middleware's `firstOrgForUser` fallback resolves the org on later requests,
 * and a genuinely org-less session still fails closed (403 no_organization)
 * rather than crossing tenancy — so a missed org degrades safely.
 */
export async function createPersonalOrgForUser(user: {
  id: string;
  name?: string | null;
  email: string;
}): Promise<void> {
  const now = new Date();
  const label = (user.name?.trim() || user.email.split("@")[0] || "workspace").trim();

  try {
    const orgId = `org_${crypto.randomUUID()}`;
    await db.insert(organization).values({
      id: orgId,
      name: `${label}'s workspace`,
      slug: `${slugify(label)}-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: now,
    });
    await db.insert(member).values({
      id: `member_${crypto.randomUUID()}`,
      organizationId: orgId,
      userId: user.id,
      role: "owner",
      createdAt: now,
    });
  } catch (err) {
    console.error(
      `[auth] failed to create personal org for user ${user.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Lowercase, hyphenate, and bound a label into a DNS-ish org slug stem. */
function slugify(label: string): string {
  const stem = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return stem || "workspace";
}
