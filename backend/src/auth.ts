import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createPersonalOrgForUser } from "./auth-hooks";
import { db } from "./db/client";
import * as schema from "./db/auth-schema";
import { env, googleAuthConfig } from "./env";

// Google social sign-in — only when both GOOGLE_CLIENT_ID and _SECRET are set
// (env-gated, like every other optional integration). Unconfigured → the object
// is empty and only email/password is offered.
const google = googleAuthConfig();
const socialProviders = google
  ? { google: { clientId: google.clientId, clientSecret: google.clientSecret } }
  : {};

/**
 * better-auth server. Email/password + Google (when configured) + the
 * organization plugin (orgs, members, invitations, active organization), backed
 * by the Drizzle/Postgres adapter. Mounted at `/api/auth/*` on the Hono app
 * (see index.ts). On first sign-in — Google or email — a personal organization
 * is created for the new user so they land in their own tenant (auth-hooks.ts).
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  socialProviders,
  plugins: [organization()],
  trustedOrigins: [env.FRONTEND_ORIGIN, env.BETTER_AUTH_URL],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await createPersonalOrgForUser(user);
        },
      },
    },
  },
});
