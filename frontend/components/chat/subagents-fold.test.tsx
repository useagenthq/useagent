import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanonicalChildEventLike } from "./canonical-children";
import { type GatewayChildSession, SubagentsFold } from "./subagents-fold";

const canonicalChild = (over: Partial<CanonicalChildEventLike> = {}): CanonicalChildEventLike => ({
  kind: "child.started",
  seq: 1,
  ts: 1_000,
  childId: "ses_child",
  launchToolCallId: "call-1",
  title: "Verify checkout",
  state: {
    status: "running",
    summary: "Running the suite",
    role: "verifier",
    model: "gpt-5.6-luna",
    usage: { totalTokens: 41_200 },
  },
  ...over,
});

const gatewayChild = (over: Partial<GatewayChildSession> = {}): GatewayChildSession => ({
  id: "child-run-1",
  prompt: "Summarize the wiki for onboarding",
  engine: "claude",
  model: "claude-sonnet-5",
  status: "queued",
  summary: null,
  ...over,
});

describe("subagents fold (inline conversation group)", () => {
  test("renders nothing when the turn spawned no children", () => {
    const html = renderToStaticMarkup(<SubagentsFold steps={[]} live={false} />);
    expect(html).toBe("");
  });

  test("one group entry counts native and gateway children together with real state", () => {
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live
        canonicalEvents={[canonicalChild()]}
        childSessions={[gatewayChild()]}
      />,
    );
    expect(html).toContain('data-testid="subagents-fold"');
    expect(html).toContain("2 subagents");
    // Native child row: title, agent-type, model, tokens, live state.
    expect(html).toContain("Verify checkout");
    expect(html).toContain("verifier");
    expect(html).toContain("gpt-5.6-luna");
    expect(html).toContain("41.2k tok");
    expect(html).toContain("Running the suite");
    // Gateway child row: honest QUEUED (serial, not parallel) + own-session link.
    expect(html).toContain("Summarize the wiki for onboarding");
    expect(html).toContain("Queued");
    expect(html).toContain('href="/session/child-run-1"');
    expect(html).not.toContain("parallel");
  });

  test("a settled turn collapses the fold but keeps the honest count", () => {
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live={false}
        canonicalEvents={[
          canonicalChild(),
          {
            kind: "child.completed",
            seq: 2,
            ts: 2_000,
            childId: "ses_child",
            status: "ok",
            result: "Suite green.",
          },
        ]}
        childSessions={[gatewayChild({ status: "completed", summary: "Wiki summarized." })]}
      />,
    );
    expect(html).toContain("2 subagents");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Suite green.");
  });

  test("a running gateway child row reads Running with its settled sibling Completed", () => {
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live={false}
        childSessions={[
          gatewayChild({ id: "c1", status: "completed", summary: "Done first." }),
          gatewayChild({ id: "c2", status: "running", prompt: "Second delegation" }),
        ]}
      />,
    );
    expect(html).toContain("Completed · Done first.");
    expect(html).toContain("Running");
    expect(html).toContain('href="/session/c1"');
    expect(html).toContain('href="/session/c2"');
  });
});
