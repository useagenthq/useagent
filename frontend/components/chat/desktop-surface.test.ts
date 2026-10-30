import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildDesktopFrameSrc,
  DESKTOP_FRAME_SANDBOX,
  DESKTOP_PROBE_MAX_DELAY,
  DESKTOP_PROBE_MIN_DELAY,
  desktopProbeStatus,
  nextDesktopProbeDelay,
  shouldReleaseStolenFocus,
  watchDesktopFocusSteal,
} from "./desktop-pane";

describe("Desktop product surface", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("every sandbox-backed thread exposes Browser but mounts noVNC only after selection", () => {
    const sessionView = read("./session-view.tsx");
    const railTabs = read("./session-rail-tabs.tsx");

    // The Browser pill is unconditional in the rail's switcher.
    expect(railTabs).toContain('tab("desktop", RiComputerLine, "Browser")');
    expect(railTabs).toContain("data-testid={`rail-tab-${id}`}");
    expect(railTabs).not.toContain("hasDesktop");
    expect(sessionView).not.toContain("{hasDesktop && (");
    expect(sessionView).toContain("<DesktopPane");
    expect(sessionView).toContain(
      'const desktopActive = railTab === "desktop" && (!surfacesSheet || sheetSurfacesOpen)',
    );
    expect(sessionView).toContain("active={desktopActive}");
    expect(sessionView).toContain("desktopEverOpened ? (");
    expect(sessionView).toContain('if (railTab === "desktop") setDesktopEverOpened(true)');
    expect(sessionView).toContain(
      'const hasRuntimeSurfaces = normalizeEngine(newest.engine) !== "chat"',
    );
    expect(sessionView).toContain("const railOpen = railOverride ?? (railDefaultOpen && hasRuntimeSurfaces)");
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
    expect(desktopPane).toContain("Starting the browser…");
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

  test("the frame opens the session entry; the backend owns noVNC's socket path", () => {
    const frameUrl = new URL(buildDesktopFrameSrc("thread-1"), "http://localhost:3401");
    expect(frameUrl.pathname).toBe("/api/desktop-proxy/thread-1/vnc.html");
    // The capability view the entry redirects to is the only valid socket path.
    expect(frameUrl.searchParams.get("path")).toBeNull();
    expect(frameUrl.searchParams.get("reconnect")).toBe("true");
    expect(frameUrl.searchParams.get("reconnect_delay")).toBe("500");
  });

  test("sandbox-served noVNC runs in an opaque origin", () => {
    const desktopPane = read("./desktop-pane.tsx");
    expect(desktopPane).toContain("sandbox={DESKTOP_FRAME_SANDBOX}");
    expect(DESKTOP_FRAME_SANDBOX.split(" ").toSorted()).toEqual([
      "allow-downloads",
      "allow-forms",
      "allow-popups",
      "allow-scripts",
    ]);
    // The pane never reaches into the frame's document.
    expect(desktopPane).not.toContain("contentDocument");
  });

  test("the embedded noVNC iframe cannot steal composer focus implicitly", () => {
    const desktopPane = read("./desktop-pane.tsx");

    expect(desktopPane).toContain("tabIndex={-1}");
    expect(desktopPane).toContain('data-testid="desktop-frame"');
    // Pointer input reaches the frame only once loaded and after the explicit
    // take-control gesture (desktopFrameInteractive), card or viewer alike.
    expect(desktopPane).toContain("desktopFrameInteractive({ loaded, captured: inputCaptured })");
    expect(desktopPane).toContain('pointerEvents: frameInteractive ? "auto" : "none"');
    expect(desktopPane).toContain("interactive={frameInteractive}");
    // The control button has no fixed aria-label: its visible text (Take
    // control / Release control) is its accessible name.
    expect(desktopPane).not.toContain('aria-label="Control sandbox desktop"');
    expect(desktopPane).toContain('inputCaptured ? "Release control" : "Take control"');
    expect(desktopPane).toContain('window.addEventListener("focusin", releaseDesktopInput, true)');
    expect(desktopPane).toContain(
      'window.addEventListener("pointerdown", releaseDesktopInput, true)',
    );
  });

  test("the mount/connect path never grabs keyboard focus: noVNC steals are bounced", () => {
    const desktopPane = read("./desktop-pane.tsx");

    // Stolen focus returns to the last legitimate outer element (the composer).
    expect(desktopPane).toContain('window.addEventListener("focusin", rememberOuterFocus, true)');
    expect(desktopPane).toContain("lastOuterFocusRef.current = target");
    expect(desktopPane).toContain("previous.focus()");
    // Enabling control never strands keyboard focus in the cross-origin frame.
    expect(desktopPane).not.toContain("contentWindow?.focus()");
    expect(desktopPane).toContain("inputCapturedRef.current = true;");
    // Release resets the synchronous mirror too, so the guard resumes bouncing.
    expect(desktopPane).toContain("inputCapturedRef.current = false;");
  });

  test("the pill, Open and Take control wait for the RFB session, not just the vnc.html load", () => {
    const desktopPane = read("./desktop-pane.tsx");

    // The iframe's onLoad fires about 2.5s before noVNC connects (sweep m9), so
    // load alone never counts as connected: the sandboxed frame reports noVNC's
    // connected marker by message, and a dropped session reloads the frame.
    expect(desktopPane).not.toContain("const connected = ready && loaded;");
    expect(desktopPane).toContain("const connected = ready && loaded && frameConnected;");
    expect(desktopPane).toContain(
      "desktopFrameConnection(event, frameRef.current?.contentWindow)",
    );
    expect(desktopPane).toContain('window.addEventListener("message", onMessage)');
    expect(desktopPane).toContain("setFrameKey((key) => key + 1)");
    expect(desktopPane).toContain("key={frameKey}");
    // A thread switch starts over from Loading.
    expect(desktopPane).toContain("setFrameConnected(false);");
    // Everything the sweep saw lift early keys off that connected flag.
    expect(desktopPane).toContain("loading={!connected}");
    expect(desktopPane).toContain("disabled={!connected}");
    expect(desktopPane).toContain("status={desktopScreenStatus({ connected, live })}");
  });

  test("bot home, delegated and plain threads share the SessionView rail and its Agent Screen card", () => {
    const desktopPane = read("./desktop-pane.tsx");
    const botThreadPane = read("../bots/bot-thread-pane.tsx");
    const threadPage = read("../../app/session/(thread)/[id]/page.tsx");
    const botsWorkspace = read("../bots/bots-workspace.tsx");

    // The card is the pane's only presentation: whoever renders SessionView gets it.
    expect(desktopPane).toContain("<AgentScreen");
    expect(desktopPane).not.toContain("Click to control desktop");
    // A bot's home thread (/bots/[id]) and a delegated thread (/session/[id]
    // resolved through botForThread) both render the real SessionView.
    expect(botsWorkspace).toContain("<BotThreadPane bot={selected} thread={thread} />");
    expect(botThreadPane).toContain("<SessionView");
    expect(threadPage).toContain("botForThread(bots, id)");
    expect(threadPage).toContain("<SessionView");
  });

  test("the take-control toggle is the only way into the frame; control survives collapse, leaving the surface releases it", () => {
    const desktopPane = read("./desktop-pane.tsx");
    const agentScreen = read("../ai/agent-screen.tsx");

    expect(desktopPane).toContain("aria-pressed={inputCaptured}");
    expect(desktopPane).toContain('{inputCaptured ? "Release control" : "Take control"}');
    expect(desktopPane).toContain("onClick={inputCaptured ? releaseCapture : captureInput}");
    expect(desktopPane).not.toContain("if (!open) releaseCapture();");
    expect(desktopPane).toContain("if (active) return;");
    expect(desktopPane).toContain("setViewerOpen(false);");
    // The one toggle lives in the card's status row while collapsed and in the
    // viewer's title bar while open; no click-to-control overlay anywhere.
    expect(agentScreen).toContain("{!open && controls}");
    expect(agentScreen).toContain("ref={surfaceRef}");
    expect(agentScreen).toContain("ref={openButtonRef}");
    expect(desktopPane).toContain("surfaceRef={surfaceRef}");
    expect(desktopPane).not.toContain("Click to control desktop");
  });

  test("the cross-origin steal check fires only when the iframe element holds focus", () => {
    // Fake the iframe element and an unrelated outside element (the composer).
    const frame = { id: "desktop-frame" } as unknown as Element;
    const composer = { id: "composer" } as unknown as Element;

    // noVNC's async rfb.focus() lands on the iframe element while only watching.
    expect(shouldReleaseStolenFocus({ activeElement: frame, frame, captured: false })).toBe(true);
    // After an explicit "click to control", focus legitimately lives in the pane.
    expect(shouldReleaseStolenFocus({ activeElement: frame, frame, captured: true })).toBe(false);
    // Focus that stayed on the composer is left alone.
    expect(shouldReleaseStolenFocus({ activeElement: composer, frame, captured: false })).toBe(
      false,
    );
    // Nothing focused, or no frame mounted yet, is never a steal.
    expect(shouldReleaseStolenFocus({ activeElement: null, frame, captured: false })).toBe(false);
    expect(shouldReleaseStolenFocus({ activeElement: null, frame: null, captured: false })).toBe(
      false,
    );
  });

  test("the watchdog releases stolen focus on poll and window focus, then cleans up both", () => {
    // Deterministic, no real timers: capture the tick the wrapper schedules and
    // fire it by hand.
    let stolen = true;
    let releases = 0;
    let tickFromPoll: (() => void) | null = null;
    let tickFromListen: (() => void) | null = null;
    let pollStopped = false;
    let listenStopped = false;

    const cleanup = watchDesktopFocusSteal({
      check: () => stolen,
      release: () => {
        releases += 1;
      },
      schedule: (tick) => {
        tickFromPoll = tick;
        return () => {
          pollStopped = true;
        };
      },
      listen: (tick) => {
        tickFromListen = tick;
        return () => {
          listenStopped = true;
        };
      },
    });

    // The poll and the window focus listeners run the same check.
    expect(tickFromPoll).toBe(tickFromListen);

    // A poll while the iframe holds stolen focus hands it back to the composer.
    tickFromPoll?.();
    expect(releases).toBe(1);
    // A window focus change re-checks too.
    tickFromListen?.();
    expect(releases).toBe(2);

    // Once captured (nothing to release), the watchdog does not interfere.
    stolen = false;
    tickFromPoll?.();
    expect(releases).toBe(2);

    // Cleanup stops the poll and detaches the listeners.
    cleanup();
    expect(pollStopped).toBe(true);
    expect(listenStopped).toBe(true);
  });

  test("a cross-origin watchdog bounces noVNC's async focus off the iframe element", () => {
    const desktopPane = read("./desktop-pane.tsx");

    // Runs only while the pane is watched (loaded, not captured).
    expect(desktopPane).toContain("if (!loaded || inputCaptured) return;");
    expect(desktopPane).toContain("watchDesktopFocusSteal({");
    // Keys off the iframe ELEMENT being activeElement - observable from the
    // outer page, unlike the sandboxed frame's own document.
    expect(desktopPane).toContain("activeElement: document.activeElement");
    expect(desktopPane).toContain("frame: frameRef.current");
    expect(desktopPane).toContain("captured: inputCapturedRef.current");
    // Poll plus window focus changes; restores the remembered outer focus.
    expect(desktopPane).toContain("window.setInterval(tick, DESKTOP_FOCUS_WATCHDOG_INTERVAL)");
    expect(desktopPane).toContain('window.addEventListener("focusin", tick, true)');
    expect(desktopPane).toContain('window.addEventListener("blur", tick, true)');
    expect(desktopPane).toContain("restoreOuterFocus(lastOuterFocusRef.current, frameRef.current)");
  });
});

describe("Desktop probe copy", () => {
  test("names the binaries a sandbox image lacks instead of waiting forever", () => {
    expect(
      desktopProbeStatus(502, "desktop proxy failed: missing desktop binaries: budgie-panel"),
    ).toBe(
      "The browser is not available here: it is missing budgie-panel. Rebuild the environment with those packages to enable it.",
    );
    expect(
      desktopProbeStatus(
        502,
        "desktop proxy failed: missing desktop binaries: xdotool budgie-panel",
      ),
    ).toContain("missing xdotool, budgie-panel");
  });

  test("keeps the waiting and no-sandbox states for every other answer", () => {
    expect(desktopProbeStatus(409, "no live sandbox for this conversation yet")).toBe(
      "Nothing is running yet. Send a message to start one.",
    );
    expect(desktopProbeStatus(502, "desktop proxy failed: connect ECONNREFUSED")).toBe(
      "Starting the browser…",
    );
    expect(desktopProbeStatus(500, null)).toBe("Starting the browser…");
  });

  test("the pane reads the probe body so the copy can be honest", () => {
    const desktopPane = readFileSync(new URL("./desktop-pane.tsx", import.meta.url), "utf8");
    expect(desktopPane).toContain("desktopProbeStatus(");
    expect(desktopPane).toContain("await response.json().catch(() => null)");
  });
});
