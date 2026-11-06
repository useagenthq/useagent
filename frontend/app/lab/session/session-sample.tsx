"use client";

// /lab/session - a single synthetic session rendered through the REAL live chat
// renderers, so every canonical timeline + session-chrome type can be reviewed in
// one believable conversation. This file wires fixtures (./session-sample-data) to
// the exact components the live session page uses - it never reimplements one.
//
// The conversation itself is the real `Timeline` (the lowest component that renders
// a canonical timeline) wrapped in the real UserBubble / AssistantTurnHeader / copy
// button. Types that never mount as a conversation timeline event (git chips, the
// changed-files card, the diff surface, banners, child-agent rows, the proposed
// plan / plan card) are shown in a clearly labelled "Adjacent surfaces" strip.

import { RiAttachment2, RiExternalLinkLine } from "@remixicon/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PlanChecklist } from "@/components/agent-ui/plan-checklist";
import { ComposerPrefillProvider } from "@/components/chat/composer-prefill-context";
import {
  AgentAnswer,
  AssistantTurnHeader,
  Timeline,
  UserBubble,
} from "@/components/chat/conversation";
import { FollowUpRows } from "@/components/chat/follow-up-rows";
import { ChatTabStrip } from "@/components/chat/chat-tabs";
import { ReplyComposer } from "@/components/chat/reply-composer";
import { type RunUpload, uploadNotice } from "@/components/chat/run-uploads";
import { SubagentRow } from "@/components/chat/subagent-row";
import { SessionDetailsRail } from "@/components/chat/session-details-rail";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { ComposerAttachmentRow, ComposerUploadNotice } from "@/components/pro/composer-attachments";
import { ComposerStatusBar } from "@/components/pro/composer-status-bar";
import { RunningFooter } from "@/components/pro/running-footer";
import { UsageCard } from "@/components/pro/usage-card";
import { PermissionModeChip } from "@/components/pro/permission-mode-chip";
import { AgentPanelRow } from "@/components/session-ui/agent-panel-row";
import { BackgroundStatusPill } from "@/components/session-ui/background-status-pill";
import { ChangedFilesCard } from "@/components/session-ui/changed-files-tree";
import { ContextWindowMeter } from "@/components/session-ui/context-window-meter";
import { FileDiffView, filePatchesFromSteps } from "@/components/session-ui/file-diff-view";
import { GitChips } from "@/components/session-ui/git-chip";
import { MessageCopyButton } from "@/components/session-ui/message-copy-button";
import { MessageScrollerRail } from "@/components/session-ui/message-scroller-rail";
import { ProposedPlanCard } from "@/components/session-ui/proposed-plan-card";
import { ProviderStatusBanner } from "@/components/session-ui/provider-status-banner";
import { QueuedMessagePill } from "@/components/session-ui/queued-message-pill";
import { ScrollToEndPill } from "@/components/session-ui/scroll-to-end-pill";
import { SyncStatusPill } from "@/components/session-ui/sync-status-pill";
import {
  isUserStopSummary,
  ThreadErrorBanner,
} from "@/components/session-ui/thread-error-banner";
import { ProjectThreadList } from "@/components/session-ui/project-thread-tree";
import { WorkedForFold } from "@/components/session-ui/worked-for-fold";
import { type BookmarkRow, BookmarksSection } from "@/components/shell/sidebar-bookmarks";
import { cx } from "@/utils/cx";
import { LongThreadSample } from "./long-thread-sample";
import {
  agentRows,
  changedFiles,
  changeSetSteps,
  conversation,
  planEntries,
  planTodoStep,
  PROPOSED_PLAN_MARKDOWN,
  sampleUploads,
  type SampleTurn,
  subagentRows,
  THREAD_ERROR_SUMMARY,
  USER_STOP_SUMMARY,
} from "./session-sample-data";
import {
  detailsTurns,
  sampleBookmarks,
  sampleRun,
  sampleTabs,
  sampleThreads,
} from "./shell-panels-data";

/** Left-rail index: every covered type, linked to where it renders. */
const INDEX: readonly { label: string; href: string }[] = [
  { label: "User message + attachment", href: "#turn-1" },
  { label: "Work log pill (Worked · counts · duration)", href: "#turn-1" },
  { label: "Context recall fold (skill / memory / knowledge)", href: "#turn-1" },
  { label: "Reasoning / thinking fold", href: "#turn-1" },
  { label: "Tool rows (Run / List / Error chip / durations)", href: "#turn-1" },
  { label: "File edit with line diff", href: "#turn-1" },
  { label: "File receipt row", href: "#turn-1" },
  { label: "Memory write chip", href: "#turn-1" },
  { label: "Assistant markdown answer", href: "#turn-1" },
  { label: "Artifact card (image, below answer)", href: "#turn-1" },
  { label: "Subagent / github / computer-use rows", href: "#turn-2" },
  { label: "Artifact media + Slack delivery", href: "#turn-2" },
  { label: "Message copy button", href: "#turn-2" },
  { label: "Reconcile marker + working indicator (live)", href: "#turn-3" },
  { label: "Queued-message pill", href: "#turn-4" },
  { label: "Message scroller rail", href: "#conversation" },
  { label: "Session chrome (git chips, context meter)", href: "#chrome" },
  { label: "Status + background pills", href: "#chrome" },
  { label: "Provider + thread-error banners", href: "#banners" },
  { label: "Worked-for fold (all row families)", href: "#work-families" },
  { label: "Plan / todo card (mixed states)", href: "#plan" },
  { label: "Proposed-plan card", href: "#proposed-plan" },
  { label: "Changed-files card + tree", href: "#changed-files" },
  { label: "File-diff view (hunks)", href: "#file-diff" },
  { label: "Child-agent panel rows", href: "#agents" },
  { label: "Subagent rows (one line folded, tool rows + Summary open)", href: "#subagents" },
  { label: "Shell panels (Details rail, chat tabs, Bookmarks)", href: "#shell-panels" },
  { label: "Composer attachments", href: "#uploads" },
  { label: "Follow-ups + sources (closing turn grammar)", href: "#conversation" },
  { label: "Long thread (windowed rendering)", href: "#long-thread" },
];

function AttachmentChip({ name }: { name: string }) {
  return (
    <div className="flex justify-end">
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-button-default bg-background-secondary-default px-2 py-1 text-caption-1-medium text-text-secondary">
        <RiAttachment2 className="size-3.5 text-text-tertiary" aria-hidden />
        {name}
        <span className="text-text-tertiary">attached</span>
      </span>
    </div>
  );
}

function TurnView({
  turn,
  live,
  workingSince,
  sendNow,
  showFollowups,
}: {
  turn: SampleTurn;
  live: boolean;
  workingSince?: string;
  sendNow?: () => void;
  /** Sample stand-in for the product's latest-turn gating. */
  showFollowups?: boolean;
}) {
  return (
    <div
      id={turn.id}
      data-run-id={turn.id}
      data-testid="turn-block"
      className="scroll-mt-6 space-y-4"
    >
      <UserBubble>{turn.prompt}</UserBubble>
      {turn.attachment && <AttachmentChip name={turn.attachment} />}

      {turn.status === "queued" ? (
        <QueuedMessagePill position={turn.queuePosition ?? 1} onSendNow={sendNow} />
      ) : (
        <div className="group/turn space-y-3">
          <AssistantTurnHeader engine={turn.engine} />
          <Timeline
            nodes={turn.nodes}
            live={live}
            workingSince={workingSince}
            showFollowups={showFollowups}
          />
          {turn.answer && !live && (
            <div className="flex items-center gap-2">
              <MessageCopyButton text={turn.answer} />
              <span className="text-caption-1-medium text-text-tertiary">Copy answer</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Surface({
  id,
  title,
  owner,
  children,
}: {
  id: string;
  title: string;
  owner: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3 border-t border-border-button-default pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-body-medium text-text-primary">{title}</h3>
        <code className="text-mono-label text-text-tertiary">{owner}</code>
      </div>
      {children}
    </section>
  );
}

export function SessionSample() {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Time-relative surfaces (live working indicator, background pill elapsed) render
  // ONLY after mount so the server HTML and first client render agree - no hydration
  // mismatch, and the live state animates in a beat after load.
  const [mounted, setMounted] = useState(false);
  const [liveStartedAt, setLiveStartedAt] = useState<string | null>(null);
  const [uploads, setUploads] = useState<readonly RunUpload[]>(sampleUploads);
  // What the composer WOULD receive from a follow-up pick in the conversation;
  // the lab has no live composer, so the handoff renders as a preview box.
  const [proposedPrefill, setProposedPrefill] = useState<string | null>(null);
  // The lab's Bookmarks keep their pins in state, so a rail row dragged (or
  // pinned) onto the section really lands there and unpins from it.
  const [pins, setPins] = useState<readonly BookmarkRow[]>(sampleBookmarks);
  const pinChat = (id: string) =>
    setPins((current) => {
      const row = sampleThreads.find((thread) => thread.id === id);
      if (!row || current.some((pin) => pin.id === id)) return current;
      return [...current, { id, title: row.label, href: `#${id}` }];
    });
  useEffect(() => {
    setMounted(true);
    setLiveStartedAt(new Date(Date.now() - 48_000).toISOString());
  }, []);

  const scrollerTurns = conversation.map((t) => ({ run: { id: t.id, prompt: t.prompt } }));
  // Every settled tool row family in one expanded fold, drawn from the real turns.
  const workFamilyNodes = [...conversation[0].nodes, ...conversation[1].nodes].filter(
    (node) => node.kind === "tool",
  );
  const diffPatches = filePatchesFromSteps(changeSetSteps);

  return (
    <main data-testid="session-sample" className="min-h-full bg-background-primary-default">
      <header className="relative overflow-hidden border-b border-border-button-default">
        <div className="bg-halftone pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto flex max-w-6xl flex-col gap-1 px-6 py-10">
          <div className="flex items-center gap-2">
            <Link
              href="/lab"
              className="text-mono-label text-text-tertiary hover:text-text-secondary"
            >
              Component lab
            </Link>
            <span className="text-text-disabled">/</span>
            <span className="text-mono-label text-text-tertiary">Session sample</span>
          </div>
          <h1 className="text-title-1-medium text-text-primary">Session sample</h1>
          <p className="max-w-3xl text-body-regular text-text-secondary">
            One synthetic session rendered through the real chat timeline and session
            chrome - every canonical event and adjacent surface in one believable
            conversation, for visual review. Nothing here reimplements a renderer; it
            only feeds the live ones.
          </p>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-6 py-8">
        {/* Left index */}
        <nav
          aria-label="Covered types"
          className="sticky top-6 hidden h-fit w-56 shrink-0 flex-col gap-1 lg:flex"
        >
          <p className="text-mono-label text-text-tertiary pb-1">Covered types</p>
          {INDEX.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="rounded-md px-2 py-1 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-secondary-default hover:text-text-primary"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-8">
          {/* Session bar chrome */}
          <Surface
            id="chrome"
            title="Session bar chrome"
            owner="git-chip · context-window-meter · sync/background pills"
          >
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-button-default bg-background-primary-default px-4 py-2.5">
              <span className="text-mono-label text-text-tertiary">Session</span>
              <GitChips
                refs={[
                  { repo: "useagent/gateway", branch: "main" },
                  { repo: "useagent/infra", branch: "rl-staging" },
                ]}
              />
              <div className="ml-auto flex items-center gap-2">
                <SyncStatusPill label="Synced" />
                <ContextWindowMeter
                  usage={{
                    usedTokens: 82_000,
                    maxTokens: 200_000,
                    totalProcessedTokens: 240_000,
                    compactsAutomatically: true,
                  }}
                  providerDisplayName="OpenCode"
                />
              </div>
            </div>
            {mounted && liveStartedAt && (
              <BackgroundStatusPill
                label="Deploying to staging"
                startedAt={liveStartedAt}
                onStop={() => {}}
              />
            )}
          </Surface>

          {/* The believable conversation */}
          <section id="conversation" className="scroll-mt-6">
            {/* The lab has no live composer: follow-up picks land in the
                "composer would receive" preview box below the conversation. */}
            <ComposerPrefillProvider value={setProposedPrefill}>
            <div className="relative">
              <div
                ref={scrollRef}
                className="scrollbar-slim max-h-[76vh] space-y-8 overflow-y-auto rounded-2xl border border-border-button-default bg-background-primary-default px-5 py-6"
              >
                {conversation.map((turn) => {
                  const live = mounted && turn.live;
                  return (
                    <TurnView
                      key={turn.id}
                      turn={turn}
                      live={live}
                      workingSince={live ? (liveStartedAt ?? undefined) : undefined}
                      sendNow={turn.status === "queued" ? () => {} : undefined}
                      // turn-2 stands in for the product's latest settled turn.
                      showFollowups={turn.id === "turn-2"}
                    />
                  );
                })}
              </div>
              <MessageScrollerRail turns={scrollerTurns} scrollRef={scrollRef} />
              <ScrollToEndPill scrollRef={scrollRef} />
            </div>
            </ComposerPrefillProvider>
            {proposedPrefill !== null && (
              <div className="mt-3 rounded-lg border border-border-button-default bg-background-secondary-default px-3 py-2">
                <span className="text-mono-label text-text-tertiary">composer would receive</span>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-caption-1-regular text-text-secondary">
                  {proposedPrefill}
                </pre>
              </div>
            )}
          </section>

          <div className="space-y-8">
            <p className="text-mono-label text-text-tertiary">
              Adjacent surfaces - session chrome + rails that render OUTSIDE the
              conversation timeline
            </p>

            <Surface
              id="banners"
              title="Banners"
              owner="provider-status-banner · thread-error-banner"
            >
              <ProviderStatusBanner engineLabel="Codex" onDismiss={() => {}} />
              <ThreadErrorBanner error={THREAD_ERROR_SUMMARY} onDismiss={() => {}} />
              <p className="text-caption-1-regular text-text-tertiary">
                A deliberate user stop settles the run as &ldquo;{USER_STOP_SUMMARY}&rdquo;
                and the error banner is intentionally suppressed (isUserStopSummary =
                {" "}
                {String(isUserStopSummary(USER_STOP_SUMMARY))}) - a stop is a neutral
                outcome, never an alarm.
              </p>
            </Surface>

            <Surface
              id="work-families"
              title="Worked-for fold - every tool row family, expanded"
              owner="worked-for-fold · work-entry-row"
            >
              <WorkedForFold nodes={workFamilyNodes} defaultExpanded />
            </Surface>

            <Surface
              id="plan"
              title="Plan / todo card (mixed states)"
              owner="plan-checklist via tool-step-row (Agents / subagent activity)"
            >
              <p className="text-caption-1-regular text-text-tertiary">
                A plan is a folded pill in the same grammar as the Thinking header, in the
                conversation and in the Agents rail alike (ToolStepRow renders the same
                PlanChecklist). Both entry points shown.
              </p>
              <ToolStepRow step={planTodoStep} state="running" />
              <PlanChecklist title="Implementation plan" entries={planEntries} />
            </Surface>

            <Surface
              id="proposed-plan"
              title="Proposed-plan card"
              owner="proposed-plan-card"
            >
              <ProposedPlanCard
                planMarkdown={PROPOSED_PLAN_MARKDOWN}
                onImplement={() => {}}
              />
            </Surface>

            <Surface
              id="changed-files"
              title="Changed-files card + tree"
              owner="changed-files-tree"
            >
              <ChangedFilesCard files={changedFiles} defaultExpanded onOpenFile={() => {}} />
            </Surface>

            <Surface
              id="file-diff"
              title="File-diff view (recovered hunks)"
              owner="file-diff-view"
            >
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default">
                <FileDiffView files={changedFiles} patches={diffPatches} />
              </div>
            </Surface>

            <Surface
              id="agents"
              title="Child-agent panel rows"
              owner="agent-panel-row (Agents rail)"
            >
              <div className="space-y-2">
                {agentRows.map((agent) => (
                  <AgentPanelRow key={agent.title} agent={agent} onOpen={() => {}} />
                ))}
              </div>
            </Surface>

            <Surface
              id="subagents"
              title="Subagent rows - one line folded, tool rows + Summary open"
              owner="subagent-row (subagents-fold)"
            >
              <p className="text-caption-1-regular text-text-tertiary">
                A settled subagent is one line: its name, role and how long it ran.
                Opened, its own tool rows carry the durations the engine reported and
                its result sits in a Summary card behind More. Both come from the same
                children projection the conversation fold reads.
              </p>
              <ul className="space-y-px">
                {subagentRows.map((row, index) => (
                  <SubagentRow
                    key={row.card.id}
                    card={row.card}
                    fidelity={row.fidelity}
                    steps={row.steps}
                    runLive={false}
                    defaultOpen={index === 0}
                  />
                ))}
              </ul>
            </Surface>

            <Surface
              id="shell-panels"
              title="Shell panels - chat tabs, Bookmarks, the Details rail"
              owner="chat-tabs · sidebar-bookmarks · session-details-rail"
            >
              <p className="text-caption-1-regular text-text-tertiary">
                The chat tabs sit across the top of the transcript (the open chats, the
                current one selected); Bookmarks is the rail section a chat row drops
                onto; the Details rail is the surface with Environment, Task plan and
                Usage, every value read from the run rows and the usage frames the thread
                already holds.
              </p>
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default">
                <ChatTabStrip tabs={sampleTabs} activeId="turn-2" onClose={() => {}} />
              </div>
              <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
                <div className="rounded-2xl border border-border-button-default bg-sidebar p-2">
                  <BookmarksSection
                    rows={pins}
                    activeHref="#turn-1"
                    onPin={pinChat}
                    onUnpin={(id) => setPins((current) => current.filter((pin) => pin.id !== id))}
                  />
                  <p className="text-mono-label px-2.5 pb-1 pt-3 text-text-tertiary">Threads</p>
                  <ProjectThreadList
                    threads={sampleThreads}
                    threadHref={(thread) => `#${thread.id}`}
                    ariaLabel="Sample threads"
                    onPinThread={pinChat}
                  />
                </div>
                <div className="h-[34rem] overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default">
                  <SessionDetailsRail root={sampleRun} newest={sampleRun} turns={detailsTurns} />
                </div>
              </div>
            </Surface>

            <Surface
              id="uploads"
              title="Composer attachments"
              owner="composer-attachments (ComposerAttachmentRow)"
            >
              <p className="text-caption-1-regular text-text-tertiary">
                Picked, dropped or pasted files sit above the prompt as tiles: an image
                shows its thumbnail, any other file its typed icon over the name, each
                with a remove mark. Past eight, the rest fold behind a count. A failed
                file says why under the tiles, and that removing it frees Send. Image
                content itself renders as an artifact card (with a click-to-expand
                lightbox) in the conversation above.
              </p>
              <div className="rounded-xl border border-border-button-default bg-background-primary-default">
                <ComposerAttachmentRow
                  uploads={uploads}
                  onRemove={(u) =>
                    setUploads((current) => current.filter((item) => item.localId !== u.localId))
                  }
                  className="p-3"
                />
                <ComposerUploadNotice notice={uploadNotice(uploads, 0)} className="px-3 pb-3" />
              </div>
              <a
                href="#turn-1"
                className="inline-flex items-center gap-1 text-caption-1-medium text-accent-500 hover:underline"
              >
                <RiExternalLinkLine className="size-3.5" aria-hidden />
                Jump to the image artifact + lightbox in turn 1
              </a>
            </Surface>

            <Surface
              id="composer-status"
              title="Reply composer with its status tray"
              owner="reply-composer · composer-status-bar"
            >
              <p className="text-caption-1-regular text-text-tertiary">
                The status tray hangs under the card: where the run executes, then
                the branch and the project, with the engine, the spend and the
                context meter at the right. The round add button at the left of the
                footer opens the attach menu.
              </p>
              <div
                data-testid="composer-status-sample"
                className="rounded-2xl border border-border-button-default bg-background-primary-default"
              >
                <ReplyComposer
                  engine="codex"
                  model="gpt-5.6-sol"
                  memoryScope="org"
                  pending={false}
                  enableUploads
                  onReply={() => {}}
                  permission={
                    <PermissionModeChip mode="approval-required" onChange={() => {}} engine="codex" />
                  }
                  status={
                    <ComposerStatusBar
                      run={{ sandbox_id: "sbx-7f3a", sandbox_provider: "daytona" }}
                      branch="rl-staging"
                      project="gateway"
                      agent="Codex"
                      context={{ used: 92_400, cached: 61_000, window: 200_000, input: 29_800, output: 1_420, reasoning: 0, cacheWrite: 180 }}
                      spend={{ spent: 12.34, allowance: 100, runs: 3 }}
                    />
                  }
                />
              </div>
            </Surface>

            <Surface
              id="composer-running"
              title="Reply composer while a run is in flight"
              owner="reply-composer · running-footer · composer-status-bar"
            >
              <p className="text-caption-1-regular text-text-tertiary">
                The running footer sits above the card and the send action reads Queue;
                the status tray stays where it is under the card.
              </p>
              <div
                data-testid="composer-running-sample"
                className="rounded-2xl border border-border-button-default bg-background-primary-default"
              >
                <ReplyComposer
                  engine="codex"
                  model="gpt-5.6-sol"
                  memoryScope="org"
                  pending={false}
                  enableUploads
                  running
                  onStop={() => {}}
                  runStartedAt={new Date(Date.now() - 84_000).toISOString()}
                  onReply={() => {}}
                  permission={
                    <PermissionModeChip mode="approval-required" onChange={() => {}} engine="codex" />
                  }
                  lead={
                    <RunningFooter
                      status={{ phase: "working", label: "Working", sentence: "Editing gateway/routes.ts", toolCalls: 7, agentsRunning: 0, agentsDone: 1 }}
                      model="GPT-5.6 Sol"
                      startedAt={new Date(Date.now() - 84_000).toISOString()}
                      onStop={() => {}}
                    />
                  }
                  status={
                    <ComposerStatusBar
                      run={{ sandbox_id: "sbx-7f3a", sandbox_provider: "daytona" }}
                      branch="rl-staging"
                      project="gateway"
                      agent="Codex"
                      context={{ used: 92_400, cached: 61_000, window: 200_000, input: 29_800, output: 1_420, reasoning: 0, cacheWrite: 180 }}
                      spend={{ spent: 12.34, allowance: 100, runs: 3 }}
                    />
                  }
                />
              </div>
            </Surface>
          </div>

          {/* The status tab's context popover as the reference's usage card, with
              the member's figures supplied so every row shows here. */}
          <Surface id="usage-card" title="Usage card (the context ring's popover)" owner="usage-card · agent-limits-card">
            <p className="text-caption-1-regular text-text-tertiary">
              The context window over the buckets the runtime's usage frames carry, expandable
              to the breakdown; under it the member's usage limits, sandbox minutes and spend,
              with a bar while a cap is set and no reset line. On a runtime that reports no
              window the card shows the token readout alone.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div
                data-testid="usage-card-sample"
                className="w-[320px] max-w-full rounded-2xl border border-border-button-default bg-background-primary-default"
              >
                <UsageCard
                  context={{ used: 92_400, cached: 61_000, window: 200_000, input: 29_800, output: 1_420, reasoning: 0, cacheWrite: 180 }}
                  minutes={{ used: 12, cap: 600 }}
                  spend={{ spent: 12.34, allowance: 100, runs: 3 }}
                  onCompact={() => {}}
                />
              </div>
              <div
                data-testid="usage-card-sample-no-window"
                className="w-[320px] max-w-full rounded-2xl border border-border-button-default bg-background-primary-default"
              >
                <UsageCard
                  context={{ used: 92_400, cached: 61_000, window: null, input: 29_800, output: 1_420 }}
                  minutes={{ used: 12, cap: null }}
                  spend={{ spent: 5, allowance: null, runs: 1 }}
                />
              </div>
            </div>
          </Surface>

          {/* A settled markdown answer rendered on its own, so the AgentAnswer
              summary path (used when a turn carries no narration) is also visible. */}
          <Surface
            id="answer"
            title="Settled markdown answer (summary path)"
            owner="conversation AgentAnswer"
          >
            <AgentAnswer summary={conversation[0].answer ?? ""} />
          </Surface>

          {/* The real Conversation fed 80 settled turns - past the short-thread
              bypass, so off-viewport turns hold their height as placeholders and
              scrolling stays anchor-stable while rows materialize. */}
          <Surface
            id="long-thread"
            title="Long thread (windowed rendering)"
            owner="conversation TurnWindow"
          >
            <p className="text-caption-1-regular text-text-tertiary">
              80 synthetic settled turns through the production Conversation. Only
              turns near the viewport mount real DOM; scroll to watch placeholders
              materialize without the visible line moving.
            </p>
            <LongThreadSample />
          </Surface>

        </div>
      </div>
    </main>
  );
}
