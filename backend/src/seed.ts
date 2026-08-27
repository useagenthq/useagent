import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { member, organization, user } from "./db/schema";

// ---------------------------------------------------------------------------
// Dev fallback identity. When a request has no session, the org-scoping
// middleware falls back to this seeded org + user so every API works
// unauthenticated in local dev. Seeded idempotently at boot.
// ---------------------------------------------------------------------------

export const DEV_ORG_ID = "org-useagent-dev";
export const DEV_ORG_SLUG = "useagent-dev";
export const DEV_ORG_NAME = "useAgent Dev";
export const DEV_USER_ID = "user-useagent-dev";
export const DEV_USER_EMAIL = "dev@useagent.local";
export const DEV_USER_NAME = "Dev User";
const DEV_MEMBER_ID = "member-useagent-dev";

export function getDevContext(): { orgId: string; userId: string } {
  return { orgId: DEV_ORG_ID, userId: DEV_USER_ID };
}

/** Create the dev org, dev user, and one membership row. Every step is
 * idempotent, so booting repeatedly is a no-op. No demo content is planted —
 * Knowledge and Skills start empty and fill only with real, user- or
 * agent-authored records. */
export async function seedDev(): Promise<void> {
  const now = new Date();

  await db
    .insert(user)
    .values({
      id: DEV_USER_ID,
      name: DEV_USER_NAME,
      email: DEV_USER_EMAIL,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(organization)
    .values({
      id: DEV_ORG_ID,
      name: DEV_ORG_NAME,
      slug: DEV_ORG_SLUG,
      createdAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(member)
    .values({
      id: DEV_MEMBER_ID,
      organizationId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoNothing();
}

/** The org id of the first membership for a user, or null if they have none. */
export async function firstOrgForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  return row?.organizationId ?? null;
}
