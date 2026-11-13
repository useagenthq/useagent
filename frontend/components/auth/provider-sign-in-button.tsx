"use client";

import type { RemixiconComponentType } from "@remixicon/react";
import { useState } from "react";
import { cx } from "@/utils/cx";

/**
 * A full-width button that hands sign-in off to an identity provider (Google,
 * or the deployment's own OpenID Connect provider). `start` sends the browser
 * away; when it throws, the button says so and can be pressed again.
 */
export function ProviderSignInButton({
  label,
  icon: Icon,
  failure,
  start,
  disabled = false,
}: {
  /** The button's text, such as "Continue with Google". */
  label: string;
  icon: RemixiconComponentType;
  /** What to say when the hand-off could not start. */
  failure: string;
  start: () => Promise<void>;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (pending || disabled) return;
    setError(null);
    setPending(true);
    try {
      await start();
      // On success the browser navigates to the provider; nothing renders after.
    } catch {
      setError(failure);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || pending}
        aria-label={label}
        className={cx(
          "inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-full border border-border-button-default bg-background-primary-default text-body-2-medium text-text-primary shadow-card outline-none transition-colors",
          "hover:bg-background-secondary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <Icon className="size-[18px] shrink-0" aria-hidden />
        {pending ? "Redirecting…" : label}
      </button>
      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}
