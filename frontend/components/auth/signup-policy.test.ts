import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../../app/${path}`, import.meta.url), "utf8");
}

describe("self-service signup UI policy", () => {
  test("redirects the legacy signup route and exposes no account-creation affordance", () => {
    const signupPage = read("signup/page.tsx");
    const authForm = read("login/auth-form.tsx");

    expect(signupPage).toContain('redirect("/login")');
    expect(authForm).not.toContain("Create an account");
    expect(authForm).not.toContain("/api/auth/sign-up/email");
    expect(authForm).not.toContain("/signup");
  });
});
