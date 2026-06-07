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

const [{ auth }, { createPersonalOrgForUser }, { client, db }, { member, user }] = await Promise.all([
  import("../src/auth"),
  import("../src/auth-hooks"),
  import("../src/db/client"),
  import("../src/db/auth-schema"),
]);

try {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  let userId = existing?.id;
  if (userId) {
    console.log(`bootstrap user already exists: ${email}`);
  } else {
    const created = await auth.api.signUpEmail({ body: { email, password, name } });
    userId = created.user.id;
    console.log(`bootstrap user created: ${email}`);
  }

  let [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  if (!membership) {
    await createPersonalOrgForUser({ id: userId, email, name });
    [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1);
  }
  if (membership?.role !== "owner") {
    throw new Error("bootstrap user was not provisioned as an organization owner");
  }
} finally {
  await client.end();
}
