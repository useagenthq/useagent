import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildDesktopFrameSrc } from "./desktop-pane";

describe("Desktop product surface", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("the rail always exposes Desktop instead of waiting for a capability event", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain('value="desktop" data-testid="rail-tab-desktop"');
    expect(sessionView).not.toContain("{hasDesktop && (");
    expect(sessionView).toContain("<DesktopPane threadId={rootId} />");
    expect(sessionView).toContain("const railOpen = railOverride ?? true");
    expect(sessionView).not.toContain("railOverride ?? hasRailContent");
    expect(sessionView).toContain('aria-hidden={railTab !== "desktop"}');
    expect(sessionView).toContain(
      'railTab === "desktop" ? "visible" : "pointer-events-none invisible"',
    );
  });

  test("the rail resize separator has a visible grip and explicit semantics", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain("<hr");
    expect(sessionView).toContain("before:bg-stroke-soft-200");
    expect(sessionView).toContain("cursor-col-resize");
  });

  test("the pane probes and retries without embedding raw proxy errors", () => {
    const desktopPane = read("./desktop-pane.tsx");
    const threadInterpolation = "$" + "{threadId}";

    expect(desktopPane).toContain(`\`/api/desktop-proxy/${threadInterpolation}/ready\``);
    expect(desktopPane).toContain('fetch(readySrc, { cache: "no-store" })');
    expect(desktopPane).toContain("Starting sandbox desktop…");
    expect(desktopPane).toContain("setTimeout(() => void probe(), 1_000)");
  });

  test("noVNC resolves its WebSocket to the thread desktop proxy", () => {
    const threadId = "thread-1";
    const frameUrl = new URL(buildDesktopFrameSrc(threadId), "http://localhost:3401");
    const path = frameUrl.searchParams.get("path");
    if (!path) throw new Error("desktop frame is missing its noVNC WebSocket path");
    expect(frameUrl.searchParams.get("reconnect")).toBe("true");
    expect(frameUrl.searchParams.get("reconnect_delay")).toBe("500");
    // Match noVNC 1.6's `new URL(path, location.href)` behavior. Without the
    // leading slash, the entire desktop-proxy prefix is duplicated.
    const socketUrl = new URL(path, frameUrl);

    expect(socketUrl.pathname).toBe(`/api/desktop-proxy/${threadId}/websockify`);
  });
});
