import { and, eq, gt, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../auth";
import { INVITATION_EXPIRES_IN_SECONDS, NO_WAY_IN, canSignIn, deliverInvitation } from "../auth-invitations";
import { acceptLinkedInvitationAsMember, bindInvitedSlackSender, linkedSlackSenders, reopenInvitedRequest } from "../slack/access-requests";
import { db } from "../db/client";
import { invitation, member, organization, user } from "../db/auth-schema";
import { allowDevOrg, betterAuthTrustedOrigins, googleAuthEnabled, invitationMailEnabled, oidcAuthConfig, openSignupConfig } from "../env";
import type { AppEnv } from "../http";
import { operatorAccessAllowed } from "../operator/access";
import { withOrgLock } from "../org-lock";
import { createSignupRoutes, fixedWindow, jsonBody, withJsonBody } from "./signup-routes";

/** Session reads are renderer-reachable (the desktop copies the HttpOnly
 *  cookie into Chromium), so every token-like field leaves the JSON here. */
function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !/token/i.test(key)).map(([key, item]) => [key, withoutTokens(item)]),
    );
  }
  return value;
}

async function redactSessionTokens(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(withoutTokens(await response.json())), { status: response.status, headers });
}

const routes = new Hono<AppEnv>();
routes.get("/api/auth/provider-config", (c) => {
  const open = openSignupConfig();
  const oidc = oidcAuthConfig();
  return c.json({
    google: googleAuthEnabled(),
    // OpenID Connect sign-in: only the button's label; the issuer and client
    // stay on the server.
    oidc: oidc ? { label: oidc.label } : null,
    emailPassword: true,
    allowDevOrg: allowDevOrg(),
    invitationEmail: invitationMailEnabled(),
    // Open sign-up: whether the card offers it, asks for an invite code, and
    // which domains it admits. The code itself never leaves the server.
    signup: open ? { inviteCode: open.inviteCode !== "", domains: open.domains } : null,
  });
});
routes.on("GET", ["/api/auth/get-session", "/api/auth/list-sessions"], async (c) =>
  redactSessionTokens(await auth.handler(c.req.raw)),
);
/** Only the native main process may exchange an authorization code for a
 *  session token. Browsers always send their web Origin on a POST and cannot
 *  forge it, so a renderer holding the copied cookie never reaches the exchange. */
routes.post("/api/auth/electron/token", async (c) => {
  const origin = c.req.header("origin") ?? c.req.header("electron-origin");
  if (origin !== "useagent:/") return c.json({ message: "Desktop token exchange requires the native app." }, 403);
  return auth.handler(c.req.raw);
});
const ROLE_MESSAGE = "Role must be owner, admin or member";
const exactRole = (value: unknown): boolean => value === "owner" || value === "admin" || value === "member";

/** The library's rule: the origin header, else the referer; http(s) values match
 *  by origin, the desktop scheme by prefix; missing or the literal "null" fails. */
function trustedOrigin(request: Request): boolean {
  const value = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!value || value === "null") return false;
  const trusted = betterAuthTrustedOrigins();
  if (/^https?:\/\//i.test(value)) {
    try {
      return trusted.includes(new URL(value).origin);
    } catch {
      return false;
    }
  }
  return trusted.some((pattern) => value.startsWith(pattern));
}

const roles = (value: string | null | undefined) => (value ?? "").split(",").map((role) => role.trim());

type Refusal = { status: 400 | 401 | 403 | 429; message: string };
type Manager = { session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>; organizationId: string; roles: string[] };

/** The signed-in owner or admin behind a request, for the organisation it names
 *  or the session's active one. Refusals come before any invitation is read, so
 *  an outsider gets one answer whatever exists. */
async function managerFor(request: Request, body: Record<string, unknown>, least: "manager" | "member" = "manager"): Promise<Manager | Refusal> {
  if (!trustedOrigin(request)) return { status: 403, message: "Invalid origin" };
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { status: 401, message: "Not authenticated" };
  const organizationId =
    typeof body.organizationId === "string" && body.organizationId.trim()
      ? body.organizationId.trim()
      : session.session.activeOrganizationId ?? null;
  if (!organizationId) return { status: 400, message: "Organization not found" };
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1);
  const mine = roles(membership?.role);
  // One answer for an outsider and for a member without the rank, so nobody
  // learns from the difference who belongs to the workspace.
  if (least === "manager" && !mine.includes("owner") && !mine.includes("admin")) {
    return { status: 403, message: "You are not allowed to invite people to this workspace" };
  }
  if (!membership) return { status: 403, message: "You are not a member of this workspace" };
  return { session, organizationId, roles: mine };
}

/** The request the library sees names the organisation that was locked, so a
 *  workspace switch in between cannot move the change elsewhere. */
function pinned(request: Request, body: Record<string, unknown>, organizationId: string): Request {
  return withJsonBody(request, { ...body, organizationId });
}

const LAST_OWNER = "A workspace needs at least one owner. Make someone else an owner first.";

/** Whether the member (by id, or by email for remove-member) is the organisation's only owner. */
async function onlyOwner(organizationId: string, target: { memberId?: string; email?: string; userId?: string }): Promise<boolean> {
  const owners = await db
    .select({ id: member.id, userId: member.userId, email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId));
  const owning = owners.filter((row) => roles(row.role).includes("owner"));
  if (owning.length !== 1) return false;
  const [only] = owning;
  return (
    only!.id === target.memberId ||
    only!.userId === target.userId ||
    (target.email !== undefined && only!.email.toLowerCase() === target.email.toLowerCase())
  );
}

/** The organisation a request is about, for the lock key only: the body's, else
 *  the session's active one. Authorisation happens inside the lock. */
async function organisationOf(request: Request, body: Record<string, unknown>): Promise<string | null> {
  if (typeof body.organizationId === "string" && body.organizationId.trim()) return body.organizationId.trim();
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.session.activeOrganizationId ?? null;
}

/** The same trimming gap applies when a role is changed, and taking ownership
 *  away from the last owner is refused. The manager check comes first, so
 *  nobody else learns who owns what, and only real managers take the lock. */
routes.post("/api/auth/organization/update-member-role", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body) return auth.handler(request);
  if (body.role !== undefined && !exactRole(body.role)) return c.json({ message: ROLE_MESSAGE }, 400);
  const organizationId = await organisationOf(request, body);
  if (!organizationId) return c.json({ message: "Organization not found" }, 400);
  return withOrgLock(organizationId, async () => {
    // Authorised inside the lock: a removal that finished just before this
    // turn is seen, and a manager removed meanwhile gets nothing done. Only
    // the last-owner check is skipped when ownership is being handed out.
    const manager = await managerFor(request, { ...body, organizationId });
    if ("status" in manager) return c.json({ message: manager.message }, manager.status);
    if (body.role !== "owner" && typeof body.memberId === "string" && (await onlyOwner(organizationId, { memberId: body.memberId }))) {
      return c.json({ message: LAST_OWNER }, 400);
    }
    return auth.handler(pinned(request, body, organizationId));
  });
});

routes.post("/api/auth/organization/remove-member", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body) return auth.handler(request);
  const organizationId = await organisationOf(request, body);
  if (!organizationId) return c.json({ message: "Organization not found" }, 400);
  return withOrgLock(organizationId, async () => {
    const manager = await managerFor(request, { ...body, organizationId });
    if ("status" in manager) return c.json({ message: manager.message }, manager.status);
    const target = typeof body.memberIdOrEmail === "string" ? body.memberIdOrEmail : "";
    if (target && (await onlyOwner(organizationId, { memberId: target, email: target }))) {
      return c.json({ message: LAST_OWNER }, 400);
    }
    return auth.handler(pinned(request, body, organizationId));
  });
});

routes.post("/api/auth/organization/leave", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body) return auth.handler(request);
  const organizationId = await organisationOf(request, body);
  if (!organizationId) return c.json({ message: "Organization not found" }, 400);
  return withOrgLock(organizationId, async () => {
    const leaver = await managerFor(request, { ...body, organizationId }, "member");
    if ("status" in leaver) return c.json({ message: leaver.message }, leaver.status);
    if (await onlyOwner(organizationId, { userId: leaver.session.user.id })) return c.json({ message: LAST_OWNER }, 400);
    return auth.handler(pinned(request, body, organizationId));
  });
});

const RESEND_WINDOW_MS = 60_000;
const resendAllowed = fixedWindow(1, RESEND_WINDOW_MS);

/** Every invitation, new or resent, is a mail from our domain with a name the
 *  inviter typed in it. A day's worth per workspace and per inviter bounds what
 *  one free account can send; the deployment's operators are not counted. */
const DAY_MS = 24 * 60 * 60_000;
function dailyInviteCap(name: string): number {
  const value = Number(process.env[name]?.trim() || 20);
  return Number.isInteger(value) && value > 0 ? value : 20;
}
const invitesPerOrg = fixedWindow(dailyInviteCap("INVITES_PER_ORG_PER_DAY"), DAY_MS);
const invitesPerUser = fixedWindow(dailyInviteCap("INVITES_PER_USER_PER_DAY"), DAY_MS);

function overDailyInvites(manager: Manager): Refusal | null {
  if (operatorAccessAllowed(manager.session.user.email)) return null;
  if (invitesPerOrg(manager.organizationId) > 0 || invitesPerUser(manager.session.user.id) > 0) {
    return { status: 429, message: "That is all the invitations that can go out today. Try again tomorrow." };
  }
  return null;
}

/** A resend renews the invitation that already exists, with the role stored on
 *  it, never the role the request names. It is answered here in full instead of
 *  being forwarded, so nothing can change between the check and the renewal.
 *  Membership is checked before any invitation is read, so an outsider learns
 *  nothing about a workspace's invitations from the answer. */
routes.post("/api/auth/organization/invite-member", async (c) => {
  const request = c.req.raw;
  const text = await request.clone().text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return auth.handler(request); // better-auth answers malformed bodies itself
  }
  if (body.resend !== true || typeof body.email !== "string") {
    // The library trims role tokens when it validates them but stores the raw
    // string, so "admin, owner" passes as admin and lands as owner. One exact role.
    if (body.role !== undefined && !exactRole(body.role)) return c.json({ message: ROLE_MESSAGE }, 400);
    if (typeof body.email !== "string") return auth.handler(request);
    const organizationId = await organisationOf(request, body);
    if (!organizationId) return c.json({ message: "Organization not found" }, 400);
    // One invitation change at a time per organisation, the same lock acceptance,
    // cancellation and rejection take: the library checks for a member and a
    // pending invitation and then inserts, and a creation racing an acceptance
    // or another creation would otherwise hand out a second link. The manager
    // check runs inside, whatever the address, so nobody else can tell from the
    // answer which addresses can sign in. Mail is not awaited by the library.
    return withOrgLock(organizationId, async () => {
      const manager = await managerFor(request, { ...body, organizationId });
      if ("status" in manager) return c.json({ message: manager.message }, manager.status);
      if (!(await canSignIn(body.email as string))) return c.json({ message: NO_WAY_IN }, 400);
      const capped = overDailyInvites(manager);
      if (capped) return c.json({ message: capped.message }, capped.status);
      return auth.handler(pinned(request, body, organizationId));
    });
  }
  const organizationId = await organisationOf(request, body);
  if (!organizationId) return c.json({ message: "Organization not found" }, 400);
  const outcome = await withOrgLock(organizationId, async () => {
    const manager = await managerFor(request, { ...body, organizationId });
    if ("status" in manager) return manager;
    if (!(await canSignIn(body.email as string))) return { status: 400 as const, message: NO_WAY_IN };
    return renew(manager, body.email as string);
  });
  if ("status" in outcome) return c.json({ message: outcome.message }, outcome.status);
  // Delivered after the organisation's turn is over, so a slow relay holds nobody up.
  try {
    await deliverInvitation(outcome.delivery);
  } catch (error) {
    // The invitation is renewed either way and the link still works; the mail is best effort.
    console.error(`[auth] invitation ${outcome.renewed.id} could not be resent:`, (error as Error).message);
  }
  return c.json(outcome.renewed);
});

type Renewal = { renewed: typeof invitation.$inferSelect; delivery: Parameters<typeof deliverInvitation>[0] };

async function renew(manager: Manager, email: string): Promise<Renewal | Refusal> {
  const { session, organizationId, roles: mine } = manager;
  const live = await db
    .select({ id: invitation.id, role: invitation.role })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.email, email.trim().toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    );
  if (live.some((row) => roles(row.role).includes("owner")) && !mine.includes("owner")) {
    return { status: 403, message: "Only an owner can resend an owner invitation" };
  }
  // Answered outside the library, so its request limiter does not apply; one
  // resend per address and organisation per minute bounds the mail it can cause.
  if (live.length && resendAllowed(`${organizationId}:${email.trim().toLowerCase()}`) > 0) {
    return { status: 429, message: "That invitation was resent less than a minute ago. Try again shortly." };
  }
  const capped = live.length ? overDailyInvites(manager) : null;
  if (capped) return capped;
  const [renewed] = live.length
    ? await db
        .update(invitation)
        .set({ expiresAt: new Date(Date.now() + INVITATION_EXPIRES_IN_SECONDS * 1000) })
        .where(and(inArray(invitation.id, live.map((row) => row.id)), eq(invitation.status, "pending")))
        .returning()
    : [];
  if (!renewed) return { status: 400, message: "No pending invitation for that address" };
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return {
    renewed,
    delivery: {
      id: renewed.id,
      email: renewed.email,
      role: renewed.role ?? "member",
      organization: { name: org?.name ?? "" },
      invitation: { expiresAt: renewed.expiresAt },
      inviter: { user: { name: session.user.name, email: session.user.email } },
    },
  };
}

/** Cancelling is an atomic pending-to-canceled step under the organisation's
 *  lock, so an invitation that acceptance has already claimed stays accepted
 *  and the answer says so, instead of a canceled row beside a new member. */
routes.post("/api/auth/organization/cancel-invitation", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body || typeof body.invitationId !== "string") return auth.handler(request);
  const [target] = await db
    .select({ organizationId: invitation.organizationId })
    .from(invitation)
    .where(eq(invitation.id, body.invitationId))
    .limit(1);
  if (!target) return auth.handler(request); // the library reports the unknown id
  return withOrgLock(target.organizationId, async () => {
    const manager = await managerFor(request, { ...body, organizationId: target.organizationId });
    if ("status" in manager) return c.json({ message: manager.message }, manager.status);
    const [canceled] = await db
      .update(invitation)
      .set({ status: "canceled" })
      .where(and(eq(invitation.id, body.invitationId as string), eq(invitation.organizationId, manager.organizationId), eq(invitation.status, "pending")))
      .returning();
    if (!canceled) return c.json({ message: "That invitation is no longer open: it was accepted or already cancelled." }, 409);
    return c.json(canceled);
  });
});

/** Rejection runs under the organisation's lock too, so it cannot interleave
 *  with a cancellation, a creation or an owner change. Acceptance has its own
 *  handler below, under the same lock. */
for (const path of ["/api/auth/organization/reject-invitation"]) {
  routes.post(path, async (c) => {
    const request = c.req.raw;
    const body = await jsonBody(request);
    if (!body || typeof body.invitationId !== "string") return auth.handler(request);
    const [target] = await db
      .select({ organizationId: invitation.organizationId })
      .from(invitation)
      .where(eq(invitation.id, body.invitationId))
      .limit(1);
    if (!target) return auth.handler(request);
    return withOrgLock(target.organizationId, () => auth.handler(request));
  });
}
/** The invitation a link points at, for the person it was sent to. better-auth's
 *  own preview refuses once the inviter has left the organisation, although the
 *  invitation itself still accepts; this one checks only what matters: a
 *  signed-in recipient, a pending invitation that has not expired. */
routes.get("/api/auth/invitation-preview", async (c) => {
  const id = c.req.query("id")?.trim();
  if (!id) return c.json({ message: "Invitation not found" }, 404);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ message: "Not authenticated" }, 401);
  const [row] = await db
    .select({
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organizationName: organization.name,
      inviterEmail: user.email,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .leftJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, id))
    .limit(1);
  if (!row || row.status !== "pending" || row.expiresAt <= new Date()) {
    return c.json({ message: "Invitation not found" }, 404);
  }
  if (row.email.toLowerCase() !== session.user.email.toLowerCase()) {
    return c.json({ message: "You are not the recipient of the invitation" }, 403);
  }
  return c.json({
    email: row.email,
    role: row.role ?? "member",
    organizationName: row.organizationName,
    inviterEmail: row.inviterEmail,
    expiresAt: row.expiresAt.toISOString(),
    // Accepting also lets these Slack senders act as the recipient; the
    // acceptance must name the same ids, so nothing attached later is covered.
    slackSenders: await linkedSlackSenders(id),
  });
});
/** Acceptance runs under the organisation's lock, the direct path, the library
 *  and the Slack binding together, so nothing about the organisation moves in
 *  between: a Slack message cannot reopen the request while the library is
 *  still writing the membership. Accepting an invitation an admin sent on a
 *  Slack sender's behalf binds that sender to the account that accepted: the
 *  address's owner has proven it. */
routes.post("/api/auth/organization/accept-invitation", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body || typeof body.invitationId !== "string") return auth.handler(request);
  const invitationId = body.invitationId;
  const [target] = await db
    .select({ organizationId: invitation.organizationId })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1);
  if (!target) return auth.handler(request);
  const session = await auth.api.getSession({ headers: request.headers });
  // The Slack senders the person saw on the accept page and agreed to; any
  // other sender linked to the invitation is sent back to the admins.
  const confirmed = Array.isArray(body.slackRequestIds) ? body.slackRequestIds.filter((id): id is string => typeof id === "string") : [];
  return withOrgLock(target.organizationId, async () => {
    if (session) {
      // Already a member here, invited on a Slack sender's behalf: the library
      // would add a second membership, so the invitation is consumed directly,
      // behind the same source check the library applies.
      if (!trustedOrigin(request)) return c.json({ message: "Invalid origin" }, 403);
      const organizationId = await acceptLinkedInvitationAsMember(invitationId, { id: session.user.id, email: session.user.email }, confirmed);
      if (organizationId) {
        await auth.api.setActiveOrganization({ headers: request.headers, body: { organizationId } }).catch(() => undefined);
        return c.json({ status: "accepted", organizationId });
      }
    }
    const response = await auth.handler(request);
    if (response.ok && session) {
      const bound = await bindInvitedSlackSender(invitationId, session.user.id, confirmed);
      // Accepted, but the membership is already gone (removed in between): the
      // request goes back to the admins rather than waiting for nothing.
      if (bound === "no_membership") await reopenInvitedRequest(invitationId);
    }
    return response;
  });
});
/** An invitation id must come from the invitation itself (the mail or the
 *  inviter), never from a lookup by the session's email claim: a Google account
 *  can keep a verified claim on an address after the mailbox changed hands. */
routes.on(["GET", "POST"], "/api/auth/organization/list-user-invitations", (c) =>
  c.json({ message: "Not available" }, 404),
);
routes.route("/", createSignupRoutes(auth));
routes.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

export function handleAuthRequest(request: Request, env?: AppEnv["Bindings"]): Response | Promise<Response> {
  return routes.fetch(request, env);
}
