// Browser auth helpers — the ONE place the frontend talks to better-auth. The
// backend mounts better-auth at `/api/auth/*` and the Next `/api/*` rewrite
// proxies it same-origin, so the session cookie is first-party and rides on
// `backendFetch`'s `credentials: "include"`. No better-auth client dependency:
// these are thin typed wrappers over its REST endpoints, matching the existing
// email form (app/login/auth-form.tsx).

import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "./backend-fetch";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface Session {
  user: SessionUser;
}

/** The authenticated session, or null when anonymous (incl. the dev-org path,
 *  where domain APIs still work but no better-auth session cookie exists). */
export async function getSession(): Promise<Session | null> {
  try {
    const res = await backendFetch("/api/auth/get-session");
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: SessionUser } | null;
    return data?.user ? { user: data.user } : null;
  } catch {
    return null;
  }
}

/** Begin the Google OAuth flow: better-auth returns the provider URL to visit,
 *  and we hand the browser off to it. Throws if Google isn't configured. */
export async function signInWithGoogle(callbackURL = "/"): Promise<void> {
  const res = await backendFetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL }),
  });
  if (!res.ok) throw new Error(`Google sign-in unavailable (${res.status})`);
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("No redirect URL returned");
  window.location.href = data.url;
}

/** End the session (clears the cookie server-side). */
export async function signOut(): Promise<void> {
  await backendFetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export interface AuthConfig {
  /** Google provider configured (GOOGLE_CLIENT_ID/SECRET both present). */
  google: boolean;
  emailPassword: boolean;
  /** Unauthenticated dev-org access currently open (ALLOW_DEV_ORG). */
  allowDevOrg: boolean;
}

const FALLBACK_CONFIG: AuthConfig = {
  google: false,
  emailPassword: true,
  allowDevOrg: true,
};

/** Public client config from GET /api/config — never carries any secret. */
export async function getAuthConfig(): Promise<AuthConfig> {
  try {
    const res = await backendFetch("/api/config");
    if (!res.ok) return FALLBACK_CONFIG;
    const data = (await res.json()) as {
      auth?: { google?: boolean; emailPassword?: boolean };
      allowDevOrg?: boolean;
    };
    return {
      google: Boolean(data.auth?.google),
      emailPassword: data.auth?.emailPassword ?? true,
      allowDevOrg: Boolean(data.allowDevOrg),
    };
  } catch {
    return FALLBACK_CONFIG;
  }
}

/** Subscribe to the current session; `refresh()` re-fetches (e.g. after sign-out). */
export function useSession(): {
  session: Session | null;
  loading: boolean;
  refresh: () => void;
} {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSession().then((s) => {
      if (cancelled) return;
      setSession(s);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { session, loading, refresh };
}

/** The public auth config, fetched once on mount. Null until it resolves. */
export function useAuthConfig(): AuthConfig | null {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAuthConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}
