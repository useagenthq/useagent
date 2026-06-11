import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { ApiRun, RunStatus } from "./types";
import { WorkspaceOpenProvider } from "./workspace-open-context";

// The canonical-timeline flag is read at module load; flip it on BEFORE importing
// the conversation so these turns render through the canonical lane.
process.env.NEXT_PUBLIC_CANONICAL_TIMELINE = "1";
const { Conversation } = await import("./conversation");
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

function liveEvents(): StoredCanonicalEvent[] {
  return [
    ev("tool.started", {
      toolCallId: "live-run",
      name: "bash",
      input: { command: "bun run typecheck" },
    }),
  ];
}

test("queued turns render the T3 queued pill with honest FIFO positions", () => {
  const html = render(
    [
      makeTurn("run-live", "running", liveEvents()),
      makeTurn("run-q1", "queued", [], "run-live"),
      makeTurn("run-q2", "queued", [], "run-live"),
    ],
    { sendNowFor: "run-q1", onSendNow: () => {} },
  );

  expect(html).toContain('data-session-ui="queued-message-pill"');
  expect(html).toContain("Queued - sends after the current run");
  expect(html).toContain("Queued #2 - 1 reply ahead");
  // Send now steers ONLY the head queued turn (queue order preserved).
  expect(html.split(">Send now<").length - 1).toBe(1);
  // The old bare "queued" tag row is gone.
  expect(html).not.toContain(">queued<");
});

test("running thread threads runStartedAt into the composer status pill", () => {
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const html = render([makeTurn("run-live", "running", liveEvents())], {
    running: true,
    onStop: () => {},
    runStartedAt: startedAt,
  });

  expect(html).toContain('data-session-ui="background-status-pill"');
  // The elapsed timer rendered from the provided start time (65s ago).
  expect(html).toContain("1m 5s");
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
