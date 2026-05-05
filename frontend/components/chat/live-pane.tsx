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
// Our skin, layered AFTER the opencode stylesheet: re-anchors their warm dark
// ladder, hides their app chrome (titlebar/tab strip), flattens the box-in-box
// frame so the embed reads as our own chat. See that file's header for the map.
const THEME_CSS = "/opencode-element/skynet-theme-element.css";

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
  // Append our skin AFTER theirs so it wins the cascade on ties.
  const theme = document.createElement("link");
  theme.rel = "stylesheet";
  theme.href = THEME_CSS;
  theme.dataset.skynetOcTheme = "";
  document.head.appendChild(theme);
}

// Browser/OS-reserved combos the embed must never hijack. opencode registers
// its command keybinds on `document` in the CAPTURE phase (context/command.tsx:
// makeEventListener(document, "keydown", …, { capture: true })) and binds e.g.
// review.toggle → mod+shift+r — i.e. Cmd+Shift+R, the browser hard-refresh. A
// listener on WINDOW in the capture phase runs strictly before any document
// listener (window precedes document in the capture path, regardless of
// registration order), so stopImmediatePropagation() there means opencode's
// handler never sees these combos. We do NOT preventDefault, so the browser's
// own action (reload / new-tab / address-bar / …) still fires. Preferred over a
// structural bundle patch: their keybind registration is fused with the command
// palette / model-picker / slash commands, so skipping it would cost fidelity.
const RESERVED_KEYS = new Set(["r", "t", "w", "n", "l"]);
function installShortcutGuard(): () => void {
  if (typeof window === "undefined") return () => {};
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (!RESERVED_KEYS.has(e.key.toLowerCase())) return;
    // Block opencode's document-capture command handler; leave the native
    // browser action intact (no preventDefault).
    e.stopImmediatePropagation();
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
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
    const removeGuard = installShortcutGuard();
    let active = true;
    ensureElementDefined()
      .then(() => active && setReady(true))
      .catch(() => {});
    return () => {
      active = false;
      removeGuard();
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
        // Force opencode's own dark token block onto the element's subtree
        // regardless of the scheme its ThemeProvider sets on <html>; our skin
        // (skynet-theme-element.css) re-anchors that block's ramp to our ladder.
        data-color-scheme="dark"
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
