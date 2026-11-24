import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { ApiRun, ApiStep, RunStatus } from "./types";
import { WorkspaceOpenProvider } from "./workspace-open-context";

// The canonical-timeline flag is read at module load; flip it on BEFORE importing
// the conversation so these turns render through the canonical lane.
process.env.NEXT_PUBLIC_CANONICAL_TIMELINE = "1";
const { Conversation, scrollSignatureOf } = await import("./conversation");
type Turn = import("./conversation").Turn;
type ConversationProps = Parameters<typeof Conversation>[0];

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

function makeTurn(id: string, status: RunStatus, canonical: StoredCanonicalEvent[], parentRunId: string | null = null): Turn {
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
    parent_run_id: parentRunId,
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

function render(turns: Turn[], extra: Partial<ConversationProps> = {}): string {
  return renderToStaticMarkup(
    <>
      <Conversation
        turns={turns}
        defaultEngine="opencode"
        defaultModel="claude-sonnet-5"
        defaultMemoryScope="org"
        pendingReply={null}
        onReply={async () => {}}
        {...extra}
      />
    </>,
  );
}

test("a resolved gateway approval renders inside the turn that raised it, so reload keeps the decision", () => {
  const approval = {
    id: "appr-1",
    runId: "run-1",
    toolName: "automation_delete",
    arguments: { id: "auto-1" },
    status: "approved" as const,
    requestedAt: "2026-09-02T15:06:51Z",
    resolvedAt: "2026-09-02T15:06:53Z",
    resolvedBy: "dana",
  };
  const orphan = { ...approval, id: "appr-2", runId: "run-folded-child", status: "denied" as const };
  const html = render([makeTurn("run-1", "completed", []), makeTurn("run-2", "completed", [])], {
    gatewayApprovals: [approval, orphan],
  });
  const turnOne = html.slice(html.indexOf('data-run-id="run-1"'), html.indexOf('data-run-id="run-2"'));
  expect(turnOne).toContain('data-testid="gateway-approval-card"');
  expect(turnOne).toContain("Approved by dana");
  expect(turnOne).not.toContain(">Approve<");
  // A card whose run is not a rendered turn still shows, below the thread.
  const afterTurns = html.slice(html.indexOf('data-run-id="run-2"'));
  expect(afterTurns).toContain(">Denied<");
  expect(html.match(/data-testid="gateway-approval-card"/g)).toHaveLength(2);
});

function liveEvents(): StoredCanonicalEvent[] {
  return [
    ev("tool.started", {
      toolCallId: "live-run",
      name: "bash",
      input: { command: "bun run typecheck" },
    }),
  ];
}

test("queued turns wait as numbered rows above the composer, never as transcript bubbles", () => {
  const q1 = makeTurn("run-q1", "queued", [], "run-live");
  q1.run.prompt = "okay keep working";
  const q2 = makeTurn("run-q2", "queued", [], "run-live");
  q2.run.prompt = "then run the tests";
  const html = render([makeTurn("run-live", "running", liveEvents()), q1, q2], {
    running: true,
    onStop: () => {},
    sendNowFor: "run-q1",
    onSendNow: () => {},
    onRemoveQueued: async () => {},
  });

  expect(html).toContain('data-session-ui="queued-messages"');
  expect(html.match(/data-session-ui="queued-message"/g)).toHaveLength(2);
  expect(html).toContain("okay keep working");
  expect(html).toContain("then run the tests");
  // Not in the transcript: only the running turn is a turn block.
  expect(html.match(/data-testid="turn-block"/g)).toHaveLength(1);
  expect(html).not.toContain('data-run-id="run-q1"');
  expect(html).not.toContain('data-session-ui="queued-message-pill"');
  // Send now steers ONLY the head queued turn (queue order preserved); Remove is on both.
  expect(html.split(">Send now<").length - 1).toBe(1);
  expect(html.match(/aria-label="Remove queued message \d"/g)).toHaveLength(2);
  // The composer is in its running state.
  expect(html).toContain('placeholder="Add context while this runs"');
  expect(html).toContain(">Queue<");
  // Waiting for admission (nothing running): still a row, with no Send now.
  const idle = render([makeTurn("run-done", "completed", []), makeTurn("run-q1", "queued", [], "run-done")]);
  expect(idle).toContain('data-session-ui="queued-messages"');
  expect(idle).not.toContain("Send now");
  expect(idle).not.toContain("Add context while this runs");
});

test("a queued spawned session ahead of a reply keeps the reply's honest place and its Send now", () => {
  const child = makeTurn("run-child", "queued", [], "run-live");
  child.run.child_session = true;
  const reply = makeTurn("run-q1", "queued", [], "run-live");
  reply.run.prompt = "after the child";
  const html = render([makeTurn("run-live", "running", liveEvents()), child, reply], {
    running: true,
    sendNowFor: "run-child",
    onSendNow: () => {},
  });
  // One visible row, numbered by the whole serial queue, and no Send now (the head is the child).
  expect(html.match(/data-session-ui="queued-message"/g)).toHaveLength(1);
  expect(html).toContain(">2<");
  expect(html).not.toContain("Send now");
  expect(html).not.toContain('data-run-id="run-child"');
});

test("a queued turn promoted to running changes what autoscroll follows, even before any content lands", () => {
  const queued = makeTurn("run-q1", "queued", [], "run-live");
  const running = { ...queued, status: "running" as const, live: true };
  expect(scrollSignatureOf([running])).not.toBe(scrollSignatureOf([queued]));
});

test("the optimistic reply is the last queued row, not a transcript bubble", () => {
  const html = render([makeTurn("run-live", "running", liveEvents())], {
    running: true,
    pendingReply: "one more thing",
  });
  expect(html).toContain("one more thing");
  expect(html.match(/data-session-ui="queued-message"/g)).toHaveLength(1);
  expect(html.match(/data-testid="user-message"/g)).toHaveLength(1);
});

test("a running thread renders the running footer above the composer with the elapsed time", () => {
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const html = render([makeTurn("run-live", "running", liveEvents())], {
    running: true,
    onStop: () => {},
    runStartedAt: startedAt,
  });

  expect(html).toContain('data-session-ui="running-footer"');
  expect(html).not.toContain('data-session-ui="background-status-pill"');
  // The elapsed timer rendered from the provided start time (65s ago).
  expect(html).toContain("1m 5s");
  expect(html).toContain('aria-label="Stop this task"');
  // The phase comes from the newest turn's data: a tool step is Working with its label.
  expect(html).toContain(">Working<");
});

test("failure banner follows the projected turn status and summary after durable reconciliation", () => {
  const turn = makeTurn("run-failed", "running", []);
  turn.status = "failed";
  turn.summary = "Repository authorization failed before sandbox startup.";

  const html = render([turn]);

  expect(html).toContain('data-session-ui="thread-error-banner"');
  expect(html).toContain("Repository authorization failed before sandbox startup.");
});

test("settled answers carry the hover copy affordance; live turns do not", () => {
  const settled = render([makeTurn("run-settled", "completed", [])]);
  expect(settled).toContain('data-session-ui="message-copy-button"');
  expect(settled).toContain('aria-label="Copy message"');

  const live = render([makeTurn("run-live", "running", liveEvents())]);
  expect(live).not.toContain('data-session-ui="message-copy-button"');
});

test("a tool-only native timeline renders the finalized summary once with its citations", () => {
  const turn = makeTurn("run-settled", "completed", [
    ev("tool.completed", {
      toolCallId: "tool-1",
      name: "bash",
      input: { command: "bun run typecheck" },
      output: "ok",
    }),
  ]);
  const done: ApiStep = {
    id: "step-done",
    run_id: turn.run.id,
    idx: 0,
    kind: "done",
    label: "Done",
    chip: null,
    code_json: '{"citations":[{"title":"Retry policy","source":"wiki"}]}',
    created_at: "2026-08-17T09:01:00Z",
  };
  turn.steps = [done];
  turn.run.steps = [done];

  const html = render([turn]);

  expect(html.match(/data-testid="agent-answer"/g)).toHaveLength(1);
  expect(html).toContain("Scoped the retry budget per attempt chain.");
  expect(html).toContain('data-testid="chat-sources"');
  expect(html).toContain("Retry policy");
});

test("a stopped failed turn keeps its partial native reply instead of replacing it with the stop reason", () => {
  const turn = makeTurn("run-stopped", "failed", [
    ev("message.started", {
      messageId: "message-1",
      identity: { nativeSessionId: "session-1", nativeSeq: 1 },
    }),
    ev("message.delta", {
      messageId: "message-1",
      text: "I updated the parser before the run stopped.",
      identity: { nativeSessionId: "session-1", nativePartId: "part-1", nativeSeq: 2 },
    }),
  ]);
  turn.summary = "Stopped by user.";
  turn.run.summary = turn.summary;

  const html = render([turn]);

  expect(html).toContain("I updated the parser before the run stopped.");
  expect(html.match(/data-testid="agent-answer"/g)).toHaveLength(1);
});

test("image artifacts get the click-to-expand affordance; other artifacts do not", () => {
  const html = render([
    makeTurn("run-settled", "completed", [
      ev("artifact.created", {
        name: "screenshot.png",
        artifact: { artifactId: "art-img", bytes: 2048, sha256: "a1", contentType: "image/png" },
      }),
      ev("artifact.created", {
        name: "report.pdf",
        artifact: {
          artifactId: "art-pdf",
          bytes: 4096,
          sha256: "b2",
          contentType: "application/pdf",
        },
      }),
    ]),
  ]);

  expect(html).toContain('aria-label="Expand screenshot.png"');
  expect(html).toContain("cursor-zoom-in");
  expect(html).not.toContain('aria-label="Expand report.pdf"');
});

test("workpiece Preview actions open the session workspace and keep Download separate", () => {
  const turn = makeTurn("run-settled", "completed", [
    ev("artifact.created", {
      name: "quarterly-budget.xlsx",
      artifact: {
        artifactId: "art-sheet",
        bytes: 4096,
        sha256: "b2",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    }),
  ]);
  const html = renderToStaticMarkup(
    <WorkspaceOpenProvider value={() => {}}>
      <Conversation
        turns={[turn]}
        defaultEngine="opencode"
        defaultModel="claude-sonnet-5"
        defaultMemoryScope="org"
        pendingReply={null}
        onReply={async () => {}}
      />
    </WorkspaceOpenProvider>,
  );

  expect(html).toContain('aria-label="Open quarterly-budget.xlsx in workspace"');
  expect(html).not.toContain('aria-label="Preview quarterly-budget.xlsx"');
  expect(html).toContain('href="/api/artifacts/art-sheet/content?download=1"');
  expect(html).toContain('aria-label="Download quarterly-budget.xlsx"');
});
