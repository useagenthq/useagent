"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { LoadingState } from "@/components/ai/loading-state";
import { Thinking } from "@/components/ai/thinking";
import type { ApprovalDecision, PendingApproval } from "@/components/chat/approval-state";
import {
  buildTimelineFromCanonical,
  type CommandCatalogState,
  type StoredCanonicalEvent,
  shouldUseCanonicalTimeline,
} from "@/components/chat/canonical-timeline";
import { Composer, type ComposerSubmit } from "@/components/chat/composer";
import { useEnabledEngineConfig } from "@/components/chat/engine-picker";
import { GatewayApprovalCard } from "@/components/chat/gateway-approval-card";
import { toGatewayChildSession } from "@/components/chat/gateway-children";
import { InboundAttachments } from "@/components/chat/inbound-attachments";
import { NativeApprovalCard } from "@/components/chat/native-approval-card";
import type { NativeSnapshot } from "@/components/chat/native-store";
import { QuestionCard } from "@/components/chat/question-card";
import {
  composerAcceptsRunResources,
  type PendingQuestion,
} from "@/components/chat/question-state";
import type { SlashCommand } from "@/components/chat/slash-command";
import {
  type GatewayChildSession,
  SubagentsFold,
} from "@/components/chat/subagents-fold";
import {
  buildTimeline,
  hasNarration,
  type TimelineNode,
} from "@/components/chat/timeline";
import { MD_CLASS, MD_CLASS_REASONING, Timeline } from "@/components/chat/timeline-view";
import { TurnWindow } from "@/components/chat/turn-window";

// Re-exported so existing importers (lab samples, workspace sample) keep working.
export { Timeline } from "@/components/chat/timeline-view";
import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { Markdown } from "@/components/prompt-kit/markdown";
import { MessageCopyButton } from "@/components/session-ui/message-copy-button";
import { MessageScrollerRail } from "@/components/session-ui/message-scroller-rail";
import { unavailableEngineLabel } from "@/components/session-ui/provider-status-banner";
import { QueuedMessagePill } from "@/components/session-ui/queued-message-pill";
import { ScrollToEndPill } from "@/components/session-ui/scroll-to-end-pill";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "@/components/session-ui/thread-error-banner";
import type { GatewayApproval } from "@/lib/gateway-approvals";

// Canonical-timeline cutover flag. OFF by default:
// the legacy native/steps derivation renders unless a backend + build opt in via
// NEXT_PUBLIC_CANONICAL_TIMELINE=1. The canonical path is proven byte-for-byte
// equivalent (canonical-timeline.equiv/.nodes tests); this flag lets us flip it on
// deliberately and fall straight back to legacy if a run has no canonical events.
const CANONICAL_TIMELINE = process.env.NEXT_PUBLIC_CANONICAL_TIMELINE === "1";

import {
  type ApiRun,
  type ApiStep,
  cleanPrompt,
  deriveTrace,
  type EngineId,
  engineLabel,
  isRenderableTimelineStep,
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
  /** Accumulated provider "thinking" deltas while this turn is live; "" once
   *  settled. Surfaced as a subdued Thinking affordance ahead of the answer. */
  liveReasoning: string;
  /** Native ordered-frame projection (text + tool parts by seq) for the watched
   *  run — the source for the interleaved timeline. Absent on settled history runs
   *  (no frame stream), which fall back to the narration-blob + worklog rendering. */
  native?: NativeSnapshot;
  /** Canonical events for this run. Consumed only behind the
   *  canonical-timeline flag; empty/absent falls back to the native lane. */
  canonical?: readonly StoredCanonicalEvent[];
  /** H2: whether this run's canonicalization reached the durable `complete` record. The
   *  canonical lane drives the UI ONLY when true - otherwise the legacy native lane does,
   *  so a still-provisional (partial, retrying) snapshot never renders. */
  canonicalComplete?: boolean;
  /** Present ONLY on a not-yet-loaded outline stub (windowed initial loading):
   *  the cheap skeleton that sizes this turn's placeholder row. The turn window
   *  never materializes a stub; the full run (island fetch or SSE snapshot)
   *  replaces the whole Turn, dropping this. */
  pendingOutline?: { readonly stepCount: number; readonly hasSummary: boolean };
};


/** Terminal note for a run that failed before writing a summary. */
function FailedNote() {
  return (
    <p className="text-body-2-regular text-red-500">This run failed before producing a summary.</p>
  );
}

export function UserBubble({ children }: { children: string }) {
  return (
    <div className="flex justify-end" data-testid="user-message">
      <div className="bg-background-secondary-default text-text-primary text-body-2-regular max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5">
        {children}
      </div>
    </div>
  );
}

/** The assistant turn's identity row: brand glyph + "Agent" + the engine label.
 *  Shared by TurnBlock and the /lab/session sample so both read identically. */
export function AssistantTurnHeader({ engine }: { engine: EngineId }) {
  return (
    <div className="flex items-center gap-2">
      <span className="ring-border-button-default bg-background-secondary-default flex size-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset">
        <OrbitKnotMark className="size-3.5" stroke={2.2} />
      </span>
      <span className="text-body-2-medium text-text-primary">Agent</span>
      <span className="text-mono-label text-text-tertiary">{engineLabel(engine)}</span>
    </div>
  );
}

/** The agent's answer. No fake typewriter: real streaming is LiveNarration's
 * job (progressive markdown on actual deltas); once a run completes, the
 * summary renders as settled Markdown immediately — a plain-text re-typing
 * animation both lied about liveness and showed raw markdown runes. */
export function AgentAnswer({ summary }: { summary: string; stream?: boolean }) {
  return (
    <div className="animate-ai-fade-up" data-testid="agent-answer">
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


/** Live provider "thinking" surfaced AHEAD of the answer: a subdued, truthful
 *  Thinking disclosure streaming the real reasoning tokens. It fills the
 *  pre-answer gap with real provider output (never a fabricated spinner) and
 *  yields once the answer text begins. Memoized by text so a streaming sibling
 *  or a completing tool never re-renders it. */
const LiveThinking = memo(function LiveThinking({ text }: { text: string }) {
  return (
    <Thinking label="Thinking" active open>
      <div data-testid="live-thinking">
        <Markdown className={MD_CLASS_REASONING}>{text}</Markdown>
      </div>
    </Thinking>
  );
});

// NOTE: the mock NetworkApprovalRequest demo card was removed — engines run
// one-shot in yolo mode, so nothing can actually pause a run for approval; a
// fake approval card mid-run was actively misleading. When a real approval flow
// lands backend-side, compose `@/components/ai/approval-card` here again.

/** Wrap legacy ApiStep rows as canonical tool nodes so the T3 adapter stays the
 *  ONE step-to-work-entry mapping (no parallel grammar for the fallback lane). */
function toolNodesFromSteps(steps: readonly ApiStep[]): TimelineNode[] {
  return steps.map((step) => ({ kind: "tool", key: step.id, step }));
}

/** A single turn: the user's clean prompt, the agent's answer, and its activity
 * (open + streaming while live, a collapsed disclosure once settled).
 * Memoized: the thread store keeps a settled run's view (and so its Turn object)
 * identity-stable across snapshot rebuilds, so while one run streams every other
 * turn bails here instead of re-running buildTimeline per SSE animation frame. */
const TurnBlock = memo(function TurnBlock({
  turn,
  queuePosition,
  onSendNow,
  childSessions,
  isLatestTurn = false,
  windowOwnsRunMarker = false,
}: {
  turn: Turn;
  /** 1-based place among this thread's queued turns (queued rendering only). */
  queuePosition?: number;
  onSendNow?: () => void;
  /** Gateway child sessions THIS turn spawned (deferred serial thread turns) -
   *  they fold under this turn's subagent group instead of rendering as their
   *  own top-level turns. */
  childSessions?: readonly GatewayChildSession[];
  /** True for the thread's final turn - the only one whose follow-up
   *  suggestions render (stale suggestions under history are noise). */
  isLatestTurn?: boolean;
  /** The turn-window wrapper owns the rail marker for virtualized rows. */
  windowOwnsRunMarker?: boolean;
}) {
  const { run, steps, status, summary, live, liveText, liveReasoning } = turn;
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
  const timeline = useMemo(() => {
    // Canonical cutover (flag-gated): render from the canonical lane ONLY once this run's
    // canonicalization reached its durable `complete` record (H2). A still-provisional
    // projection (the outbox is retrying, the snapshot may be partial) never drives the
    // UI - the legacy native derivation does. The two are proven byte-for-byte equivalent,
    // so a completed swap never changes what the user sees.
    const canonical = turn.canonical;
    if (canonical && shouldUseCanonicalTimeline(CANONICAL_TIMELINE, turn)) {
      const stepsById = new Map(turn.steps.map((s) => [s.id, s]));
      return buildTimelineFromCanonical(canonical, stepsById, live);
    }
    return turn.native ? buildTimeline(turn.native, live) : null;
  }, [turn.native, turn.canonical, turn.canonicalComplete, turn.steps, live]);

  // Which lane actually drove the timeline above - a test/debug hook (asserted by the
  // flag-on browser E2E to prove the canonical path really rendered, not just that a
  // timeline appeared). Cheap + pure.
  const timelineSource: "canonical" | "native" = shouldUseCanonicalTimeline(
    CANONICAL_TIMELINE,
    turn,
  )
    ? "canonical"
    : "native";

  const activity = steps.filter((s) => s.kind !== "done" && isRenderableTimelineStep(s));
  const failed = status === "failed";
  // Settled history drops sandbox plumbing rows ("Sandbox — Thinking…" etc.):
  // they're live indicators, not work worth re-reading. Live rendering keeps
  // them — they ARE the signal during the boot gap.
  const settled = activity.filter((s) => deriveTrace(s).accent !== "boot");
  // While narration is streaming it IS this turn's live indicator: show the
  // fading text + caret and suppress the Thinking shimmer so only one live
  // signal shows at a time.
  const narrating = live && liveText.length > 0;
  // The live thinking affordance yields the moment answer text begins, in either
  // render path: fallback narration (liveText), the durable summary, or an answer
  // burst inside the interleaved timeline.
  const answerStarted =
    liveText.length > 0 || Boolean(summary) || (timeline != null && hasNarration(timeline));

  // STANDARD queued rendering (matches opencode's steering-queue model): a
  // follow-up sent while the thread is busy queues into the same session, and
  // the UI shows ONLY the user's message with a queued tag - the assistant
  // block materializes when processing starts. An empty assistant header for
  // a queued turn read as broken (user report). "Send now" steering is a
  // future control on top of the same queue.
  if (status === "queued" && activity.length === 0 && !summary && !liveText) {
    return (
      <div
        className="space-y-1"
        data-testid="turn-block"
        data-run-id={windowOwnsRunMarker ? undefined : run.id}
      >
        <UserBubble>{cleanPrompt(run.prompt)}</UserBubble>
        <InboundAttachments uploads={run.uploads} />
        <QueuedMessagePill
          position={queuePosition ?? 1}
          waitingOnCurrentRun={run.parent_run_id !== null}
          onSendNow={onSendNow}
        />
      </div>
    );
  }

  return (
    <div
      className="space-y-4"
      data-testid="turn-block"
      data-run-id={windowOwnsRunMarker ? undefined : run.id}
    >
      <div className="space-y-2">
        <UserBubble>{cleanPrompt(run.prompt)}</UserBubble>
        <InboundAttachments uploads={run.uploads} />
      </div>

      {/* Assistant block: avatar + name on a header row, with the answer and the
          worklog capsule aligned to the same left content edge as every other
          assistant turn — one column, symmetric with the user bubble's bounds. */}
      <div className="group/turn space-y-3">
        <AssistantTurnHeader engine={run.engine} />

        {/* Thinking surfaced ahead of the answer: real streamed reasoning tokens
            (not a spinner), yielding the instant answer text starts. */}
        {live && !answerStarted && liveReasoning && <LiveThinking text={liveReasoning} />}

        {timeline ? (
          /* Native turn: the interleaved timeline IS the turn — narration bursts
             and their tool rows in true order (live and settled alike). Its final
             burst is the answer, so the durable summary is re-rendered only when
             the timeline carried no narration (a tool-only turn). */
          <div data-timeline-source={timelineSource} className="space-y-3">
            <Timeline
              nodes={timeline}
              live={live}
              workingSince={run.created_at}
              showFollowups={isLatestTurn}
            />
            {summary && !hasNarration(timeline) && <AgentAnswer summary={summary} />}
            {failed && !summary && !hasNarration(timeline) && <FailedNote />}
          </div>
        ) : (
          /* Fallback (no native frames): activity first, then the answer. One live
             indicator at a time — while narration streams it IS the indicator, so
             the working row is suppressed (the boot gap is owned by the session's
             OrbBootIndicator). Steps render through the same T3 work grammar as
             the interleaved timeline: settled work folds behind "+N previous tool
             calls"; live work tails with the T3 working indicator. */
          <div className="space-y-3">
            {narrating
              ? null
              : live
                ? activity.length > 0 && (
                    <Timeline
                      nodes={toolNodesFromSteps(activity)}
                      live
                      workingSince={run.created_at}
                    />
                  )
                : settled.length > 0 && (
                    <Timeline
                      nodes={toolNodesFromSteps(settled)}
                      live={false}
                    />
                  )}

            {summary && <AgentAnswer summary={summary} stream={wasLive && !sawNarration} />}

            {/* Answer-in-progress: the run's live tokens stream in word-by-word
                until the durable summary/markdown takes over on completion. */}
            {narrating && !summary && <LiveNarration text={liveText} />}

            {failed && !summary && <FailedNote />}

            {/* Started but nothing streamed yet: the working state (queued
                turns never reach here - they early-return as a bare user
                bubble above, per the opencode steering-queue standard). */}
            {!summary && !narrating && !failed && activity.length === 0 && status === "running" && (
              <span className="text-body-2-medium text-text-tertiary">Working...</span>
            )}
          </div>
        )}

        {/* This turn's subagents: native task fan-out (same projection as the
            Agents rail) plus gateway child sessions it spawned - one fold, real
            per-child status/model/tokens. Renders nothing when none exist. */}
        <SubagentsFold
          steps={steps}
          frames={turn.native?.nativeFrames}
          canonicalEvents={turn.canonical}
          live={live}
          childSessions={childSessions}
        />


        {/* Hover copy on the settled answer (T3 grammar). The durable summary IS
            the answer markdown even when the timeline's final narration burst
            rendered it, so one affordance covers both render paths. */}
        {!live && summary && (
          <div className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/turn:opacity-100">
            <MessageCopyButton text={summary} />
          </div>
        )}
      </div>
    </div>
  );
});

function ReplyComposer({
  engine,
  model,
  memoryScope,
  pending,
  commands,
  commandState,
  modelSelection,
  locked,
  placeholder,
  onReply,
  running,
  stopping,
  stopError,
  onStop,
  runStartedAt,
  threadError,
  onDismissThreadError,
  engineUnavailable,
  engineUnavailableMessage,
  draftKey,
  prefill,
  enableMentions,
  enableUploads,
  repoRevisions,
}: {
  engine: EngineId;
  model: string;
  memoryScope: MemoryScope;
  pending: boolean;
  commands?: SlashCommand[];
  commandState?: CommandCatalogState;
  /** The session's negotiated model-selection capability - the per-message model picker shows ONLY
   *  when the engine actually lets the user choose (opencode); ACP engines run a fixed model. */
  modelSelection?: boolean;
  locked?: boolean;
  placeholder?: string;
  onReply: ComposerSubmit;
  running?: boolean;
  stopping?: boolean;
  stopError?: string | null;
  onStop?: () => void;
  runStartedAt?: string | null;
  threadError?: string | null;
  onDismissThreadError?: () => void;
  engineUnavailable?: boolean;
  engineUnavailableMessage?: string;
  /** Thread key for per-thread draft persistence (the root run id). */
  draftKey?: string | null;
  /** Externally seed the composer (conflicted-proposal "Ask agent to redo"). */
  prefill?: { readonly text: string; readonly nonce: number } | null;
  enableMentions?: boolean;
  enableUploads?: boolean;
  repoRevisions?: Readonly<Record<string, string | null>>;
}) {
  return (
    <div className="shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
      <div className="mx-auto w-full max-w-5xl">
        <Composer
          variant="compact"
          placeholder={placeholder ?? "Reply to Agent…"}
          defaultEngine={engine}
          defaultModel={model}
          defaultMemoryScope={memoryScope}
          pending={pending}
          locked={locked}
          commands={commands} commandState={commandState}
          enableUploads={enableUploads}
          enableMentions={enableMentions}
          repoRevisions={repoRevisions}
          enableModelPicker={modelSelection === true}
          onSubmit={onReply}
          running={running}
          stopping={stopping}
          stopError={stopError}
          onStop={onStop}
          runStartedAt={runStartedAt}
          threadError={threadError}
          onDismissThreadError={onDismissThreadError}
          engineUnavailable={engineUnavailable}
          engineUnavailableMessage={engineUnavailableMessage}
          draftKey={draftKey}
          prefill={prefill}
        />
      </div>
    </div>
  );
}

/**
 * Left column of the session: the whole thread as one conversation — one
 * `TurnBlock` per run (clean user bubble + agent answer + activity) — with a
 * reply composer pinned to the bottom. A reply appears optimistically until the
 * refetched thread carries the real child run.
 *
 * Memoized: SessionView hands it memoized `turns` and useCallback handlers, so
 * unrelated SessionView state (rail width commit, tab switches, workspace
 * bookkeeping) no longer re-renders the whole timeline.
 */
export const Conversation = memo(function Conversation({
  turns,
  defaultEngine,
  defaultModel,
  defaultMemoryScope,
  pendingReply,
  commands,
  commandState,
  modelSelection,
  onReply,
  pendingQuestion,
  answeringQuestion,
  questionError,
  onAnswerQuestion,
  pendingApproval,
  answeringApproval,
  approvalError,
  onAnswerApproval,
  gatewayApprovals,
  onGatewayApprovalResolved,
  sendNowFor,
  onSendNow,
  running,
  stopping,
  stopError,
  onStop,
  runStartedAt,
  prefill,
  repoRevisions,
  onTurnsNeeded,
}: {
  turns: Turn[];
  defaultEngine: EngineId;
  defaultModel: string;
  /** The thread's current memory scope — the reply composer starts here. */
  defaultMemoryScope: MemoryScope;
  pendingReply: string | null;
  /** Engine slash commands for the reply composer's "/" autocomplete. */
  commands?: SlashCommand[];
  /** The honest command-catalog state (source + loading/unavailable/error/ready). */
  commandState?: CommandCatalogState;
  /** The session's negotiated model-selection capability (opencode true, ACP false). */
  modelSelection?: boolean;
  onReply: ComposerSubmit;
  /** A provider-native question blocks this turn until answered through its
   * control endpoint. It is not a new user message/run. */
  pendingQuestion?: PendingQuestion | null;
  answeringQuestion?: boolean;
  questionError?: string | null;
  onAnswerQuestion?: (answers: string[][]) => void | Promise<void>;
  /** A native provider permission request blocks the active T3 turn until the
   * user chooses one of T3's four approval decisions. */
  pendingApproval?: PendingApproval | null;
  answeringApproval?: boolean;
  approvalError?: string | null;
  onAnswerApproval?: (decision: ApprovalDecision) => void | Promise<void>;
  /** Gateway approvals (#77) for the thread's live runs - pending ones render
   * as Approve/Deny cards (stacked when several are pending); each card owns
   * its own optimistic resolve against /api/gateway/approvals. */
  gatewayApprovals?: readonly GatewayApproval[];
  /** Nudges the approvals fetch lane after a card resolves locally. */
  onGatewayApprovalResolved?: () => void;
  /** Run id of the HEAD queued turn when a turn is running - that bubble gets
   *  the "Send now" steering affordance (opencode's control on our harness). */
  sendNowFor?: string | null;
  onSendNow?: () => void;
  /** A turn is running - the composer send button becomes Stop while empty. */
  running?: boolean;
  stopping?: boolean;
  stopError?: string | null;
  onStop?: () => void;
  /** ISO start of the RUNNING turn (its run.created_at) - powers the composer
   *  status pill's elapsed timer. */
  runStartedAt?: string | null;
  /** Externally seed the reply composer (e.g. "Ask agent to redo" on a conflicted
   *  proposal); each request carries a fresh nonce so repeats re-apply. */
  prefill?: { readonly text: string; readonly nonce: number } | null;
  repoRevisions?: Readonly<Record<string, string | null>>;
  /** Windowed initial loading: called with the run ids of not-yet-loaded
   *  (outline stub) turns entering the render window, so their island can be
   *  fetched. Absent on fully-loaded threads. */
  onTurnsNeeded?: (runIds: readonly string[]) => void;
}) {
  // Stick-to-bottom autoscroll: follow new turns/steps/narration as they
  // stream, but ONLY while the user is already near the bottom — scrolling up
  // to read history must never be yanked back down. `stick` flips on scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const scrollSignature = turns
    .map(
      (t) =>
        `${t.steps.length}:${t.liveText.length}:${t.liveReasoning.length}:${t.summary ? 1 : 0}`,
    )
    .join("|");
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [
    scrollSignature,
    pendingReply,
    pendingQuestion?.id,
    pendingApproval?.id,
    gatewayApprovals?.length,
    turns.length,
  ]);

  const composerCanAnswerQuestion =
    pendingQuestion?.questions.length === 1 && pendingQuestion.questions[0]?.custom === true;
  const controlLocksComposer =
    !!pendingApproval || (!!pendingQuestion && !composerCanAnswerQuestion);

  // Gateway child sessions fold under their PARENT turn's subagent group - they
  // are deferred serial thread turns the agent spawned, not user messages, so
  // they never render as top-level turn blocks. Row arrays are identity-cached
  // per parent so an unchanged fold never breaks a settled TurnBlock's memo.
  const childRowsCacheRef = useRef(
    new Map<string, { source: readonly Turn[]; rows: readonly GatewayChildSession[] }>(),
  );
  const { renderedTurns, childSessionsByParent } = useMemo(() => {
    const turnIds = new Set(turns.map((t) => t.run.id));
    const grouped = new Map<string, Turn[]>();
    for (const t of turns) {
      const parentId = t.run.parent_run_id ?? null;
      if (t.run.child_session === true && parentId && turnIds.has(parentId)) {
        const list = grouped.get(parentId);
        if (list) list.push(t);
        else grouped.set(parentId, [t]);
      }
    }
    const folded = new Set([...grouped.values()].flat().map((t) => t.run.id));
    const cache = childRowsCacheRef.current;
    const next = new Map<string, { source: readonly Turn[]; rows: readonly GatewayChildSession[] }>();
    const byParent = new Map<string, readonly GatewayChildSession[]>();
    for (const [parentId, children] of grouped) {
      const cached = cache.get(parentId);
      const entry =
        cached &&
        cached.source.length === children.length &&
        cached.source.every((t, i) => t === children[i])
          ? cached
          : {
              source: children,
              rows: children.map(toGatewayChildSession),
            };
      next.set(parentId, entry);
      byParent.set(parentId, entry.rows);
    }
    childRowsCacheRef.current = next;
    return {
      renderedTurns: turns.filter((t) => !folded.has(t.run.id)),
      childSessionsByParent: byParent,
    };
  }, [turns]);

  // 1-based FIFO position per queued turn: the queued pill states the honest
  // place in line (position 1 waits only on the running turn). Counted over the
  // WHOLE serial queue - a queued gateway child ahead of a reply is real wait.
  const queuedPositions = new Map(
    turns.filter((t) => t.status === "queued").map((t, i) => [t.run.id, i + 1] as const),
  );

  // Thread-error banner: the newest FAILED run's real summary, dismissible for
  // the session (a NEW error re-appears because the key includes the message).
  // No banner while a turn is running - the live pill owns that state.
  const newestFailed = running
    ? undefined
    : [...turns].reverse().find((t) => t.status === "failed" && t.summary);
  const threadErrorKey = getThreadErrorBannerKey(
    newestFailed?.run.id ?? "",
    newestFailed?.summary ?? null,
  );
  const [, bumpDismissTick] = useState(0);
  const threadError =
    newestFailed &&
    shouldShowThreadErrorBanner(
      newestFailed.run.id,
      newestFailed.summary,
      isThreadErrorBannerDismissedForSession(threadErrorKey),
    )
      ? newestFailed.summary
      : null;
  const handleDismissThreadError = () => {
    dismissThreadErrorBannerForSession(threadErrorKey);
    bumpDismissTick((t) => t + 1);
  };

  // Provider banner: wait for the server manifest before treating the hook's
  // conservative loading fallback as evidence that an engine is unavailable.
  const engineConfig = useEnabledEngineConfig();
  const engineUnavailable =
    unavailableEngineLabel(
      defaultEngine,
      engineConfig.engines,
      engineConfig.readinessKnown,
      engineConfig.readiness,
    ) !==
    null;
  const engineUnavailableMessage = engineConfig.readiness[defaultEngine]?.ready === false
    ? engineConfig.readiness[defaultEngine]?.message
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="scrollbar-slim h-full space-y-8 overflow-y-auto px-5 py-6 [overflow-anchor:none]"
        >
          {/* Long threads render through the turn window: only turns near the
              viewport mount real DOM, the rest hold their measured height as
              placeholders, and scroll stays anchor-stabilized while rows swap.
              Short threads bypass it entirely (identical DOM to before). */}
          <TurnWindow
            turns={renderedTurns}
            scrollRef={scrollRef}
            onTurnsNeeded={onTurnsNeeded}
            renderTurn={(turn, index, windowOwnsRunMarker) => (
              <TurnBlock
                turn={turn}
                queuePosition={queuedPositions.get(turn.run.id)}
                onSendNow={turn.run.id === sendNowFor ? onSendNow : undefined}
                childSessions={childSessionsByParent.get(turn.run.id)}
                isLatestTurn={index === renderedTurns.length - 1}
                windowOwnsRunMarker={windowOwnsRunMarker}
              />
            )}
          />
          {pendingQuestion && onAnswerQuestion && (
            <QuestionCard
              key={pendingQuestion.id}
              request={pendingQuestion}
              submitting={answeringQuestion === true}
              error={questionError ?? null}
              onSubmit={onAnswerQuestion}
            />
          )}
          {pendingApproval && onAnswerApproval && (
            <NativeApprovalCard
              key={pendingApproval.id}
              request={pendingApproval}
              submitting={answeringApproval === true}
              error={approvalError ?? null}
              onRespond={onAnswerApproval}
            />
          )}
          {gatewayApprovals?.map((approval) => (
            <GatewayApprovalCard
              key={approval.id}
              approval={approval}
              onResolved={onGatewayApprovalResolved}
            />
          ))}
          {pendingReply && <UserBubble>{pendingReply}</UserBubble>}
        </div>
        <MessageScrollerRail turns={renderedTurns} scrollRef={scrollRef} />
        <ScrollToEndPill scrollRef={scrollRef} />
      </div>

      <ReplyComposer
        engine={defaultEngine}
        model={defaultModel}
        memoryScope={defaultMemoryScope}
        pending={pendingReply !== null}
        commands={commands}
        commandState={commandState}
        modelSelection={modelSelection}
        locked={controlLocksComposer}
        placeholder={
          pendingApproval
            ? "Respond to the approval above to continue…"
            : pendingQuestion
              ? composerCanAnswerQuestion
                ? "Answer Agent’s question…"
                : "Answer the question above to continue…"
              : undefined
        }
        onReply={onReply}
        running={running}
        stopping={stopping}
        stopError={stopError}
        onStop={onStop}
        runStartedAt={runStartedAt}
        threadError={threadError}
        onDismissThreadError={handleDismissThreadError}
        engineUnavailable={engineUnavailable}
        engineUnavailableMessage={engineUnavailableMessage}
        draftKey={turns[0]?.run.id ?? null}
        prefill={prefill}
        enableMentions={composerAcceptsRunResources(pendingQuestion ?? null)}
        enableUploads={composerAcceptsRunResources(pendingQuestion ?? null)}
        repoRevisions={repoRevisions}
      />
    </div>
  );
});
