"use client";

import { useMemo, useState } from "react";

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
 * Without a live sandbox (pre-session, or a non-opencode thread) we show a
 * placeholder instead of a dead connection.
 */
export function DesktopPane({
  threadId,
  hasSandbox,
}: {
  threadId: string;
  hasSandbox: boolean;
}) {
  const [loaded, setLoaded] = useState(false);

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

  if (!hasSandbox) {
    return (
      <div className="text-text-soft-400 flex size-full items-center justify-center px-6 text-center text-paragraph-sm">
        No live sandbox yet - send a message to start one.
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
