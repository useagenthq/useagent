"use client";

import { RiShieldUserLine } from "@remixicon/react";
import { signInWithOidc } from "@/lib/auth";
import { ProviderSignInButton } from "./provider-sign-in-button";

/**
 * "Sign in with <label>": the deployment's own OpenID Connect provider (Okta,
 * Microsoft Entra ID, Keycloak and the like), named by the backend's
 * OIDC_BUTTON_LABEL. Hands off to better-auth's OAuth 2 flow (lib/auth.ts).
 */
export function OidcSignInButton({
  label,
  disabled = false,
  callbackURL = "/",
  action,
}: {
  label: string;
  disabled?: boolean;
  callbackURL?: string;
  action?: () => Promise<void>;
}) {
  return (
    <ProviderSignInButton
      label={`Sign in with ${label}`}
      icon={RiShieldUserLine}
      failure={`Couldn't start sign-in with ${label}. Please try again.`}
      start={action ?? (() => signInWithOidc(callbackURL))}
      disabled={disabled}
    />
  );
}
