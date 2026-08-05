"use client";

/**
 * The "Live" tab: opencode's own session view, rendered **inline as a Web
 * Component** (no iframe). The vendored build (`public/opencode-element/`) is a
 * solid-element custom element (`<skynet-oc-session>`) that reuses opencode's
 * full app bootstrap and boots straight into one session via a seeded in-memory
 * router — see that directory's README for how it's built and how it reaches its
 * server. It talks to the thread's live opencode server through the same-origin
 * backend bridge at `/api/live-proxy/<threadId>` (which injects the Daytona
 * preview token and streams the `/api/event` SSE through); the element's own
 * fetch shim rewrites its client onto that base from the `api` attribute.
 *
 * Deep-link: when the thread has a recorded opencode session id (`ses_*`), the
 * element opens straight into that session's view (via the `session-id`
 * attribute). Without one we show a small placeholder rather than the app home.
 *
 * The element renders into LIGHT DOM, so its stylesheet is loaded once as a
 * global <link>; the ESM bundle is injected as a <script type="module"> on first
 * use and registers the element, which then upgrades in place. Mounted only while
 * the tab is selected, so the heavy bundle loads on demand.
 */

import { useEffect, useState } from "react";

const ELEMENT_TAG = "skynet-oc-session";
const BUNDLE_JS = "/opencode-element/skynet-oc-session.js";
const BUNDLE_CSS = "/opencode-element/skynet-oc-session.css";

// Custom-element intrinsic (React 19 passes these through as attributes verbatim).
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "skynet-oc-session": HTMLAttributes<HTMLElement> & {
        api?: string;
        "session-id"?: string;
      };
    }
  }
}

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector("link[data-skynet-oc-element]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = BUNDLE_CSS;
  link.dataset.skynetOcElement = "";
  document.head.appendChild(link);
}

let definePromise: Promise<void> | null = null;
function ensureElementDefined(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (customElements.get(ELEMENT_TAG)) return Promise.resolve();
  definePromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = BUNDLE_JS;
    // The module registers the element on evaluation; wait until it's defined.
    script.onload = () => void customElements.whenDefined(ELEMENT_TAG).then(() => resolve());
    script.onerror = () => reject(new Error("failed to load skynet-oc-session bundle"));
    document.head.appendChild(script);
  });
  return definePromise;
}

export function LivePane({
  threadId,
  sessionId,
}: {
  threadId: string;
  sessionId: string | null;
}) {
  const [ready, setReady] = useState(
    () => typeof window !== "undefined" && !!customElements.get(ELEMENT_TAG),
  );

  useEffect(() => {
    ensureStyles();
    let active = true;
    ensureElementDefined()
      .then(() => active && setReady(true))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!sessionId) {
    return (
      <div className="text-text-soft-400 flex size-full items-center justify-center text-paragraph-sm">
        No opencode session recorded for this thread yet.
      </div>
    );
  }

  return (
    <div className="bg-bg-white-0 relative size-full">
      <skynet-oc-session
        api={`/api/live-proxy/${threadId}`}
        session-id={sessionId}
        style={{ display: "block", height: "100%", width: "100%" }}
      />
      {!ready && (
        <div className="bg-bg-white-0 text-text-soft-400 absolute inset-0 flex items-center justify-center text-paragraph-sm">
          Loading session…
        </div>
      )}
    </div>
  );
}
