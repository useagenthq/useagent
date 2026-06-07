"use client";

// /lab/session "long thread" harness: the REAL Conversation fed 80 synthetic
// settled turns, so the turn-window rendering (placeholder rows sized from the
// measured-height cache, anchor-stabilized scroll, the short-thread bypass
// threshold being exceeded) can be reviewed and profiled visually. Nothing here
// reimplements a renderer - it only feeds the production component.

import { Conversation, type Turn } from "@/components/chat/conversation";
import type { ApiRun, ApiStep } from "@/components/chat/types";
import { sampleStep } from "./session-sample-data";

const LONG_THREAD_TURNS = 80;

// Deterministic content (never Date.now/random): SSR and client must agree.
const T0 = Date.parse("2026-08-18T10:00:00.000Z");

const PROMPTS = [
  "Tighten the retry budget on the webhook dispatcher",
  "Why is the nightly index rebuild slow this week?",
  "Add a regression test for the pagination cursor",
  "Refactor the queue drain loop to batch acknowledgements",
  "Summarize what changed in the billing reconciler",
];

const SHORT_ANSWER =
  "Done. The retry budget now caps at 5 attempts per delivery with exponential backoff, and the dead-letter path records the final error.";

const LONG_ANSWER = `Here is what I found and changed:

- The rebuild spent most of its time re-tokenizing unchanged documents; the content hash check was comparing against the wrong column, so every row looked dirty.
- Fixed the comparison and added a covering index on \`(collection_id, content_hash)\`.
- The nightly job now skips ~92% of rows and finishes in 4 minutes instead of 51.

\`\`\`sql
CREATE INDEX CONCURRENTLY idx_documents_rebuild
  ON documents (collection_id, content_hash);
\`\`\`

The remaining time is dominated by embedding calls for genuinely new documents, which is expected.`;

function commandStep(label: string, command: string, output: string): ApiStep {
  return sampleStep({
    kind: "command",
    label,
    code: { tool: "bash", input: { command }, output },
  });
}

function makeTurn(index: number): Turn {
  const id = `long-turn-${index}`;
  const createdAt = new Date(T0 + index * 90_000).toISOString();
  const withSteps = index % 3 === 0;
  const longAnswer = index % 4 === 1;
  const steps: ApiStep[] = withSteps
    ? [
        commandStep(
          "Run the focused test file",
          `bun test src/queue/drain.test.ts # turn ${index}`,
          "12 pass, 0 fail",
        ),
        commandStep("Check the worker logs", "tail -n 50 logs/worker.log", "no errors"),
      ]
    : [];
  const run: ApiRun = {
    id,
    org_id: null,
    user_id: null,
    prompt: `${PROMPTS[index % PROMPTS.length]} (turn ${index + 1})`,
    model: "claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: longAnswer ? LONG_ANSWER : SHORT_ANSWER,
    duration_ms: 42_000,
    parent_run_id: index === 0 ? null : "long-turn-0",
    child_session: false,
    thread_id: "long-turn-0",
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
    created_at: createdAt,
    updated_at: createdAt,
    steps,
  };
  return {
    run,
    steps,
    status: run.status,
    summary: run.summary,
    live: false,
    liveText: "",
    liveReasoning: "",
  };
}

// Built once at module scope so server and client render identical fixtures.
const longThreadTurns: Turn[] = Array.from({ length: LONG_THREAD_TURNS }, (_, i) => makeTurn(i));

export function LongThreadSample() {
  return (
    <div className="h-[76vh] overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default">
      <Conversation
        turns={longThreadTurns}
        defaultEngine="opencode"
        defaultModel="claude-sonnet-5"
        defaultMemoryScope="org"
        pendingReply={null}
        onReply={() => {}}
      />
    </div>
  );
}
