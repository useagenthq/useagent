"use client";

import { RiLockLine, RiMailLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { Button } from "@/components/base/buttons/button";
import { Divider } from "@/components/base/divider/divider";
import { Input } from "@/components/base/input/input";
import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { useAuthConfig } from "@/lib/auth";
import { backendFetch } from "@/lib/backend-fetch";

const COPY = {
  title: "Welcome back",
  subtitle: "Sign in to your useAgent workspace",
  submit: "Sign in",
  pending: "Signing in…",
  endpoint: "/api/auth/sign-in/email",
} as const;

export function AuthForm() {
  const router = useRouter();
  const authConfig = useAuthConfig();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    try {
      const res = await backendFetch(COPY.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        setError(data?.message ?? "Something went wrong. Please try again.");
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      // Network failure / backend down — keep the page usable, surface inline.
      setError("Couldn't reach the server. Please try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-background-secondary-default p-4 sm:p-6">
      {/* Card recipe mirrors components/application/auth/auth-card.tsx; the
          form stays our own so the real better-auth handlers (error surface,
          pending state, Google config gating) are preserved verbatim. */}
      <div className="animate-ai-fade-up mx-auto flex w-full max-w-[400px] flex-col rounded-3xl border border-border-button-default bg-background-primary-default p-6 shadow-xs sm:p-8">
        <OrbitKnotMark className="size-8" />
        <h1 className="mt-5 text-title-2-medium text-text-primary">{COPY.title}</h1>
        <p className="mt-1.5 text-body-regular text-text-secondary">{COPY.subtitle}</p>

        <div className="mt-8">
          <GoogleSignInButton enabled={authConfig?.google ?? false} />
        </div>

        <Divider
          aria-hidden
          className="my-6"
          contentClassName="text-mono-label text-text-tertiary"
        >
          or
        </Divider>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <Input
            name="email"
            type="email"
            label="Email"
            placeholder="you@company.com"
            autoComplete="email"
            leadingIcon={RiMailLine}
            value={email}
            onChange={setEmail}
            isRequired
          />
          <Input
            name="password"
            type="password"
            label="Password"
            placeholder="••••••••"
            autoComplete="current-password"
            leadingIcon={RiLockLine}
            value={password}
            onChange={setPassword}
            isRequired
          />

          {error && (
            <p role="alert" className="text-body-2-regular text-text-error-primary">
              {error}
            </p>
          )}

          <Button type="submit" className="mt-2 w-full" disabled={pending}>
            {pending ? COPY.pending : COPY.submit}
          </Button>
        </form>
      </div>
    </main>
  );
}
