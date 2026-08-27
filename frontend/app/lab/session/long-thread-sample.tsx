"use client";

// /lab/session "long thread" harness: the REAL Conversation fed up to 1,000 synthetic
// settled turns, so the turn-window rendering (placeholder rows sized from the
// measured-height cache, anchor-stabilized scroll, the short-thread bypass
// threshold being exceeded) can be reviewed and profiled visually. Nothing here
// reimplements a renderer - it only feeds the production component.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Conversation, type Turn } from "@/components/chat/conversation";
import type { ApiRun, ApiStep } from "@/components/chat/types";
import { sampleStep } from "./session-sample-data";

const LONG_THREAD_TURNS = 1_000;
const DEFAULT_THREAD_TURNS = 30;

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
        commandStep("Inspect queue depth", "queuectl depth", "depth=0"),
        sampleStep({
          kind: "task",
          label: "Subagent - verify the fix",
          chip: "subagent",
          code: {
            tool: "task",
            input: { description: "Verify the focused change" },
            output: "Verification passed.",
          },
        }),
        commandStep("Confirm the diff", "git diff --check", "clean"),
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
  const [turnCount, setTurnCount] = useState(DEFAULT_THREAD_TURNS);
  const [metrics, setMetrics] = useState<Record<string, number> | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const renderStartedRef = useRef<number | null>(null);
  const longTasksRef = useRef({ count: 0, duration: 0 });

  // Opt-in browser perf probe: `/lab/session?turns=1000` uses the exact same
  // deterministic fixture and production Conversation, then publishes measured
  // render/scroll/DOM evidence into the DOM for a headless-browser capture.
  useEffect(() => {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasksRef.current.count += 1;
        longTasksRef.current.duration += entry.duration;
      }
    });
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      observer.observe({ entryTypes: ["longtask"] });
    }
    const requested = Number(new URLSearchParams(window.location.search).get("turns"));
    if ([100, 1_000].includes(requested)) {
      requestAnimationFrame(() => {
        const measureTarget = () => {
          renderStartedRef.current = performance.now();
          setTurnCount(requested);
        };
        if (requested === turnCount) {
          setTurnCount(31);
          setTimeout(measureTarget, 50);
        } else {
          measureTarget();
        }
      });
    }
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const renderMs = performance.now() - (renderStartedRef.current ?? performance.now());
        const viewport = surface.querySelector<HTMLElement>(".scrollbar-slim");
        const scrollStarted = performance.now();
        if (viewport) viewport.scrollTop = Math.max(0, viewport.scrollHeight / 2);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setMetrics({
              turns: turnCount,
              render_ms: Number(renderMs.toFixed(2)),
              scroll_ms: Number((performance.now() - scrollStarted).toFixed(2)),
              dom_nodes: surface.querySelectorAll("*").length,
              turn_rows: surface.querySelectorAll("[data-turn-row]").length,
              placeholders: surface.querySelectorAll('[data-testid="turn-placeholder"]').length,
              long_tasks: longTasksRef.current.count,
              long_task_ms: Number(longTasksRef.current.duration.toFixed(2)),
              scroll_height: viewport?.scrollHeight ?? 0,
              viewport_height: viewport?.clientHeight ?? 0,
            });
          }),
        );
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [turnCount]);

  return (
    <div className="space-y-2">
      <fieldset className="flex items-center gap-2" aria-label="Long-thread turn count">
        {[DEFAULT_THREAD_TURNS, 31, 100, LONG_THREAD_TURNS].map((count) => (
          <button
            key={count}
            type="button"
            data-testid={`long-thread-size-${count}`}
            aria-pressed={turnCount === count}
            onClick={() => setTurnCount(count)}
            className="rounded-md border border-border-button-default px-2 py-1 text-caption-1-medium text-text-secondary"
          >
            {count} turns
          </button>
        ))}
      </fieldset>
      {metrics && <output data-testid="long-thread-perf">{JSON.stringify(metrics)}</output>}
      <div
        ref={surfaceRef}
        data-testid="long-thread-surface"
        className="flex h-[76vh] flex-col overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default"
      >
        <Conversation
          turns={longThreadTurns.slice(0, turnCount)}
          defaultEngine="opencode"
          defaultModel="claude-sonnet-5"
          defaultMemoryScope="org"
          pendingReply={null}
          onReply={() => {}}
        />
      </div>
    </div>
  );
}
