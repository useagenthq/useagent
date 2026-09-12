import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, type Turn } from "./conversation";
import { createNativeStore } from "./native-store";
import type { ApiRun } from "./types";

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
    provider: "skynet",
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

test("a chat turn narrates its streamed answer while its native frames carry no text", () => {
  const html = render(chatTurn("Retry budgets bound how much a client may retry"));
  expect(html).toContain("Retry budgets bound how much a client may retry");
});

test("a chat turn with no deltas yet shows no narration", () => {
  expect(render(chatTurn(""))).not.toContain("Retry budgets");
});
