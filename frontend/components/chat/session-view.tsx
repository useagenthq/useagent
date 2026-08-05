"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  RiAddLine,
  RiCodeSSlashLine,
  RiLayoutRightLine,
  RiTerminalBoxLine,
} from "@remixicon/react";
import { backendFetch } from "@/lib/backend-fetch";
import { cnExt as cn } from "@/utils/cn";
import * as SegmentedControl from "@/components/ui/segmented-control";
import { Conversation, type Turn } from "@/components/chat/conversation";
import { EditorPane } from "@/components/chat/editor-pane";
import { TerminalPane } from "@/components/chat/terminal-pane";
import { OrbBootIndicator } from "@/components/chat/orb-boot-indicator";
import { useRunStream } from "@/components/chat/use-run-stream";
import { SubagentChips } from "@/components/chat/subagent-pane";
import {
  normalizeEngine,
  parseFileEntries,
  toThread,
  type ApiRun,
  type EngineId,
  type RunStatus,
} from "@/components/chat/types";

function StatusPill({ status }: { status: RunStatus }) {
  const live = status === "queued" || status === "running";
  const map: Record<RunStatus, string> = {
    queued: "bg-blue-50 text-blue-500",
    running: "bg-blue-50 text-blue-500",
    completed: "bg-green-50 text-green-600",
    failed: "bg-red-50 text-red-600",
  };
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-label-xs capitalize",
        map[status],
      )}
    >
      {live && (
        <span className="ai-loading-pixel size-1.5 rounded-full bg-blue-500" />
      )}
      {status}
    </span>
  );
}

/**
 * The coding-session surface: a threaded conversation column beside a vertical
 * editor|terminal split. The whole thread renders as one conversation; a single
 * SSE subscription (`useRunStream`) watches the *newest* run and overrides its
 * static snapshot live. All runs' steps feed the editor tabs (files touched) and
 * the terminal (commands). A reply starts a child run in the same thread and we
 * refetch in place — never navigating away.
 */
export function SessionView({ initialThread }: { initialThread: ApiRun[] }) {
  const [thread, setThread] = useState(initialThread);
  const [pendingReply, setPendingReply] = useState<string | null>(null);

  const newest = thread[thread.length - 1];
  const rootId = thread[0].id;
  const stream = useRunStream(newest);

  // Newest run's live stream overrides its thread snapshot; older runs are
  // settled history.
  const turns: Turn[] = thread.map((run) =>
    run.id === newest.id
      ? {
          run,
          steps: stream.steps,
          status: stream.status,
          summary: stream.summary,
          live: stream.live,
        }
      : {
          run,
          steps: run.steps,
          status: run.status,
          summary: run.summary,
          live: false,
        },
  );
  const allSteps = turns.flatMap((t) => t.steps);
  const live = stream.live;
  // Boot window: run accepted but no activity has streamed yet — the orb stands
  // in until the first step arrives, then the Thinking disclosure takes over.
  const booting = live && !stream.steps.some((s) => s.kind !== "done");

  const refetchThread = useCallback(async () => {
    try {
      const res = await backendFetch(`/api/runs/${rootId}?thread=1`);
      if (res.ok) {
        const next = toThread(await res.json());
        if (next.length) setThread(next);
      }
    } catch {
      // keep the current thread on a transient failure
    } finally {
      setPendingReply(null);
    }
  }, [rootId]);

  const handleReply = useCallback(
    async (text: string, engine: EngineId) => {
      setPendingReply(text);
      try {
        const res = await backendFetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: text,
            engine,
            parent_run_id: newest.id,
          }),
        });
        if (!res.ok) throw new Error(`backend ${res.status}`);
        // Child run lives in this thread — pull it in and keep streaming here
        // instead of navigating to a fresh session.
        await refetchThread();
      } catch {
        setPendingReply(null);
      }
    },
    [newest.id, refetchThread],
  );

  // Right rail: ONE tabbed panel (Editor | Terminal), not stacked panes. It only
  // claims width when there's REAL content (parseable file edits or command
  // output); empty panes never steal space from the conversation. The user can
  // still collapse / reopen and switch tabs; auto state applies until they do.
  const hasFiles = allSteps.some(
    (s) => s.kind === "file" && parseFileEntries(s).length > 0,
  );
  const hasCommands = allSteps.some((s) => s.kind === "command");
  const hasRailContent = hasFiles || hasCommands;
  const [railOverride, setRailOverride] = useState<boolean | null>(null);
  const railOpen = railOverride ?? hasRailContent;
  // Default to whichever pane actually has content; an explicit pick wins.
  const [railTabOverride, setRailTabOverride] = useState<
    "editor" | "terminal" | null
  >(null);
  const railTab =
    railTabOverride ?? (hasFiles ? "editor" : hasCommands ? "terminal" : "editor");

  return (
    <div className="flex h-full flex-col">
      {/* Compact session bar — the shell's TopNav + AgentSidebar (⌘K included)
          wrap this view, so the brand/search chrome lives there now. */}
      <div className="border-stroke-soft-200 bg-bg-white-0 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
        <span className="text-mono-label text-text-soft-400">Session</span>
        <div className="flex items-center gap-3">
          <StatusPill status={stream.status} />
          <Link
            href="/agent/new"
            className="border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-label-xs transition-colors"
          >
            <RiAddLine className="size-4" aria-hidden />
            New session
          </Link>
        </div>
      </div>

      {/* Fan-out subagents in this thread that aren't on the main reply line —
          each opens in the temporary viewing pane. Empty until threading lands. */}
      <SubagentChips rootId={rootId} excludeIds={thread.map((r) => r.id)} />

      {/* Body: the conversation is the dominant surface (~68% when the rail is
          open, everything when it's collapsed); the right rail is ONE tabbed
          Editor|Terminal panel. ONE live indicator at a time: the boot gap is the
          orb below, and once steps stream the conversation's Thinking block takes
          over — the old floating WorkingPill duplicate is gone. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        {/* Conversation */}
        <section className="border-stroke-soft-200 bg-bg-white-0 relative flex min-h-[60vh] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border lg:min-h-0">
          <Conversation
            turns={turns}
            defaultEngine={normalizeEngine(newest.engine)}
            pendingReply={pendingReply}
            onReply={handleReply}
          />
          {/* Boot phase: engine spinning up, no steps yet — orb pill; clears the
              moment the first step streams in (Thinking block takes over). */}
          {booting && (
            <div className="animate-ai-fade-up pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center">
              <OrbBootIndicator engine={newest.engine} status={stream.status} />
            </div>
          )}
        </section>

        {railOpen ? (
          // ONE bordered panel: the Editor|Terminal switcher + collapse live in
          // its header; the active pane fills the body bare (its own border/round
          // is dropped so this panel owns the single card edge).
          <section className="border-stroke-soft-200 bg-bg-white-0 flex min-h-[50vh] min-w-0 flex-col overflow-hidden rounded-2xl border lg:min-h-0 lg:w-[32%] lg:shrink-0">
            <div className="border-stroke-soft-200 flex shrink-0 items-center gap-2 border-b p-2">
              <SegmentedControl.Root
                className="flex-1"
                value={railTab}
                onValueChange={(v) => setRailTabOverride(v as "editor" | "terminal")}
              >
                <SegmentedControl.List>
                  <SegmentedControl.Trigger value="editor">
                    <RiCodeSSlashLine className="size-4" aria-hidden />
                    Editor
                  </SegmentedControl.Trigger>
                  <SegmentedControl.Trigger value="terminal">
                    <RiTerminalBoxLine className="size-4" aria-hidden />
                    Terminal
                  </SegmentedControl.Trigger>
                </SegmentedControl.List>
              </SegmentedControl.Root>
              <button
                type="button"
                onClick={() => setRailOverride(false)}
                title="Collapse panel"
                aria-label="Collapse the editor/terminal panel"
                className="text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-sub-600 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
              >
                <RiLayoutRightLine className="size-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {railTab === "editor" ? (
                <EditorPane steps={allSteps} live={live} />
              ) : (
                <TerminalPane steps={allSteps} live={live} engine={newest.engine} />
              )}
            </div>
          </section>
        ) : (
          <button
            type="button"
            onClick={() => setRailOverride(true)}
            title="Open the editor/terminal panel"
            aria-label="Open the editor/terminal panel"
            className="border-stroke-soft-200 bg-bg-white-0 text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-sub-600 hidden shrink-0 flex-col items-center gap-3 rounded-2xl border px-2 py-4 transition-colors lg:flex"
          >
            <RiCodeSSlashLine className="size-4" aria-hidden />
            <RiTerminalBoxLine className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
