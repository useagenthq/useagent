/** Minimal structural slice of the frame's Document the connection watch reads. */
export interface DesktopFrameDoc {
  documentElement: { classList: { contains(token: string): boolean } };
}

/**
 * noVNC's client stamps its connection state on vnc.html's own <html> element
 * (app/ui.js updateVisualState): noVNC_connecting while the RFB handshake runs,
 * noVNC_connected once the session is up. Only the latter means a desktop is on
 * screen; the iframe's load event fires seconds earlier, with the page still
 * showing "Connecting...".
 */
const DESKTOP_FRAME_CONNECTED_CLASS = "noVNC_connected";

/**
 * Whether the frame document shows a connected desktop. An unavailable
 * document is not evidence of a completed RFB handshake, so it stays
 * non-connected and keeps desktop controls disabled.
 */
export function isDesktopFrameConnected(doc: DesktopFrameDoc | null): boolean {
  return doc?.documentElement.classList.contains(DESKTOP_FRAME_CONNECTED_CLASS) ?? false;
}

/** Poll cadence while waiting for the frame's RFB session to come up (ms). */
export const DESKTOP_CONNECT_POLL_INTERVAL = 250;

/**
 * Polls `check` until the frame reports connected, then calls `onConnected`
 * once and stops its own interval. The returned cleanup stops an unfinished
 * poll (frame unmounted or reloaded). Timer-free like the focus watchdog:
 * `schedule` owns the interval so the poll is deterministic under test.
 */
export function watchDesktopFrameConnected({
  check,
  onConnected,
  schedule,
}: {
  check: () => boolean;
  onConnected: () => void;
  schedule: (tick: () => void) => () => void;
}): () => void {
  if (check()) {
    onConnected();
    return () => {};
  }
  const stopPoll = schedule(() => {
    if (!check()) return;
    stopPoll();
    onConnected();
  });
  return stopPoll;
}
