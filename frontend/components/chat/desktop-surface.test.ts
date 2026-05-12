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
    expect(sessionView).toContain('railTab === "desktop" ? "visible" : "pointer-events-none invisible"');
  });

  test("the rail resize separator has a visible grip and explicit semantics", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain('role="separator"');
    expect(sessionView).toContain("before:bg-stroke-soft-200");
    expect(sessionView).toContain("cursor-col-resize");
  });

  test("the pane probes and retries without embedding raw proxy errors", () => {
    const desktopPane = read("./desktop-pane.tsx");

    expect(desktopPane).toContain('`/api/desktop-proxy/${threadId}/ready`');
    expect(desktopPane).toContain('fetch(readySrc, { cache: "no-store" })');
    expect(desktopPane).toContain("Starting sandbox desktop…");
    expect(desktopPane).toContain("setTimeout(() => void probe(), 1_000)");
  });

  test("noVNC resolves its WebSocket to the thread desktop proxy", () => {
    const threadId = "thread-1";
    const frameUrl = new URL(
      buildDesktopFrameSrc(threadId),
      "http://localhost:3401",
    );
    const socketUrl = new URL(frameUrl.searchParams.get("path")!, frameUrl);

    expect(socketUrl.pathname).toBe(
      `/api/desktop-proxy/${threadId}/websockify`,
    );
  });
});
