"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownSLine, RiCheckLine, RiCloseLine } from "@remixicon/react";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { cnExt as cn } from "@/utils/cn";
import * as Badge from "@/components/ui/badge";
import { Thinking } from "@/components/ai/thinking";
import { LoadingState } from "@/components/ai/loading-state";
import { Composer, type ComposerSubmit } from "@/components/chat/composer";
import { Markdown } from "@/components/prompt-kit/markdown";
import { MarkerRow, ToolStepRow } from "@/components/chat/tool-step-row";
import type { SlashCommand } from "@/components/chat/slash-command";
import { buildTimeline, hasNarration, type TimelineNode } from "@/components/chat/timeline";
import type { NativeSnapshot } from "@/components/chat/native-store";
import {
  cleanPrompt,
  deriveTrace,
  engineLabel,
  type ApiRun,
  type ApiStep,
  type EngineId,
  type MemoryScope,
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
  /** Native ordered-frame projection (text + tool parts by seq) for the watched
   *  run — the source for the interleaved timeline. Absent on settled history runs
   *  (no frame stream), which fall back to the narration-blob + worklog rendering. */
  native?: NativeSnapshot;
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

/** Terminal note for a run that failed before writing a summary. */
function FailedNote() {
  return (
    <p className="text-paragraph-sm text-error-base">
      This run failed before producing a summary.
    </p>
  );
}

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
      {/* Pixel-grid churn indicator (beautiful-ui LoadingState) — replaced the
          lone blinking caret line the user rejected. */}
      <LoadingState label="Working" className="mt-2" />
    </div>
  );
}

/** One narration burst of the interleaved timeline — the same progressive-markdown
 *  treatment LiveNarration uses, memoized by its text so a streaming sibling burst
 *  or a completing tool never re-renders the settled ones (no fanout churn). */
const TextBurst = memo(function TextBurst({ text }: { text: string }) {
  return (
    <div className="animate-ai-fade-up">
      <Markdown className={MD_CLASS}>{text}</Markdown>
    </div>
  );
});

/**
 * The interleaved turn timeline: narration bursts and the tool rows that followed
 * them, in TRUE ORDER (opencode-style) from the native ordered frames. While live,
 * the last tool reads as running and a LoadingState tails the block; the final
 * narration burst is the turn's answer (so the summary is not re-rendered below).
 * Each node is memoized (TextBurst by text, ToolStepRow by step) so a 20-way
 * fanout doesn't restorm on every frame.
 */
function Timeline({ nodes, live }: { nodes: TimelineNode[]; live: boolean }) {
  // LIVE: render flat so every tool row streams in view as it happens.
  if (live) {
    const last = nodes.length - 1;
    return (
      <div className="space-y-3">
        {nodes.map((node, i) =>
          node.kind === "marker" ? (
            <MarkerRow key={node.key} marker={node.marker} />
          ) : node.kind === "text" ? (
            <TextBurst key={node.key} text={node.text} />
          ) : (
            <ToolStepRow key={node.key} step={node.step} state={i === last ? "running" : "done"} />
          ),
        )}
        <LoadingState label="Working" className="mt-1" />
      </div>
    );
  }

  // SETTLED: keep narration + markers inline, but FOLD consecutive tool rows
  // into a collapsed "Ran N tools" disclosure - a long turn (15 tool calls)
  // otherwise dumps every row and buries the answer (user report / BUG-010).
  // A lone tool between bursts stays inline (nothing to collapse).
  type Group =
    | { kind: "inline"; key: string; node: TimelineNode }
    | { kind: "tools"; key: string; steps: TimelineNode[] };
  const groups: Group[] = [];
  for (const node of nodes) {
    if (node.kind === "tool") {
      const last = groups.at(-1);
      if (last && last.kind === "tools") last.steps.push(node);
      else groups.push({ kind: "tools", key: node.key, steps: [node] });
    } else {
      groups.push({ kind: "inline", key: node.key, node });
    }
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => {
        if (g.kind === "inline") {
          return g.node.kind === "marker" ? (
            <MarkerRow key={g.key} marker={g.node.marker} />
          ) : (
            <TextBurst key={g.key} text={(g.node as { text: string }).text} />
          );
        }
        const stepOf = (n: TimelineNode) =>
          (n as Extract<TimelineNode, { kind: "tool" }>).step;
        if (g.steps.length === 1) {
          return <ToolStepRow key={g.key} step={stepOf(g.steps[0])} state="done" />;
        }
        return (
          <Thinking key={g.key} label={`Ran ${g.steps.length} tools`} active={false}>
            {g.steps.map((n) => (
              <ToolStepRow key={n.key} step={stepOf(n)} state="done" />
            ))}
          </Thinking>
        );
      })}
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
function TurnBlock({ turn, onSendNow }: { turn: Turn; onSendNow?: () => void }) {
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

  // The interleaved timeline (narration bursts ↔ tool rows in true order), built
  // from the watched run's native ordered frames. Null on turns without native
  // data (settled history, non-native engines) → the legacy rendering below takes
  // over. Recomputed only when the native snapshot or liveness changes.
  const timeline = useMemo(
    () => (turn.native ? buildTimeline(turn.native, live) : null),
    [turn.native, live],
  );

  const activity = steps.filter((s) => s.kind !== "done");
  const latestLabel = activity.at(-1)?.label ?? "Starting up";
  const failed = status === "failed";
  // Settled history drops sandbox plumbing rows ("Sandbox — Thinking…" etc.):
  // they're live indicators, not work worth re-reading. Live rendering keeps
  // them — they ARE the signal during the boot gap.
  const settled = activity.filter((s) => deriveTrace(s).accent !== "boot");
  // Settled-state weight (beautiful-ui): fanout turns earn the full Worklog
  // capsule; plain tool runs settle into the quiet "Ran N tools" trace.
  const hasSubagents = settled.some((s) => s.chip === "subagent");
  const toolCount = settled.filter(
    (s) => s.kind === "command" || s.kind === "file",
  ).length;
  const traceLabel =
    toolCount > 0
      ? `Ran ${toolCount} tool${toolCount === 1 ? "" : "s"}`
      : `${settled.length} step${settled.length === 1 ? "" : "s"}`;
  // While narration is streaming it IS this turn's live indicator: show the
  // fading text + caret and suppress the Thinking shimmer so only one live
  // signal shows at a time.
  const narrating = live && liveText.length > 0;

  // STANDARD queued rendering (matches opencode's steering-queue model): a
  // follow-up sent while the thread is busy queues into the same session, and
  // the UI shows ONLY the user's message with a queued tag - the assistant
  // block materializes when processing starts. An empty assistant header for
  // a queued turn read as broken (user report). "Send now" steering is a
  // future control on top of the same queue.
  if (status === "queued" && activity.length === 0 && !summary && !liveText) {
    return (
      <div className="space-y-1">
        <UserBubble>{cleanPrompt(run.prompt)}</UserBubble>
        <div className="flex items-center justify-end gap-2">
          <span className="text-label-xs text-text-soft-400">queued</span>
          {onSendNow && (
            <button
              type="button"
              onClick={onSendNow}
              title="Stops the current turn; this message starts immediately"
              className="text-label-xs text-primary-base cursor-pointer underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              Send now
            </button>
          )}
        </div>
      </div>
    );
  }

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

        {timeline ? (
          /* Native turn: the interleaved timeline IS the turn — narration bursts
             and their tool rows in true order (live and settled alike). Its final
             burst is the answer, so the durable summary is re-rendered only when
             the timeline carried no narration (a tool-only turn). */
          <>
            <Timeline nodes={timeline} live={live} />
            {summary && !hasNarration(timeline) && <AgentAnswer summary={summary} />}
            {failed && !summary && !hasNarration(timeline) && <FailedNote />}
          </>
        ) : (
          /* Fallback (no native frames): activity first, then the answer. One live
             indicator at a time — while narration streams it IS the indicator, so
             the Thinking block is suppressed (the boot gap is owned by the
             session's OrbBootIndicator). Settled history splits by weight: subagent
             fanouts (and failures, which need the status badge) keep the Worklog
             capsule; plain tool runs collapse to the quiet trace. */
          <>
            {narrating ? null : live
              ? activity.length > 0 && (
                  <Thinking label={`Working - ${latestLabel}`} active open>
                    {activity.map((step, i) => (
                      <ToolStepRow
                        key={step.id}
                        step={step}
                        state={i === activity.length - 1 ? "running" : "done"}
                      />
                    ))}
                  </Thinking>
                )
              : settled.length > 0 &&
                (hasSubagents || failed ? (
                  <WorklogCapsule count={settled.length} failed={failed}>
                    {settled.map((step) => (
                      <ToolStepRow key={step.id} step={step} state="done" />
                    ))}
                  </WorklogCapsule>
                ) : (
                  <Thinking label={traceLabel} active={false}>
                    {settled.map((step) => (
                      <ToolStepRow key={step.id} step={step} state="done" />
                    ))}
                  </Thinking>
                ))}

            {summary && (
              <AgentAnswer summary={summary} stream={wasLive && !sawNarration} />
            )}

            {/* Answer-in-progress: the run's live tokens stream in word-by-word
                until the durable summary/markdown takes over on completion. */}
            {narrating && !summary && <LiveNarration text={liveText} />}

            {failed && !summary && <FailedNote />}

            {/* Started but nothing streamed yet: the working state (queued
                turns never reach here - they early-return as a bare user
                bubble above, per the opencode steering-queue standard). */}
            {!summary &&
              !narrating &&
              !failed &&
              activity.length === 0 &&
              status === "running" && (
                <span className="text-label-sm text-text-soft-400">Working...</span>
              )}
          </>
        )}
      </div>
    </div>
  );
}

function ReplyComposer({
  engine,
  model,
  memoryScope,
  pending,
  commands,
  onReply,
}: {
  engine: EngineId;
  model: string;
  memoryScope: MemoryScope;
  pending: boolean;
  commands?: SlashCommand[];
  onReply: ComposerSubmit;
}) {
  return (
    <div className="border-stroke-soft-200 shrink-0 border-t p-3">
      <Composer
        variant="compact"
        placeholder="Reply to Skynet…"
        defaultEngine={engine}
        defaultModel={model}
        defaultMemoryScope={memoryScope}
        pending={pending}
        commands={commands}
        onSubmit={onReply}
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
  defaultMemoryScope,
  pendingReply,
  commands,
  onReply,
  sendNowFor,
  onSendNow,
}: {
  turns: Turn[];
  defaultEngine: EngineId;
  defaultModel: string;
  /** The thread's current memory scope — the reply composer starts here. */
  defaultMemoryScope: MemoryScope;
  pendingReply: string | null;
  /** Engine slash commands for the reply composer's "/" autocomplete. */
  commands?: SlashCommand[];
  onReply: ComposerSubmit;
  /** Run id of the HEAD queued turn when a turn is running - that bubble gets
   *  the "Send now" steering affordance (opencode's control on our harness). */
  sendNowFor?: string | null;
  onSendNow?: () => void;
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
          <TurnBlock
            key={turn.run.id}
            turn={turn}
            onSendNow={turn.run.id === sendNowFor ? onSendNow : undefined}
          />
        ))}
        {pendingReply && <UserBubble>{pendingReply}</UserBubble>}
      </div>

      <ReplyComposer
        engine={defaultEngine}
        model={defaultModel}
        memoryScope={defaultMemoryScope}
        pending={pendingReply !== null}
        commands={commands}
        onReply={onReply}
      />
    </div>
  );
}
