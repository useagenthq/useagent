import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Desktop product surface", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("the rail always exposes Desktop instead of waiting for a capability event", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain('value="desktop" data-testid="rail-tab-desktop"');
    expect(sessionView).not.toContain("{hasDesktop && (");
    expect(sessionView).toContain("<DesktopPane threadId={rootId} />");
  });

  test("the pane probes and retries without embedding raw proxy errors", () => {
    const desktopPane = read("./desktop-pane.tsx");

    expect(desktopPane).toContain('fetch(src, { cache: "no-store" })');
    expect(desktopPane).toContain("Starting sandbox desktop…");
    expect(desktopPane).toContain("setTimeout(() => void probe(), 1_000)");
  });
});
