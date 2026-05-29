import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildDesktopFrameSrc,
  DESKTOP_PROBE_MAX_DELAY,
  DESKTOP_PROBE_MIN_DELAY,
  guardDesktopFocusSteal,
  nextDesktopProbeDelay,
} from "./desktop-pane";
import type { DesktopFocusGuardDoc } from "./desktop-pane";

describe("Desktop product surface", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("every sandbox-backed thread exposes Browser but mounts noVNC only after selection", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain('data-testid="rail-tab-desktop"');
    expect(sessionView).toContain('isSelected={railTab === "desktop"}');
    expect(sessionView).toContain('onSelect={() => setRailTabOverride("desktop")}');
    expect(sessionView).not.toContain("{hasDesktop && (");
    expect(sessionView).toContain("<DesktopPane threadId={rootId} />");
    expect(sessionView).toContain("desktopEverOpened ? (");
    expect(sessionView).toContain('if (railTab === "desktop") setDesktopEverOpened(true)');
    expect(sessionView).toContain(
      'const hasRuntimeSurfaces = normalizeEngine(newest.engine) !== "chat"',
    );
    expect(sessionView).toContain("const railOpen = railOverride ?? hasRuntimeSurfaces");
    expect(sessionView).not.toContain("railOverride ?? hasRailContent");
    expect(sessionView).toContain('aria-hidden={railTab !== "desktop"}');
    expect(sessionView).toContain(
      'railTab === "desktop" ? "visible" : "pointer-events-none invisible"',
    );
  });

  test("the rail resize separator has a visible grip and explicit semantics", () => {
    const sessionView = read("./session-view.tsx");
    const railResizer = read("./rail-resizer.tsx");

    expect(sessionView).toContain("<RailResizer");
    expect(railResizer).toContain("<hr");
    expect(railResizer).toContain('data-testid="rail-resize-grip"');
    expect(railResizer).toContain("before:absolute before:inset-y-3");
    expect(railResizer).toContain("after:top-1/2");
    expect(railResizer).toContain("after:-translate-y-1/2");
    expect(railResizer).toContain('aria-label="Resize the side panel; double-click to reset"');
    expect(railResizer).not.toContain('title="Drag to resize');
    expect(railResizer).toContain("cursor-col-resize");
  });

  test("the pane probes and retries without embedding raw proxy errors", () => {
    const desktopPane = read("./desktop-pane.tsx");
    const threadInterpolation = "$" + "{threadId}";

    expect(desktopPane).toContain(`\`/api/desktop-proxy/${threadInterpolation}/ready\``);
    expect(desktopPane).toContain('fetch(readySrc, { cache: "no-store" })');
    expect(desktopPane).toContain("Starting sandbox desktop…");
    // Retries on bounded exponential backoff, not a fixed one-second interval.
    expect(desktopPane).toContain("delay = nextDesktopProbeDelay(delay)");
    expect(desktopPane).toContain("setTimeout(() => void probe(), delay)");
    expect(desktopPane).not.toContain("setTimeout(() => void probe(), 1_000)");
  });

  test("the readiness probe backs off exponentially from 250ms, capped at 2000ms", () => {
    // First retry starts at the floor.
    expect(nextDesktopProbeDelay(null)).toBe(DESKTOP_PROBE_MIN_DELAY);
    expect(DESKTOP_PROBE_MIN_DELAY).toBe(250);

    // Each retry multiplies by 1.5x (ceil), plateauing at the cap - it never stops.
    const schedule: number[] = [];
    let delay: number | null = null;
    for (let i = 0; i < 8; i++) {
      delay = nextDesktopProbeDelay(delay);
      schedule.push(delay);
    }
    expect(schedule).toEqual([250, 375, 563, 845, 1268, 1902, 2000, 2000]);

    // The cap is a fixed point: once reached, the delay stays there forever.
    expect(nextDesktopProbeDelay(DESKTOP_PROBE_MAX_DELAY)).toBe(DESKTOP_PROBE_MAX_DELAY);
    expect(DESKTOP_PROBE_MAX_DELAY).toBe(2000);
    // Monotonic non-decreasing (never regresses to a faster poll mid-backoff).
    for (let i = 1; i < schedule.length; i++) {
      const current = schedule[i];
      const previous = schedule[i - 1];
      if (current === undefined || previous === undefined) {
        throw new Error("missing desktop probe delay");
      }
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  test("noVNC resolves its WebSocket to the thread desktop proxy", () => {
    const threadId = "thread-1";
    const frameUrl = new URL(buildDesktopFrameSrc(threadId), "http://localhost:3401");
    const path = frameUrl.searchParams.get("path");
    if (!path) throw new Error("desktop frame is missing its noVNC WebSocket path");
    expect(frameUrl.searchParams.get("reconnect")).toBe("true");
    expect(frameUrl.searchParams.get("reconnect_delay")).toBe("500");
    // Current noVNC resolves relative to vnc.html.
    const currentSocketUrl = new URL(path, frameUrl);
    // The Cube template currently carries a legacy noVNC that concatenates
    // `ws(s)://host/` + path. URL parsing normalizes the traversal segments.
    const legacySocketUrl = new URL(`wss://localhost/${path}`);

    expect(currentSocketUrl.pathname).toBe(`/api/desktop-proxy/${threadId}/websockify`);
    expect(legacySocketUrl.pathname).toBe(`/api/desktop-proxy/${threadId}/websockify`);
  });

  test("the embedded noVNC iframe cannot steal composer focus implicitly", () => {
    const desktopPane = read("./desktop-pane.tsx");

    expect(desktopPane).toContain("tabIndex={-1}");
    expect(desktopPane).toContain('data-testid="desktop-frame"');
    expect(desktopPane).toContain('pointerEvents: loaded && inputCaptured ? "auto" : "none"');
    expect(desktopPane).toContain('aria-label="Control sandbox desktop"');
    expect(desktopPane).toContain('window.addEventListener("focusin", releaseDesktopInput, true)');
    expect(desktopPane).toContain(
      'window.addEventListener("pointerdown", releaseDesktopInput, true)',
    );
  });

  test("the mount/connect path never grabs keyboard focus: noVNC steals are bounced", () => {
    const desktopPane = read("./desktop-pane.tsx");

    // The guard watches the frame's own document, because noVNC focuses its
    // canvas on RFB connect - AFTER iframe load, where the onLoad blur cannot
    // reach it.
    expect(desktopPane).toContain("guardDesktopFocusSteal({");
    expect(desktopPane).toContain("frameRef.current?.contentDocument ?? null");
    expect(desktopPane).toContain("isCaptured: () => inputCapturedRef.current");
    // Stolen focus returns to the last legitimate outer element (the composer).
    expect(desktopPane).toContain(
      'window.addEventListener("focusin", rememberOuterFocus, true)',
    );
    expect(desktopPane).toContain("lastOuterFocusRef.current = target");
    expect(desktopPane).toContain("previous.focus()");
    // The ONLY programmatic focus into the frame is the explicit capture click.
    const focusCalls = desktopPane.split("contentWindow?.focus()").length - 1;
    expect(focusCalls).toBe(1);
    expect(desktopPane).toContain("inputCapturedRef.current = true;");
    // Release resets the synchronous mirror too, so the guard resumes bouncing.
    expect(desktopPane).toContain("inputCapturedRef.current = false;");
  });

  test("the focus-steal guard bounces only while input is not captured", () => {
    const listeners = new Map<string, { listener: () => void; capture: boolean }>();
    const innerDoc: DesktopFocusGuardDoc = {
      addEventListener: (type, listener, capture) => listeners.set(type, { listener, capture }),
      removeEventListener: (type) => listeners.delete(type),
    };
    let captured = false;
    let restores = 0;

    const release = guardDesktopFocusSteal({
      innerDoc,
      isCaptured: () => captured,
      restoreFocus: () => {
        restores += 1;
      },
    });

    // Installed as a capture-phase focusin listener on the frame document.
    const entry = listeners.get("focusin");
    if (!entry) throw new Error("guard did not watch focusin on the frame document");
    expect(entry.capture).toBe(true);

    // First open: noVNC autofocuses its canvas on connect - focus is handed back.
    entry.listener();
    expect(restores).toBe(1);

    // After the user explicitly clicks to control, focus may live in the pane.
    captured = true;
    entry.listener();
    expect(restores).toBe(1);

    // Clicking outside releases capture - the guard bounces again.
    captured = false;
    entry.listener();
    expect(restores).toBe(2);

    // Cleanup detaches the listener.
    release();
    expect(listeners.has("focusin")).toBe(false);
  });

  test("the focus-steal guard degrades to a no-op without a same-origin document", () => {
    const release = guardDesktopFocusSteal({
      innerDoc: null,
      isCaptured: () => false,
      restoreFocus: () => {
        throw new Error("must not restore focus without a document to guard");
      },
    });
    expect(() => release()).not.toThrow();
  });
});
