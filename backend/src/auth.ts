import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { db } from "./db/client";
import * as schema from "./db/auth-schema";
import { env } from "./env";

/**
 * better-auth server. Email/password + the organization plugin (orgs, members,
 * invitations, active organization), backed by the Drizzle/Postgres adapter.
 * Mounted at `/api/auth/*` on the Hono app (see index.ts).
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  plugins: [organization()],
  trustedOrigins: [env.FRONTEND_ORIGIN, env.BETTER_AUTH_URL],
});
