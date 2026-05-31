import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentsRail, childElapsedMs, childStatusLabel } from "./agents-rail";
import type { CanonicalChildEventLike } from "./canonical-children";
import type { SubagentCard } from "./subagents";

describe("agents rail child state labels", () => {
  test("uses the explicit resumable flag for idle children", () => {
    expect(childStatusLabel("idle", true)).toBe("Idle · resumable");
    expect(childStatusLabel("idle", false)).toBe("Idle");
  });

  test("keeps the legacy idle label when no resumability signal exists", () => {
    expect(childStatusLabel("idle", null)).toBe("Idle · resumable");
  });

  test("uses provider duration for synthetic canonical timestamps and never shows 0ms", () => {
    const card: SubagentCard = {
      id: "canonical-child-child-1",
      title: "Research checkout",
      childSessionId: "child-1",
      callId: "call-1",
      aliases: ["call-1", "child-1"],
      status: "Completed",
      startedAt: 1,
      lastActivityAt: 2,
    };

    expect(childElapsedMs(card, 10_000, false, 1_234)).toBe(1_234);
    expect(childElapsedMs(card, 10_000, false, null)).toBeNull();
  });
});

describe("agents rail rows", () => {
  test("renders canonical children through the T3 fleet row with activity and usage", () => {
    const events: readonly CanonicalChildEventLike[] = [
      {
        kind: "child.started",
        seq: 1,
        ts: Date.now() - 5_000,
        childId: "child-1",
        launchToolCallId: "call-1",
        title: "Research checkout",
        state: { status: "running", summary: "Scanning the repo" },
      },
      {
        kind: "child.updated",
        seq: 2,
        ts: Date.now() - 1_000,
        childId: "child-1",
        state: {
          status: "running",
          summary: "Reading checkout files",
          lastToolName: "bash",
          usage: { totalTokens: 41200 },
        },
      },
    ];

    const html = renderToStaticMarkup(
      createElement(AgentsRail, { steps: [], live: true, canonicalEvents: events }),
    );
    expect(html).toContain('data-session-ui="agent-panel-row"');
    expect(html).toContain('data-testid="subagent-card"');
    expect(html).toContain("Open subagent: Research checkout");
    expect(html).toContain("Reading checkout files");
    expect(html).toContain("41.2k tok");
  });

  test("keeps same-role siblings as distinct canonical rows", () => {
    const events: readonly CanonicalChildEventLike[] = [
      { kind: "child.started", seq: 1, childId: "child-a", title: "Research price" },
      { kind: "child.started", seq: 2, childId: "child-b", title: "Research price" },
    ];

    const html = renderToStaticMarkup(
      createElement(AgentsRail, { steps: [], live: true, canonicalEvents: events }),
    );
    expect(html.match(/Open subagent: Research price/g)).toHaveLength(2);
    expect(html.match(/data-testid="subagent-card"/g)).toHaveLength(2);
  });
});
