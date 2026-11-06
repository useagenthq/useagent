"use client";

import { useEffect, useRef, useState } from "react";
import { AuthForm } from "@/app/login/auth-form";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/base/buttons/button";
import { useSession } from "@/lib/auth";
import { desktopAuthClient } from "@/lib/desktop-auth-client";

import { desktopAuthRequest, restartElectronRedirect, startDesktopGoogleSignIn, type DesktopAuthRequest } from "./request";

export default function DesktopAuthPage() {
  const { session, loading } = useSession();
  const [request, setRequest] = useState<DesktopAuthRequest | null>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const redirectTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setRequest(desktopAuthRequest(window.location.href)); }, []);
  useEffect(() => {
    if (!request) return;
    redirectTimer.current = restartElectronRedirect(redirectTimer.current);
    return () => {
      if (redirectTimer.current) clearInterval(redirectTimer.current);
      redirectTimer.current = null;
    };
  }, [request]);

  async function connect() {
    if (!request || pending) return;
    setPending(true);
    setError(null);
    try {
      redirectTimer.current = restartElectronRedirect(redirectTimer.current);
      const result = await desktopAuthClient.electron.transferUser({ fetchOptions: { query: request.query } });
      if (!result.error && result.data?.electron_authorization_code) return;
    } catch {
      // The same actionable message covers network and rejected transfer failures.
    }
    setError("Could not connect the desktop. Start sign-in again.");
    setPending(false);
  }

  if (!request) return (
    <AuthScreen>
      <p role={request === null ? "alert" : "status"}>
        {request === null ? "Open sign-in from the desktop app to begin." : "Loading sign-in..."}
      </p>
    </AuthScreen>
  );
  if (!loading && !session) return (
    <AuthForm callbackURL={request.url} googleAction={() => startDesktopGoogleSignIn(request)} />
  );
  return (
    <AuthScreen>
      <section className="space-y-5">
        <h1 className="text-display-sm text-text-primary">Connect your desktop</h1>
        <p className="text-body-regular text-text-secondary">
          {loading ? "Checking your session..." : `Signed in as ${session?.user.email ?? "your account"}. Approve only if you started this request in your UseAgent desktop app.`}
        </p>
        <Button className="rounded-full" disabled={loading || pending} onClick={() => void connect()}>
          {pending ? "Opening UseAgent..." : "Connect desktop"}
        </Button>
        {error ? <p role="alert" className="text-body-2-regular text-text-secondary">{error}</p> : null}
      </section>
    </AuthScreen>
  );
}
