/**
 * A Slack sender the bot does not know yet. Instead of running their message as
 * somebody else, the bot records who asked, tells the workspace admins, and waits.
 * Allow creates the member (a new account when the address is new) and binds the
 * Slack sender to it, so their next message runs as themselves. Deny is remembered.
 *
 * Who an address belongs to is decided by evidence, not by typing. A sender who
 * already owns a binding here is that account. An address Slack itself reported
 * for the sender may match an existing account or create one, and the sender is
 * bound at once. An address an admin typed is only an invitation: the binding is
 * made when the person who owns that address accepts it on the web, so a typed
 * address can never claim somebody else's identity. Deny is remembered.
 */
import { and, eq, gt, isNull, lte, ne, notExists, or } from "drizzle-orm";
import { INVITATION_EXPIRES_IN_SECONDS, INVITATION_MAIL_TIMEOUT_MS, canSignIn, deliverInvitation, headerSafe } from "../auth-invitations";
import { claimCondition, createPersonalOrgForUser } from "../auth-hooks";
import { sendSmtp } from "../connectors/email/smtp";
import { db, type Executor } from "../db/client";
import { invitation, member, organization, user } from "../db/auth-schema";
import { slackAccessRequests, slackUsers, slackWorkspaces } from "../db/schema";
import { env, invitationMailConfig, providerSignInEnabled } from "../env";
import { withOrgLock } from "../org-lock";
import type { SlackClient } from "./client";
import { kickSlackOutbox } from "./outbox/delivery";
import { enqueuePostMessageTx } from "./outbox";
import { findActiveSlackUser, upsertSlackUser } from "./workspaces";

export type AccessRequestVerdict = "asked" | "waiting" | "invited" | "denied" | "already_in";

const roles = (value: string | null | undefined) => (value ?? "").split(",").map((role) => role.trim());
const manages = (role: string | null | undefined) => roles(role).some((r) => r === "owner" || r === "admin");
/** One rule for every address source: no whitespace or control characters, bounded, one @ with a dot after it. */
export function validEmail(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/.test(value)
  );
}

type InvitationState = "open" | "accepted" | "gone";

async function invitationState(id: string | null, exec: Executor): Promise<InvitationState> {
  if (!id) return "gone";
  const [row] = await exec
    .select({ status: invitation.status, expiresAt: invitation.expiresAt })
    .from(invitation)
    .where(eq(invitation.id, id))
    .limit(1);
  if (row?.status === "accepted") return "accepted";
  return row?.status === "pending" && row.expiresAt > new Date() ? "open" : "gone";
}


/** Record the request once and tell the admins who are reachable on Slack. The
 *  row and the notices commit together, so a failed notice is never lost behind
 *  a row that says "already asked". */
export async function requestSlackAccess(input: {
  teamId: string;
  slackUserId: string;
  orgId: string;
  /** The Slack message that asked; a retried delivery of it sends no second notice. */
  messageTs: string;
  client: SlackClient;
}): Promise<AccessRequestVerdict> {
  const sender = and(
    eq(slackAccessRequests.teamId, input.teamId),
    eq(slackAccessRequests.slackUserId, input.slackUserId),
    eq(slackAccessRequests.orgId, input.orgId),
  );
  const [existing] = await db
    .select({ id: slackAccessRequests.id, status: slackAccessRequests.status, email: slackAccessRequests.email, invitationId: slackAccessRequests.invitationId })
    .from(slackAccessRequests)
    .where(sender)
    .limit(1);
  if (existing?.status === "denied") return "denied";
  // A pending request that already carries Slack's word about the address needs
  // nothing more; one without it gets another look, in case the lookup failed.
  if (existing?.status === "pending" && existing.email) return "waiting";
  if (existing?.status === "invited") {
    const state = await invitationState(existing.invitationId, db);
    if (state === "open") return "invited";
    if (state === "accepted") return settleAccepted(input, existing.invitationId!);
  }

  const profile = (await input.client.userInfo?.({ user: input.slackUserId })) ?? null;
  const name = profile?.name ?? input.slackUserId;
  const email = validEmail(profile?.email) ? profile.email : null;
  const admins = await db
    .select({ slackUserId: slackUsers.slackUserId, role: member.role })
    .from(slackUsers)
    .innerJoin(member, and(eq(member.userId, slackUsers.userId), eq(member.organizationId, input.orgId)))
    .where(and(eq(slackUsers.teamId, input.teamId), eq(slackUsers.orgId, input.orgId)));
  const who = email ? `${name} (${email})` : name;
  const id = existing?.id ?? crypto.randomUUID();
  // The organisation's turn, then the transaction: an acceptance holds the same
  // turn from the library's write to the Slack binding, so nothing here can
  // reopen a request whose acceptance is half done.
  const verdict = await withOrgLock(input.orgId, () => db.transaction(async (tx): Promise<AccessRequestVerdict | "accepted_unbound"> => {
    const [locked] = existing
      ? await tx.select({ status: slackAccessRequests.status, invitationId: slackAccessRequests.invitationId }).from(slackAccessRequests).where(eq(slackAccessRequests.id, existing.id)).for("update")
      : [];
    if (locked?.status === "denied") return "denied";
    if (locked?.status === "pending") {
      // Whatever the lookup recovered this time is kept: a name and avatar
      // without an address still help the admins, and a null address stays
      // open for the next look.
      if (profile) {
        await tx.update(slackAccessRequests).set({ name, email, image: profile.image }).where(and(eq(slackAccessRequests.id, existing!.id), isNull(slackAccessRequests.email)));
      }
      return "waiting";
    }
    if (locked?.status === "invited") {
      const state = await invitationState(locked.invitationId, tx);
      if (state === "open") return "invited";
      if (state === "accepted") return "accepted_unbound";
    }
    if (locked?.status === "allowed") {
      // A stale event from before the decision must not reopen a live
      // membership; only a membership that is gone asks again.
      const active = await findActiveSlackUser(input.teamId, input.slackUserId, tx);
      if (active?.orgId === input.orgId) return "already_in";
    }
    if (locked) {
      // Allowed once and gone, or invited and the invitation lapsed: ask again,
      // keeping what was known about them unless the lookup brought more.
      await tx
        .update(slackAccessRequests)
        .set({ status: "pending", ...(profile ? { name, email, image: profile.image } : {}), invitationId: null, decidedBy: null, decidedAt: null })
        .where(eq(slackAccessRequests.id, existing!.id));
    } else {
      await tx.insert(slackAccessRequests).values({ id, teamId: input.teamId, slackUserId: input.slackUserId, orgId: input.orgId, name, email, image: profile?.image ?? null });
    }
    for (const admin of admins) {
      if (!manages(admin.role)) continue;
      await enqueuePostMessageTx(tx, {
        idempotencyKey: `slack-access-request:${id}:${admin.slackUserId}:${input.messageTs}`,
        orgId: input.orgId,
        teamId: input.teamId,
        channel: admin.slackUserId,
        text: `${who} asked to use UseAgent from Slack. Let them in or not: ${env.FRONTEND_ORIGIN}/settings#team`,
      });
    }
    return "asked";
  }));
  if (verdict === "accepted_unbound") return settleAccepted(input, existing!.invitationId!);
  if (verdict === "asked") kickSlackOutbox();
  return verdict;
}

/** An invitation accepted while the request still says invited (a message
 *  landed between the library's acceptance and our binding): finish the binding now. */
async function settleAccepted(
  input: { teamId: string; slackUserId: string; orgId: string },
  invitationId: string,
): Promise<AccessRequestVerdict> {
  // The organisation's turn: acceptance holds it from the library's write to
  // the binding, so by the time this runs an acceptance has finished with every
  // linked request. One still marked invited was never confirmed by the
  // acceptor (or the acceptance broke off): nobody has agreed to let this
  // sender act as that person, so the admins decide again.
  return withOrgLock(input.orgId, async () => {
    const state = await invitationState(invitationId, db);
    if (state === "open") return "invited";
    const active = await findActiveSlackUser(input.teamId, input.slackUserId);
    if (active?.orgId === input.orgId) return "already_in";
    await reopenInvitedRequest(invitationId);
    return "waiting";
  });
}

export interface AccessRequestRow {
  id: string;
  slackUserId: string;
  name: string;
  email: string | null;
  image: string | null;
  /** The address of the account this sender already owns here (let in before,
   *  membership since removed): Allow restores that account, nothing else. */
  account: string | null;
  createdAt: string;
}

export async function listAccessRequests(orgId: string): Promise<AccessRequestRow[]> {
  // An invitation cancelled, rejected, expired or deleted leaves its request
  // marked invited and invisible: bring such requests back before listing.
  await withOrgLock(orgId, async () => {
    const stale = await db
      .select({ id: slackAccessRequests.id, invitationId: slackAccessRequests.invitationId })
      .from(slackAccessRequests)
      .leftJoin(invitation, eq(invitation.id, slackAccessRequests.invitationId))
      .where(
        and(
          eq(slackAccessRequests.orgId, orgId),
          eq(slackAccessRequests.status, "invited"),
          or(isNull(invitation.id), and(ne(invitation.status, "accepted"), or(ne(invitation.status, "pending"), lte(invitation.expiresAt, new Date())))),
        ),
      );
    for (const row of stale) {
      // Only the link that was inspected: a replacement attached meanwhile stays.
      await db
        .update(slackAccessRequests)
        .set({ status: "pending", invitationId: null, decidedBy: null, decidedAt: null })
        .where(
          and(
            eq(slackAccessRequests.id, row.id),
            eq(slackAccessRequests.status, "invited"),
            row.invitationId === null ? isNull(slackAccessRequests.invitationId) : eq(slackAccessRequests.invitationId, row.invitationId),
          ),
        );
    }
  });
  const rows = await db
    .select({
      id: slackAccessRequests.id,
      slackUserId: slackAccessRequests.slackUserId,
      name: slackAccessRequests.name,
      email: slackAccessRequests.email,
      image: slackAccessRequests.image,
      account: user.email,
      createdAt: slackAccessRequests.createdAt,
    })
    .from(slackAccessRequests)
    // Only while the workspace still belongs here: a request from a workspace
    // since rebound to another org can no longer be answered by this one.
    .innerJoin(slackWorkspaces, and(eq(slackWorkspaces.teamId, slackAccessRequests.teamId), eq(slackWorkspaces.orgId, slackAccessRequests.orgId)))
    .leftJoin(
      slackUsers,
      and(eq(slackUsers.teamId, slackAccessRequests.teamId), eq(slackUsers.slackUserId, slackAccessRequests.slackUserId), eq(slackUsers.orgId, slackAccessRequests.orgId)),
    )
    .leftJoin(user, eq(user.id, slackUsers.userId))
    .where(and(eq(slackAccessRequests.orgId, orgId), eq(slackAccessRequests.status, "pending")))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export type AccessDecision = "allowed" | "invited" | "denied" | "not_found" | "email_required" | "email_invalid" | "no_way_in";

/** Allow or deny a pending request, in one transaction on a locked row, so two
 *  admins answering at once cannot leave a denied sender bound. */
export interface Decision {
  outcome: AccessDecision;
  /** Mail to send once the caller has released the organisation's turn. */
  deliver?: () => Promise<void>;
}

export async function decideAccessRequest(input: {
  id: string;
  orgId: string;
  decidedBy: { id: string; name: string; email: string };
  allow: boolean;
  email?: string | null;
}): Promise<Decision> {
  const typed = (input.email ?? "").trim().toLowerCase();
  if (typed && !validEmail(typed)) return { outcome: "email_invalid" };
  // Checked before the transaction: inside it, with rows locked, a second
  // pool connection for this read could wait on the first and stall everyone.
  const typedCanSignIn = typed ? await canSignIn(typed) : false;
  let invited: { id: string; email: string; expiresAt: Date } | null = null;
  const outcome = await db.transaction(async (tx): Promise<AccessDecision> => {
    const [pending] = await tx
      .select({ teamId: slackAccessRequests.teamId })
      .from(slackAccessRequests)
      .where(and(eq(slackAccessRequests.id, input.id), eq(slackAccessRequests.orgId, input.orgId), eq(slackAccessRequests.status, "pending")))
      .limit(1);
    if (!pending) return "not_found";
    // Workspace first, then the request: a rebinding to another org waits for
    // this decision, and a workspace already rebound keeps nothing from here.
    const [workspace] = await tx
      .select({ orgId: slackWorkspaces.orgId })
      .from(slackWorkspaces)
      .where(eq(slackWorkspaces.teamId, pending.teamId))
      .for("update");
    if (workspace?.orgId !== input.orgId) return "not_found";
    const [row] = await tx
      .select()
      .from(slackAccessRequests)
      .where(and(eq(slackAccessRequests.id, input.id), eq(slackAccessRequests.orgId, input.orgId), eq(slackAccessRequests.status, "pending")))
      .for("update");
    if (!row) return "not_found";
    const decided = { decidedBy: input.decidedBy.id, decidedAt: new Date() };
    if (!input.allow) {
      await tx.update(slackAccessRequests).set({ status: "denied", ...decided }).where(eq(slackAccessRequests.id, row.id));
      return "denied";
    }

    const userId = await provenIdentity(tx, row);
    if (!userId) {
      // Only the admin's word about the address: an invitation, which binds the
      // sender when the address's owner accepts it on the web.
      if (!typed) return "email_required";
      if (!typedCanSignIn) return "no_way_in";
      // An invitation this address already holds here is the one to accept:
      // a second one would leave the first stranded once the person is a member.
      const [open] = await tx
        .select({ id: invitation.id })
        .from(invitation)
        .where(and(eq(invitation.organizationId, input.orgId), eq(invitation.email, typed), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
        .limit(1);
      if (open) {
        await tx.update(slackAccessRequests).set({ status: "invited", invitationId: open.id, ...decided }).where(eq(slackAccessRequests.id, row.id));
        return "invited";
      }
      invited = { id: crypto.randomUUID(), email: typed, expiresAt: new Date(Date.now() + INVITATION_EXPIRES_IN_SECONDS * 1000) };
      await tx.insert(invitation).values({ ...invited, organizationId: input.orgId, role: "member", status: "pending", inviterId: input.decidedBy.id });
      // The typed address stays on the invitation; the request keeps only what
      // Slack said, so a lapsed invitation never turns typing into evidence.
      await tx.update(slackAccessRequests).set({ status: "invited", invitationId: invited.id, ...decided }).where(eq(slackAccessRequests.id, row.id));
      return "invited";
    }
    await admit(tx, { orgId: input.orgId, teamId: row.teamId, slackUserId: row.slackUserId, userId }, `${row.id}:${decided.decidedAt.getTime()}`);
    await tx.update(slackAccessRequests).set({ status: "allowed", ...decided }).where(eq(slackAccessRequests.id, row.id));
    return "allowed";
  });
  if (outcome === "allowed") {
    kickSlackOutbox();
    return { outcome, deliver: () => welcome(input.orgId, input.id) };
  }
  if (outcome === "invited" && invited) {
    const sent: { id: string; email: string; expiresAt: Date } = invited;
    return {
      outcome,
      deliver: async () => {
        const [org] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, input.orgId)).limit(1);
        try {
          await deliverInvitation({
            id: sent.id,
            email: sent.email,
            role: "member",
            organization: { name: org?.name ?? "" },
            invitation: { expiresAt: sent.expiresAt },
            inviter: { user: { name: input.decidedBy.name, email: input.decidedBy.email } },
          });
        } catch (error) {
          console.error(`[slack] invitation ${sent.id} could not be sent:`, (error as Error).message);
        }
      },
    };
  }
  return { outcome };
}

/** The person who accepted an invitation an admin sent on a Slack sender's
 *  behalf now owns that sender: bind them and tell them on Slack. */
export interface LinkedSlackSender {
  readonly id: string;
  readonly name: string;
  readonly teamId: string;
}

/** The Slack senders an acceptance of this invitation would let act as the
 *  recipient. Shown before accepting; the acceptance names the same ids. */
export async function linkedSlackSenders(invitationId: string): Promise<LinkedSlackSender[]> {
  return db
    .select({ id: slackAccessRequests.id, name: slackAccessRequests.name, teamId: slackAccessRequests.teamId })
    .from(slackAccessRequests)
    .where(and(eq(slackAccessRequests.invitationId, invitationId), eq(slackAccessRequests.status, "invited")));
}

export type InvitedBinding = "bound" | "no_membership" | "none";

export async function bindInvitedSlackSender(invitationId: string, userId: string, confirmed: readonly string[]): Promise<InvitedBinding> {
  const bound = await db.transaction(async (tx): Promise<InvitedBinding> => {
    // Several senders may share one invitation (one address, several workspaces);
    // each linked request is judged on its own, by its exact id. Only the senders
    // the acceptor saw and confirmed are bound; any other goes back to the
    // admins, since nobody has agreed to let it act as this person.
    const linked = await tx
      .select({ id: slackAccessRequests.id, teamId: slackAccessRequests.teamId, orgId: slackAccessRequests.orgId })
      .from(slackAccessRequests)
      .where(and(eq(slackAccessRequests.invitationId, invitationId), eq(slackAccessRequests.status, "invited")));
    if (!linked.length) return "none";
    let result: InvitedBinding = "none";
    for (const candidate of linked) {
      if (!confirmed.includes(candidate.id)) {
        await tx
          .update(slackAccessRequests)
          .set({ status: "pending", invitationId: null, decidedBy: null, decidedAt: null })
          .where(and(eq(slackAccessRequests.id, candidate.id), eq(slackAccessRequests.status, "invited")));
        continue;
      }
      // Workspace first, then the request, as in decideAccessRequest: an old
      // invitation must not overwrite the binding a rebound workspace made.
      const [workspace] = await tx
        .select({ orgId: slackWorkspaces.orgId })
        .from(slackWorkspaces)
        .where(eq(slackWorkspaces.teamId, candidate.teamId))
        .for("update");
      if (workspace?.orgId !== candidate.orgId) continue; // this workspace moved on
      const [row] = await tx
        .select()
        .from(slackAccessRequests)
        .where(and(eq(slackAccessRequests.id, candidate.id), eq(slackAccessRequests.status, "invited")))
        .for("update");
      if (!row) continue;
      // Acceptance binds a membership that exists; it never creates one.
      const [membership] = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, row.orgId), eq(member.userId, userId)))
        .limit(1);
      if (!membership) {
        result = "no_membership";
        continue;
      }
      // The sender may have become somebody else here in the meantime (let in
      // again as another account whose membership is live): that identity
      // stands, and the old invitation only closes the request.
      const current = await findActiveSlackUser(row.teamId, row.slackUserId, tx);
      if (current?.orgId === row.orgId && current.userId !== userId) {
        await tx.update(slackAccessRequests).set({ status: "allowed" }).where(eq(slackAccessRequests.id, row.id));
        result = "bound";
        continue;
      }
      await bind(tx, { orgId: row.orgId, teamId: row.teamId, slackUserId: row.slackUserId, userId }, `${row.id}:${invitationId}`);
      await tx.update(slackAccessRequests).set({ status: "allowed" }).where(eq(slackAccessRequests.id, row.id));
      result = "bound";
    }
    return result;
  });
  if (bound === "bound") kickSlackOutbox();
  return bound;
}

/** An accepted invitation whose membership is gone again (removed in between)
 *  leaves nothing to bind: the request goes back to the admins' list. */
export async function reopenInvitedRequest(invitationId: string): Promise<void> {
  await db
    .update(slackAccessRequests)
    .set({ status: "pending", invitationId: null, decidedBy: null, decidedAt: null })
    .where(and(eq(slackAccessRequests.invitationId, invitationId), eq(slackAccessRequests.status, "invited")));
}

/** An invitation sent for a Slack sender to someone who is already a member
 *  here cannot go through the library, which would insert a second membership.
 *  The matching, signed-in recipient consumes it directly and keeps their
 *  membership; anyone else is left to the library's own checks. */
export async function acceptLinkedInvitationAsMember(
  invitationId: string,
  who: { id: string; email: string },
  confirmed: readonly string[],
): Promise<string | null> {
  const consumed = await db.transaction(async (tx): Promise<string | null> => {
    const [row] = await tx
      .select({ id: invitation.id, email: invitation.email, role: invitation.role, organizationId: invitation.organizationId })
      .from(invitation)
      .innerJoin(slackAccessRequests, and(eq(slackAccessRequests.invitationId, invitation.id), eq(slackAccessRequests.status, "invited")))
      .where(and(eq(invitation.id, invitationId), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
      .for("update", { of: invitation })
      .limit(1);
    if (!row || row.email.toLowerCase() !== who.email.toLowerCase()) return null;
    const [membership] = await tx
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, row.organizationId), eq(member.userId, who.id)))
      .limit(1);
    if (!membership) return null;
    await tx.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, row.id));
    // The invitation's promise counts here as it would through the library.
    const promised = strongest(row.role);
    if (RANK[promised]! > RANK[strongest(membership.role)]!) {
      await tx.update(member).set({ role: promised }).where(eq(member.id, membership.id));
    }
    return row.organizationId;
  });
  if (!consumed) return null;
  if ((await bindInvitedSlackSender(invitationId, who.id, confirmed)) === "no_membership") await reopenInvitedRequest(invitationId);
  return consumed;
}

/** An admin's Allow: the member row if missing, then the binding. Only this path creates membership. */
async function admit(tx: Executor, input: { orgId: string; teamId: string; slackUserId: string; userId: string }, decision: string): Promise<void> {
  const [membership] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, input.orgId), eq(member.userId, input.userId)))
    .limit(1);
  if (!membership) {
    await tx.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: input.orgId, userId: input.userId, role: "member", createdAt: new Date() });
  }
  await bind(tx, input, decision);
}

/** The binding and the Slack reply, in the caller's transaction. The reply is
 *  keyed by the decision, so a retry of it says nothing twice and a later
 *  re-admission is announced again. */
async function bind(tx: Executor, input: { orgId: string; teamId: string; slackUserId: string; userId: string }, decision: string): Promise<void> {
  await upsertSlackUser({ teamId: input.teamId, slackUserId: input.slackUserId, orgId: input.orgId, userId: input.userId }, tx);
  // The person is a member now: any other invitation this address still holds here is settled, a promised higher role applied.
  await settleInvitationsFor(tx, input.orgId, input.userId);
  await enqueuePostMessageTx(tx, {
    idempotencyKey: `slack-access-allowed:${decision}`,
    orgId: input.orgId,
    teamId: input.teamId,
    channel: input.slackUserId,
    text: "You are in. Mention me again and I will get to work.",
  });
}

const RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };
const strongest = (value: string | null | undefined) =>
  roles(value).reduce((best, role) => ((RANK[role] ?? -1) > (RANK[best] ?? -1) ? role : best), "member");

/** Other live invitations the address holds here once the person is a member:
 *  marked accepted, and a promised higher role applied rather than left in a
 *  link nobody can accept any more. */
async function settleInvitationsFor(tx: Executor, orgId: string, userId: string): Promise<void> {
  const [account] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  if (!account) return;
  // An invitation another Slack sender is still waiting on (a typed address,
  // awaiting the address owner's acceptance on the web) is left alone: settling
  // it here would let that sender in on the strength of somebody else's admission.
  const open = await tx
    .select({ id: invitation.id, role: invitation.role })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, orgId),
        eq(invitation.email, account.email.toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
        notExists(
          tx
            .select({ id: slackAccessRequests.id })
            .from(slackAccessRequests)
            .where(and(eq(slackAccessRequests.invitationId, invitation.id), eq(slackAccessRequests.status, "invited"))),
        ),
      ),
    );
  if (!open.length) return;
  const [membership] = await tx
    .select({ id: member.id, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  const promised = open.map((row) => strongest(row.role)).reduce((best, role) => (RANK[role]! > RANK[best]! ? role : best), "member");
  if (membership && RANK[promised]! > RANK[strongest(membership.role)]!) {
    await tx.update(member).set({ role: promised }).where(eq(member.id, membership.id));
  }
  for (const row of open) await tx.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, row.id));
}

type Request = typeof slackAccessRequests.$inferSelect;

/** The account this sender provably is, or null when only an admin's typing says who they are. */
async function provenIdentity(tx: Executor, row: Request): Promise<string | null> {
  const [bound] = await tx
    .select({ userId: slackUsers.userId })
    .from(slackUsers)
    .innerJoin(user, eq(user.id, slackUsers.userId)) // a binding to a deleted account is no identity
    .where(and(eq(slackUsers.teamId, row.teamId), eq(slackUsers.slackUserId, row.slackUserId), eq(slackUsers.orgId, row.orgId)))
    .limit(1);
  if (bound) return bound.userId; // the account this sender already owns here
  if (!validEmail(row.email)) return null; // nothing from Slack about the address
  // An account this address already has is adopted only when it is a person's.
  // A claim (an open sign-up that never confirmed the address) is released
  // under its row lock and a fresh account takes its place, so the person
  // admitted never inherits a stranger's password, and nothing can slip a new
  // claim in between the look and the choice. Another organisation may be
  // creating this very address at the same moment; whoever lands first owns
  // the row, and both admissions use it. The winner also gets what a sign-up
  // gives: a workspace of their own, so that being removed from this one later
  // never leaves them with nowhere to stand.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.email, row.email)).for("update");
    if (existing) {
      const [claim] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, existing.id), claimCondition)).limit(1);
      if (!claim) return existing.id;
      await tx.delete(user).where(eq(user.id, claim.id));
    }
    const [won] = await tx
      .insert(user)
      .values({ id: crypto.randomUUID(), name: row.name, email: row.email, emailVerified: false, image: row.image })
      .onConflictDoNothing({ target: user.email })
      .returning({ id: user.id });
    if (won) {
      await createPersonalOrgForUser({ id: won.id, name: row.name, email: row.email }, tx);
      return won.id;
    }
    // A creation landed in between: look at it under the lock and decide again.
  }
  return null; // lost every turn to creations landing in between; the admin can decide again
}

/** Best effort, and only when the web has a way for them in: a Google or
 *  OpenID Connect sign-in with this address links the account. Self sign-up
 *  cannot, the address is taken. The person can already work from Slack
 *  either way. */
async function welcome(orgId: string, requestId: string): Promise<void> {
  const config = invitationMailConfig();
  if (!config || !providerSignInEnabled()) return;
  const [row] = await db
    .select({ email: slackAccessRequests.email, userId: slackUsers.userId })
    .from(slackAccessRequests)
    .innerJoin(slackUsers, and(eq(slackUsers.teamId, slackAccessRequests.teamId), eq(slackUsers.slackUserId, slackAccessRequests.slackUserId), eq(slackUsers.orgId, slackAccessRequests.orgId)))
    .where(eq(slackAccessRequests.id, requestId))
    .limit(1);
  if (!row) return;
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, row.userId)).limit(1);
  const [org] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1);
  const workspace = headerSafe(org?.name ?? "") || "your workspace";
  if (!account) return;
  try {
    await sendSmtp(
      { host: config.host, port: config.port, secure: config.secure, user: config.user, pass: config.pass, timeoutMs: INVITATION_MAIL_TIMEOUT_MS },
      {
        from: config.from,
        to: [account.email],
        subject: `You can now use ${workspace} on UseAgent`,
        text: [`An admin let you into ${workspace} on UseAgent.`, "", `Sign in with this email address: ${env.FRONTEND_ORIGIN}/login`].join("\n"),
      },
    );
  } catch (error) {
    console.error(`[slack] welcome mail for request ${requestId} failed:`, (error as Error).message);
  }
}
