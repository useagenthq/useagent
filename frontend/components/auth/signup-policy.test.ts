import { describe, expect, test } from "bun:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { cloneElement, createElement, type ReactElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";

import LoginPage from "@/app/login/[[...login]]/page";
import { AuthForm, type AuthMode } from "@/app/login/auth-form";
import SignupPage from "@/app/signup/[[...signup]]/page";
import type { AuthConfig } from "@/lib/auth";
import type { VerificationNotice } from "./verification-notice";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as AppRouterInstance;
const renderToStaticMarkup = (node: ReactElement) =>
  renderMarkup(createElement(AppRouterContext.Provider, { value: router }, node));

const CLOSED: AuthConfig = { google: false, oidc: null, emailPassword: true, allowDevOrg: false, invitationEmail: null, signup: null };
const OPEN: AuthConfig = { ...CLOSED, signup: { inviteCode: true, domains: ["acme.com"] } };
const card = (config: AuthConfig, initialMode?: AuthMode) =>
  renderToStaticMarkup(createElement(AuthForm, { initialDesktopBridge: null, initialAuthConfig: config, initialMode }));

describe("self-service signup UI policy", () => {
  test("sends public signup to the login card's sign-up mode", () => {
    let digest = "";
    try {
      SignupPage();
    } catch (error) {
      digest = (error as { digest?: string }).digest ?? "";
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/login?mode=signup");
  });

  test("keeps a safe desktop callback on native sign-in", async () => {
    const page = (await LoginPage({
      searchParams: Promise.resolve({ redirect_url: "/agent/new?desktop=1" }),
    })) as ReactElement<{ callbackURL: string }>;
    expect(page.type).toBe(AuthForm);
    expect(page.props.callbackURL).toBe("/agent/new?desktop=1");

    const external = (await LoginPage({
      searchParams: Promise.resolve({ redirect_url: "//attacker.example/path" }),
    })) as ReactElement<{ callbackURL: string }>;
    expect(external.props.callbackURL).toBe("/");
  });

  test("the real login page swaps the browser form for the frozen desktop control", async () => {
    const page = (await LoginPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
      initialDesktopBridge?: { platform: "darwin"; openExternal(url: string): void } | null;
    }>;
    const browser = renderToStaticMarkup(cloneElement(page, { initialDesktopBridge: null }));
    const desktop = renderToStaticMarkup(cloneElement(page, {
      initialDesktopBridge: { platform: "darwin", openExternal() {} },
    }));

    expect(browser).toContain("Welcome back");
    expect(browser).not.toContain("Continue in browser");
    expect(desktop).toContain("Continue in browser");
    expect(desktop).not.toContain("Welcome back");
  });

  test("a closed deployment shows sign-in whatever mode the address bar asks for", () => {
    const html = card(CLOSED, "signup");
    expect(html).toContain("Welcome back");
    expect(html).not.toContain("Create your account");
    expect(html).not.toContain("Create an account");
    expect(html).not.toContain("Invite code");
  });

  test("an open deployment offers the sign-up card with its code and domain rule", () => {
    const signin = card(OPEN);
    expect(signin).toContain("Welcome back");
    expect(signin).toContain("New here? Create an account");

    const signup = card(OPEN, "signup");
    expect(signup).toContain("Create your account");
    expect(signup).toContain("Your name");
    expect(signup).toContain("Invite code");
    expect(signup).toContain("Only @acme.com addresses can sign up.");
    expect(signup).toContain("Already have an account? Sign in");
    expect(signup).not.toContain("Welcome back");

    const plain = card({ ...OPEN, signup: { inviteCode: false, domains: [] } }, "signup");
    expect(plain).toContain("Create your account");
    expect(plain).not.toContain("Invite code");
    expect(plain).not.toContain("addresses can sign up");
  });

  test("the card offers each identity provider the server names, above the password form", () => {
    const sso = card({ ...CLOSED, oidc: { label: "Acme SSO" } });
    expect(sso).toContain("Sign in with Acme SSO");
    expect(sso).not.toContain("Continue with Google");
    expect(sso.indexOf("Sign in with Acme SSO")).toBeLessThan(sso.indexOf('type="password"'));
    expect(sso).toContain(">or<");

    const both = card({ ...CLOSED, google: true, oidc: { label: "Acme SSO" } });
    expect(both).toContain("Sign in with Acme SSO");
    expect(both).toContain("Continue with Google");

    const only = card({ ...CLOSED, emailPassword: false, oidc: { label: "Acme SSO" } });
    expect(only).toContain("Sign in with Acme SSO");
    expect(only).not.toContain('type="password"');
    expect(only).not.toContain(">or<");
    expect(only).not.toContain("Sign-in is unavailable on this server.");

    expect(card(CLOSED)).not.toContain("Sign in with");
    expect(card({ ...CLOSED, emailPassword: false })).toContain("Sign-in is unavailable on this server.");
    // The sign-up card is for a password: the providers stay on the sign-in card.
    expect(card({ ...OPEN, oidc: { label: "Acme SSO" } }, "signup")).not.toContain("Sign in with Acme SSO");
  });

  test("the login page turns the confirmation landing into a notice on the card", async () => {
    const confirmed = (await LoginPage({ searchParams: Promise.resolve({ verified: "1" }) })) as ReactElement<{
      notice: VerificationNotice | null;
      initialMode: AuthMode;
    }>;
    expect(confirmed.props.initialMode).toBe("signin");
    expect(confirmed.props.notice?.tone).toBe("ok");
    const html = renderToStaticMarkup(cloneElement(confirmed, { initialDesktopBridge: null, initialAuthConfig: CLOSED }));
    expect(html).toContain("Your email address is confirmed. Sign in to continue.");

    const asked = (await LoginPage({ searchParams: Promise.resolve({ mode: "signup" }) })) as ReactElement<{
      notice: VerificationNotice | null;
      initialMode: AuthMode;
    }>;
    expect(asked.props.initialMode).toBe("signup");
    expect(asked.props.notice).toBeNull();
  });
});
