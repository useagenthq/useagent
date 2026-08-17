import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildDesktopFrameSrc,
  DESKTOP_PROBE_MAX_DELAY,
  DESKTOP_PROBE_MIN_DELAY,
  nextDesktopProbeDelay,
} from "./desktop-pane";

describe("Desktop product surface", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("every sandbox-backed thread exposes Browser but mounts noVNC only after selection", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain('value="desktop" data-testid="rail-tab-desktop"');
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
});
