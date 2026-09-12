import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createCanonicalThreadStore, type CanonicalThreadEvent } from "@useagent/agent-client";
import type { ThreadRelationship } from "@useagent/agent-client";
import type { CanonicalChildEventLike } from "./canonical-children";
import { EXECUTION_SUMMARY_ROLLOUT_MODE } from "./execution-summary-rollout";
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

const productChild = (over: Partial<ThreadRelationship> = {}): ThreadRelationship => ({
  threadId: "product-child-1",
  parentThreadId: "root",
  familyThreadId: "root",
  kind: "delegated",
  title: "Research NVIDIA and Google",
  sourceRunId: "root",
  sourceExecutionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:01:00.000Z",
  status: "completed",
  engine: "codex",
  model: "gpt-5.6-luna",
  latestRunId: "product-child-1",
  latestSummary: "NVIDIA and Google prices are ready.",
  latestDurationMs: 1_500,
  latestActivityAt: "2026-09-01T00:01:00.000Z",
  bot: null,
  followUpRunIds: [],
  ...over,
});

describe("subagents fold (inline conversation group)", () => {
  test("production fold reads the supplied turn-scoped store snapshot", () => {
    const event = (
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
    const events = [event("child-a", 0, 1), event("child-b", 1, 2)];
    const store = createCanonicalThreadStore({ threadId: "thread-1" });
    for (const item of events) store.ingest(item);
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live
        canonicalEvents={events as unknown as readonly CanonicalChildEventLike[]}
        executionSummary={store.getExecutionSummary()}
      />,
    );
    expect(html).toContain(
      EXECUTION_SUMMARY_ROLLOUT_MODE === "read" ? "1 subagent" : "2 subagents",
    );
  });

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
    expect(html).toContain("1 subagent, 1 spawned session");
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
    expect(html).toContain("1 subagent, 1 spawned session");
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

  test("keeps a completed product child visible in the parent with a link to its thread", () => {
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live={false}
        productChildren={[productChild()]}
      />,
    );
    expect(html).toContain("1 child thread");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("NVIDIA and Google prices are ready.");
    expect(html).toContain('aria-label="Inspect child thread: Research NVIDIA and Google"');
    expect(html).toContain('href="/session/product-child-1"');
    expect(html).toContain("Codex · gpt-5.6-luna");
  });

  test("shows complete combined results after every product child settles", () => {
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live={false}
        productChildren={[
          productChild({
            threadId: "child-1",
            title: "Poem: Paris",
            latestSummary: "Paris line one.\nParis line two.",
          }),
          productChild({
            threadId: "child-2",
            title: "Poem: Rome",
            latestSummary: "Rome line one.\nRome line two.",
          }),
        ]}
      />,
    );
    expect(html).toContain('data-testid="product-child-results"');
    expect(html).toContain("Combined results");
    expect(html).toContain("Paris line two.");
    expect(html).toContain("Rome line two.");
  });

  test("a bot's thread is named after the bot and counted apart from subagents", () => {
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live
        canonicalEvents={[canonicalChild(), canonicalChild({ childId: "ses_other", launchToolCallId: "call-2", title: "Check pricing" })]}
        productChildren={[
          productChild({
            threadId: "nova-thread",
            title: "Nova: compare the EU tiers",
            status: "running",
            latestSummary: null,
            bot: { id: "bot-nova", name: "Nova" },
          }),
        ]}
      />,
    );
    expect(html).toContain("2 subagents, 1 bot thread");
    expect(html).toContain("Nova · bot thread");
    expect(html).toContain('aria-label="Inspect bot thread: Nova: compare the EU tiers"');
    expect(html).toContain('aria-label="Open bot thread: Nova: compare the EU tiers"');
    expect(html).toContain('href="/session/nova-thread"');
    expect(html).not.toContain("Product");
  });

  test("a failed bot thread says Failed in words, not only in the dot colour", () => {
    const html = renderToStaticMarkup(
      <SubagentsFold
        steps={[]}
        live={false}
        productChildren={[
          productChild({
            status: "failed",
            latestSummary: "The pricing page timed out.",
            bot: { id: "bot-nova", name: "Nova" },
          }),
        ]}
      />,
    );
    expect(html).toContain("Failed · The pricing page timed out.");
    expect(html).toContain('<span class="sr-only">Failed</span>');
    expect(html).toContain("text-text-error-primary");
  });
});
