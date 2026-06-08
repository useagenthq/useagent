import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCanonicalThreadStore, type CanonicalThreadEvent } from "@useagent/agent-client";
import { AgentsRail, childElapsedMs, childStatusLabel } from "./agents-rail";
import type { CanonicalChildEventLike } from "./canonical-children";
import type { GatewayChildSession } from "./gateway-children";
import type { SubagentCard } from "./subagents";
import type { ApiStep } from "./types";
import { EXECUTION_SUMMARY_ROLLOUT_MODE } from "./execution-summary-rollout";

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
  test("production consumer reads the supplied store snapshot behind the rollout mode", () => {
    const started = (
      childId: string,
      revision: number,
      deliverySeq: number,
    ): CanonicalThreadEvent => ({
      schemaVersion: 1,
      eventId: "corrected-child",
      seq: deliverySeq,
      runId: "run-1",
      threadId: "thread-1",
      ts: 1_000 + deliverySeq,
      identity: { provider: "codex", nativeSessionId: "parent" },
      deliverySeq,
      revision,
      kind: "child.started",
      childId,
      title: childId,
    });
    const events = [started("child-a", 0, 1), started("child-b", 1, 2)];
    const store = createCanonicalThreadStore({ threadId: "thread-1" });
    for (const event of events) store.ingest(event);
    const html = renderToStaticMarkup(
      createElement(AgentsRail, {
        steps: [],
        live: true,
        canonicalEvents: events as unknown as readonly CanonicalChildEventLike[],
        executionSummary: store.getExecutionSummary(),
      }),
    );
    const expectedRows = EXECUTION_SUMMARY_ROLLOUT_MODE === "read" ? 1 : 2;
    expect(html.match(/data-testid="subagent-card"/g)).toHaveLength(expectedRows);
    if (EXECUTION_SUMMARY_ROLLOUT_MODE === "read") {
      expect(html).toContain("Open subagent: child-b");
      expect(html).not.toContain("Open subagent: child-a");
    }
  });

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

// The regression surface: a gateway `child_session_create` fan-out on codex. The
// children are their OWN runs (no native child.started, no chip-subagent spawn),
// so the rail must render them from the gateway list with real identity, and must
// NOT card the anonymous "Tool" tool-call rows the run also emitted.
describe("agents rail gateway children", () => {
  const gatewayChild = (over: Partial<GatewayChildSession> = {}): GatewayChildSession => ({
    id: "child-run-1",
    prompt: "Get Google stock price",
    engine: "codex",
    model: "openai/gpt-5.6-sol",
    status: "completed",
    summary: "GOOGL is $344.82.",
    ...over,
  });

  // A runtime collab_agent_tool_call row chipped `subagent` with tool "subagent"
  // but no child session and no objective - the label falls back to "Tool".
  const anonymousToolStep = (id: string): ApiStep => ({
    id,
    run_id: "parent",
    idx: 0,
    kind: "task",
    label: "Tool",
    chip: "subagent",
    code_json: JSON.stringify({
      source: "t3",
      activityKind: "tool.completed",
      tool: "subagent",
      input: {},
      native: { callID: `${id}-call` },
    }),
    created_at: "2026-08-23T09:00:00Z",
  });

  test("renders gateway children with real identity and a link to their session", () => {
    const html = renderToStaticMarkup(
      createElement(AgentsRail, {
        steps: [],
        live: false,
        childSessions: [
          gatewayChild(),
          gatewayChild({ id: "child-run-2", prompt: "Get NVIDIA stock price", status: "queued", summary: null }),
        ],
      }),
    );
    expect(html.match(/data-testid="subagent-card"/g)).toHaveLength(2);
    expect(html).toContain("Get Google stock price");
    expect(html).toContain("Get NVIDIA stock price");
    // Real engine + model identity, its own-session link, and honest queued state.
    expect(html).toContain("Codex");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain('href="/session/child-run-1"');
    expect(html).toContain("GOOGL is $344.82.");
    expect(html).toContain("Queued");
  });

  test("excludes anonymous 'Tool' tool-call rows - the nine-identical-cards bug", () => {
    const html = renderToStaticMarkup(
      createElement(AgentsRail, {
        steps: [anonymousToolStep("a1"), anonymousToolStep("a2"), anonymousToolStep("a3")],
        live: false,
      }),
    );
    // None of the anonymous rows become cards; with no real children the rail is empty.
    expect(html).not.toContain('data-testid="subagent-card"');
    expect(html).toContain("No subagents in this conversation yet.");
  });

  test("shows only the real gateway children when a run also emitted anonymous rows", () => {
    const html = renderToStaticMarkup(
      createElement(AgentsRail, {
        steps: [anonymousToolStep("a1"), anonymousToolStep("a2")],
        live: false,
        childSessions: [gatewayChild()],
      }),
    );
    expect(html.match(/data-testid="subagent-card"/g)).toHaveLength(1);
    expect(html).toContain("Get Google stock price");
  });

  test("prefers one gateway row when canonical lifecycle names the same child", () => {
    const html = renderToStaticMarkup(
      createElement(AgentsRail, {
        steps: [],
        live: false,
        canonicalEvents: [
          {
            kind: "child.started",
            seq: 1,
            childId: "child-run-1",
            title: "Subagent",
          },
        ],
        childSessions: [gatewayChild()],
      }),
    );
    expect(html.match(/data-testid="subagent-card"/g)).toHaveLength(1);
    expect(html).toContain("Get Google stock price");
  });
});
