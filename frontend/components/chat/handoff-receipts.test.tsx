import { describe, expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  decodeRunAccepted,
  deriveHandoffReceipts,
  type HandoffReceipt,
  HandoffReceipts,
  handoffNotice,
  handoffReceiptPreview,
  handoffReceiptText,
  mergeHandoffReceipts,
} from "./handoff-receipts";

const receipt = (over: Partial<HandoffReceipt> = {}): HandoffReceipt => ({
  botId: "bot-nova",
  name: "Nova",
  avatarTone: "violet",
  avatarIcon: "research",
  threadId: "nova-thread",
  status: "created",
  ...over,
});

describe("decodeRunAccepted", () => {
  test("reads the run id and every well-formed handoff, dropping junk", () => {
    const decoded = decodeRunAccepted({
      id: "run-1",
      status: "running",
      handoffs: [
        { botId: "b1", name: "Nova", threadId: "t1", status: "created" },
        { botId: "b2", name: "Atlas", threadId: null, status: "refused", reason: "cap", retryAfterMs: 120_000 },
        { botId: "b3", name: "", threadId: null, status: "failed", error: "prompt too large" },
        { botId: "b4", status: "not-a-status" },
        "nope",
      ],
    });
    expect(decoded.runId).toBe("run-1");
    expect(decoded.handoffs).toEqual([
      { botId: "b1", name: "Nova", threadId: "t1", status: "created" },
      { botId: "b2", name: "Atlas", threadId: null, status: "refused", reason: "cap", retryAfterMs: 120_000 },
      { botId: "b3", name: "", threadId: null, status: "failed", error: "prompt too large" },
    ]);
  });

  test("a response without handoffs decodes to none", () => {
    expect(decodeRunAccepted({ id: "run-2" })).toEqual({ runId: "run-2", handoffs: [] });
    expect(decodeRunAccepted(null)).toEqual({ runId: null, handoffs: [] });
  });
});

describe("handoffReceiptText", () => {
  test("names every outcome in plain words", () => {
    expect(handoffReceiptText(receipt())).toBe("Handed to Nova.");
    expect(handoffReceiptText(receipt({ status: "replayed" }))).toBe("Already handed to Nova.");
    expect(handoffReceiptText(receipt({ status: "followed_up" }))).toBe("Sent to Nova's existing thread.");
    expect(handoffReceiptText(receipt({ status: "refused", reason: "self", threadId: null }))).toBe(
      "Nova can't hand work to itself.",
    );
    expect(handoffReceiptText(receipt({ status: "refused", reason: "cycle", threadId: null }))).toBe(
      "Nova is already working above this thread, so it can't take this.",
    );
    expect(handoffReceiptText(receipt({ status: "refused", reason: "depth", threadId: null }))).toBe(
      "This thread is already as deep as handoffs go, so Nova didn't get this.",
    );
    expect(handoffReceiptText(receipt({ status: "busy" }))).toBe(
      "Nova's thread is busy right now. Try again in a moment.",
    );
    expect(handoffReceiptText(receipt({ status: "conflict", threadId: null }))).toBe(
      "This handoff clashed with an earlier one, so Nova didn't get it. Send the message again.",
    );
    expect(handoffReceiptText(receipt({ status: "not_found", name: "", threadId: null }))).toBe(
      "That bot no longer exists, so nothing was handed off.",
    );
    expect(handoffReceiptText(receipt({ status: "unavailable", threadId: null }))).toBe(
      "Bot threads are turned off here, so Nova didn't get this.",
    );
    expect(handoffReceiptText(receipt({ status: "failed", threadId: null }))).toBe(
      "Nova didn't get this. Try again.",
    );
    expect(handoffReceiptText(receipt({ status: "failed", threadId: null, error: "prompt too large" }))).toBe(
      "Nova didn't get this: prompt too large",
    );
  });

  test("a refused cap carries the retry hint in minutes", () => {
    expect(handoffReceiptText(receipt({ status: "refused", reason: "cap", threadId: null }))).toBe(
      "Nova has taken on as much as it can for now. Try again in a moment.",
    );
    expect(
      handoffReceiptText(receipt({ status: "refused", reason: "cap", threadId: null, retryAfterMs: 60_000 })),
    ).toBe("Nova has taken on as much as it can for now. Try again in a minute.");
    expect(
      handoffReceiptText(receipt({ status: "refused", reason: "cap", threadId: null, retryAfterMs: 7 * 60_000 })),
    ).toBe("Nova has taken on as much as it can for now. Try again in 7 minutes.");
  });
});

describe("handoffNotice", () => {
  test("is null when every bot got the message, else lists the ones that did not", () => {
    expect(handoffNotice([receipt(), receipt({ status: "followed_up" })])).toBeNull();
    expect(
      handoffNotice([receipt(), receipt({ botId: "b2", name: "Atlas", status: "refused", reason: "self", threadId: null })]),
    ).toBe("Atlas can't hand work to itself.");
  });
});

describe("deriveHandoffReceipts", () => {
  const child = (over: Partial<ThreadRelationship> = {}): ThreadRelationship => ({
    threadId: "nova-thread",
    parentThreadId: "root",
    familyThreadId: "root",
    kind: "delegated",
    title: "Nova: compare the EU tiers",
    sourceRunId: "run-1",
    sourceExecutionId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    status: "completed",
    engine: "opencode",
    model: "claude-opus-5",
    latestRunId: "nova-thread",
    latestSummary: null,
    latestDurationMs: null,
    latestActivityAt: "2026-09-01T00:01:00.000Z",
    bot: { id: "bot-nova", name: "Nova", avatarTone: "violet", avatarIcon: "research" },
    handoffOutcomes: [
      { sourceRunId: "run-1", status: "completed", summary: null },
      { sourceRunId: "run-2", status: "completed", summary: null },
      { sourceRunId: "run-3", status: "completed", summary: null },
    ],
    followUpRunIds: ["run-2", "run-3"],
    ...over,
  });

  test("a bot's thread yields created on its source run and followed_up on each follow-up run", () => {
    const byRun = deriveHandoffReceipts([child()]);
    expect(byRun.get("run-1")).toEqual([
      expect.objectContaining(receipt({ status: "created" })),
    ]);
    expect(byRun.get("run-2")).toEqual([
      expect.objectContaining(receipt({ status: "followed_up" })),
    ]);
    expect(byRun.get("run-3")).toEqual([
      expect.objectContaining(receipt({ status: "followed_up" })),
    ]);
  });

  test("a settled child projects its final reply while pending and failed children keep their states", () => {
    const completed = deriveHandoffReceipts([
      child({
        bot: { id: "bot-nova", name: "Nova", avatarTone: "violet", avatarIcon: "research" },
        latestSummary: "The EU tier is cheaper for annual usage.",
        handoffOutcomes: [
          {
            sourceRunId: "run-1",
            status: "completed",
            summary: "The EU tier is cheaper for annual usage.",
          },
        ],
      }),
    ]).get("run-1")?.[0];
    expect(completed).toMatchObject({
      avatarTone: "violet",
      avatarIcon: "research",
      childStatus: "completed",
      finalReply: "The EU tier is cheaper for annual usage.",
    });
    if (!completed) throw new Error("missing completed handoff receipt");
    expect(handoffReceiptPreview(completed)).toBe("Nova: The EU tier is cheaper for annual usage.");
    expect(handoffReceiptPreview(receipt({ childStatus: "running" }))).toBe("Handed to Nova.");
    expect(handoffReceiptPreview(receipt({ childStatus: "failed" }))).toBe("Nova's handoff failed.");
  });

  test("children the agent opened itself leave no receipt", () => {
    expect(deriveHandoffReceipts([child({ bot: null, followUpRunIds: [] })]).size).toBe(0);
  });

  test("keeps each parent mention bound to its exact child turn across two follow-ups", () => {
    const byRun = deriveHandoffReceipts([
      child({
        latestSummary: "Reply B is the newest thread result.",
        handoffOutcomes: [
          { sourceRunId: "run-1", status: "completed", summary: "Reply A" },
          { sourceRunId: "run-2", status: "completed", summary: "Reply B" },
          { sourceRunId: "run-3", status: "running", summary: null },
        ],
      }),
    ]);
    expect(byRun.get("run-1")?.[0]).toMatchObject({ childStatus: "completed", finalReply: "Reply A" });
    expect(byRun.get("run-2")?.[0]).toMatchObject({ childStatus: "completed", finalReply: "Reply B" });
    expect(byRun.get("run-3")?.[0]).toMatchObject({ childStatus: "running", finalReply: null });
  });
});

describe("mergeHandoffReceipts", () => {
  test("advances an optimistic success through live durable state to its final reply", () => {
    const optimistic = [receipt()];
    const running = [receipt({ childStatus: "running" })];
    const settled = [
      receipt({ childStatus: "completed", finalReply: "The final delegated answer." }),
    ];
    expect(mergeHandoffReceipts(optimistic, running)?.[0]?.childStatus).toBe("running");
    expect(mergeHandoffReceipts(optimistic, settled)?.[0]).toMatchObject({
      childStatus: "completed",
      finalReply: "The final delegated answer.",
    });
  });

  test("preserves optimistic failures and successes that have not materialized", () => {
    const failed = receipt({ botId: "bot-failed", status: "failed", threadId: null });
    const pending = receipt({ botId: "bot-pending" });
    const durable = receipt({ botId: "bot-other", childStatus: "completed", finalReply: "Done" });
    expect(mergeHandoffReceipts([failed, pending], [durable])).toEqual([failed, pending, durable]);
    expect(mergeHandoffReceipts([failed], [receipt({ botId: "bot-failed", childStatus: "completed" })]))
      .toEqual([failed]);
  });
});

describe("HandoffReceipts", () => {
  test("renders one row per bot with a link only where a thread exists", () => {
    const html = renderToStaticMarkup(
      <HandoffReceipts
        receipts={[
          receipt(),
          receipt({ botId: "b2", name: "Atlas", status: "followed_up", threadId: "atlas-thread" }),
          receipt({ botId: "b3", name: "Relay", status: "refused", reason: "self", threadId: null }),
          receipt({ botId: "b4", name: "Scout", status: "busy", threadId: "scout-thread" }),
        ]}
      />,
    );
    expect(html).toContain('data-testid="handoff-receipts"');
    expect(html).toContain('data-tone="violet"');
    expect(html).toContain("Handed to Nova.");
    expect(html).toContain('href="/session/nova-thread"');
    expect(html).toContain("Sent to Atlas&#x27;s existing thread.");
    expect(html).toContain('href="/session/atlas-thread"');
    expect(html).toContain("Relay can&#x27;t hand work to itself.");
    expect(html).toContain("text-text-error-primary");
    // Busy names the existing thread but is not a success: no "Open thread" link for it.
    expect(html).not.toContain('href="/session/scout-thread"');
    expect(html).toContain("text-warning-base");
    expect(html.match(/Open thread/g)).toHaveLength(2);
  });

  test("renders nothing without receipts", () => {
    expect(renderToStaticMarkup(<HandoffReceipts receipts={[]} />)).toBe("");
    expect(renderToStaticMarkup(<HandoffReceipts />)).toBe("");
  });

  test("renders a durable failure as an error state", () => {
    const html = renderToStaticMarkup(
      <HandoffReceipts receipts={[receipt({ childStatus: "failed" })]} />,
    );
    expect(html).toContain('data-child-status="failed"');
    expect(html).toContain("Nova&#x27;s handoff failed.");
    expect(html).toContain("text-text-error-primary");
  });
});
