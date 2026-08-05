import { describe, expect, test } from "bun:test";
import { CookieJar, fetchApi, json, uid } from "./helpers";

const SESSION_COOKIE = "better-auth.session_token";

describe("auth", () => {
  test("sign-up → session cookie → get-session", async () => {
    const email = `${uid("auth")}@example.com`;
    const password = "correct-horse-battery";
    const jar = new CookieJar();

    const signUp = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Test User", email, password },
    });
    expect(signUp.status).toBe(200);
    jar.absorb(signUp);
    expect(jar.has(SESSION_COOKIE)).toBe(true);

    // The session cookie authenticates get-session.
    const session = await json<any>("/api/auth/get-session", {
      cookies: jar.header(),
    });
    expect(session.status).toBe(200);
    expect(session.body?.user?.email).toBe(email);
  });

  test("wrong password → 401", async () => {
    const email = `${uid("auth")}@example.com`;
    const password = "the-real-password";

    const signUp = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Pw User", email, password },
    });
    expect(signUp.status).toBe(200);

    const bad = await fetchApi("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: "not-the-password" },
    });
    expect(bad.status).toBe(401);
  });
});
