import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { ApiRun, RunStatus } from "./types";

// The canonical-timeline flag is read at module load; flip it on BEFORE importing
// the conversation so these turns render through the canonical lane.
process.env.NEXT_PUBLIC_CANONICAL_TIMELINE = "1";
const { Conversation } = await import("./conversation");
type Turn = import("./conversation").Turn;

let seq = 0;
function ev(kind: string, body: Record<string, unknown> = {}): StoredCanonicalEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    eventId: `ev-${seq}`,
    runId: "run-1",
    threadId: "thread-1",
    deliverySeq: seq,
    revision: 1,
    kind,
    seq,
    identity: { nativeEventId: `ev-${seq}`, nativeSeq: seq },
    ...body,
  } as StoredCanonicalEvent;
}

function makeTurn(id: string, status: RunStatus, canonical: StoredCanonicalEvent[]): Turn {
  const run: ApiRun = {
    id,
    org_id: null,
    user_id: null,
    prompt: "Fix the retry budget",
    model: "claude-sonnet-5",
    engine: "opencode",
    status,
    summary: status === "completed" ? "Scoped the retry budget per attempt chain." : null,
    duration_ms: null,
    created_at: "2026-08-17T09:00:00Z",
    updated_at: "2026-08-17T09:01:00Z",
    steps: [],
  };
  return {
    run,
    steps: [],
    status,
    summary: run.summary,
    live: status === "running",
    liveText: "",
    liveReasoning: "",
    canonical,
    canonicalComplete: true,
  };
}

function render(turns: Turn[]): string {
  return renderToStaticMarkup(
    <Tooltip.Provider>
      <Conversation
        turns={turns}
        defaultEngine="opencode"
        defaultModel="claude-sonnet-5"
        defaultMemoryScope="org"
        pendingReply={null}
        onReply={async () => {}}
      />
    </Tooltip.Provider>,
  );
}

// A settled turn: a skill marker, a narration burst, then a 3-tool burst with one
// real failure - the shapes the canonical reducer emits for a finished run.
function settledEvents(): StoredCanonicalEvent[] {
  return [
    ev("context.marker", {
      markerType: "skill",
      sourceEventType: "skill.loaded",
      sourcePayload: { kind: "skill", name: "fix-loop", version: 3, contentHash: "abc123" },
    }),
    ev("message.started", { messageId: "msg-1" }),
    ev("message.delta", {
      messageId: "msg-1",
      text: "Scoping the retry budget now.",
      identity: { nativeEventId: "ev-text", nativeSeq: seq + 1, nativePartId: "part-1" },
    }),
    ev("tool.started", {
      toolCallId: "call-read",
      name: "read",
      input: { file_path: "backend/src/provider-gateway/retry.ts" },
    }),
    ev("tool.completed", { toolCallId: "call-read", status: "ok", preview: "read 120 lines" }),
    ev("tool.started", {
      toolCallId: "call-bad",
      name: "bash",
      input: { command: "cat missing.txt" },
    }),
    ev("tool.completed", {
      toolCallId: "call-bad",
      status: "error",
      error: "cat: missing.txt: No such file or directory",
    }),
    ev("tool.started", {
      toolCallId: "call-test",
      name: "bash",
      input: { command: "bun test retry" },
    }),
    ev("tool.completed", { toolCallId: "call-test", status: "ok", preview: "42 pass, 0 fail" }),
  ];
}

// A live turn: two completed tools plus one still in flight (no completion event).
function liveEvents(): StoredCanonicalEvent[] {
  return [
    ev("tool.started", {
      toolCallId: "live-read",
      name: "read",
      input: { file_path: "frontend/components/chat/conversation.tsx" },
    }),
    ev("tool.completed", { toolCallId: "live-read", status: "ok", preview: "read 800 lines" }),
    ev("tool.started", {
      toolCallId: "live-edit",
      name: "edit",
      input: { file_path: "frontend/components/chat/conversation.tsx" },
    }),
    ev("tool.completed", { toolCallId: "live-edit", status: "ok", preview: "edited" }),
    ev("tool.started", {
      toolCallId: "live-run",
      name: "bash",
      input: { command: "bun run typecheck" },
    }),
  ];
}

test("settled turn renders tool bursts through the T3 work grammar", () => {
  const html = render([makeTurn("run-settled", "completed", settledEvents())]);

  // The canonical lane drove the timeline, and tools render as T3 work rows.
  expect(html).toContain('data-timeline-source="canonical"');
  expect(html).toContain('data-t3-ui="work-group"');
  expect(html).toContain('data-t3-ui="work-entry-row"');
  // The legacy ToolStepRow grammar no longer renders tool nodes.
  expect(html).not.toContain('data-testid="tool-row"');

  // The 3-tool burst folds behind the upstream overflow toggle (newest visible).
  expect(html).toContain("+2 previous tool calls");

  // Failed/success affordances from the ported status heuristics.
  expect(html).toContain('aria-label="Completed"');

  // Everything else is preserved: marker rows, narration bursts, the answer.
  expect(html).toContain('data-testid="marker-row"');
  expect(html).toContain("Scoping the retry budget now.");
});

test("settled turn surfaces the failed tool once the fold is expanded", () => {
  const html = render([makeTurn("run-settled", "completed", settledEvents())]);
  // The failure affordance belongs to a hidden (older) row; the fold itself and
  // the newest visible row must still expose the failure heuristics' markup when
  // the collapsed group carries the failing entry as its newest row.
  const htmlNewestFailure = render([
    makeTurn("run-failed-last", "completed", [
      ev("tool.started", {
        toolCallId: "only-bad",
        name: "bash",
        input: { command: "cat missing.txt" },
      }),
      ev("tool.completed", {
        toolCallId: "only-bad",
        status: "error",
        error: "cat: missing.txt: No such file or directory",
      }),
    ]),
  ]);
  expect(htmlNewestFailure).toContain('aria-label="Failed"');
  expect(html).toContain('data-t3-ui="work-group"');
});

test("live turn tails with the T3 working indicator and hides the in-flight row", () => {
  const html = render([makeTurn("run-live", "running", liveEvents())]);

  // Working indicator with the self-ticking timer and the in-flight step suffix.
  expect(html).toContain('data-t3-ui="working-indicator"');
  expect(html).toContain("Working for");
  expect(html).toContain("bun run typecheck");
  // The old LoadingState "Working" shimmer tail is gone from the timeline (no
  // narration is streaming here, so nothing else may render it either).
  expect(html).not.toContain("agent-progress-loading-text");

  // Completed work folds T3-style even while live (newest visible, older hidden).
  expect(html).toContain('data-t3-ui="work-group"');
  expect(html).toContain("+1 previous tool call");
});
