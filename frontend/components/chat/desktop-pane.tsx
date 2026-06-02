"use client";

import { useEffect, useRef, useState } from "react";

export function buildDesktopFrameSrc(threadId: string): string {
  const params = new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    reconnect: "true",
    reconnect_delay: "500",
    // The Cube template's legacy noVNC builds `ws(s)://host/` + path, while
    // current noVNC resolves path relative to vnc.html. This traversal-safe
    // relative form normalizes to the same root route in both implementations.
    path: `../../../api/desktop-proxy/${threadId}/websockify`,
  });
  return `/api/desktop-proxy/${threadId}/vnc.html?${params.toString()}`;
}

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
export function nextDesktopProbeDelay(previous: number | null): number {
  if (previous === null) return DESKTOP_PROBE_MIN_DELAY;
  return Math.min(Math.ceil(previous * 1.5), DESKTOP_PROBE_MAX_DELAY);
}

/** Minimal structural slice of the frame's Document the focus guard needs. */
export interface DesktopFocusGuardDoc {
  addEventListener(type: "focusin", listener: () => void, capture: boolean): void;
  removeEventListener(type: "focusin", listener: () => void, capture: boolean): void;
}

/**
 * noVNC's full client focuses its canvas once the RFB connection settles
 * (app/ui.js calls rfb.focus() on connect). That happens AFTER iframe load -
 * the websocket handshake is async - so the one-shot onLoad blur cannot stop
 * it, and the first keystrokes meant for the composer land in the VNC pane.
 * While the pane is only being watched (input not captured), bounce any focus
 * that lands inside the frame straight back to the app. The pane captures
 * keys only after an explicit click into it. Returns a cleanup function.
 */
export function guardDesktopFocusSteal({
  innerDoc,
  isCaptured,
  restoreFocus,
}: {
  innerDoc: DesktopFocusGuardDoc | null;
  isCaptured: () => boolean;
  restoreFocus: () => void;
}): () => void {
  if (!innerDoc) return () => {};
  const bounce = () => {
    if (isCaptured()) return;
    restoreFocus();
  };
  innerDoc.addEventListener("focusin", bounce, true);
  return () => innerDoc.removeEventListener("focusin", bounce, true);
}

/** Poll cadence for the cross-origin focus-steal watchdog (ms). */
export const DESKTOP_FOCUS_WATCHDOG_INTERVAL = 250;

/**
 * Cross-origin fallback for {@link guardDesktopFocusSteal}. noVNC calls
 * rfb.focus() asynchronously after the RFB connection settles, moving keyboard
 * focus onto the iframe ELEMENT without a user gesture. When the browser treats
 * the `/api/desktop-proxy` iframe as cross-origin the guard's inner document is
 * unreachable, but `document.activeElement === frame` (the iframe element itself)
 * stays observable from the outer page. A steal should be released only while the
 * pane is being watched (input not captured) - once the user clicks to control,
 * the keyboard SHOULD go to the desktop.
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
 * via noVNC. The sandbox runtime keeps Xvfb + XFCE + x11vnc + noVNC alive on
 * :6080; we iframe noVNC's own `vnc.html` served THROUGH the same-origin
 * `/api/desktop-proxy/<threadId>` bridge (backend injects the provider preview
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
  const [inputCaptured, setInputCaptured] = useState(false);
  const [status, setStatus] = useState("Waiting for sandbox…");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Mirrors inputCaptured synchronously so the focus-steal guard cannot race
  // the requestAnimationFrame focus issued by the explicit capture click.
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
    inputCapturedRef.current = false;
    setInputCaptured(false);
    setStatus("Waiting for sandbox…");

    const probe = async (): Promise<void> => {
      try {
        const response = await fetch(readySrc, { cache: "no-store" });
        await response.body?.cancel();
        if (cancelled) return;
        if (response.ok) {
          setReady(true);
          return;
        }
        setStatus(response.status === 409 ? "Waiting for sandbox…" : "Starting sandbox desktop…");
      } catch {
        if (cancelled) return;
        setStatus("Reconnecting to sandbox desktop…");
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

  useEffect(() => {
    if (!inputCaptured) return;

    const releaseDesktopInput = (event: FocusEvent | PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && surfaceRef.current?.contains(target)) return;
      inputCapturedRef.current = false;
      setInputCaptured(false);
      try {
        frameRef.current?.contentWindow?.blur();
      } catch {
        // The desktop proxy is normally same-origin. If a browser treats it as
        // cross-origin, disabling pointer events still prevents re-capture.
      }
    };

    window.addEventListener("focusin", releaseDesktopInput, true);
    window.addEventListener("pointerdown", releaseDesktopInput, true);
    return () => {
      window.removeEventListener("focusin", releaseDesktopInput, true);
      window.removeEventListener("pointerdown", releaseDesktopInput, true);
    };
  }, [inputCaptured]);

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

    let innerDoc: DesktopFocusGuardDoc | null = null;
    try {
      innerDoc = frameRef.current?.contentDocument ?? null;
    } catch {
      // The desktop proxy is normally same-origin. If a browser treats it as
      // cross-origin, tabIndex=-1 + pointer-events none still block capture.
    }
    const releaseGuard = guardDesktopFocusSteal({
      innerDoc,
      isCaptured: () => inputCapturedRef.current,
      restoreFocus: () => restoreOuterFocus(lastOuterFocusRef.current, frameRef.current),
    });

    return () => {
      window.removeEventListener("focusin", rememberOuterFocus, true);
      releaseGuard();
    };
  }, [loaded]);

  // Cross-origin fallback for the same-origin guard above. When the proxy iframe
  // is treated as cross-origin its inner document is unreachable, so the guard's
  // focusin listener never sees noVNC's async rfb.focus() steal. The steal still
  // lands the iframe ELEMENT as document.activeElement (observable cross-origin),
  // so while the pane is only being watched, poll for it - and re-check on window
  // focus changes - then bounce it back to the composer. Stops at the explicit
  // capture click, which SHOULD route the keyboard to the desktop.
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

  if (!ready) {
    return (
      <div className="text-text-tertiary flex size-full items-center justify-center px-6 text-center text-body-2-regular">
        {status}
      </div>
    );
  }

  return (
    <div ref={surfaceRef} className="relative size-full bg-neutral-950">
      <iframe
        ref={frameRef}
        data-testid="desktop-frame"
        title="Sandbox desktop"
        src={src}
        tabIndex={-1}
        onLoad={(event) => {
          setLoaded(true);
          event.currentTarget.blur();
        }}
        className="size-full border-0"
        style={{ pointerEvents: loaded && inputCaptured ? "auto" : "none" }}
        allow="clipboard-read; clipboard-write"
      />
      {!loaded && (
        <div className="bg-background-primary-default text-text-tertiary absolute inset-0 flex items-center justify-center text-body-2-regular">
          Connecting to desktop…
        </div>
      )}
      {loaded && !inputCaptured && (
        <button
          type="button"
          aria-label="Control sandbox desktop"
          onClick={() => {
            inputCapturedRef.current = true;
            setInputCaptured(true);
            requestAnimationFrame(() => frameRef.current?.contentWindow?.focus());
          }}
          className="absolute inset-0 flex items-end justify-center bg-transparent p-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
        >
          <span className="rounded-full bg-neutral-950/80 px-3 py-1.5 text-caption-1-medium text-white shadow-lg backdrop-blur-sm">
            Click to control desktop
          </span>
        </button>
      )}
    </div>
  );
}
