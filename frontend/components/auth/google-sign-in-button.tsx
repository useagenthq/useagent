"use client";

import { RiGoogleFill } from "@remixicon/react";
import { useState } from "react";
import { signInWithGoogle } from "@/lib/auth";
import { cx } from "@/utils/cx";

/**
 * "Continue with Google" — the primary sign-in affordance. Hands off to
 * better-auth's social flow (lib/auth.ts). When Google isn't configured on the
 * backend (`enabled={false}`) it renders disabled with an honest hint instead of
 * failing on click, so a local dev without keys sees exactly what's missing.
 */
export function GoogleSignInButton({
  enabled,
  callbackURL = "/",
}: {
  enabled: boolean;
  callbackURL?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (pending || !enabled) return;
    setError(null);
    setPending(true);
    try {
      await signInWithGoogle(callbackURL);
      // On success the browser navigates to Google; nothing renders after.
    } catch {
      setError("Couldn't start Google sign-in. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={!enabled || pending}
        aria-label="Continue with Google"
        className={cx(
          "inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-full border border-border-button-default bg-background-primary-default text-body-2-medium text-text-primary shadow-card outline-none transition-colors",
          "hover:bg-background-secondary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <RiGoogleFill className="size-[18px] shrink-0" aria-hidden />
        {pending ? "Redirecting…" : "Continue with Google"}
      </button>
      {!enabled && (
        <p className="text-caption-1-regular text-text-tertiary">
          Google sign-in isn&apos;t configured on this server.
        </p>
      )}
      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}
