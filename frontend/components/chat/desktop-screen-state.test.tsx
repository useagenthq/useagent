import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentScreen } from "@/components/ai/agent-screen";
import { desktopFrameInteractive, desktopScreenStatus } from "./desktop-screen-state";

describe("desktop screen status pill", () => {
  test("is Loading until the screen is connected, whatever the run is doing", () => {
    expect(desktopScreenStatus({ connected: false, live: false })).toBe("loading");
    expect(desktopScreenStatus({ connected: false, live: true })).toBe("loading");
  });

  test("is Working while the thread has a live run and Idle once it settles", () => {
    expect(desktopScreenStatus({ connected: true, live: true })).toBe("working");
    expect(desktopScreenStatus({ connected: true, live: false })).toBe("idle");
  });
});

describe("desktop frame interactivity", () => {
  test("the frame is view-only until the explicit take-control gesture", () => {
    expect(desktopFrameInteractive({ loaded: true, captured: false })).toBe(false);
    expect(desktopFrameInteractive({ loaded: false, captured: false })).toBe(false);
  });

  test("taking control makes a loaded frame interactive, in the card and the viewer alike", () => {
    expect(desktopFrameInteractive({ loaded: true, captured: true })).toBe(true);
    expect(desktopFrameInteractive({ loaded: false, captured: true })).toBe(false);
  });
});

describe("agent screen card", () => {
  const render = (open: boolean, extra: Partial<Parameters<typeof AgentScreen>[0]> = {}) =>
    renderToStaticMarkup(
      <AgentScreen
        agentName="Nova"
        status="working"
        screen={<div data-testid="live" />}
        open={open}
        onOpenChange={() => {}}
        controls={<button type="button">Take control</button>}
        {...extra}
      />,
    );

  test("collapsed: the Open control over the live screen, the controls and Expand in the status row, no viewer chrome", () => {
    const html = render(false);
    expect(html).toContain('data-agent-screen="collapsed"');
    expect(html).toContain('aria-label="Open Nova&#x27;s screen"');
    expect(html).toContain("Nova&#x27;s screen");
    expect(html).toContain('data-status="working"');
    expect(html).toContain('data-testid="live"');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("Take control");
    expect(html).toContain('aria-label="Expand"');
    expect(html).not.toContain('aria-label="Collapse"');
  });

  test("collapsed and interactive: the frame takes the pointer, so the Open overlay steps aside", () => {
    const html = render(false, { interactive: true });
    expect(html).not.toContain('aria-label="Open Nova&#x27;s screen"');
    expect(html).toContain('aria-label="Expand"');
    expect(html).toContain('data-testid="live"');
  });

  test("expanded: a dialog with the controls and Collapse around the same screen", () => {
    const html = render(true);
    expect(html).toContain('data-agent-screen="open"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Nova&#x27;s screen"');
    expect(html).toContain("Take control");
    expect(html).toContain('aria-label="Collapse"');
    expect(html.split('aria-label="Collapse"')).toHaveLength(2);
    expect(html).toContain('data-testid="live"');
    expect(html).toContain("max-w-full");
    expect(html).not.toContain('aria-label="Open Nova&#x27;s screen"');
  });

  test("the stage stays one dialog element in both states, so the screen has one stable owner", () => {
    for (const open of [false, true]) {
      const html = render(open);
      expect(html.split("<dialog")).toHaveLength(2);
      expect(html.split('data-testid="live"')).toHaveLength(2);
    }
  });

  test("loading covers the frame with the connecting screen and the probe caption", () => {
    const html = render(false, {
      status: "loading",
      loading: true,
      loadingCaption: "No active sandbox. Send a message to start one.",
    });
    expect(html).toContain("Connecting to agent&#x27;s screen");
    expect(html).toContain("No active sandbox. Send a message to start one.");
    expect(html).toContain('data-status="loading"');
    // Nothing to open into yet: the connecting card offers no Open control.
    expect(html).not.toContain('aria-label="Open Nova&#x27;s screen"');
  });
});
