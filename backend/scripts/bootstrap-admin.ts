import { eq } from "drizzle-orm";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || email.split("@")[0] || "Admin";

if (!email.includes("@")) throw new Error("BOOTSTRAP_ADMIN_EMAIL must be a valid email address");
if (password.length < 12) {
  throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters");
}

// This one-shot process alone enables Better Auth signup. The long-running
// backend remains NODE_ENV=production with signup disabled.
process.env.NODE_ENV = "development";
process.env.USEAGENT_DEV_MODE = "true";

const [{ auth }, { client, db }, { user }] = await Promise.all([
  import("../src/auth"),
  import("../src/db/client"),
  import("../src/db/auth-schema"),
]);

try {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (existing) {
    console.log(`bootstrap user already exists: ${email}`);
  } else {
    await auth.api.signUpEmail({ body: { email, password, name } });
    console.log(`bootstrap user created: ${email}`);
  }
} finally {
  await client.end();
}
