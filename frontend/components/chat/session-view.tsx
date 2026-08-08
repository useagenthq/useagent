"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useThreadStream, shouldRetireOptimistic } from "@/components/chat/use-thread-stream";
import type { NativeSnapshot } from "@/components/chat/native-store";
import type { ThreadRunView } from "@/components/chat/thread-store";
import { SubagentChips } from "@/components/chat/subagent-pane";
import {
  isLiveStatus,
  normalizeEngine,
  parseFileEntries,
  type ApiRun,
  type EngineId,
  type MemoryScope,
  type RunStatus,
} from "@/components/chat/types";
import {
  resolveCommandCatalog,
  selectSessionCommands,
  type CanonicalCommandView,
} from "@/components/chat/canonical-timeline";

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
 * editor|terminal split. The whole thread renders as one conversation, driven by
 * a single thread-scoped SSE subscription (`useThreadStream`) whose lifetime is the
 * ROOT thread - creating/queueing/starting/settling/cancelling a run never resets
 * it. Every run's projection (durable steps + native frames + live narration) is
 * owned by the thread store, so all runs stream concurrently through one connection.
 * All runs' steps feed the editor tabs (files touched) and the terminal (commands).
 * A reply starts a child run in the same thread and arrives on the open stream -
 * never navigating away, never reconnecting.
 */
export function SessionView({ initialThread }: { initialThread: ApiRun[] }) {
  // Optimistic reply, keyed by the accepted run id: kept visible until the durable
  // run is observed in the store, so a POST-accepted message never vanishes if SSE
  // is momentarily down AND the reconcile fetch fails (Codex finding 4).
  const [pending, setPending] = useState<{ text: string; runId: string | null } | null>(null);
  const [stopping, setStopping] = useState(false);

  // ONE realtime subscription for the whole conversation, keyed by the ROOT thread
  // id for the page lifetime (final_fix.md): creating/queueing/starting/settling/
  // cancelling a run never resets the store or reconnects. Every run's projection
  // (durable steps + native frames + live narration) is owned by the thread store,
  // so no run-switch transition can blank/freeze a turn or target the wrong run.
  const rootId = initialThread[0]!.id;
  const { snapshot, reconcile } = useThreadStream(rootId, initialThread);
  const thread = snapshot.runs.length ? snapshot.runs : initialThread;
  const newest = thread[thread.length - 1]!;

  // A settled turn shows its native timeline ONLY when it actually has native
  // frames (opencode tool rows live only on the native lane); a settled turn with
  // no frames (mock / non-native engines) falls back to the worklog+answer
  // rendering, exactly as before. A live turn always uses its native timeline.
  const nativeFor = (v: ThreadRunView): NativeSnapshot | undefined =>
    isLiveStatus(v.status) ? v.native : v.native.nativeFrames.length > 0 ? v.native : undefined;

  // Every run renders from its OWN thread-store slice - no active-run selection, no
  // projection cache: a reply never makes another turn render less than it already
  // showed, because nothing switches the subscription (root-fix of the reply flash).
  const turns: Turn[] = thread.map((run) => {
    const v = snapshot.byId.get(run.id);
    if (!v) {
      return { run, steps: run.steps, status: run.status, summary: run.summary, live: false, liveText: "", native: undefined };
    }
    return {
      run: v.run,
      steps: v.native.steps,
      status: v.status,
      summary: v.summary,
      live: isLiveStatus(v.status),
      liveText: v.liveText,
      native: nativeFor(v),
      canonical: v.canonical,
      canonicalComplete: v.canonicalComplete,
    };
  });
  const allSteps = turns.flatMap((t) => t.steps);
  // Subagent fidelity is derived from native frames across the WHOLE thread.
  const allFrames = turns.flatMap((t) => t.native?.nativeFrames ?? []);
  const live = turns.some((t) => isLiveStatus(t.status));
  // The turn currently producing events (running preferred; else the newest live
  // turn about to start) - the boot orb + live indicators read from it.
  const liveTurn =
    turns.find((t) => t.status === "running") ?? turns.find((t) => isLiveStatus(t.status)) ?? null;
  // Boot window: a live turn accepted but nothing streamed yet - the orb stands in
  // until the first narration token OR step arrives, then the conversation's live
  // narration / Thinking disclosure takes over (one live indicator at a time).
  const booting =
    !!liveTurn && !liveTurn.liveText && !liveTurn.steps.some((s) => s.kind !== "done");

  // Removed with the cutover: the active-run projection cache, the terminal-state
  // refetch, and the five-second external-turn discovery poll. The thread stream
  // now delivers new runs (post-commit `created` signal), settled run fields
  // (summary / engine_session_id via the `settled` frame), and external turns on
  // the ONE open connection - no polling while SSE is healthy, no run-switch reset.

  const handleReply = useCallback(
    async (
      text: string,
      engine: EngineId,
      model: string,
      idempotencyKey: string,
      memoryScope: MemoryScope,
      command?: { name: string; args: string } | null,
    ) => {
      setPending({ text, runId: null });
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
            // TYPED native-command intent (Phase 3): present ONLY for a `/known-command ...`
            // from the current session's catalog. Carries the provider + native session id so
            // the backend rejects a stale/cross-session intent; the backend re-validates before
            // delivering it verbatim. Absent => an ordinary prompt keeps its full context.
            ...(command ? { command: { ...command, provider: engine, sessionId: engineSessionId ?? undefined } } : {}),
          }),
        });
        if (!res.ok) throw new Error(`backend ${res.status}`);
        // Key the optimistic bubble to the ACCEPTED run id and keep it until that
        // durable run is observed in the store (retired by the effect below). The
        // child run normally arrives on the OPEN thread stream (post-commit
        // `created` signal); reconcile is a best-effort nudge if SSE was momentarily
        // down. If BOTH are down, the message must NOT vanish - the backend accepted
        // it (Codex finding 4).
        const body = (await res.json().catch(() => ({}))) as { id?: unknown };
        const runId = typeof body.id === "string" ? body.id : null;
        setPending((p) => (p ? { ...p, runId } : { text, runId }));
        void reconcile();
      } catch (err) {
        // POST itself failed: drop the optimistic bubble and re-throw so the composer
        // restores the draft and shows an explicit retry state.
        setPending(null);
        throw err;
      }
    },
    [newest.id, reconcile],
  );

  // Retire the optimistic bubble ONLY once its accepted run is present in the thread
  // store (matched by run id, never prompt text) - so a POST-accepted reply survives
  // an SSE/reconcile outage and is cleared exactly when the durable run lands.
  useEffect(() => {
    if (pending && shouldRetireOptimistic(pending.runId, snapshot)) setPending(null);
  }, [pending, snapshot]);

  // The ACTUALLY-RUNNING turn may not be the newest (rapid-fire replies make
  // the newest a QUEUED run) - Stop and Send-now must target the running one.
  const runningTurn = turns.find((t) => t.status === "running") ?? null;
  const headQueuedId = turns.find((t) => t.status === "queued")?.run.id ?? null;
  // The session-bar status reflects the thread's current activity: running if any
  // turn runs, else queued if any is waiting, else the newest turn's terminal state.
  const newestTurn = turns[turns.length - 1] ?? null;
  const threadStatus: RunStatus = runningTurn
    ? "running"
    : headQueuedId
      ? "queued"
      : newestTurn?.status ?? newest.status;

  // Stop the live turn: POST the durable cancel. The backend aborts the actor and
  // settles the run "Stopped by user"; the thread stream then emits its `done` +
  // `settled` frames, so the pill flips and the summary lands - nothing to do here
  // but fire and let the stream drive the UI.
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

  // Slash-command catalog for the reply composer's "/" autocomplete - the SELECTED engine's
  // real native commands, capability-driven (no provider-name gate). Authoritative source is
  // the DURABLE canonical stream's per-session `commands.updated`, SESSION-SCOPED to the current
  // native session so a historical or other-session snapshot can NEVER mask the active session
  // (a restarted/new session that has not re-advertised falls back to the pre-session priming
  // fetch rather than showing stale commands). The live session snapshot always wins; the fetch
  // (OpenCode's live-proxy, or the ACP engines' org priming cache via GET /api/commands) only
  // primes until this session advertises. `resolveCommandCatalog` folds both into one honest
  // state (loading / unavailable / error / ready[+stale]).
  const engine = normalizeEngine(newest.engine);
  const durableCommands = useMemo(
    () => selectSessionCommands([...snapshot.byId.values()], engineSessionId),
    [snapshot.byId, engineSessionId],
  );
  const hasDurable = durableCommands !== null;
  const [fetchState, setFetchState] = useState<{ phase: "loading" | "done" | "error"; commands: CanonicalCommandView[] }>({
    phase: "loading",
    commands: [],
  });
  useEffect(() => {
    if (hasDurable) return; // the durable session catalog wins; no live fetch needed
    let cancelled = false;
    // Clear-on-change: reset immediately so a prior engine/session's commands never linger
    // while the new source loads.
    setFetchState({ phase: "loading", commands: [] });
    void (async () => {
      const fail = () => !cancelled && setFetchState({ phase: "error", commands: [] });
      try {
        let list: { name?: string; description?: string; input?: string }[] = [];
        if (engine === "opencode") {
          if (!engineSessionId) { if (!cancelled) setFetchState({ phase: "done", commands: [] }); return; }
          const res = await backendFetch(`/api/live-proxy/${rootId}/command`);
          if (!res.ok) return fail();
          list = (await res.json()) as typeof list;
        } else {
          const res = await backendFetch(`/api/commands?engine=${encodeURIComponent(engine)}`);
          if (!res.ok) return fail();
          list = ((await res.json()) as { commands?: typeof list }).commands ?? [];
        }
        if (cancelled) return;
        if (!Array.isArray(list)) return fail();
        setFetchState({
          phase: "done",
          commands: list
            .filter((c): c is { name: string; description?: string; input?: string } => !!c.name)
            .map((c) => ({ name: c.name, description: c.description ?? null, input: typeof c.input === "string" ? c.input : null })),
        });
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, engineSessionId, rootId, hasDurable]);
  const catalogState = resolveCommandCatalog(durableCommands, fetchState, engine);
  const commands: SlashCommand[] =
    catalogState.status === "ready"
      ? catalogState.commands.map((c) => ({ name: c.name, description: c.description ?? null }))
      : [];

  return (
    <div className="flex h-full flex-col">
      {/* Compact session bar — the shell's TopNav + AgentSidebar (⌘K included)
          wrap this view, so the brand/search chrome lives there now. */}
      <div className="border-stroke-soft-200 bg-bg-white-0 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
        <span className="text-mono-label text-text-soft-400">Session</span>
        <div className="flex items-center gap-3">
          <StatusPill status={threadStatus} />
          {/* Stop lives in the composer send button (running+empty -> red Stop),
              threaded through Conversation. The old top-bar Stop was removed so
              there is exactly ONE Stop affordance (user: "i mean stop here"). */}
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
            pendingReply={pending?.text ?? null}
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
              <OrbBootIndicator
                engine={liveTurn?.run.engine ?? newest.engine}
                status={liveTurn?.status ?? threadStatus}
              />
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
                    <SegmentedControl.Trigger value="agents" data-testid="rail-tab-agents">
                      <RiRobot2Line className="size-4" aria-hidden />
                      Agents
                    </SegmentedControl.Trigger>
                  )}
                  <SegmentedControl.Trigger value="editor" data-testid="rail-tab-editor">
                    <RiCodeSSlashLine className="size-4" aria-hidden />
                    Editor
                  </SegmentedControl.Trigger>
                  <SegmentedControl.Trigger value="terminal" data-testid="rail-tab-terminal">
                    <RiTerminalBoxLine className="size-4" aria-hidden />
                    Terminal
                  </SegmentedControl.Trigger>
                  {/* multi-repo desktop: watch (and click) the sandbox GUI over
                      noVNC. Only opencode threads carry the noVNC snapshot. */}
                  {hasDesktop && (
                    <SegmentedControl.Trigger value="desktop" data-testid="rail-tab-desktop">
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
                <AgentsRail steps={allSteps} live={live} frames={allFrames} />
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
