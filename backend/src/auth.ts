import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { genericOAuth, organization } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { ensurePersonalOrgForUser, hasCredential, unverifiedClaim } from "./auth-hooks";
import { organizationLimitReached } from "./auth/organization-limit";
import {
  INVITATION_EXPIRES_IN_SECONDS,
  confirmationLinks,
  confirmationToken,
  deliverInvitation,
  deliverVerification,
  invitedSignupAllowed,
} from "./auth-invitations";
import { db } from "./db/client";
import * as schema from "./db/auth-schema";
import {
  betterAuthTrustedOrigins,
  env,
  googleAuthConfig,
  OIDC_PROVIDER_ID,
  oidcAuthConfig,
  openSignupConfig,
  selfSignupEnabled,
  signupRefusal,
  signupSwitchOn,
} from "./env";

/** Hops whose forwarded-address entries are stripped when a client is resolved:
 *  the edge and any private proxy in front of the backend. The library's own
 *  limiter and the sign-up limiter then both see the address the edge saw. */
const TRUSTED_PROXIES = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

/** The display name an OpenID Connect identity gets: the `name` claim, else the
 *  given and family names, else the username, else the address. Many providers
 *  send `name` only once a person has filled in their names, and the library
 *  refuses a sign-in without one. */
export function oidcDisplayName(profile: Record<string, unknown>): string | undefined {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const given = [text(profile.given_name), text(profile.family_name)].filter(Boolean).join(" ");
  return text(profile.name) || given || text(profile.preferred_username) || text(profile.email) || undefined;
}

/**
 * Better Auth server with Google, OpenID Connect, existing-account password
 * sign-in, and organizations. A closed deployment creates no accounts on its
 * own: a verified Google or OpenID Connect identity links to an existing local
 * user, or creates one only when a pending organisation invitation names that
 * email. SIGNUP_OPEN (env.ts) opens email-and-password sign-up behind mail
 * verification.
 */
export function createAuthServer() {
  const google = googleAuthConfig();
  const oidc = oidcAuthConfig();
  const allowSignup = selfSignupEnabled();
  const open = openSignupConfig();
  if (signupSwitchOn() && !open) {
    console.warn(
      "[auth] SIGNUP_OPEN is set but no account mail transport is configured (CONNECTOR_EMAIL_HOST and CONNECTOR_EMAIL_FROM): sign-up stays closed, an address cannot be verified without mail.",
    );
  }
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignup,
      // An open sign-up is verified by mail before its first sign-in; a sign-in
      // with the right password for an unverified address sends the link again.
      requireEmailVerification: open !== null,
    },
    emailVerification: open
      ? {
          // Mailed when a sign-up creates the registration. The library's own
          // link (keyed by address alone) is not mailed; the signed one names
          // the registration (auth/signup-routes.ts confirms it). A sign-in for
          // an unconfirmed address is answered and mailed by the sign-in route,
          // so the answer can say what happened to the mail.
          sendVerificationEmail: async ({ user }) => {
            // The account exists whatever the mail does; the card can ask again.
            void deliverVerification(user.email, confirmationLinks(confirmationToken(user))).catch((error: unknown) => {
              console.error(`[auth] verification mail for ${user.email} could not be sent:`, (error as Error).message);
            });
          },
        }
      : undefined,
    socialProviders: google
      ? {
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            // The user-create hook below decides, per email, whether a new
            // Google identity may become an account (invited, or dev mode).
            disableSignUp: false,
          },
        }
      : {},
    account: { accountLinking: { requireLocalEmailVerified: false } },
    // The library's own limiter runs in production, as its default says; read
    // when the server is built rather than when the library was loaded, so a
    // server built for production behaves as one.
    rateLimit: { enabled: (process.env.NODE_ENV ?? "development") === "production" },
    advanced: { ipAddress: { trustedProxies: TRUSTED_PROXIES } },
    plugins: [
      organization({
        invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
        // The library stops an organisation at 100 members by default (ledger
        // G10); a real team never meets this one. ponytail: list-members answers
        // up to this many rows in one page (the Team card reads it unpaged);
        // paginate there before a workspace nears it.
        membershipLimit: 10_000,
        // Each person creates at most ORG_CREATE_LIMIT_PER_USER organisations.
        organizationLimit: organizationLimitReached,
        sendInvitationEmail: async (data) => {
          // The invitation exists whatever the mail does, and the request that
          // created it holds the organisation's turn: delivery runs on its own.
          void deliverInvitation(data).catch((error: unknown) => {
            console.error(`[auth] invitation ${data.id} could not be sent:`, (error as Error).message);
          });
        },
      }),
      electron(),
      // Each new identity answers to the same user-create hook as Google below:
      // invited with a verified address, or admitted by the sign-up policy.
      ...(oidc
        ? [
            genericOAuth({
              config: [
                {
                  providerId: OIDC_PROVIDER_ID,
                  discoveryUrl: oidc.discoveryUrl,
                  clientId: oidc.clientId,
                  clientSecret: oidc.clientSecret,
                  scopes: ["openid", "email", "profile"],
                  pkce: true,
                  mapProfileToUser: (profile) => ({
                    name: oidcDisplayName(profile),
                    // Only a literal `email_verified: true` vouches for the
                    // address; a missing claim or a string does not.
                    emailVerified: profile.email_verified === true,
                  }),
                },
              ],
            }),
          ]
        : []),
    ],
    trustedOrigins: betterAuthTrustedOrigins(),
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            // An invitation opens the door only to a verified identity: an unverified
            // email claim could be anyone naming the invited address. A stale verified
            // claim (a mailbox that changed hands) can still create an account, but
            // never joins the organisation: the invitation id travels only in the mail
            // and the by-email listing is closed in auth/routes.ts.
            const pending = await invitedSignupAllowed(user.email);
            const invited = user.emailVerified === true && pending;
            if (invited) return;
            // Every other creation, whatever the provider, answers to the sign-up
            // policy: closed, or open and narrowed by domain and invite code (an
            // invited address passes both). The code travels in the sign-up
            // body; a Google identity presents none.
            const refusal = signupRefusal(user.email, context?.body?.inviteCode, process.env, pending);
            if (refusal) throw APIError.from("FORBIDDEN", { code: "SIGNUP_DISABLED", message: refusal });
          },
          after: async (user) => {
            // An open sign-up gets its organisation once the address is confirmed
            // (auth/signup-routes.ts); everyone else on creation. Ensured, not
            // created blindly: a provider link reported first may have done it.
            if (user.emailVerified || !open) await ensurePersonalOrgForUser(user);
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            // A claim (never confirmed, belongs nowhere) gets no session whatever
            // the switch says now: closing sign-up after such an account was
            // created must not let its password in. A claim can only sign in;
            // the session a sign-up makes for itself (development, where nothing
            // is confirmed and the organisation follows once the request's
            // transaction has committed) is not one.
            if (context?.path === "/sign-up/email") return;
            if (await unverifiedClaim(session.userId)) {
              throw APIError.from("FORBIDDEN", { code: "EMAIL_NOT_VERIFIED", message: "Confirm your email address first" });
            }
            // A password sign-in checked a credential it loaded earlier; a provider
            // takeover (below) may have dropped it in between. The takeover drops
            // the credential before it confirms the address, so after the claim
            // check above there is no moment at which the account is confirmed
            // and the credential still stands: whichever way the two interleave,
            // a revoked password gets no session.
            if (context?.path === "/sign-in/email" && !(await hasCredential(session.userId))) {
              throw APIError.from("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
            }
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            // A provider identity that verified the address (the library links no
            // other) outranks a password nobody confirmed: linking to a claim (an
            // account that never confirmed its address and belongs nowhere) drops
            // the claim's password, and the account is that person's; the library
            // marks the address confirmed right after the link. Invited or not,
            // open or closed: the account already exists, no door is opened.
            if (account.providerId !== "credential" && (await unverifiedClaim(account.userId))) {
              await db.delete(schema.account).where(and(eq(schema.account.userId, account.userId), eq(schema.account.providerId, "credential")));
            }
          },
          after: async (account) => {
            // A person a provider vouched for lands in a workspace of their own,
            // whichever way the account came to be (a taken-over claim has none).
            if (account.providerId === "credential") return;
            const [owner] = await db
              .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, account.userId))
              .limit(1);
            if (owner) await ensurePersonalOrgForUser(owner);
          },
        },
      },
    },
  });
}

export const auth = createAuthServer();
