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
  subtitle: "Enter your credentials to continue",
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
    <main className="flex min-h-dvh w-full bg-background-primary-default">
      {/* Left: the form column (split layout). The real better-auth handlers
          (error surface, pending state, Google config gating) are preserved
          verbatim; only the page composition changed. */}
      <section className="relative flex min-h-dvh w-full flex-col justify-center px-6 sm:px-12 lg:w-[44%] lg:min-w-[420px] lg:max-w-[560px] lg:px-16">
        <div className="animate-ai-fade-up mx-auto w-full max-w-[360px]">
          <h1 className="text-title-2-medium text-text-primary">{COPY.title}</h1>
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

        {/* Wordmark anchored to the panel's bottom edge. */}
        <div className="absolute bottom-8 left-6 flex items-center gap-2 sm:left-12 lg:left-16">
          <OrbitKnotMark className="size-5" />
          <span className="text-body-2-medium tracking-wide text-text-secondary">useAgent</span>
        </div>
      </section>

      {/* Right: full-bleed brand visual (desktop only) - the app-shell aurora
          grammar scaled to a full panel. Pure CSS, no remote assets. */}
      <aside
        aria-hidden
        className="relative hidden flex-1 overflow-hidden border-l border-border-button-default bg-background-secondary-default lg:block"
      >
        <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_35%,transparent_100%)]">
          <div className="aurora-blob aurora-blob-a absolute left-[-15%] top-[-22rem] size-[58rem] bg-[radial-gradient(closest-side,var(--color-chart-6),transparent_72%)]" />
          <div className="aurora-blob aurora-blob-b absolute right-[-12%] top-[-16rem] size-[52rem] bg-[radial-gradient(closest-side,var(--color-chart-4),transparent_72%)]" />
          <div className="aurora-blob aurora-blob-c absolute left-[28%] top-[-10rem] size-[60rem] bg-[radial-gradient(closest-side,var(--color-chart-5),transparent_72%)]" />
          <div className="bg-halftone absolute inset-0" />
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center px-12 text-center">
          <OrbitKnotMark className="size-14" stroke={2.4} />
          <p className="mt-6 max-w-md text-title-3-medium text-text-primary">
            Ask anything. It does the rest.
          </p>
          <p className="mt-2 max-w-sm text-body-regular text-text-secondary">
            Coding agents in isolated cloud workspaces, with durable context and
            audit trails.
          </p>
        </div>
      </aside>
    </main>
  );
}
