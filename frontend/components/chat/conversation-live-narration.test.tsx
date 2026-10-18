import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, type Turn } from "./conversation";
import { createNativeStore } from "./native-store";
import type { ApiRun, ApiStep } from "./types";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";

/** A running chat turn: no steps yet, no text in its native frames (the worker
 * records only timing spans for chat), and answer tokens on the delta channel. */
function chatTurn(liveText: string): Turn {
  const run: ApiRun = {
    id: "chat-run",
    org_id: null,
    user_id: null,
    prompt: "Write a short essay on retry budgets",
    model: "anthropic/claude-sonnet-5",
    engine: "chat",
    status: "running",
    summary: null,
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "chat-run",
    sandbox_id: null,
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
    created_at: "2026-09-02T09:00:00Z",
    updated_at: "2026-09-02T09:00:01Z",
    steps: [],
  };
  const store = createNativeStore();
  store.ingestNative({
    schemaVersion: 1,
    eventId: "chat-run:timing:worker.accept_to_running",
    seq: 1,
    provider: PLATFORM_EVENT_LANES.platform,
    eventType: "timing.span",
    native: { sessionId: null, parentSessionId: null, messageId: null, partId: null, callId: null },
    payload: { stage: "worker.accept_to_running", durMs: 3 },
  }, 0);
  return {
    run,
    steps: [],
    status: "running",
    summary: null,
    live: true,
    liveText,
    liveReasoning: "",
    native: store.getSnapshot(),
  };
}

function render(turn: Turn): string {
  return renderToStaticMarkup(
    <Conversation
      turns={[turn]}
      defaultEngine="chat"
      defaultModel="anthropic/claude-sonnet-5"
      defaultMemoryScope="org"
      pendingReply={null}
      onReply={async () => {}}
      productChildren={[]}
    />,
  );
}

test("native working timers exclude queue delay and hide elapsed without a durable start", () => {
  const now = Date.now();
  const pending = chatTurn("");
  pending.run.created_at = new Date(now - 365_000).toISOString();
  const waitingForStart = render(pending);
  expect(waitingForStart).toContain('data-timeline-source="native"');
  expect(waitingForStart).toContain('data-session-ui="working-indicator"');
  expect(waitingForStart).not.toContain("Working for");
  expect(waitingForStart).not.toContain("6m 5s");
  const start: ApiStep = {
    id: "chat-start", run_id: pending.run.id, idx: 0, kind: "task", chip: "chat",
    label: "Preparing chat context", code_json: '{"phase":"retrieval"}',
    created_at: new Date(now - 65_000).toISOString(),
  };
  const running = { ...pending, steps: [start] };
  const replay = { ...running, steps: JSON.parse(JSON.stringify(running.steps)) as ApiStep[] };
  for (const snapshot of [running, replay]) {
    const html = render(snapshot);
    expect(html).toContain('data-session-ui="working-indicator"');
    expect(html).toContain("Working for");
    expect(html).toContain("1m 5s");
    expect(html).not.toContain("6m 5s");
  }
  // Steps-only preparation owns a work row rather than the empty-timeline timer.
  expect(render({ ...running, native: undefined })).not.toContain("6m 5s");
});

test("a chat turn narrates its streamed answer while its native frames carry no text", () => {
  const html = render(chatTurn("Retry budgets bound how much a client may retry"));
  expect(html).toContain("Retry budgets bound how much a client may retry");
});

test("a chat turn with no deltas yet shows no narration", () => {
  expect(render(chatTurn(""))).not.toContain("Retry budgets");
});

test("native reconnect replay keeps one timeline Thinking owner", () => {
  const run: ApiRun = {
    ...chatTurn("").run,
    id: "native-run",
    thread_id: "native-run",
    engine: "opencode",
    model: "synthetic-model",
    prompt: "Check the retry policy",
  };
  const step: ApiStep = {
    id: "native-step",
    run_id: run.id,
    idx: 0,
    kind: "command",
    label: "bash",
    chip: "bash",
    code_json: JSON.stringify({
      tool: "bash",
      input: { command: "bun test retry" },
      native: {
        sessionID: "root-session",
        messageID: "assistant-message",
        partID: "tool-part",
        callID: "tool-call",
      },
    }),
    created_at: "2026-01-01T09:00:00.000Z",
  };
  const store = createNativeStore();
  store.ingestAll([step], 0);
  const frames = [
    {
      schemaVersion: 1 as const,
      eventId: "message-start",
      seq: 1,
      provider: "opencode",
      eventType: "part.step-start",
      native: { sessionId: "root-session", parentSessionId: null, messageId: "assistant-message", partId: "start-part", callId: null },
      payload: {},
    },
    {
      schemaVersion: 1 as const,
      eventId: "reasoning-update",
      seq: 2,
      provider: "opencode",
      eventType: "part.reasoning",
      native: { sessionId: "root-session", parentSessionId: null, messageId: "assistant-message", partId: "reasoning-part", callId: null },
      payload: { text: "Checking the synthetic retry policy." },
    },
    {
      schemaVersion: 1 as const,
      eventId: "tool-complete",
      seq: 3,
      provider: "opencode",
      eventType: "part.tool.completed",
      native: { sessionId: "root-session", parentSessionId: null, messageId: "assistant-message", partId: "tool-part", callId: "tool-call" },
      payload: { tool: "bash" },
    },
  ];
  for (const frame of frames) {
    expect(store.ingestNative(frame, 0)).toBe(true);
    // Reconnect replay of the same durable frame is ignored.
    expect(store.ingestNative(frame, 0)).toBe(false);
  }
  const turn: Turn = {
    run,
    steps: [step],
    status: "running",
    summary: null,
    live: true,
    liveText: "",
    liveReasoning: "Checking the synthetic retry policy.",
    native: store.getSnapshot(),
  };
  const html = render(turn);

  expect(html.match(/data-testid="thinking-header"/g)).toHaveLength(1);
  expect(html.match(/data-family="reasoning"/g)).toHaveLength(1);
});
