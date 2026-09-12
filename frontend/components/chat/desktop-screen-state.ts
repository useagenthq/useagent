import type { AgentScreenStatus } from "@/components/ai/agent-screen";

/**
 * Status pill for the live desktop card: Loading until the screen is
 * connected (readiness probe passed, the noVNC frame loaded and its RFB
 * session is up), then Working while the thread has a live run, else Idle.
 */
export function desktopScreenStatus({
  connected,
  live,
}: {
  connected: boolean;
  live: boolean;
}): AgentScreenStatus {
  if (!connected) return "loading";
  return live ? "working" : "idle";
}

/**
 * The noVNC frame takes pointer input only once it has loaded and after the
 * explicit take-control gesture, in the card and in the viewer alike. Until
 * that gesture the frame is view-only, so it can never steal a click or focus.
 */
export function desktopFrameInteractive({
  loaded,
  captured,
}: {
  loaded: boolean;
  captured: boolean;
}): boolean {
  return loaded && captured;
}
