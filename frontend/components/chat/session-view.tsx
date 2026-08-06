"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  RiAddLine,
  RiCodeSSlashLine,
  RiComputerLine,
  RiLayoutRightLine,
  RiRobot2Line,
  RiStopCircleLine,
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
  type MemoryScope,
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
  const [stopping, setStopping] = useState(false);

  const newest = thread[thread.length - 1];
  const rootId = thread[0].id;
  // The stream must watch the turn PRODUCING events: the running run. Watching
  // the newest froze the running turn's progress the moment a follow-up queued
  // (newest became the queued reply, which streams nothing - user report).
  // Falls back to newest on fresh/idle threads (SSE attaches when it starts).
  const activeRun = thread.find((r) => r.status === "running") ?? newest;
  const stream = useRunStream(activeRun);

  // Cache each run's RICHEST projection (stream overlay) so a turn never
  // renders LESS than what was already on screen. Without this, a web reply
  // mid-stream re-keyed the stream to the NEW run and the still-running old
  // turn instantly lost its overlay - its DB steps had not been written yet,
  // so it rendered a bare "Skynet" header until a later poll refilled it
  // (user-reported flash; Slack replies dodged it only by timing).
  const projectionCache = useRef(
    new Map<string, { steps: Turn["steps"]; summary: string | null; native: Turn["native"] }>(),
  );
  if (stream.steps.length > 0 || stream.summary) {
    projectionCache.current.set(activeRun.id, {
      steps: stream.steps,
      summary: stream.summary,
      native: stream.native,
    });
  }

  // Newest run's live stream overrides its thread snapshot; older runs are
  // settled history - served from the projection cache whenever it is richer
  // than the (possibly lagging) DB snapshot.
  const turns: Turn[] = thread.map((run) => {
    if (run.id === activeRun.id) {
      return {
        run,
        steps: stream.steps,
        status: stream.status,
        summary: stream.summary,
        live: stream.live,
        liveText: stream.liveText,
        native: stream.native,
      };
    }
    const cached = projectionCache.current.get(run.id);
    // ALWAYS prefer a cached native snapshot: opencode tool rows exist ONLY in
    // the native frame lane (the DB steps table carries just boot/synthetic
    // rows), so no thread refetch can ever re-render them - a step-count
    // comparison here wrongly dropped the frames and re-blanked the turn
    // (verified via network-trace repro: collapse at the new run's SSE
    // subscribe, with DB steps present but unrenderable).
    const useCached = cached !== undefined && (cached.native?.nativeFrames.length ?? 0) > 0;
    return {
      run,
      steps: useCached && cached.steps.length >= run.steps.length ? cached.steps : run.steps,
      status: run.status,
      summary: run.summary ?? cached?.summary ?? null,
      live: false,
      liveText: "",
      native: useCached ? cached.native : undefined,
    };
  });
  const allSteps = turns.flatMap((t) => t.steps);
  const live = stream.live;
  // Boot window: run accepted but nothing has streamed yet — the orb stands in
  // until the first narration token OR step arrives, then the conversation's live
  // narration / Thinking disclosure takes over (keeps one live indicator at a time).
  const booting =
    live &&
    !stream.liveText &&
    !stream.steps.some((s) => s.kind !== "done");

  // Cheap change signature so the poll below can skip no-op setThread calls
  // (toThread always builds fresh objects; unconditional set = 5s render churn).
  const threadSig = (runs: typeof thread): string =>
    runs.map((r) => `${r.id}:${r.status}:${r.steps.length}:${r.summary?.length ?? 0}`).join("|");

  const refetchThread = useCallback(
    async (opts?: { keepPending?: boolean }) => {
      try {
        const res = await backendFetch(`/api/runs/${rootId}?thread=1`);
        if (res.ok) {
          const next = toThread(await res.json());
          if (next.length) {
            setThread((cur) => (threadSig(cur) === threadSig(next) ? cur : next));
          }
        }
      } catch {
        // keep the current thread on a transient failure
      } finally {
        if (!opts?.keepPending) setPendingReply(null);
      }
    },
    [rootId],
  );

  // Refetch the thread whenever the streamed run reaches a terminal state —
  // run-level fields written during the turn (engine_session_id → the Live
  // tab's deep-link, summary) only travel via thread fetches, and without this
  // a FRESH session never learns them until a reply or a page reload.
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !stream.live) void refetchThread();
    wasLive.current = stream.live;
  }, [stream.live, refetchThread]);

  // External turns (Slack mentions, schedules) create runs in this thread with
  // no local action to trigger a refetch — the user had to reload the page to
  // see them. Poll lightly while the tab is visible; keepPending so an
  // in-flight optimistic reply bubble is never cleared by the poll. The change
  // signature above makes a no-change poll render-free. (A thread-level push
  // lane is #78's territory; this is the single-replica answer.)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refetchThread({ keepPending: true });
    }, 5_000);
    return () => clearInterval(id);
  }, [refetchThread]);

  const handleReply = useCallback(
    async (
      text: string,
      engine: EngineId,
      model: string,
      idempotencyKey: string,
      memoryScope: MemoryScope,
    ) => {
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
            // The backend inherits the parent's scope when omitted; sending the
            // composer's choice lets the user change it for this reply.
            memory_scope: memoryScope,
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

  // The ACTUALLY-RUNNING turn may not be the newest (rapid-fire replies make
  // the newest a QUEUED run) - Stop and Send-now must target the running one.
  const runningTurn = turns.find((t) => t.status === "running") ?? null;
  const headQueuedId = turns.find((t) => t.status === "queued")?.run.id ?? null;

  // Stop the live turn: POST the durable cancel. The backend aborts the actor and
  // settles the run "Stopped by user"; the SSE stream then emits its terminal
  // event, so the pill flips and the wasLive effect refetches — nothing to do
  // here but fire and let the stream drive the UI.
  const canStop = stream.status === "queued" || stream.status === "running";
  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      // Prefer the running turn (the newest may be a queued reply, and Stop
      // means "stop the work", not "drop my message").
      const target = runningTurn?.run.id ?? newest.id;
      await backendFetch(`/api/runs/${target}/cancel`, { method: "POST" });
    } catch {
      // Leave the button; the turn is still live so the user can retry Stop.
    } finally {
      setStopping(false);
    }
  }, [newest.id, runningTurn, stopping]);

  // Send-now steering (opencode's control, matched to our harness): cancel the
  // RUNNING turn; the per-thread command lane then auto-dispatches the head
  // queued turn immediately (FIFO promotion is already the lane's behavior).
  // Only offered on the HEAD queued message so the queue order is preserved.
  const handleSendNow = useCallback(async () => {
    if (!runningTurn) return;
    try {
      await backendFetch(`/api/runs/${runningTurn.run.id}/cancel`, { method: "POST" });
    } catch {
      // The queued bubble keeps its affordance; the user can retry.
    }
  }, [runningTurn]);

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
          {/* Quiet Stop control — present only while the newest turn is live.
              Cancels the run durably; the stream settles it "Stopped by user". */}
          {canStop && (
            <button
              type="button"
              onClick={handleStop}
              disabled={stopping}
              title="Stop this run"
              aria-label="Stop this run"
              className="border-stroke-soft-200 text-text-sub-600 hover:border-error-base hover:text-error-base flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-label-xs transition-colors disabled:opacity-50"
            >
              <RiStopCircleLine className="size-4" aria-hidden />
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
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
            // A reply inherits the thread's current scope (its newest run); the
            // composer lets the user change it. Legacy runs w/o a scope → "org".
            defaultMemoryScope={newest.memory_scope ?? "org"}
            pendingReply={pendingReply}
            commands={commands}
            onReply={handleReply}
            sendNowFor={runningTurn ? headQueuedId : null}
            onSendNow={handleSendNow}
            running={runningTurn !== null}
            stopping={stopping}
            onStop={handleStop}
          />
          {/* Boot phase: engine spinning up, no steps yet — orb pill; clears the
              moment the first step streams in (Thinking block takes over).
              Placement: centered ONLY on a fresh empty thread; once history
              exists it docks to the panel's top-right corner so a queued
              follow-up never floats over prior message text (user report). */}
          {booting && (
            <div
              className={
                turns.length === 0
                  ? "animate-ai-fade-up pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center"
                  : "animate-ai-fade-up pointer-events-none absolute right-4 top-4 z-20"
              }
            >
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
              railWidth !== null ? "md:w-[var(--rail-w)]" : "md:w-[30%]",
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
                <AgentsRail steps={allSteps} live={live} frames={stream.native.nativeFrames} />
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
