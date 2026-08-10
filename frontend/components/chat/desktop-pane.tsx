"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * The "Desktop" tab: a live view of the conversation's sandbox GUI (multi-repo),
 * via noVNC. The skynet-agent snapshot runs Xvfb + XFCE + x11vnc + noVNC on
 * :6080; we iframe noVNC's own `vnc.html` served THROUGH the same-origin
 * `/api/desktop-proxy/<threadId>` bridge (backend injects the Daytona preview
 * token on both the static app and the RFB WebSocket — see backend
 * runs/desktop-proxy.ts). `path` points noVNC's socket back at that same bridge
 * so the token never reaches the browser; `autoconnect` opens it on load and
 * `resize=scale` fits the remote screen to the pane.
 *
 * The tab is always present. Before a sandbox exists, or while a retained
 * sandbox's desktop service is being repaired, probe the authenticated proxy
 * and show a product-owned waiting state instead of embedding raw error JSON.
 */
export function DesktopPane({ threadId }: { threadId: string }) {
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Waiting for Daytona sandbox…");

  const readySrc = useMemo(
    () => `/api/desktop-proxy/${threadId}/ready`,
    [threadId],
  );

  const src = useMemo(() => {
    const params = new URLSearchParams({
      autoconnect: "true",
      resize: "scale",
      reconnect: "true",
      // noVNC rebuilds its socket URL from window.location + this path (query
      // params dropped), so it must carry the full same-origin bridge path.
      path: `api/desktop-proxy/${threadId}/websockify`,
    });
    return `/api/desktop-proxy/${threadId}/vnc.html?${params.toString()}`;
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setReady(false);
    setLoaded(false);
    setStatus("Waiting for Daytona sandbox…");

    const probe = async (): Promise<void> => {
      try {
        const response = await fetch(readySrc, { cache: "no-store" });
        await response.body?.cancel();
        if (cancelled) return;
        if (response.ok) {
          setReady(true);
          return;
        }
        setStatus(response.status === 409 ? "Waiting for Daytona sandbox…" : "Starting sandbox desktop…");
      } catch {
        if (cancelled) return;
        setStatus("Reconnecting to sandbox desktop…");
      }
      retry = setTimeout(() => void probe(), 1_000);
    };

    void probe();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [readySrc]);

  if (!ready) {
    return (
      <div className="text-text-soft-400 flex size-full items-center justify-center px-6 text-center text-paragraph-sm">
        {status}
      </div>
    );
  }

  return (
    <div className="relative size-full bg-neutral-950">
      <iframe
        title="Sandbox desktop"
        src={src}
        onLoad={() => setLoaded(true)}
        className="size-full border-0"
        allow="clipboard-read; clipboard-write"
      />
      {!loaded && (
        <div className="bg-bg-white-0 text-text-soft-400 absolute inset-0 flex items-center justify-center text-paragraph-sm">
          Connecting to desktop…
        </div>
      )}
    </div>
  );
}
