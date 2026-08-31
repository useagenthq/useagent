import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, user } from "../src/db/schema";
import { CookieJar, createOrgSession, fetchApi, json, uid } from "./helpers";

/**
 * Production-mode fail-closed behavior. The org middleware evaluates
 * USEAGENT_DEV_MODE per request, so this suite flips it off for its lifetime
 * (restored in afterAll) instead of needing a separate process.
 *
 *  - anonymous (no session) → 401 on every domain route (no dev-org fallback);
 *  - a fresh signup lands in its own personal org (created on first sign-in);
 *  - a session that ends up in NO org → 403 no_organization (never the dev org).
 */
describe("production mode: fail closed", () => {
  beforeAll(() => {
    process.env.USEAGENT_DEV_MODE = "false";
  });
  afterAll(() => {
    delete process.env.USEAGENT_DEV_MODE;
  });

  test("anonymous requests are 401 on all domain routes", async () => {
    const skills = await json<any>("/api/skills");
    expect(skills.status).toBe(401);
    expect(skills.body.error).toBe("unauthorized");

    const knowledge = await json<any>("/api/knowledge");
    expect(knowledge.status).toBe(401);

    const runs = await json<any>("/api/runs");
    expect(runs.status).toBe(401);
  });

  test("health stays public (no org scoping)", async () => {
    const { status, body } = await json("/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  test("a fresh signup lands in its own personal org (created on first sign-in)", async () => {
    const email = `${uid("personal")}@example.com`;
    const jar = new CookieJar();
    const signUp = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Personal Org User", email, password: "password-1234" },
    });
    expect(signUp.status).toBe(200);
    jar.absorb(signUp);

    // The create-personal-org-on-first-signin hook gave them an org, so domain
    // routes resolve their tenant even with production fail-closed on.
    const runs = await json<any>("/api/runs", { cookies: jar.header() });
    expect(runs.status).toBe(200);
  });

  test("a session that belongs to no org → 403 no_organization", async () => {
    // Sign up (which auto-creates a personal org), then strip the membership to
    // simulate a genuinely org-less session (e.g. its only org was deleted): the
    // middleware must fail closed, never borrow the dev org.
    const email = `${uid("noorg")}@example.com`;
    const jar = new CookieJar();
    const signUp = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "No Org User", email, password: "password-1234" },
    });
    expect(signUp.status).toBe(200);
    jar.absorb(signUp);

    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await db.delete(member).where(eq(member.userId, row.id));

    const skills = await json<any>("/api/skills", { cookies: jar.header() });
    expect(skills.status).toBe(403);
    expect(skills.body.error).toBe("no_organization");

    // Same fail-closed verdict across the other domains.
    const runs = await json<any>("/api/runs", { cookies: jar.header() });
    expect(runs.status).toBe(403);
    const knowledge = await json<any>("/api/knowledge", { cookies: jar.header() });
    expect(knowledge.status).toBe(403);
  });

  test("removing a member invalidates its active-organization session immediately", async () => {
    const org = await createOrgSession("removed-active-member");
    const [account] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, org.email));
    expect(account).toBeTruthy();
    expect((await json("/api/skills", { cookies: org.cookies })).status).toBe(200);

    await db
      .delete(member)
      .where(and(eq(member.organizationId, org.orgId), eq(member.userId, account!.id)));

    const denied = await json<any>("/api/skills", { cookies: org.cookies });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: "no_organization" });
  });
});
