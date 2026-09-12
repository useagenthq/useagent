import { describe, expect, test } from "bun:test";
import type { DesktopFrameDoc } from "./desktop-frame-connection";
import {
  DESKTOP_CONNECT_POLL_INTERVAL,
  isDesktopFrameConnected,
  watchDesktopFrameConnected,
} from "./desktop-frame-connection";

/** A vnc.html document whose <html> carries the given noVNC state classes. */
const frameDoc = (...classes: string[]): DesktopFrameDoc => ({
  documentElement: { classList: { contains: (token) => classes.includes(token) } },
});

describe("desktop frame connection", () => {
  test("a loaded vnc.html that is still connecting is not a connected desktop", () => {
    // Sweep m9: the iframe's onLoad fires about 2.5s before the RFB session is
    // up. In that window the page has loaded and shows noVNC's "Connecting...".
    expect(isDesktopFrameConnected(frameDoc("noVNC_loaded", "noVNC_connecting"))).toBe(false);
    expect(isDesktopFrameConnected(frameDoc("noVNC_loaded"))).toBe(false);
    expect(isDesktopFrameConnected(frameDoc("noVNC_loaded", "noVNC_reconnecting"))).toBe(false);
  });

  test("the desktop is connected once noVNC stamps the session on its document", () => {
    expect(isDesktopFrameConnected(frameDoc("noVNC_loaded", "noVNC_connected"))).toBe(true);
  });

  test("an unavailable frame document is never mistaken for a connected desktop", () => {
    expect(isDesktopFrameConnected(null)).toBe(false);
  });

  test("the poll keeps Loading until connected, then reports once and stops itself", () => {
    // Deterministic, no real timers: capture the scheduled tick and fire it.
    let connected = false;
    let reports = 0;
    let tick: (() => void) | null = null;
    let stops = 0;

    const cleanup = watchDesktopFrameConnected({
      check: () => connected,
      onConnected: () => {
        reports += 1;
      },
      schedule: (scheduled) => {
        tick = scheduled;
        return () => {
          stops += 1;
        };
      },
    });

    // Still connecting: nothing reported, poll keeps going.
    tick?.();
    tick?.();
    expect(reports).toBe(0);
    expect(stops).toBe(0);

    // The RFB session comes up: reported exactly once and the interval is cleared.
    connected = true;
    tick?.();
    expect(reports).toBe(1);
    expect(stops).toBe(1);

    // Unmount/reload cleanup after the fact is harmless.
    cleanup();
    expect(reports).toBe(1);
  });

  test("cleanup stops an unfinished poll without ever reporting connected", () => {
    let reports = 0;
    let stops = 0;
    const cleanup = watchDesktopFrameConnected({
      check: () => false,
      onConnected: () => {
        reports += 1;
      },
      schedule: () => () => {
        stops += 1;
      },
    });
    cleanup();
    expect(stops).toBe(1);
    expect(reports).toBe(0);
  });

  test("an already-connected frame reports immediately and schedules no poll", () => {
    let reports = 0;
    let scheduled = false;
    watchDesktopFrameConnected({
      check: () => true,
      onConnected: () => {
        reports += 1;
      },
      schedule: () => {
        scheduled = true;
        return () => {};
      },
    });
    expect(reports).toBe(1);
    expect(scheduled).toBe(false);
  });

  test("the poll cadence is sub-second so the pill trails the real connection closely", () => {
    expect(DESKTOP_CONNECT_POLL_INTERVAL).toBe(250);
  });
});
