import type { AgentScreenStatus } from "@/components/ai/agent-screen";

/**
 * Status pill for the live desktop card: Loading until the screen is
 * connected (readiness probe passed and the noVNC frame loaded), then Working
 * while the thread has a live run, else Idle.
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
 * The noVNC frame takes pointer input only inside the expanded viewer, once
 * it has loaded, after the explicit take-control gesture. The collapsed card
 * is view-only whatever else is true, so it can never steal a click or focus.
 */
export function desktopFrameInteractive({
  expanded,
  loaded,
  captured,
}: {
  expanded: boolean;
  loaded: boolean;
  captured: boolean;
}): boolean {
  return expanded && loaded && captured;
}
