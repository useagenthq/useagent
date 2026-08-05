"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  RiAddLine,
  RiCodeSSlashLine,
  RiComputerLine,
  RiLayoutRightLine,
  RiRobot2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import { backendFetch } from "@/lib/backend-fetch";
import { cnExt as cn } from "@/utils/cn";
import * as SegmentedControl from "@/components/ui/segmented-control";
import { Conversation, type Turn } from "@/components/chat/conversation";
import type { SlashCommand } from "@/components/chat/slash-command";
import { AgentsRail } from "@/components/chat/agents-rail";
import { EditorPane } from "@/components/chat/editor-pane";
import { DesktopPane } from "@/components/chat/desktop-pane";
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

/** Narrowest useful rail — keeps the terminal/desktop panes workable. */
const RAIL_MIN = 280;

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
          liveText: stream.liveText,
        }
      : {
          run,
          steps: run.steps,
          status: run.status,
          summary: run.summary,
          live: false,
          liveText: "",
        },
  );
  const allSteps = turns.flatMap((t) => t.steps);
  const live = stream.live;
  // Boot window: run accepted but nothing has streamed yet — the orb stands in
  // until the first narration token OR step arrives, then the conversation's live
  // narration / Thinking disclosure takes over (keeps one live indicator at a time).
  const booting =
    live &&
    !stream.liveText &&
    !stream.steps.some((s) => s.kind !== "done");

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

  // Refetch the thread whenever the streamed run reaches a terminal state —
  // run-level fields written during the turn (engine_session_id → the Live
  // tab's deep-link, summary) only travel via thread fetches, and without this
  // a FRESH session never learns them until a reply or a page reload.
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !stream.live) void refetchThread();
    wasLive.current = stream.live;
  }, [stream.live, refetchThread]);

  const handleReply = useCallback(
    async (text: string, engine: EngineId, model: string, idempotencyKey: string) => {
      setPendingReply(text);
      try {
        const res = await backendFetch("/api/runs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // A lost-response retry with the same key observes the original run
            // instead of starting a duplicate turn (backend durable command).
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            prompt: text,
            engine,
            model,
            parent_run_id: newest.id,
          }),
        });
        if (!res.ok) throw new Error(`backend ${res.status}`);
        // Child run lives in this thread — pull it in and keep streaming here
        // instead of navigating to a fresh session.
        await refetchThread();
      } catch (err) {
        // Don't swallow: clear the optimistic bubble and re-throw so the composer
        // restores the draft and shows an explicit retry state.
        setPendingReply(null);
        throw err;
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
  const hasSubagents = allSteps.some((s) => s.chip === "subagent");
  const hasRailContent = hasFiles || hasCommands || hasSubagents;
  // opencode threads carry a live resident server in their sandbox — offer its
  // own web UI as a "Live" tab (opt-in: the heavy iframe mounts only when picked).
  const isOpencode = thread.some((r) => normalizeEngine(r.engine) === "opencode");
  // The engine's own session id for this thread — the LATEST non-null across its
  // runs (oldest→newest, so `findLast`). Lets the Live tab open straight into the
  // conversation's opencode session instead of the app's home screen.
  const engineSessionId =
    thread.findLast((r) => r.engine_session_id)?.engine_session_id ?? null;
  const [railOverride, setRailOverride] = useState<boolean | null>(null);
  const railOpen = railOverride ?? hasRailContent;
  // Rail resize: a dragger between the conversation and the rail (md+). Width
  // in px, persisted per browser; null → the 32% default. Loaded in an effect
  // (not the initializer) so SSR and first client render agree.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [railWidth, setRailWidth] = useState<number | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem("skynet.rail-width"));
    if (Number.isFinite(saved) && saved >= RAIL_MIN) setRailWidth(saved);
  }, []);
  function startRailDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    // Pointer capture keeps move events on the handle even over the terminal /
    // desktop iframes, which would otherwise swallow the drag.
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      const r = body.getBoundingClientRect();
      // Rail right edge sits at the body's right padding edge (p-3 = 12px).
      const w = Math.min(Math.max(r.right - 12 - ev.clientX, RAIL_MIN), r.width * 0.6);
      setRailWidth(Math.round(w));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setRailWidth((w) => {
        if (w !== null) localStorage.setItem("skynet.rail-width", String(w));
        return w;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }
  // Default to whichever pane actually has content; an explicit pick wins.
  // Agents leads when a run fanned out — that's the story you want to watch.
  const [railTabOverride, setRailTabOverride] = useState<
    "agents" | "editor" | "terminal" | "desktop" | null
  >(null);
  const railTab =
    railTabOverride ??
    (hasSubagents ? "agents" : hasFiles ? "editor" : hasCommands ? "terminal" : "editor");
  // The Desktop tab watches the sandbox GUI (multi-repo); a recorded opencode
  // session implies its sandbox exists, so the pane can connect (else it shows a
  // placeholder). Only offered for opencode threads — the snapshot with noVNC.
  const hasDesktop = isOpencode;

  // Slash-command list for the reply composer's "/" autocomplete — the resident
  // opencode server's real GET /command, via the same-origin live-proxy. Best
  // effort: a stopped sandbox or non-opencode thread just means no popover.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    if (!isOpencode || !engineSessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await backendFetch(`/api/live-proxy/${rootId}/command`);
        if (!res.ok) return;
        const list = (await res.json()) as { name?: string; description?: string }[];
        if (cancelled || !Array.isArray(list)) return;
        setCommands(
          list
            .filter((c): c is { name: string; description?: string } => !!c.name)
            .map((c) => ({ name: c.name, description: c.description ?? null })),
        );
      } catch {
        // no commands — the composer simply has no "/" popover
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpencode, engineSessionId, rootId]);

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
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row">
        {/* Conversation */}
        <section className="border-stroke-soft-200 bg-bg-white-0 relative flex min-h-[60vh] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border md:min-h-0">
          {/* PRIMARY CHAT = our native React conversation (user decision
              2026-08-05, second pass): owning the rendering layer keeps the
              extension surface ours — artifact/PPT/PDF viewers, custom panes —
              per the reference bot/Cloudflare-OS model. The opencode inline-embed
              implementation lives complete on branch feat/opencode-live-embed;
              the React-native port of their part renderers grows on
              feat/react-session-port. */}
          <Conversation
            turns={turns}
            defaultEngine={normalizeEngine(newest.engine)}
            defaultModel={newest.model}
            pendingReply={pendingReply}
            commands={commands}
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

        {railOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side panel"
            title="Drag to resize · double-click to reset"
            onPointerDown={startRailDrag}
            onDoubleClick={() => {
              setRailWidth(null);
              localStorage.removeItem("skynet.rail-width");
            }}
            className="hover:bg-stroke-sub-300 active:bg-stroke-sub-300 -mx-1.5 hidden w-1 shrink-0 cursor-col-resize touch-none self-stretch rounded-full transition-colors md:block"
          />
        )}

        {railOpen ? (
          // ONE bordered panel: the Editor|Terminal switcher + collapse live in
          // its header; the active pane fills the body bare (its own border/round
          // is dropped so this panel owns the single card edge).
          <section
            style={railWidth !== null ? ({ "--rail-w": `${railWidth}px` } as React.CSSProperties) : undefined}
            className={cn(
              "border-stroke-soft-200 bg-bg-white-0 flex min-h-[50vh] min-w-0 flex-col overflow-hidden rounded-2xl border md:min-h-0 md:shrink-0",
              railWidth !== null ? "md:w-[var(--rail-w)]" : "md:w-[32%]",
            )}
          >
            <div className="border-stroke-soft-200 flex shrink-0 items-center gap-2 border-b p-2">
              <SegmentedControl.Root
                className="flex-1"
                value={railTab}
                onValueChange={(v) =>
                  setRailTabOverride(v as "agents" | "editor" | "terminal" | "desktop")
                }
              >
                <SegmentedControl.List>
                  {/* Agents leads the switcher, but only once a run has fanned
                      out — no empty tab before then. */}
                  {hasSubagents && (
                    <SegmentedControl.Trigger value="agents">
                      <RiRobot2Line className="size-4" aria-hidden />
                      Agents
                    </SegmentedControl.Trigger>
                  )}
                  <SegmentedControl.Trigger value="editor">
                    <RiCodeSSlashLine className="size-4" aria-hidden />
                    Editor
                  </SegmentedControl.Trigger>
                  <SegmentedControl.Trigger value="terminal">
                    <RiTerminalBoxLine className="size-4" aria-hidden />
                    Terminal
                  </SegmentedControl.Trigger>
                  {/* multi-repo desktop: watch (and click) the sandbox GUI over
                      noVNC. Only opencode threads carry the noVNC snapshot. */}
                  {hasDesktop && (
                    <SegmentedControl.Trigger value="desktop">
                      <RiComputerLine className="size-4" aria-hidden />
                      Desktop
                    </SegmentedControl.Trigger>
                  )}
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
              {railTab === "agents" ? (
                <AgentsRail steps={allSteps} live={live} />
              ) : railTab === "editor" ? (
                <EditorPane steps={allSteps} live={live} />
              ) : railTab === "desktop" ? (
                <DesktopPane threadId={rootId} hasSandbox={isOpencode && !!engineSessionId} />
              ) : (
                <TerminalPane steps={allSteps} live={live} engine={newest.engine} runId={newest.id} />
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
