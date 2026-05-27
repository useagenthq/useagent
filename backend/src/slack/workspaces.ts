/**
 * Slack workspace -> tenant identity mapping. Every inbound Slack event carries
 * the workspace (team) id it came from; this module resolves that id to the org
 * the run is scoped to. Resolution FAILS CLOSED: an event from an unmapped
 * workspace is ignored (logged once per team id), never attributed to a seeded
 * fallback org. Event user attribution comes only from `slack_users`; the
 * workspace row's legacy operator user is not a sender identity.
 *
 * Rows are provisioned by an operator: `SLACK_WORKSPACE_BINDINGS` (comma-
 * separated `teamId:orgId:userId` triples) is upserted at boot, and direct
 * inserts work for multi-workspace setups without a redeploy.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { slackUsers, slackWorkspaces } from "../db/schema";

export interface SlackWorkspaceIdentity {
  orgId: string;
  userId: string;
}

export interface SlackSenderIdentity {
  orgId: string;
  userId: string;
}

/** The tenant identity for a Slack team id, or null when unmapped. */
export async function findSlackWorkspace(
  teamId: string,
): Promise<SlackWorkspaceIdentity | null> {
  const [row] = await db
    .select({ orgId: slackWorkspaces.orgId, userId: slackWorkspaces.userId })
    .from(slackWorkspaces)
    .where(eq(slackWorkspaces.teamId, teamId))
    .limit(1);
  return row ?? null;
}

/** Bind (or re-bind) a workspace to a tenant identity. Idempotent upsert. */
export async function upsertSlackWorkspace(input: {
  teamId: string;
  orgId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(slackWorkspaces)
    .values(input)
    .onConflictDoUpdate({
      target: slackWorkspaces.teamId,
      set: { orgId: input.orgId, userId: input.userId },
    });
}

/** The product identity explicitly bound to one Slack sender, if any. */
export async function findSlackUser(
  teamId: string,
  slackUserId: string,
): Promise<SlackSenderIdentity | null> {
  const [row] = await db
    .select({ orgId: slackUsers.orgId, userId: slackUsers.userId })
    .from(slackUsers)
    .where(and(eq(slackUsers.teamId, teamId), eq(slackUsers.slackUserId, slackUserId)))
    .limit(1);
  return row ?? null;
}

/** Bind one Slack sender to one product user inside the workspace tenant. */
export async function upsertSlackUser(input: {
  teamId: string;
  slackUserId: string;
  orgId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(slackUsers)
    .values(input)
    .onConflictDoUpdate({
      target: [slackUsers.teamId, slackUsers.slackUserId],
      set: { orgId: input.orgId, userId: input.userId },
    });
}

/**
 * Resolve a sender only when its explicit mapping belongs to the currently
 * mapped workspace org. A stale cross-org user row fails closed.
 */
export async function resolveSlackSender(
  workspace: SlackWorkspaceIdentity,
  teamId: string | undefined,
  slackUserId: string | undefined,
): Promise<SlackSenderIdentity | null> {
  const team = teamId?.trim();
  const sender = slackUserId?.trim();
  if (!team || !sender) return null;
  const identity = await findSlackUser(team, sender);
  return identity?.orgId === workspace.orgId ? identity : null;
}

// Bounded once-per-team logging so an unmapped workspace's retry storm does not
// flood the log. Insertion-ordered Set: the oldest key evicts first.
const loggedUnknownTeams = new Set<string>();
const LOGGED_TEAMS_MAX = 200;

/**
 * Resolve an inbound event's workspace to its tenant identity, failing closed.
 * A missing team id or an unmapped workspace returns null and logs ONCE per
 * team id (the caller ignores the event).
 */
export async function resolveSlackWorkspace(
  teamId: string | undefined,
): Promise<SlackWorkspaceIdentity | null> {
  const key = teamId?.trim() || "(missing team_id)";
  const identity = teamId?.trim() ? await findSlackWorkspace(teamId.trim()) : null;
  if (identity) return identity;
  if (!loggedUnknownTeams.has(key)) {
    loggedUnknownTeams.add(key);
    if (loggedUnknownTeams.size > LOGGED_TEAMS_MAX) {
      const oldest = loggedUnknownTeams.values().next().value;
      if (oldest !== undefined) loggedUnknownTeams.delete(oldest);
    }
    console.warn(
      `[slack] ignoring event from unmapped workspace ${key} - add a slack_workspaces row (or SLACK_WORKSPACE_BINDINGS entry) to accept it`,
    );
  }
  return null;
}

/**
 * Boot-time sync of workspace and per-sender bindings. Both are additive
 * upserts; removing an env entry does not delete an operator-managed row.
 * Malformed entries are skipped loudly.
 */
export async function syncSlackWorkspaceBindings(): Promise<void> {
  const raw = process.env.SLACK_WORKSPACE_BINDINGS?.trim();
  if (raw) {
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(":").map((p) => p.trim());
      const [teamId, orgId, userId] = parts;
      if (parts.length !== 3 || !teamId || !orgId || !userId) {
        console.error(
          `[slack] skipping malformed SLACK_WORKSPACE_BINDINGS entry "${trimmed}" (expected teamId:orgId:userId)`,
        );
        continue;
      }
      await upsertSlackWorkspace({ teamId, orgId, userId });
    }
  }

  const userRaw = process.env.SLACK_USER_BINDINGS?.trim();
  if (!userRaw) return;
  for (const entry of userRaw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":").map((part) => part.trim());
    const [teamId, slackUserId, orgId, userId] = parts;
    if (parts.length !== 4 || !teamId || !slackUserId || !orgId || !userId) {
      console.error(
        `[slack] skipping malformed SLACK_USER_BINDINGS entry "${trimmed}" ` +
          "(expected teamId:slackUserId:orgId:userId)",
      );
      continue;
    }
    await upsertSlackUser({ teamId, slackUserId, orgId, userId });
  }
}
