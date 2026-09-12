import { expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { ApiRun, RunStatus } from "./types";

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
    sandbox_id: null,
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

function render(turns: Turn[], productChildren: readonly ThreadRelationship[] = []): string {
  return renderToStaticMarkup(
    <Conversation
      turns={turns}
      defaultEngine="opencode"
      defaultModel="claude-sonnet-5"
      defaultMemoryScope="org"
      pendingReply={null}
      onReply={async () => {}}
      productChildren={productChildren}
      canonicalTimeline
    />,
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
  const rows = html.split('data-testid="trace-row"').slice(1);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const heading = /data-testid="trace-row-label"[^>]*>([^<]*)<\/span>/.exec(row)?.[1];
    expect(heading?.trim().length ?? 0).toBeGreaterThan(0);
  }
  // The child_session_create call is a step line named by its tool.
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
  expect(html).toContain("1 spawned session");
  expect(html).toContain("Delegated: audit the docs");
  expect(html).toContain("Queued");
  expect(html).toContain('href="/session/run-child"');
});

test("a product child result stays under its spawning parent and links to its thread", () => {
  const parent = makeTurn("run-parent", "completed");
  const child: ThreadRelationship = {
    threadId: "product-child",
    parentThreadId: "run-parent",
    familyThreadId: "run-parent",
    kind: "delegated",
    title: "Research market prices",
    sourceRunId: "run-parent",
    sourceExecutionId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    status: "completed",
    engine: "codex",
    model: "gpt-5.6-luna",
    latestRunId: "product-child",
    latestSummary: "NVDA and GOOGL prices are ready.",
    latestDurationMs: 1_500,
    latestActivityAt: "2026-09-01T00:01:00.000Z",
    bot: null,
    followUpRunIds: [],
  };
  const html = render([parent], [child]);
  expect(html).toContain("Research market prices");
  expect(html).toContain("NVDA and GOOGL prices are ready.");
  expect(html).toContain('href="/session/product-child"');
  // The agent opened this child itself: no bot, so no handoff receipt under the turn.
  expect(html).not.toContain('data-testid="handoff-receipts"');
});

test("a bot's thread leaves a receipt under the turn that handed it work and under every follow-up", () => {
  const first = makeTurn("run-first", "completed");
  const second = makeTurn("run-second", "completed");
  const child: ThreadRelationship = {
    threadId: "nova-thread",
    parentThreadId: "run-first",
    familyThreadId: "run-first",
    kind: "delegated",
    title: "Nova: compare the EU tiers",
    sourceRunId: "run-first",
    sourceExecutionId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    status: "running",
    engine: "opencode",
    model: "claude-opus-5",
    latestRunId: "nova-thread",
    latestSummary: null,
    latestDurationMs: null,
    latestActivityAt: "2026-09-01T00:01:00.000Z",
    bot: { id: "bot-nova", name: "Nova" },
    followUpRunIds: ["run-second"],
  };
  const html = render([first, second], [child]);
  expect(html).toContain('data-handoff-status="created"');
  expect(html).toContain("Handed to Nova.");
  expect(html).toContain('data-handoff-status="followed_up"');
  expect(html).toContain("Sent to Nova&#x27;s existing thread.");
  expect(html.match(/href="\/session\/nova-thread"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  // The fold names it by what happened, not by the lane id.
  expect(html).toContain("1 bot thread");
  expect(html).toContain("Nova · bot thread");
  expect(html).not.toContain("Product child");
});

test("a reply turn without the child-session mark still renders as its own block", () => {
  const parent = makeTurn("run-parent", "completed");
  const reply = makeTurn("run-reply", "completed");
  reply.run = { ...reply.run, prompt: "Follow up on this", parent_run_id: "run-parent" };
  const html = render([parent, reply]);

  expect(html.split('data-testid="turn-block"')).toHaveLength(3);
  expect(html).not.toContain('data-testid="subagents-fold"');
});

test("settled turn renders its work as one trace block", () => {
  const html = render([makeTurn("run-settled", "completed", settledEvents())]);

  // The canonical lane drove the timeline, and the work is ONE trace.
  expect(html).toContain('data-timeline-source="canonical"');
  // The timeline wrapper carries the shared 12px (space-y-3) rhythm so a trailing
  // published-artifact card / answer sits one step below the timeline above it,
  // not glued to it (artifact-block spacing fix).
  const timelineWrapper = html.match(/<div[^>]*data-timeline-source="canonical"[^>]*>/)?.[0] ?? "";
  expect(timelineWrapper).toContain("space-y-3");
  expect(html.match(/data-testid="turn-trace"/g)).toHaveLength(1);
  // A plain thread opens the trace: the skill receipt and the 3 tools are its
  // step lines, one short line each, in the Thinking grammar; the pre-tool
  // prose is a narration line between them, with no verb and no chip.
  expect(html).toContain('aria-expanded="true"');
  expect(html.match(/data-testid="trace-row"/g)).toHaveLength(4);
  expect(html.match(/data-testid="trace-narration"/g)).toHaveLength(1);
  // The context marker is a receipt, not a tool call. Pre-tool prose is one
  // narration message inside the trace; the durable summary owns the reply.
  expect(html).toContain("3 tool calls, 1 message, 1 failed");
  expect(html).toContain(">Loaded skill<");
  expect(html).toContain(">fix-loop<");
  expect(html).toContain(">Run<");
  expect(html).toContain(">bun test retry<");
  expect(html).toContain('aria-label="Completed"');
  // The old grammars no longer render tool nodes: no T3 work rows, no overflow
  // fold, no marker rows, no legacy ToolStepRow.
  expect(html).not.toContain('data-session-ui="work-group"');
  expect(html).not.toContain('data-session-ui="work-entry-row"');
  expect(html).not.toContain("previous tool calls");
  expect(html).not.toContain('data-testid="marker-row"');
  expect(html).not.toContain('data-testid="tool-row"');

  // Narration followed by work stays in the trace. The durable summary is the
  // only terminal answer outside it.
  expect(html).toContain("Scoping the retry budget now.");
  expect(html).toContain("Scoped the retry budget per attempt chain.");
});

test("canonical replay renders one Thinking owner when live reasoning is also buffered", () => {
  const reasoning = ev("reasoning.delta", {
    messageId: "reasoning-message",
    text: "Checking the synthetic retry policy.",
    identity: {
      nativeEventId: "reasoning-event",
      nativeSeq: seq + 1,
      nativeMessageId: "reasoning-message",
      nativePartId: "reasoning-part",
    },
  });
  const turn = makeTurn("run-reasoning", "running", [reasoning, { ...reasoning, revision: 2 }]);
  turn.liveReasoning = "Checking the synthetic retry policy.";
  const html = render([turn]);

  expect(html.match(/data-testid="thinking-header"/g)).toHaveLength(1);
  expect(html.match(/data-family="reasoning"/g)).toHaveLength(1);
});

test("a timeline work row owns transient reasoning before its durable frame arrives", () => {
  const turn = makeTurn("run-reasoning-race", "running", liveEvents());
  turn.liveReasoning = "Checking the synthetic retry policy.";
  const html = render([turn]);

  expect(html.match(/data-testid="thinking-header"/g)).toHaveLength(1);
  expect(html.match(/data-family="reasoning"/g)).toHaveLength(1);
  expect(html).toContain("Checking the synthetic retry policy.");
});

test("a run that failed at boot traces its category with the full reason and copies it", () => {
  // Synthetic steps-only relay failure: all sandbox plumbing, then a done step
  // that says just "Engine error"; run.summary carries the detailed reason.
  const reason =
    "error: synthetic engine relay stopped during startup after the child process exited before signaling readiness. Diagnostic output remains visible in full so operators can copy the complete failure context.";
  const boot = (
    idx: number,
    kind: "task" | "done",
    label: string,
    chip: string | null,
  ): Turn["steps"][number] => ({
    id: `st${idx}`,
    run_id: "run-boot-failed",
    idx,
    kind,
    label,
    chip,
    code_json: null,
    created_at: "2030-01-01T00:00:00.000Z",
  });
  const turn = makeTurn("run-boot-failed", "failed", undefined, [
    boot(0, "task", "Preparing context and runtime…", "boot"),
    boot(1, "task", "Provisioning cloud sandbox…", "claude"),
    boot(2, "task", "Sandbox sandbox-demo-02 ready in 4s (4 CPU / 8 GiB)", "claude"),
    boot(3, "task", "Preparing browser, tools, and integrations…", "claude"),
    boot(4, "done", "Engine error", null),
  ]);
  turn.summary = reason;
  const html = render([turn]);
  const escaped = reason.replaceAll("'", "&#x27;");

  // The trace exists for the failure alone: the header is the category in the
  // failure tint with the reason as its detail, and one failed terminal row.
  expect(html).toContain('data-testid="turn-trace"');
  const header = html.split('data-testid="thinking-header"')[1]?.split("</button>")[0] ?? "";
  expect(header).toContain(">Engine error<");
  expect(header).toContain(escaped);
  expect(html.match(/data-testid="trace-row"/g)).toHaveLength(1);
  expect(html).toContain('data-status="failed"');
  // The failure banner shows the whole reason with its own copy affordance.
  expect(html).toContain('data-session-ui="thread-error-banner"');
  expect(html).toContain('aria-label="Copy error"');
  expect(html).not.toContain("line-clamp");
});

test("settled turn shows the failed step as an x in the open trace", () => {
  const html = render([makeTurn("run-settled", "completed", settledEvents())]);
  expect(html).toContain('data-status="failed"');
  expect(html).toContain('aria-label="Failed"');
  expect(html).toContain(">cat missing.txt<");
  // Payloads stay behind the row until opened: the error text never renders inline.
  expect(html).not.toContain("No such file or directory");
});

test("live turn heads the trace with Thinking and the loader, and runs its last step", () => {
  const html = render([makeTurn("run-live", "running", liveEvents())]);

  // The header shimmers "Thinking" beside the pixel loader; the running step is
  // its muted detail, named by the summarizer: for a shell step, the command
  // line itself (never the "Run - <command>" row grammar).
  expect(html).toContain('data-testid="turn-trace"');
  expect(html).toContain('data-live="true"');
  expect(html).toContain("agent-progress-loading-text");
  expect(html).toContain(">Thinking<");
  expect(html).toContain(">Run bun run typecheck<");
  expect(html).not.toContain("Run - bun run typecheck");
  // The in-flight step is a row with the loader in place of the check.
  expect(html).toContain('data-status="running"');
  expect(html).toContain('aria-label="Running"');
  // Completed work stays visible above it; no T3 working indicator, no folds.
  expect(html.match(/data-testid="trace-row"/g)).toHaveLength(3);
  expect(html).not.toContain('data-session-ui="working-indicator"');
  expect(html).not.toContain("previous tool call");
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
  const html = render([makeTurn("run-plan-fallback", "completed", undefined, [planStep])]);

  expect(html).toContain('data-testid="todo-list"');
  expect(html).toContain("Create components");
  expect(html).toContain("Verify rendering");
  expect(html).not.toContain('data-session-ui="work-entry-row"');
});
