"use client";

import { useEffect, useRef, useState } from "react";
import { RiArrowDownSLine, RiCheckLine, RiCloseLine } from "@remixicon/react";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { cnExt as cn } from "@/utils/cn";
import * as Badge from "@/components/ui/badge";
import { Thinking } from "@/components/ai/thinking";
import { Composer } from "@/components/chat/composer";
import { Markdown } from "@/components/prompt-kit/markdown";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import {
  cleanPrompt,
  engineLabel,
  type ApiRun,
  type ApiStep,
  type EngineId,
  type RunStatus,
} from "@/components/chat/types";

/** One conversation turn: a run, plus its live-or-settled step/summary state. */
export type Turn = {
  run: ApiRun;
  steps: ApiStep[];
  status: RunStatus;
  summary: string | null;
  live: boolean;
  /** Accumulated token deltas while this turn is live; "" once settled. */
  liveText: string;
};

// Lightweight prose styling for rendered summaries — the AlignUI foundation
// doesn't ship @tailwindcss/typography, so map the flow elements (headings,
// paragraphs, lists, links) to brand tokens here. Structural elements that need
// a wrapper — tables, blockquotes, code — are styled as component overrides in
// `prompt-kit/markdown.tsx` so every caller gets them.
const MD_CLASS = cn(
  "text-paragraph-sm text-text-strong-950",
  // First/last block flush to the turn's edges; even rhythm everywhere else.
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2",
  "[&_h1]:text-label-md [&_h1]:font-medium [&_h1]:mt-4 [&_h1]:mb-1.5",
  "[&_h2]:text-label-sm [&_h2]:font-medium [&_h2]:mt-4 [&_h2]:mb-1.5",
  "[&_h3]:text-label-sm [&_h3]:font-medium [&_h3]:mt-3 [&_h3]:mb-1",
  "[&_h4]:text-label-xs [&_h4]:font-medium [&_h4]:mt-3 [&_h4]:mb-1",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_a]:text-blue-500 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-medium",
);

function UserBubble({ children }: { children: string }) {
  return (
    <div className="flex justify-end">
      <div className="bg-bg-weak-50 text-text-strong-950 text-paragraph-sm max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5">
        {children}
      </div>
    </div>
  );
}

/** The agent's answer. No fake typewriter: real streaming is LiveNarration's
 * job (progressive markdown on actual deltas); once a run completes, the
 * summary renders as settled Markdown immediately — a plain-text re-typing
 * animation both lied about liveness and showed raw markdown runes. */
function AgentAnswer({ summary }: { summary: string; stream?: boolean }) {
  return (
    <div className="animate-ai-fade-up">
      <Markdown className={MD_CLASS}>{summary}</Markdown>
    </div>
  );
}

/**
 * Live narration: the run's token deltas rendered as the answer-in-progress —
 * PROGRESSIVE MARKDOWN (Zola-style): remark-gfm parses whatever partial
 * markdown exists on each delta and degrades gracefully, so bold/tables/lists
 * render as they stream instead of arriving as raw `**`/`|` runes and snapping
 * into shape only at completion. A blinking caret tails the rendered block.
 * Replaced by the durable Markdown summary once the run settles.
 */
function LiveNarration({ text }: { text: string }) {
  return (
    <div className="animate-ai-fade-up">
      <Markdown className={MD_CLASS}>{text}</Markdown>
      <span
        className="ai-caret ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 rounded-full bg-text-strong-950 align-text-bottom"
        aria-hidden
      />
    </div>
  );
}

// NOTE: the mock NetworkApprovalRequest demo card was removed — engines run
// one-shot in yolo mode, so nothing can actually pause a run for approval; a
// fake approval card mid-run was actively misleading. When a real approval flow
// lands backend-side, compose `@/components/ai/approval-card` here again.

/**
 * Settled worklog, beautiful-ui capsule style: a pill row with a status circle,
 * step count, and Completed/Failed badge that expands to the full step cards.
 * Live activity keeps the Thinking shimmer — this is only the settled state.
 */
function WorklogCapsule({
  count,
  failed,
  children,
}: {
  count: number;
  failed: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = failed ? RiCloseLine : RiCheckLine;
  return (
    <div className="space-y-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="border-stroke-soft-200 bg-bg-white-0 hover:bg-bg-weak-50 flex items-center gap-2.5 rounded-full border py-1.5 pl-1.5 pr-2.5 transition-colors"
      >
        <span
          className={cn(
            "text-static-white flex size-5 shrink-0 items-center justify-center rounded-full",
            failed ? "bg-error-base" : "bg-success-base",
          )}
        >
          <Icon className="size-3" aria-hidden />
        </span>
        <span className="text-label-sm text-text-strong-950">Worklog</span>
        <span className="text-paragraph-xs text-text-soft-400">
          {count} step{count === 1 ? "" : "s"}
        </span>
        <Badge.Root variant="light" color={failed ? "red" : "green"} size="medium">
          {failed ? "Failed" : "Completed"}
        </Badge.Root>
        <RiArrowDownSLine
          className={cn(
            "text-text-soft-400 size-4 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && <div className="space-y-2.5">{children}</div>}
    </div>
  );
}

/** A single turn: the user's clean prompt, the agent's answer, and its activity
 * (open + streaming while live, a collapsed disclosure once settled). */
function TurnBlock({ turn }: { turn: Turn }) {
  const { run, steps, status, summary, live, liveText } = turn;
  // Capture whether this turn was streaming when it first mounted, so its
  // summary typewriters in on arrival but settled history renders instantly.
  const [wasLive] = useState(() => live);
  // Whether this turn ever streamed live narration. Once it has, the completed
  // summary swaps in instantly (no re-typewriter of text the user just watched);
  // turns with no narration keep the on-arrival typewriter as a graceful fallback.
  const [sawNarration, setSawNarration] = useState(false);
  useEffect(() => {
    if (liveText.length > 0) setSawNarration(true);
  }, [liveText]);

  const activity = steps.filter((s) => s.kind !== "done");
  const latestLabel = activity.at(-1)?.label ?? "Starting up";
  const failed = status === "failed";
  // Settled-state weight (beautiful-ui): fanout turns earn the full Worklog
  // capsule; plain tool runs settle into the quiet "Ran N tools" trace.
  const hasSubagents = activity.some((s) => s.chip === "subagent");
  const toolCount = activity.filter(
    (s) => s.kind === "command" || s.kind === "file",
  ).length;
  const traceLabel =
    toolCount > 0
      ? `Ran ${toolCount} tool${toolCount === 1 ? "" : "s"}`
      : `${activity.length} step${activity.length === 1 ? "" : "s"}`;
  // While narration is streaming it IS this turn's live indicator: show the
  // fading text + caret and suppress the Thinking shimmer so only one live
  // signal shows at a time.
  const narrating = live && liveText.length > 0;

  return (
    <div className="space-y-4">
      <UserBubble>{cleanPrompt(run.prompt)}</UserBubble>

      {/* Assistant block: avatar + name on a header row, with the answer and the
          worklog capsule aligned to the same left content edge as every other
          assistant turn — one column, symmetric with the user bubble's bounds. */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="ring-stroke-soft-200 bg-bg-weak-50 flex size-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset">
            <AsteriskMark className="text-text-strong-950 size-3" />
          </span>
          <span className="text-label-sm text-text-strong-950">Skynet</span>
          <span className="text-mono-label text-text-soft-400">
            {engineLabel(run.engine)}
          </span>
        </div>

        {summary && (
          <AgentAnswer summary={summary} stream={wasLive && !sawNarration} />
        )}

        {/* Answer-in-progress: the run's live tokens stream in word-by-word
            until the durable summary/markdown takes over on completion. */}
        {narrating && !summary && <LiveNarration text={liveText} />}

        {failed && !summary && (
          <p className="text-paragraph-sm text-error-base">
            This run failed before producing a summary.
          </p>
        )}

        {/* One live indicator: while narration streams it IS the indicator, so
            the Thinking block is suppressed for that turn. Otherwise Thinking
            covers live activity (the boot gap — live, no steps yet — is owned by
            the session's OrbBootIndicator). Settled history splits by weight:
            subagent fanouts (and failures, which need the status badge) keep the
            Worklog capsule; plain tool runs collapse to the quiet trace. */}
        {narrating ? null : live
          ? activity.length > 0 && (
              <Thinking label={`Working — ${latestLabel}`} active open>
                {activity.map((step, i) => (
                  <ToolStepRow
                    key={step.id}
                    step={step}
                    state={i === activity.length - 1 ? "running" : "done"}
                  />
                ))}
              </Thinking>
            )
          : activity.length > 0 &&
            (hasSubagents || failed ? (
              <WorklogCapsule count={activity.length} failed={failed}>
                {activity.map((step) => (
                  <ToolStepRow key={step.id} step={step} state="done" />
                ))}
              </WorklogCapsule>
            ) : (
              <Thinking label={traceLabel} active={false}>
                {activity.map((step) => (
                  <ToolStepRow key={step.id} step={step} state="done" />
                ))}
              </Thinking>
            ))}
      </div>
    </div>
  );
}

function ReplyComposer({
  engine,
  model,
  pending,
  onReply,
}: {
  engine: EngineId;
  model: string;
  pending: boolean;
  onReply: (text: string, engine: EngineId, model: string) => void;
}) {
  return (
    <div className="border-stroke-soft-200 shrink-0 border-t p-3">
      <Composer
        variant="compact"
        placeholder="Reply to Skynet…"
        defaultEngine={engine}
        defaultModel={model}
        pending={pending}
        onSubmit={(text, eng, mdl) => onReply(text, eng, mdl)}
      />
    </div>
  );
}

/**
 * Left column of the session: the whole thread as one conversation — one
 * `TurnBlock` per run (clean user bubble + agent answer + activity) — with a
 * reply composer pinned to the bottom. A reply appears optimistically until the
 * refetched thread carries the real child run.
 */
export function Conversation({
  turns,
  defaultEngine,
  defaultModel,
  pendingReply,
  onReply,
}: {
  turns: Turn[];
  defaultEngine: EngineId;
  defaultModel: string;
  pendingReply: string | null;
  onReply: (text: string, engine: EngineId, model: string) => void;
}) {
  // Stick-to-bottom autoscroll: follow new turns/steps/narration as they
  // stream, but ONLY while the user is already near the bottom — scrolling up
  // to read history must never be yanked back down. `stick` flips on scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const scrollSignature = turns
    .map((t) => `${t.steps.length}:${t.liveText.length}:${t.summary ? 1 : 0}`)
    .join("|");
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [scrollSignature, pendingReply, turns.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-8 overflow-y-auto px-5 py-6"
      >
        {turns.map((turn) => (
          <TurnBlock key={turn.run.id} turn={turn} />
        ))}
        {pendingReply && <UserBubble>{pendingReply}</UserBubble>}
      </div>

      <ReplyComposer
        engine={defaultEngine}
        model={defaultModel}
        pending={pendingReply !== null}
        onReply={onReply}
      />
    </div>
  );
}
