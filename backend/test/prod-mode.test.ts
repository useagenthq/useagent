import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CookieJar, fetchApi, json, uid } from "./helpers";

/**
 * Production-mode fail-closed behavior. The org middleware evaluates
 * SKYNET_DEV_MODE per request, so this suite flips it off for its lifetime
 * (restored in afterAll) instead of needing a separate process.
 *
 *  - anonymous (no session) → 401 on every domain route (no dev-org fallback);
 *  - authenticated but member of no org → 403 no_organization (never the dev org).
 */
describe("production mode: fail closed", () => {
  beforeAll(() => {
    process.env.SKYNET_DEV_MODE = "false";
  });
  afterAll(() => {
    delete process.env.SKYNET_DEV_MODE;
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

  test("authenticated user with no organization → 403 no_organization", async () => {
    // Sign up but never create/activate an org: the session has zero memberships.
    const email = `${uid("noorg")}@example.com`;
    const jar = new CookieJar();
    const signUp = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "No Org User", email, password: "password-1234" },
    });
    expect(signUp.status).toBe(200);
    jar.absorb(signUp);

    const skills = await json<any>("/api/skills", { cookies: jar.header() });
    expect(skills.status).toBe(403);
    expect(skills.body.error).toBe("no_organization");

    // Same fail-closed verdict across the other domains.
    const runs = await json<any>("/api/runs", { cookies: jar.header() });
    expect(runs.status).toBe(403);
    const knowledge = await json<any>("/api/knowledge", { cookies: jar.header() });
    expect(knowledge.status).toBe(403);
  });
});
