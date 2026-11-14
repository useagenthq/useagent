"use client";

import { RiGoogleFill } from "@remixicon/react";
import { signInWithGoogle } from "@/lib/auth";
import { ProviderSignInButton } from "./provider-sign-in-button";

/**
 * "Continue with Google" — the primary sign-in affordance. Hands off to
 * better-auth's social flow (lib/auth.ts). When Google isn't configured on the
 * backend (`enabled={false}`) it does not render.
 */
export function GoogleSignInButton({
  enabled,
  disabled = false,
  callbackURL = "/",
  action,
}: {
  enabled: boolean;
  disabled?: boolean;
  callbackURL?: string;
  action?: () => Promise<void>;
}) {
  if (!enabled) return null;
  return (
    <ProviderSignInButton
      label="Continue with Google"
      icon={RiGoogleFill}
      failure="Couldn't start Google sign-in. Please try again."
      start={action ?? (() => signInWithGoogle(callbackURL))}
      disabled={disabled}
    />
  );
}
