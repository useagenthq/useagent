"use client";

import { RiKeyLine, RiLockLine, RiMailLine, RiUserLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AuthScreen } from "@/components/auth/auth-screen";
import { CheckYourEmail, type MailStatus } from "@/components/auth/check-your-email";
import { DesktopSignIn } from "@/components/auth/desktop-sign-in";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { OidcSignInButton } from "@/components/auth/oidc-sign-in-button";
import type { VerificationNotice } from "@/components/auth/verification-notice";
import { Button } from "@/components/base/buttons/button";
import { Divider } from "@/components/base/divider/divider";
import { Input } from "@/components/base/input/input";
import { type AuthConfig, invalidateSession, useAuthConfig } from "@/lib/auth";
import { backendFetch } from "@/lib/backend-fetch";
import { desktopBridge, type DesktopBridge } from "@/lib/desktop-bridge";

export type AuthMode = "signin" | "signup";

/** The server's word on the mail a refused sign-in asked for. */
function signInMailStatus(mail: { sent?: boolean; reason?: string; retryAfterSeconds?: number } | undefined): MailStatus {
  if (mail?.reason === "held") return { kind: "held", retryAfterSeconds: mail.retryAfterSeconds ?? 3600 };
  if (mail?.reason === "closed") return { kind: "closed" };
  return { kind: "sent" };
}

const COPY = {
  signin: {
    title: "Welcome back",
    subtitle: "Enter your credentials to continue",
    submit: "Sign in",
    pending: "Signing in…",
    endpoint: "/api/auth/sign-in/email",
    switch: "New here? Create an account",
  },
  signup: {
    title: "Create your account",
    subtitle: "We will email you a link to confirm your address",
    submit: "Create account",
    pending: "Creating account…",
    endpoint: "/api/auth/sign-up/email",
    switch: "Already have an account? Sign in",
  },
} as const;

export function AuthForm({
  callbackURL = "/",
  googleAction,
  oidcAction,
  initialDesktopBridge,
  initialAuthConfig,
  initialMode = "signin",
  notice = null,
}: {
  callbackURL?: string;
  googleAction?: () => Promise<void>;
  oidcAction?: () => Promise<void>;
  initialDesktopBridge?: DesktopBridge | null;
  /** The server's answer when already known (tests); otherwise fetched on mount. */
  initialAuthConfig?: AuthConfig | null;
  initialMode?: AuthMode;
  /** What a confirmation link that landed here has to say. */
  notice?: VerificationNotice | null;
}) {
  const router = useRouter();
  const fetchedConfig = useAuthConfig();
  const authConfig = initialAuthConfig ?? fetchedConfig;
  const [desktop, setDesktop] = useState<DesktopBridge | null | undefined>(initialDesktopBridge);

  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** An account whose address is unconfirmed, what the server said about the
   *  mail, and the request that asks for it again. */
  const [awaiting, setAwaiting] = useState<{ email: string; kind: AuthMode; mail: MailStatus } | null>(null);

  useEffect(() => {
    if (initialDesktopBridge === undefined) setDesktop(desktopBridge());
  }, [initialDesktopBridge]);

  // A closed deployment ignores a request for the sign-up card.
  const signup = authConfig?.emailPassword ? authConfig.signup : null;
  const kind: AuthMode = signup && mode === "signup" ? "signup" : "signin";
  const copy = COPY[kind];
  // The identity providers this deployment offers, shown above the password form.
  const providers = kind === "signin" && Boolean(authConfig?.google || authConfig?.oidc);

  /** One attempt of either kind: the card is now waiting for mail (and what
   *  the server said about it), or a problem to show, or null once signed in. */
  async function attempt(which: AuthMode): Promise<{ mail: MailStatus } | { problem: string } | null> {
    try {
      const res = await backendFetch(COPY[which].endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(which === "signup" ? { name, email, password, inviteCode } : { email, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        message?: string;
        code?: string;
        token?: string | null;
        mail?: { sent?: boolean; reason?: string; retryAfterSeconds?: number };
      } | null;
      // The right password for an address that has not confirmed its mail; the
      // server says whether it sent the link again.
      if (res.status === 403 && data?.code === "EMAIL_NOT_VERIFIED") return { mail: signInMailStatus(data.mail) };
      if (!res.ok) return { problem: data?.message ?? "Something went wrong. Please try again." };
      // An open sign-up has no session until the address is confirmed. The
      // answer is the same for a new address and for one that has an account.
      if (which === "signup" && !data?.token) return { mail: { kind: "if_new" } };
      invalidateSession();
      router.push(callbackURL);
      router.refresh();
      return null;
    } catch {
      // Network failure / backend down — keep the page usable, surface inline.
      return { problem: "Couldn't reach the server. Please try again in a moment." };
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const outcome = await attempt(kind);
      if (outcome && "mail" in outcome) setAwaiting({ email, kind, mail: outcome.mail });
      else if (outcome) setError(outcome.problem);
    } finally {
      setPending(false);
    }
  }

  if (desktop === undefined) return <AuthScreen><p role="status">Loading sign-in...</p></AuthScreen>;
  if (desktop) return <AuthScreen><DesktopSignIn openExternal={desktop.openExternal} /></AuthScreen>;
  if (awaiting) {
    return (
      <AuthScreen>
        <CheckYourEmail
          email={awaiting.email}
          mail={awaiting.mail}
          onResend={async () => (await attempt(awaiting.kind)) ?? { mail: awaiting.mail }}
          onBack={() => {
            setAwaiting(null);
            setMode("signin");
          }}
        />
      </AuthScreen>
    );
  }
  return (
    <AuthScreen>
      <div className="mx-auto w-full max-w-[360px]">
        <h1 className="text-title-2-medium text-text-primary">{copy.title}</h1>
        <p className="mt-1.5 text-body-regular text-text-secondary">{copy.subtitle}</p>

        {notice && (
          <p
            role={notice.tone === "problem" ? "alert" : "status"}
            className={`mt-4 text-body-2-regular ${notice.tone === "problem" ? "text-text-error-primary" : "text-text-secondary"}`}
          >
            {notice.text}
          </p>
        )}

        {providers && (
          <div className="mt-8 flex flex-col gap-3">
            {authConfig?.oidc && (
              <OidcSignInButton label={authConfig.oidc.label} callbackURL={callbackURL} action={oidcAction} />
            )}
            {authConfig?.google && <GoogleSignInButton enabled callbackURL={callbackURL} action={googleAction} />}
          </div>
        )}

        {providers && authConfig?.emailPassword && (
          <Divider
            aria-hidden
            className="my-6"
            contentClassName="text-mono-label text-text-tertiary"
          >
            or
          </Divider>
        )}

        {authConfig?.emailPassword && (
          <form
            className={`flex flex-col gap-4 ${providers ? "" : "mt-8"}`}
            onSubmit={handleSubmit}
            noValidate
          >
            {kind === "signup" && (
              <Input
                name="name"
                type="text"
                label="Name"
                placeholder="Your name"
                autoComplete="name"
                leadingIcon={RiUserLine}
                value={name}
                onChange={setName}
                isRequired
              />
            )}
            <Input
              name="email"
              type="email"
              label="Email"
              placeholder="you@company.com"
              autoComplete="email"
              leadingIcon={RiMailLine}
              value={email}
              onChange={setEmail}
              hint={
                kind === "signup" && signup?.domains.length
                  ? `Only ${signup.domains.map((domain) => `@${domain}`).join(", ")} addresses can sign up.`
                  : undefined
              }
              isRequired
            />
            <Input
              name="password"
              type="password"
              label="Password"
              placeholder="••••••••"
              autoComplete={kind === "signup" ? "new-password" : "current-password"}
              leadingIcon={RiLockLine}
              value={password}
              onChange={setPassword}
              isRequired
            />
            {kind === "signup" && signup?.inviteCode && (
              <Input
                name="inviteCode"
                type="text"
                label="Invite code"
                placeholder="The code you were given"
                autoComplete="off"
                leadingIcon={RiKeyLine}
                value={inviteCode}
                onChange={setInviteCode}
                isRequired
              />
            )}

            {error && (
              <p role="alert" className="text-body-2-regular text-text-error-primary">
                {error}
              </p>
            )}

            <Button type="submit" className="mt-2 w-full" disabled={pending}>
              {pending ? copy.pending : copy.submit}
            </Button>
          </form>
        )}

        {signup && (
          <div className="mt-6">
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                setError(null);
                setMode(kind === "signup" ? "signin" : "signup");
              }}
            >
              {copy.switch}
            </Button>
          </div>
        )}

        {authConfig && !authConfig.google && !authConfig.oidc && !authConfig.emailPassword && (
          <p role="alert" className="mt-8 text-body-2-regular text-text-error-primary">
            Sign-in is unavailable on this server.
          </p>
        )}
      </div>
    </AuthScreen>
  );
}
