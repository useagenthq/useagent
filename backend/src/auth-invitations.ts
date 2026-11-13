import { createHmac } from "node:crypto";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { sendSmtp } from "./connectors/email/smtp";
import { db, type Executor } from "./db/client";
import { account, invitation, user } from "./db/auth-schema";
import { env, type InvitationMailConfig, invitationMailConfig, providerSignInEnabled, sameSecret, selfSignupEnabled } from "./env";

/**
 * Organisation invitations, and the sign-up verification mail that shares
 * their transport. A closed deployment creates no accounts on its own; a
 * pending invitation is the one door in. The invite goes out as an email when
 * the deployment has an SMTP host, and is always available as a link the
 * inviter can hand over themselves.
 */

/** Seven days, in the seconds better-auth's organization plugin expects. */
export const INVITATION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/** A pending, unexpired invitation for this email lets the account be created. */
export async function invitedSignupAllowed(
  email: string,
  exec: Executor = db,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await exec
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, email.trim().toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Where an invitation is accepted: the accept page lives on the frontend. */
export function invitationLink(id: string, origin: string = env.FRONTEND_ORIGIN): string {
  return new URL(`/accept-invitation/${encodeURIComponent(id)}`, origin).toString();
}

export interface InvitationNotice {
  readonly organization: string;
  readonly inviter: string;
  readonly role: string;
  readonly link: string;
  readonly expiresAt: Date;
}

/** Names are typed by people and end up in a mail header: one line, no control characters. */
export function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Longest stretch of a typed name an invitation repeats. */
const MAIL_NAME_MAX = 60;

/** A typed name, one line and short, as the subject carries it. */
function shortName(value: string): string {
  const name = headerSafe(value);
  return name.length > MAIL_NAME_MAX ? `${name.slice(0, MAIL_NAME_MAX - 3)}...` : name;
}

/** A name as the body carries it: a zero-width space after every ".", ":", "/"
 *  and "@", so no mail client turns "pay.example.com" or an address someone
 *  named their workspace after into a link. Markup is escaped by the layout. */
function inert(name: string): string {
  return name.replace(/[.:/@]/g, "$&\u200b");
}

/** Longest a delivery may take before the invitation is left as link-only. */
export const INVITATION_MAIL_TIMEOUT_MS = 20_000;

export const PRODUCT_NAME = "UseAgent";

export interface AccountMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One layout for every account mail: the product name, a title, a paragraph,
 *  one button, the small print, and the button's link spelled out for clients
 *  that strip styles. Inline styles only; mail clients drop everything else. */
export function accountMailHtml(mail: {
  readonly title: string;
  readonly intro: string;
  readonly button: { readonly label: string; readonly href: string };
  readonly notes: readonly string[];
}): string {
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif";
  const note = (html: string) => `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280">${html}</p>`;
  return [
    `<div style="margin:0;padding:32px 16px;background:#f5f6f8;font-family:${font};color:#111827">`,
    '<div style="max-width:520px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px">',
    `<p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#111827">${PRODUCT_NAME}</p>`,
    `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;line-height:1.3">${escapeHtml(mail.title)}</h1>`,
    `<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#374151">${escapeHtml(mail.intro)}</p>`,
    `<a href="${escapeHtml(mail.button.href)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px">${escapeHtml(mail.button.label)}</a>`,
    '<div style="margin-top:28px">',
    ...mail.notes.map(note),
    "</div>",
    "</div>",
    '<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#9ca3af;text-align:center;word-break:break-all">',
    `If the button does not work, open this link:<br><a href="${escapeHtml(mail.button.href)}" style="color:#9ca3af">${escapeHtml(mail.button.href)}</a>`,
    "</p>",
    "</div>",
  ].join("\n");
}

export function invitationMessage(notice: InvitationNotice): AccountMail {
  const role = notice.role === "admin" ? "an admin" : notice.role === "owner" ? "an owner" : "a member";
  const until = notice.expiresAt.toISOString().slice(0, 10);
  const inviterName = shortName(notice.inviter) || "A teammate";
  const organizationName = shortName(notice.organization) || "a workspace";
  const inviter = inert(inviterName);
  const organization = inert(organizationName);
  return {
    // Mail clients make no links in a subject, so it keeps the names as typed.
    subject: `${inviterName} invited you to ${organizationName} on ${PRODUCT_NAME}`,
    text: [
      `${inviter} invited you to join ${organization} as ${role}.`,
      "",
      `Accept the invitation: ${notice.link}`,
      "",
      `Sign in with this email address. The link works until ${until}.`,
    ].join("\n"),
    html: accountMailHtml({
      title: `Join ${organization}`,
      intro: `${inviter} invited you to join ${organization} as ${role}.`,
      button: { label: "Accept invitation", href: notice.link },
      notes: [`Sign in with this email address. The link works until ${until}.`],
    }),
  };
}

/** What better-auth hands to sendInvitationEmail, narrowed to what the mail needs. */
export interface InvitationDelivery {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly organization: { readonly name: string };
  readonly invitation: { readonly expiresAt: Date };
  readonly inviter: { readonly user: { readonly name: string; readonly email: string } };
}

export async function deliverInvitation(
  data: InvitationDelivery,
  config: InvitationMailConfig | null = invitationMailConfig(),
  send: typeof sendSmtp = sendSmtp,
): Promise<"sent" | "link_only"> {
  // Rejections and timeouts propagate: better-auth logs them and keeps the invitation.
  const link = invitationLink(data.id);
  if (!config) {
    console.log(`[auth] invitation ${data.id} for ${data.email}: no mail transport, share ${link}`);
    return "link_only";
  }
  const message = invitationMessage({
    organization: data.organization.name,
    inviter: data.inviter.user.name.trim() || data.inviter.user.email,
    role: data.role,
    link,
    expiresAt: data.invitation.expiresAt,
  });
  // A stalled SMTP dialog must not hold the invite request or its socket; the
  // invitation row already exists and the link is shown whatever the mail did.
  await send(
    {
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      pass: config.pass,
      timeoutMs: INVITATION_MAIL_TIMEOUT_MS,
    },
    { from: config.from, fromName: PRODUCT_NAME, to: [data.email], subject: message.subject, text: message.text, html: message.html },
  );
  console.log(`[auth] invitation ${data.id} emailed to ${data.email}`);
  return "sent";
}

/** How long a confirmation link works. */
export const CONFIRMATION_TTL_MS = 60 * 60 * 1000;

function digest(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** A signed, expiring statement that this registration (account id and
 *  address) asked to be confirmed. The id is under the signature, so a link
 *  confirms only the registration it was mailed for: a later sign-up for the
 *  same address is another registration, and its predecessor's link is dead
 *  (auth/signup-routes.ts). */
export function confirmationToken(
  account: { id: string; email: string },
  secret: string = env.BETTER_AUTH_SECRET,
  now: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ id: account.id, email: account.email.toLowerCase(), until: now + CONFIRMATION_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${digest(payload, secret)}`;
}

export type ConfirmationClaim = { id: string; email: string } | "expired" | "invalid";

/** The registration a token names, decided before anything is looked up. */
export function readConfirmationToken(
  token: string,
  secret: string = env.BETTER_AUTH_SECRET,
  now: number = Date.now(),
): ConfirmationClaim {
  const [payload = "", signature = ""] = token.split(".");
  if (!payload || !sameSecret(signature, digest(payload, secret))) return "invalid";
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString()) as { id?: unknown; email?: unknown; until?: unknown };
    if (typeof claim.id !== "string" || typeof claim.email !== "string" || typeof claim.until !== "number") return "invalid";
    return claim.until < now ? "expired" : { id: claim.id, email: claim.email };
  } catch {
    return "invalid";
  }
}

export interface ConfirmationLinks {
  /** Confirms the registration and sends the person to the login card. */
  readonly confirm: string;
  /** "This was not me": cancels the registration while it is still a claim. */
  readonly decline: string;
}

/** The links in the mail, both carrying the same token; the route decides what happens. */
export function confirmationLinks(token: string, origin: string = env.BETTER_AUTH_URL): ConfirmationLinks {
  const query = `?token=${encodeURIComponent(token)}`;
  return {
    confirm: new URL(`/api/auth/confirm-signup${query}`, origin).toString(),
    decline: new URL(`/api/auth/decline-signup${query}`, origin).toString(),
  };
}

export function verificationMessage(links: ConfirmationLinks): AccountMail {
  const intro = `Someone signed up for ${PRODUCT_NAME} with this address. If that was you, confirm it to sign in.`;
  return {
    subject: `Confirm your ${PRODUCT_NAME} sign-up`,
    html: accountMailHtml({
      title: "Confirm your sign-up",
      intro,
      button: { label: "Confirm email", href: links.confirm },
      notes: [
        `The password for this sign-up was chosen by whoever filled in the form. If that was not you, do not confirm; <a href="${escapeHtml(links.decline)}" style="color:#6b7280">cancel the sign-up</a> instead, and nothing is created.`,
        "Both links work for one hour.",
      ],
    }),
    text: [
      `Someone signed up for ${PRODUCT_NAME} with this address. If that was you, confirm it to sign in:`,
      "",
      links.confirm,
      "",
      "The password for this sign-up was chosen by whoever filled in the form. If that",
      "was not you, do not confirm; cancel the sign-up here instead, and nothing is created:",
      "",
      links.decline,
      "",
      "Both links work for one hour.",
    ].join("\n"),
  };
}

export async function deliverVerification(
  email: string,
  links: ConfirmationLinks,
  config: InvitationMailConfig | null = invitationMailConfig(),
  send: typeof sendSmtp = sendSmtp,
): Promise<void> {
  // Open sign-up is refused without a transport (env.ts), so this only guards a
  // transport removed after boot; the person can ask again from the card.
  if (!config) throw new Error("no mail transport for sign-up verification");
  const message = verificationMessage(links);
  await send(
    {
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      pass: config.pass,
      timeoutMs: INVITATION_MAIL_TIMEOUT_MS,
    },
    { from: config.from, fromName: PRODUCT_NAME, to: [email], subject: message.subject, text: message.text, html: message.html },
  );
  console.log(`[auth] sign-up verification emailed to ${email}`);
}

export const NO_WAY_IN =
  "That address has no account with a password here, and this deployment cannot create one. Set up Google or OpenID Connect sign-in, or invite an address that already signs in with a password.";

/** Whether an invitation to this address can ever be used. Any deployment that
 *  creates accounts says yes; a closed one needs an account with a password,
 *  since an account a provider created (Google or OpenID Connect) from a time
 *  when that provider was on has no way in. */
export async function canSignIn(email: string): Promise<boolean> {
  if (selfSignupEnabled() || providerSignInEnabled()) return true;
  const [known] = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, "credential"), isNotNull(account.password)))
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1);
  return known !== undefined;
}
