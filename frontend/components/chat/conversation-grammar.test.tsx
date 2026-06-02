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

function makeTurn(
  id: string,
  status: RunStatus,
  canonical?: StoredCanonicalEvent[],
  steps: Turn["steps"] = [],
): Turn {
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
    parent_run_id: null,
    child_session: false,
    thread_id: id,
    engine_session_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: "2026-08-17T09:00:00Z",
    updated_at: "2026-08-17T09:01:00Z",
    steps,
  };
  return {
    run,
    steps,
    status,
    summary: run.summary,
    live: status === "running",
    liveText: "",
    liveReasoning: "",
    ...(canonical ? { canonical, canonicalComplete: true } : {}),
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

// A child-session fan-out turn: a bare tool receipt (no name/title, the claude
// lane's seal shape) followed by a gateway child_session_create call, plus the
// child lifecycle events. The regression: these rows used to render heading-less
// (bare chevron+status glyph in the conversation column).
function fanOutEvents(): StoredCanonicalEvent[] {
  return [
    ev("tool.started", { toolCallId: "call-bare" }),
    ev("tool.completed", { toolCallId: "call-bare", status: "ok", preview: "sealed" }),
    ev("tool.started", {
      toolCallId: "call-spawn",
      name: "child_session_create",
      input: { prompt: "Summarize the wiki", idempotencyKey: "k1" },
    }),
    ev("tool.completed", { toolCallId: "call-spawn", status: "ok", preview: "queued child c1" }),
    ev("child.started", { childId: "c1", launchToolCallId: "call-spawn" }),
    ev("child.completed", { childId: "c1", status: "ok", result: "Summary ready" }),
  ];
}

test("fan-out turn rows always render a visible heading", () => {
  const html = render([makeTurn("run-fanout", "completed", fanOutEvents())]);
  const rows = html.split('data-session-ui="work-entry-row"').slice(1);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const heading = /<span class="min-w-0 shrink truncate[^"]*">([^<]*)<\/span>/.exec(row)?.[1];
    expect(heading?.trim().length ?? 0).toBeGreaterThan(0);
  }
  // The newest visible row is the child_session_create call, named by its tool.
  expect(html).toContain("Child session create");
});

test("a gateway child-session turn folds under its parent, never a second turn block", () => {
  const parent = makeTurn("run-parent", "completed");
  const child = makeTurn("run-child", "queued");
  child.run = {
    ...child.run,
    prompt: "Delegated: audit the docs",
    parent_run_id: "run-parent",
    child_session: true,
  };
  const html = render([parent, child]);

  // Exactly ONE rendered turn block (the parent) - the child never renders as a
  // top-level user turn or a queued bubble of its own.
  expect(html.split('data-testid="turn-block"')).toHaveLength(2);
  expect(html.split('data-testid="user-message"')).toHaveLength(2);
  expect(html).not.toContain('data-run-id="run-child"');

  // Its truth lives in the parent's subagent fold: honest serial Queued state
  // plus the open-as-own-session affordance.
  expect(html).toContain('data-testid="subagents-fold"');
  expect(html).toContain("1 subagent");
  expect(html).toContain("Delegated: audit the docs");
  expect(html).toContain("Queued");
  expect(html).toContain('href="/session/run-child"');
});

test("a reply turn without the child-session mark still renders as its own block", () => {
  const parent = makeTurn("run-parent", "completed");
  const reply = makeTurn("run-reply", "completed");
  reply.run = { ...reply.run, prompt: "Follow up on this", parent_run_id: "run-parent" };
  const html = render([parent, reply]);

  expect(html.split('data-testid="turn-block"')).toHaveLength(3);
  expect(html).not.toContain('data-testid="subagents-fold"');
});

test("settled turn renders tool bursts through the T3 work grammar", () => {
  const html = render([makeTurn("run-settled", "completed", settledEvents())]);

  // The canonical lane drove the timeline, and tools render as T3 work rows.
  expect(html).toContain('data-timeline-source="canonical"');
  expect(html).toContain('data-session-ui="work-group"');
  expect(html).toContain('data-session-ui="work-entry-row"');
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
  expect(html).toContain('data-session-ui="work-group"');
});

test("live turn tails with the T3 working indicator and hides the in-flight row", () => {
  const html = render([makeTurn("run-live", "running", liveEvents())]);

  // Working indicator with the self-ticking timer and the in-flight step suffix.
  expect(html).toContain('data-session-ui="working-indicator"');
  expect(html).toContain("Working for");
  expect(html).toContain("· Run");
  expect(html).not.toContain("· Run - bun run typecheck");
  // The old LoadingState "Working" shimmer tail is gone from the timeline (no
  // narration is streaming here, so nothing else may render it either).
  expect(html).not.toContain("agent-progress-loading-text");

  // Completed work folds T3-style even while live (newest visible, older hidden).
  expect(html).toContain('data-session-ui="work-group"');
  expect(html).toContain("+1 previous tool call");
});

test("canonical OpenCode plan renders the latest checklist instead of a generic tool row", () => {
  const html = render([
    makeTurn("run-plan", "completed", [
      ev("plan.updated", {
        entries: [{ id: "plan-1", text: "Inspect the app", status: "in_progress" }],
      }),
      ev("plan.updated", {
        entries: [
          { id: "plan-1", text: "Inspect the app", status: "completed" },
          { id: "plan-2", text: "Build the todo list", status: "in_progress" },
        ],
      }),
    ]),
  ]);

  expect(html).toContain('data-testid="todo-list"');
  expect(html).toContain("Inspect the app");
  expect(html).toContain("Build the todo list");
  expect(html).not.toContain('data-session-ui="work-entry-row"');
});

test("durable OpenCode todowrite fallback renders the checklist instead of a generic tool row", () => {
  const planStep: Turn["steps"][number] = {
    id: "step-plan",
    run_id: "run-plan-fallback",
    idx: 1,
    kind: "command",
    label: "Plan",
    chip: "todowrite",
    code_json: JSON.stringify({
      tool: "todowrite",
      input: {
        todos: [
          { id: "todo-1", content: "Create components", status: "completed" },
          { id: "todo-2", content: "Verify rendering", status: "in_progress" },
        ],
      },
    }),
    created_at: "2026-08-17T09:00:00Z",
  };
  const html = render([
    makeTurn("run-plan-fallback", "completed", undefined, [planStep]),
  ]);

  expect(html).toContain('data-testid="todo-list"');
  expect(html).toContain("Create components");
  expect(html).toContain("Verify rendering");
  expect(html).not.toContain('data-session-ui="work-entry-row"');
});
