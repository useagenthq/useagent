"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentScreen } from "@/components/ai/agent-screen";
import { Button } from "@/components/base/buttons/button";
import { desktopFrameConnection } from "./desktop-frame-connection";
import { desktopFrameInteractive, desktopScreenStatus } from "./desktop-screen-state";

/** The session entry; the backend redirects it to a capability view and points
 *  noVNC's socket `path` at that view (backend runs/desktop-proxy.ts). */
export function buildDesktopFrameSrc(threadId: string): string {
  const params = new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    reconnect: "true",
    reconnect_delay: "500",
  });
  return `/api/desktop-proxy/${threadId}/vnc.html?${params.toString()}`;
}

/** Sandbox-served noVNC runs in an opaque origin: no app cookies, storage or
 *  same-origin API access. Never add allow-same-origin (it would undo all of
 *  that); matches the CSP the backend sends with every preview response. */
export const DESKTOP_FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";

/** First retry delay for the Desktop readiness probe (ms). */
export const DESKTOP_PROBE_MIN_DELAY = 250;
/** Ceiling the probe backoff plateaus at (ms); polling continues below it. */
export const DESKTOP_PROBE_MAX_DELAY = 2_000;

/**
 * Bounded exponential backoff for the Desktop readiness probe. The first retry
 * fires at 250ms; each subsequent retry multiplies by 1.5x, capped at 2000ms.
 * Readiness can arrive late (a retained sandbox repairs its desktop service on
 * demand), so there is no attempt limit - the delay simply plateaus at the cap and
 * keeps polling while the pane is mounted. `previous` is null for the first retry.
 */
/** Product copy for one readiness probe answer. A sandbox image that lacks the
 *  desktop binaries never becomes ready, so name them instead of waiting. */
export function desktopProbeStatus(status: number, error: string | null): string {
  if (status === 409) return "Nothing is running yet. Send a message to start one.";
  const missing = /missing desktop binaries:\s*(.+)$/i.exec(error ?? "")?.[1]?.trim();
  if (missing) {
    return `The browser is not available here: it is missing ${missing.split(/\s+/).join(", ")}. Rebuild the environment with those packages to enable it.`;
  }
  return "Starting the browser…";
}

export function nextDesktopProbeDelay(previous: number | null): number {
  if (previous === null) return DESKTOP_PROBE_MIN_DELAY;
  return Math.min(Math.ceil(previous * 1.5), DESKTOP_PROBE_MAX_DELAY);
}

/** Poll cadence for the focus-steal watchdog (ms). */
export const DESKTOP_FOCUS_WATCHDOG_INTERVAL = 250;

/**
 * noVNC's full client focuses its canvas once the RFB connection settles
 * (app/ui.js calls rfb.focus() on connect). That happens AFTER iframe load -
 * the websocket handshake is async - so the one-shot onLoad blur cannot stop
 * it, and the first keystrokes meant for the composer land in the VNC pane.
 * The sandboxed frame's document is unreachable, but the steal lands the iframe
 * ELEMENT as `document.activeElement`, which the outer page can observe. A steal
 * should be released only while the pane is being watched (input not captured) -
 * once the user clicks to control, the keyboard SHOULD go to the desktop.
 */
export function shouldReleaseStolenFocus({
  activeElement,
  frame,
  captured,
}: {
  activeElement: Element | null;
  frame: Element | null;
  captured: boolean;
}): boolean {
  if (captured) return false;
  return frame !== null && activeElement === frame;
}

/**
 * Thin, timer-free wrapper that drives {@link shouldReleaseStolenFocus} from a
 * poll (async focus emits no outer event we can rely on) and from window focus
 * changes, calling `release` when the iframe holds stolen focus. `schedule` and
 * `listen` each return their own teardown; the returned cleanup runs both.
 */
export function watchDesktopFocusSteal({
  check,
  release,
  schedule,
  listen,
}: {
  check: () => boolean;
  release: () => void;
  schedule: (tick: () => void) => () => void;
  listen: (tick: () => void) => () => void;
}): () => void {
  const tick = () => {
    if (check()) release();
  };
  const stopPoll = schedule(tick);
  const stopListening = listen(tick);
  return () => {
    stopPoll();
    stopListening();
  };
}

/** Return keyboard focus to the last legitimate element outside the pane (the
 *  composer), or blur the frame when that element is gone. */
function restoreOuterFocus(previous: HTMLElement | null, frame: HTMLIFrameElement | null): void {
  if (previous?.isConnected) {
    previous.focus();
    return;
  }
  frame?.blur();
}

/**
 * The "Desktop" tab: a live view of the conversation's sandbox GUI (multi-repo),
 * via noVNC. The sandbox runtime keeps Xorg + Budgie + x11vnc + noVNC alive on
 * :6080; we iframe noVNC's own `vnc.html` served THROUGH the
 * `/api/desktop-proxy/<threadId>` bridge (backend injects the provider preview
 * token on both the static app and the RFB WebSocket — see backend
 * runs/desktop-proxy.ts), sandboxed into an opaque origin. The bridge points
 * noVNC's socket back at itself so the token never reaches the browser;
 * `autoconnect` opens it on load and `resize=scale` fits the remote screen to
 * the pane.
 *
 * The tab is always present. Before a sandbox exists, or while a retained
 * sandbox's desktop service is being repaired, probe the authenticated proxy
 * and show a product-owned waiting state instead of embedding raw error JSON.
 *
 * Presentation is the Agent Screen card: a view-only framed capture in the
 * rail, and a full-width viewer where "Take control" routes input to the
 * desktop. `live` is the thread's live-run signal, for the status pill.
 */
export function DesktopPane({
  threadId,
  live,
  active,
}: {
  threadId: string;
  live: boolean;
  active: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // vnc.html has loaded AND noVNC reports its RFB session up (see the listener below).
  const [frameConnected, setFrameConnected] = useState(false);
  // Bumped to reload the frame through the session entry (a fresh capability).
  const [frameKey, setFrameKey] = useState(0);
  const [inputCaptured, setInputCaptured] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [status, setStatus] = useState("Nothing is running yet. Send a message to start one.");
  // The Agent Screen stage: the frame plus, while expanded, the viewer chrome.
  // Pointer and focus activity inside it never releases captured input.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Mirrors inputCaptured synchronously so the focus-steal guard cannot race
  // the explicit transition from watch-only to interactive desktop input.
  const inputCapturedRef = useRef(false);
  // The last focused element OUTSIDE this pane (usually the composer) - where
  // stolen focus gets returned to.
  const lastOuterFocusRef = useRef<HTMLElement | null>(null);

  const readySrc = `/api/desktop-proxy/${threadId}/ready`;
  const src = buildDesktopFrameSrc(threadId);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Bounded exponential backoff (250ms -> x1.5 -> 2000ms cap); null until the
    // first retry is scheduled. Polling never stops while the pane is mounted.
    let delay: number | null = null;
    setReady(false);
    setLoaded(false);
    setFrameConnected(false);
    inputCapturedRef.current = false;
    setInputCaptured(false);
    setStatus("Nothing is running yet. Send a message to start one.");

    const probe = async (): Promise<void> => {
      try {
        const response = await fetch(readySrc, { cache: "no-store" });
        if (response.ok) {
          await response.body?.cancel();
          if (cancelled) return;
          setReady(true);
          return;
        }
        const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
        if (cancelled) return;
        setStatus(
          desktopProbeStatus(
            response.status,
            typeof payload?.error === "string" ? payload.error : null,
          ),
        );
      } catch {
        if (cancelled) return;
        setStatus("Reconnecting…");
      }
      delay = nextDesktopProbeDelay(delay);
      retry = setTimeout(() => void probe(), delay);
    };

    void probe();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [readySrc]);

  const releaseCapture = useCallback(() => {
    inputCapturedRef.current = false;
    setInputCaptured(false);
    try {
      frameRef.current?.contentWindow?.blur();
    } catch {
      // Disabling pointer events still prevents re-capture.
    }
  }, []);

  // Taking control enables pointer input without trapping keyboard focus in the
  // cross-origin iframe. A subsequent explicit click on the desktop focuses it.
  const captureInput = useCallback(() => {
    inputCapturedRef.current = true;
    setInputCaptured(true);
  }, []);

  // Control survives collapsing the viewer: the card can hold the pointer too.
  // Any click or focus outside the stage still releases it (the effect below).
  const setViewer = useCallback((open: boolean) => setViewerOpen(open), []);

  // SessionView keeps the desktop mounted to preserve its WebSocket. When a
  // different rail surface becomes active, close the modal and release input
  // before the preserved pane is made invisible.
  useEffect(() => {
    if (active) return;
    releaseCapture();
    setViewerOpen(false);
  }, [active, releaseCapture]);

  useEffect(() => {
    if (!inputCaptured) return;

    const releaseDesktopInput = (event: FocusEvent | PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && surfaceRef.current?.contains(target)) return;
      releaseCapture();
    };

    window.addEventListener("focusin", releaseDesktopInput, true);
    window.addEventListener("pointerdown", releaseDesktopInput, true);
    return () => {
      window.removeEventListener("focusin", releaseDesktopInput, true);
      window.removeEventListener("pointerdown", releaseDesktopInput, true);
    };
  }, [inputCaptured, releaseCapture]);

  useEffect(() => {
    if (!loaded) return;

    // Remember where keyboard focus legitimately lives outside the pane, so a
    // steal can be undone. Seeded from the moment the frame finishes loading
    // (the composer, if the user was typing when they opened Desktop).
    const active = document.activeElement;
    if (active instanceof HTMLElement && !surfaceRef.current?.contains(active)) {
      lastOuterFocusRef.current = active;
    }
    const rememberOuterFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (surfaceRef.current?.contains(target)) return;
      lastOuterFocusRef.current = target;
    };
    window.addEventListener("focusin", rememberOuterFocus, true);
    return () => window.removeEventListener("focusin", rememberOuterFocus, true);
  }, [loaded]);

  // The sandboxed frame's inner document is unreachable, so noVNC's async
  // rfb.focus() steal is seen as the iframe ELEMENT becoming
  // document.activeElement: while the pane is only being watched, poll for it -
  // and re-check on window focus changes - then bounce it back to the composer.
  // Stops at the explicit capture click, which SHOULD route the keyboard to the
  // desktop.
  useEffect(() => {
    if (!loaded || inputCaptured) return;
    return watchDesktopFocusSteal({
      check: () =>
        shouldReleaseStolenFocus({
          activeElement: document.activeElement,
          frame: frameRef.current,
          captured: inputCapturedRef.current,
        }),
      release: () => restoreOuterFocus(lastOuterFocusRef.current, frameRef.current),
      schedule: (tick) => {
        const id = window.setInterval(tick, DESKTOP_FOCUS_WATCHDOG_INTERVAL);
        return () => window.clearInterval(id);
      },
      listen: (tick) => {
        window.addEventListener("focusin", tick, true);
        window.addEventListener("blur", tick, true);
        return () => {
          window.removeEventListener("focusin", tick, true);
          window.removeEventListener("blur", tick, true);
        };
      },
    });
  }, [loaded, inputCaptured]);

  // The iframe's load event fires when vnc.html has parsed, seconds before the
  // RFB WebSocket session is up, so hold the card on Loading until the frame
  // reports a desktop on screen. A session that drops after that reloads the
  // frame through the session entry: the view's short-lived capability may
  // have expired, and noVNC's own reconnect would retry it forever.
  useEffect(() => {
    let connectedOnce = false;
    const onMessage = (event: MessageEvent) => {
      const connected = desktopFrameConnection(event, frameRef.current?.contentWindow);
      if (connected === null) return;
      setFrameConnected(connected);
      if (connected) {
        connectedOnce = true;
      } else if (connectedOnce) {
        connectedOnce = false;
        setLoaded(false);
        setFrameKey((key) => key + 1);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  const connected = ready && loaded && frameConnected;
  const frameInteractive = desktopFrameInteractive({ loaded, captured: inputCaptured });

  return (
    <div className="size-full overflow-y-auto p-3">
      <AgentScreen
        surfaceRef={surfaceRef}
        status={desktopScreenStatus({ connected, live })}
        loading={!connected}
        loadingCaption={ready ? undefined : status}
        open={viewerOpen}
        onOpenChange={setViewer}
        interactive={frameInteractive}
        controls={
          <Button
            variant="secondary"
            size="small"
            aria-pressed={inputCaptured}
            disabled={!connected}
            onClick={inputCaptured ? releaseCapture : captureInput}
            className="rounded-full"
          >
            {inputCaptured ? "Release control" : "Take control"}
          </Button>
        }
        screen={
          ready ? (
            <iframe
              key={frameKey}
              ref={frameRef}
              data-testid="desktop-frame"
              title="Browser"
              src={src}
              sandbox={DESKTOP_FRAME_SANDBOX}
              tabIndex={-1}
              onLoad={(event) => {
                setLoaded(true);
                event.currentTarget.blur();
              }}
              className="absolute inset-0 size-full border-0"
              style={{ pointerEvents: frameInteractive ? "auto" : "none" }}
              allow="clipboard-read; clipboard-write"
            />
          ) : null
        }
      />
    </div>
  );
}
