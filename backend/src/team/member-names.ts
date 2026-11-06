import { and, eq, inArray } from "drizzle-orm";
import { member, user } from "../db/auth-schema";
import { db } from "../db/client";

/**
 * How the organization's member directory names these people (better-auth's
 * member and user rows, the ones list-members serves the team card): their name,
 * else their email, as the team card shows them. Someone who is not a member of
 * the organization has no entry, so a caller shows no name rather than an id.
 */
export async function memberDisplayNames(
  orgId: string,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), inArray(member.userId, ids)));
  return new Map(
    rows.flatMap((row): [string, string][] => {
      const name = row.name?.trim() || row.email?.trim();
      return name ? [[row.id, name]] : [];
    }),
  );
}
