"use client";

import {
  RiAddLine,
  RiCodeSSlashLine,
  RiCollapseDiagonal2Line,
  RiComputerLine,
  RiExpandDiagonal2Line,
  RiFileList2Line,
  RiGitMergeLine,
  RiLayoutRightLine,
  RiPagesLine,
  RiRobot2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentsRail } from "@/components/chat/agents-rail";
import {
  type ApprovalDecision,
  type PendingApproval,
  selectPendingApproval,
} from "@/components/chat/approval-state";
import { ArtifactsRail } from "@/components/chat/artifacts-rail";
import {
  type CanonicalCommandView,
  resolveCommandCatalog,
  selectActiveSessionId,
  selectSessionCapabilities,
  selectSessionCommandCatalog,
  selectSessionCommands,
} from "@/components/chat/canonical-timeline";
import { Conversation, type Turn } from "@/components/chat/conversation";
import { DesktopPane } from "@/components/chat/desktop-pane";
import { DiffPane } from "@/components/chat/diff-pane";
import { EditorPane } from "@/components/chat/editor-pane";
import { gatewayApprovalSignature } from "@/components/chat/gateway-approval-state";
import {
  type GatewayApprovalSignal,
  useGatewayApprovals,
} from "@/components/chat/use-gateway-approvals";
import type { NativeSnapshot } from "@/components/chat/native-store";
import { OrbBootIndicator } from "@/components/chat/orb-boot-indicator";
import { type PendingQuestion, selectPendingQuestion } from "@/components/chat/question-state";
import {
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  RailResizer,
  railWidthForKey,
  railWidthFromPointer,
} from "@/components/chat/rail-resizer";
import type { SlashCommand } from "@/components/chat/slash-command";
import { SubagentChips } from "@/components/chat/subagent-pane";
import { type SurfaceChoice, SurfaceChooser } from "@/components/chat/surface-chooser";
import { TerminalPane } from "@/components/chat/terminal-pane";
import { terminalRunIdForThread } from "@/components/chat/terminal-run-state";
import type { ThreadRunView } from "@/components/chat/thread-store";
import type { TimelineArtifact } from "@/components/chat/timeline";
import { ComposerPrefillProvider } from "@/components/chat/composer-prefill-context";
import { SessionLatestRunProvider } from "@/components/chat/session-run-context";
import { useWorkpieceAutoOpen } from "@/components/chat/use-workpiece-auto-open";
import { shouldFocusAutoOpened } from "@/components/chat/workpiece-auto-open";
import { WorkspaceOpenProvider } from "@/components/chat/workspace-open-context";
import type { OpenWorkpieceTab } from "@/components/chat/workspace-pane";

// The Workspace pane pulls in the workpiece editor surfaces + revision hook. Code
// split it so that weight loads ONLY when a user first opens a workpiece - it must
// never sit in the base session bundle (the pane is already mount-gated, this keeps
// its JS out of first load too).
const WorkspacePane = dynamic(
  () => import("@/components/chat/workspace-pane").then((mod) => mod.WorkspacePane),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full place-items-center p-6 text-body-2-regular text-text-secondary">
        Loading workspace...
      </div>
    ),
  },
);
import {
  type ApiRun,
  type EngineId,
  isLiveStatus,
  type MemoryScope,
  normalizeEngine,
  parseFileEntries,
  type RunStatus,
  supportsPreSessionModelSelection,
} from "@/components/chat/types";
import { shouldRetireOptimistic, useThreadStream } from "@/components/chat/use-thread-stream";
import { runGitRefs, GitChips } from "@/components/session-ui/git-chip";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { CloseButton } from "@/components/base/buttons/close-button";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { backendFetch } from "@/lib/backend-fetch";
import { createRun } from "@/lib/create-run";
import { cx } from "@/utils/cx";

/** True when DOM focus sits inside a live workspace editing surface - the signal
 * an auto-open uses to avoid yanking the caret away from an edit in progress.
 * `visibility:hidden` on an inactive tab drops focus, so a focused surface is by
 * definition the visible one. */
function workspaceSurfaceHasFocus(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest("[data-workspace-surface]") !== null;
}

function StatusPill({ status }: { status: RunStatus }) {
  const live = status === "queued" || status === "running";
  const map: Record<RunStatus, "blue" | "lime" | "rose"> = {
    queued: "blue",
    running: "blue",
    completed: "lime",
    failed: "rose",
  };
  return (
    <Chip variant="caption" color={map[status]} className="gap-1.5 capitalize">
      {live && <span className="ai-loading-pixel size-1.5 rounded-full bg-blue-500" />}
      {status}
    </Chip>
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
  const root = initialThread[0];
  if (!root) throw new Error("SessionView requires a non-empty thread");

  // Optimistic reply, keyed by the accepted run id: kept visible until the durable
  // run is observed in the store, so a POST-accepted message never vanishes if SSE
  // is momentarily down AND the reconcile fetch fails (Codex finding 4).
  const [pending, setPending] = useState<{ text: string; runId: string | null } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [answeringApproval, setAnsweringApproval] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // ONE realtime subscription for the whole conversation, keyed by the ROOT thread
  // id for the page lifetime (final_fix.md): creating/queueing/starting/settling/
  // cancelling a run never resets the store or reconnects. Every run's projection
  // (durable steps + native frames + live narration) is owned by the thread store,
  // so no run-switch transition can blank/freeze a turn or target the wrong run.
  const rootId = root.id;
  const { snapshot, reconcile } = useThreadStream(rootId, initialThread);
  const thread = snapshot.runs.length ? snapshot.runs : initialThread;
  const newest = thread.at(-1) ?? root;

  // The ONE active native-session id, from the CURRENT (newest) run's `session.started` - NEVER a
  // findLast over historical runs (which surfaces a REPLACED session while the new run has not
  // advertised, letting a stale S1 catalog/capability mask the active S2). Falls back to the
  // newest run's persisted column (the durable form of the same session.started), else null so
  // nothing stale is shown. Memoized + a handleReply dependency so a session change refreshes the
  // command intent it sends (no stale-closure session id).
  const engineSessionId = useMemo(
    () =>
      selectActiveSessionId([...snapshot.byId.values()], newest.id) ??
      newest.engine_session_id ??
      null,
    [snapshot.byId, newest.id, newest.engine_session_id],
  );
  // The active session catalog's SNAPSHOT revision (latest commands.updated deliverySeq) - sent
  // with a native-command intent so the backend fail-closed authorization rejects a stale catalog.
  const commandCatalogRevision = useMemo(
    () =>
      selectSessionCommandCatalog([...snapshot.byId.values()], engineSessionId)?.revision ?? null,
    [snapshot.byId, engineSessionId],
  );
  // The ONE negotiated capability map for the current session: submission
  // behavior and surface visibility consume the same contract.
  const caps = useMemo(
    () => selectSessionCapabilities([...snapshot.byId.values()], engineSessionId),
    [snapshot.byId, engineSessionId],
  );
  // `session.started` can arrive after the composer first renders. Until then,
  // derive only this one capability from the engine's curated model catalog.
  // Once negotiated capabilities exist, an explicit false remains authoritative.
  const modelSelection = caps?.modelSelection ?? supportsPreSessionModelSelection(newest.engine);

  // Every run renders from its OWN thread-store slice - no active-run selection, no
  // projection cache: a reply never makes another turn render less than it already
  // showed, because nothing switches the subscription (root-fix of the reply flash).
  //
  // Per-run Turn objects are identity-stable while their store view (or fallback
  // ApiRun) is unchanged: the store rebuilds only mutated runs' views, so a
  // streaming sibling no longer hands every settled (memoized) TurnBlock a fresh
  // `turn` prop each SSE animation frame.
  const turnCacheRef = useRef(new Map<string, { source: ApiRun | ThreadRunView; turn: Turn }>());
  const turns: Turn[] = useMemo(() => {
    // A settled turn shows its native timeline ONLY when it actually has native
    // frames (opencode tool rows live only on the native lane); a settled turn with
    // no frames (mock / non-native engines) falls back to the worklog+answer
    // rendering, exactly as before. A live turn always uses its native timeline.
    const nativeFor = (v: ThreadRunView): NativeSnapshot | undefined =>
      isLiveStatus(v.status) ? v.native : v.native.nativeFrames.length > 0 ? v.native : undefined;
    const cache = turnCacheRef.current;
    const next = new Map<string, { source: ApiRun | ThreadRunView; turn: Turn }>();
    const list = thread.map((run) => {
      const v = snapshot.byId.get(run.id);
      const source = v ?? run;
      const cached = cache.get(run.id);
      if (cached && cached.source === source) {
        next.set(run.id, cached);
        return cached.turn;
      }
      const turn: Turn = v
        ? {
            run: v.run,
            steps: v.native.steps,
            status: v.status,
            summary: v.summary,
            live: isLiveStatus(v.status),
            liveText: v.liveText,
            liveReasoning: v.liveReasoning,
            native: nativeFor(v),
            canonical: v.canonical,
            canonicalComplete: v.canonicalComplete,
          }
        : {
            run,
            steps: run.steps,
            status: run.status,
            summary: run.summary,
            live: false,
            liveText: "",
            liveReasoning: "",
            native: undefined,
          };
      next.set(run.id, { source, turn });
      return turn;
    });
    turnCacheRef.current = next;
    return list;
  }, [thread, snapshot.byId]);
  const allSteps = useMemo(() => turns.flatMap((t) => t.steps), [turns]);
  const allCanonicalEvents = useMemo(() => turns.flatMap((t) => t.canonical ?? []), [turns]);
  // Subagent fidelity is derived from native frames across the WHOLE thread.
  const allFrames = useMemo(() => turns.flatMap((t) => t.native?.nativeFrames ?? []), [turns]);
  const live = turns.some((t) => isLiveStatus(t.status));
  const terminalRunId = terminalRunIdForThread(turns);
  // The turn currently producing events (running preferred; else the newest live
  // turn about to start) - the boot orb + live indicators read from it.
  const liveTurn =
    turns.find((t) => t.status === "running") ?? turns.find((t) => isLiveStatus(t.status)) ?? null;
  // Boot window: a live turn accepted but nothing streamed yet - the orb stands in
  // until the first narration token OR step arrives, then the conversation's live
  // narration / Thinking disclosure takes over (one live indicator at a time).
  const booting =
    !!liveTurn && !liveTurn.liveText && !liveTurn.steps.some((s) => s.kind !== "done");

  // Native questions are control traffic inside the currently-running provider
  // turn. Derive the card from durable frames so live streaming and reload show
  // the same pending request. Settled turns are intentionally excluded: a failed
  // provider must not leave an unanswerable historical question blocking chat.
  const activeQuestion = useMemo(() => {
    for (const turn of turns.toReversed()) {
      if (!isLiveStatus(turn.status)) continue;
      const request = selectPendingQuestion(turn.native?.nativeFrames ?? []);
      if (request) return { runId: turn.run.id, request };
    }
    return null;
  }, [turns]);
  const composerCanAnswerQuestion =
    activeQuestion?.request.questions.length === 1 &&
    activeQuestion.request.questions[0]?.custom === true;

  const activeApproval = useMemo(() => {
    for (const turn of turns.toReversed()) {
      if (!isLiveStatus(turn.status)) continue;
      const request = selectPendingApproval(turn.native?.nativeFrames ?? []);
      if (request) return { runId: turn.run.id, request };
    }
    return null;
  }, [turns]);

  // Gateway approvals (#77): same seam as the question card - the run's OWN
  // projection decides. A live turn whose timeline carries an approval step /
  // provider event signals this lane, which then fetches the authoritative
  // records from GET /api/gateway/approvals. The SIGNATURE (not a poll) drives
  // revalidation: a new approval event arriving on the thread SSE re-projects
  // the turn, changes the signature, and triggers exactly one refetch. Settled
  // turns are excluded like questions: history never re-raises a card.
  const gatewayApprovalSignals = useMemo(() => {
    const signals: GatewayApprovalSignal[] = [];
    for (const turn of turns) {
      if (!isLiveStatus(turn.status)) continue;
      const signature = gatewayApprovalSignature(
        turn.steps,
        turn.native?.nativeFrames ?? [],
        turn.canonical ?? [],
      );
      if (signature) signals.push({ runId: turn.run.id, signature });
    }
    return signals;
  }, [turns]);
  const { approvals: gatewayApprovals, refresh: refreshGatewayApprovals } =
    useGatewayApprovals(gatewayApprovalSignals);

  const submitQuestionAnswers = useCallback(
    async (target: { runId: string; request: PendingQuestion }, answers: string[][]) => {
      if (answeringQuestion) return false;
      setAnsweringQuestion(true);
      setQuestionError(null);
      try {
        const response = await backendFetch(
          `/api/runs/${target.runId}/questions/${target.request.id}/reply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers }),
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: unknown;
            message?: unknown;
          };
          const message =
            typeof body.message === "string"
              ? body.message
              : typeof body.error === "string"
                ? body.error
                : `backend ${response.status}`;
          throw new Error(message);
        }
        void reconcile();
        return true;
      } catch (error) {
        setQuestionError(error instanceof Error ? error.message : "Could not continue this turn");
        return false;
      } finally {
        setAnsweringQuestion(false);
      }
    },
    [answeringQuestion, reconcile],
  );

  useEffect(() => {
    setQuestionError(null);
  }, [activeQuestion?.request.id]);

  const submitApproval = useCallback(
    async (target: { runId: string; request: PendingApproval }, decision: ApprovalDecision) => {
      if (answeringApproval) return false;
      setAnsweringApproval(true);
      setApprovalError(null);
      try {
        const response = await backendFetch(
          `/api/runs/${target.runId}/approvals/${target.request.id}/reply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: unknown;
            message?: unknown;
          };
          const message =
            typeof body.message === "string"
              ? body.message
              : typeof body.error === "string"
                ? body.error
                : `backend ${response.status}`;
          throw new Error(message);
        }
        void reconcile();
        return true;
      } catch (error) {
        setApprovalError(
          error instanceof Error ? error.message : "Could not respond to this approval",
        );
        return false;
      } finally {
        setAnsweringApproval(false);
      }
    },
    [answeringApproval, reconcile],
  );

  useEffect(() => {
    setApprovalError(null);
  }, [activeApproval?.request.id]);

  // Stable identities for the memoized Conversation - an inline arrow here would
  // defeat its memo() on every SessionView render.
  const handleAnswerQuestion = useCallback(
    async (answers: string[][]) => {
      if (activeQuestion) await submitQuestionAnswers(activeQuestion, answers);
    },
    [activeQuestion, submitQuestionAnswers],
  );
  const handleAnswerApproval = useCallback(
    async (decision: ApprovalDecision) => {
      if (activeApproval) await submitApproval(activeApproval, decision);
    },
    [activeApproval, submitApproval],
  );
  const handleGatewayApprovalResolved = useCallback(
    () => void refreshGatewayApprovals(),
    [refreshGatewayApprovals],
  );

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
      attachmentIds: readonly string[] = [],
    ) => {
      // A free-text reply to a native question resumes the resident OpenCode
      // turn. It must never enqueue a child run behind the blocked parent.
      if (activeQuestion && composerCanAnswerQuestion) {
        const accepted = await submitQuestionAnswers(activeQuestion, [[text]]);
        if (!accepted) throw new Error("question reply failed");
        return;
      }
      setPending({ text, runId: null });
      try {
        const res = await createRun(
          {
            prompt: text,
            engine,
            // Unsupported controls must not leak stale values into the API.
            // ACP replies inherit the thread model server-side; OpenCode may
            // send the user-selected per-turn override it actually supports.
            ...(modelSelection ? { model } : {}),
            parent_run_id: newest.id,
            // The backend inherits the parent's scope when omitted; sending the
            // composer's choice lets the user change it for this reply.
            memory_scope: memoryScope,
            ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
            // TYPED native-command intent (Phase 3): present ONLY for a `/known-command ...`
            // from the current session's catalog. Carries the provider + native session id so
            // the backend rejects a stale/cross-session intent; the backend re-validates before
            // delivering it verbatim. Absent => an ordinary prompt keeps its full context.
            ...(command
              ? {
                  command: {
                    ...command,
                    provider: engine,
                    sessionId: engineSessionId ?? undefined,
                    catalogRevision: commandCatalogRevision ?? undefined,
                  },
                }
              : {}),
          },
          idempotencyKey,
        );
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
    [
      activeQuestion,
      modelSelection,
      commandCatalogRevision,
      composerCanAnswerQuestion,
      engineSessionId,
      newest.id,
      reconcile,
      submitQuestionAnswers,
    ],
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
      : (newestTurn?.status ?? newest.status);

  // Stop the live turn: POST the durable cancel. The backend aborts the actor and
  // settles the run "Stopped by user"; the thread stream then emits its `done` +
  // `settled` frames, so the pill flips and the summary lands - nothing to do here
  // but fire and let the stream drive the UI.
  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      // Prefer the running turn (the newest may be a queued reply, and Stop
      // means "stop the work", not "drop my message").
      const target = runningTurn?.run.id ?? newest.id;
      const response = await backendFetch(`/api/runs/${target}/cancel`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : `backend ${response.status}`);
      }
    } catch (error) {
      // Leave the button and surface the failure; the turn is still live so the
      // user can retry without guessing whether Stop worked.
      setStopError(error instanceof Error ? error.message : "Could not stop this run");
    } finally {
      setStopping(false);
    }
  }, [newest.id, runningTurn, stopping]);

  useEffect(() => {
    if (!runningTurn) setStopError(null);
  }, [runningTurn]);

  // Send-now steering (opencode's control, matched to our harness): cancel the
  // RUNNING turn; the per-thread command lane then auto-dispatches the head
  // queued turn immediately (FIFO promotion is already the lane's behavior).
  // Only offered on the HEAD queued message so the queue order is preserved.
  const handleSendNow = useCallback(async () => {
    if (!runningTurn) return;
    setStopError(null);
    try {
      const response = await backendFetch(`/api/runs/${runningTurn.run.id}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`backend ${response.status}`);
    } catch (error) {
      // The queued bubble keeps its affordance; the user can retry with an
      // explicit failure instead of a silent no-op.
      setStopError(error instanceof Error ? error.message : "Could not stop this run");
    }
  }, [runningTurn]);

  // Right rail: one tabbed panel, not stacked panes. Desktop and terminal are
  // useful before the first tool call, so the rail starts open on every real
  // session. The user can still collapse/reopen it explicitly.
  const hasFiles = allSteps.some((s) => s.kind === "file" && parseFileEntries(s).length > 0);
  const hasCommands = allSteps.some((s) => s.kind === "command");
  const hasSubagents =
    allCanonicalEvents.some((event) => event.kind === "child.started") ||
    allSteps.some((s) => s.chip === "subagent");
  const hasRuntimeSurfaces = normalizeEngine(newest.engine) !== "chat";
  const [railOverride, setRailOverride] = useState<boolean | null>(null);
  const [railExpanded, setRailExpanded] = useState(false);
  const railOpen = railOverride ?? hasRuntimeSurfaces;
  // Below md the SAME rail renders as a bottom slide-over sheet and starts
  // CLOSED (chat full-bleed): an explicit open - the thread bar's opener or a
  // workpiece auto-open, both of which set railOverride - slides it up.
  const isMobile = useIsMobile();
  const mobileSurfacesOpen = railOverride ?? false;
  // Rail resize: a dragger between the conversation and the rail (md+). Width
  // in px, persisted per browser; null → the 32% default. Loaded in an effect
  // (not the initializer) so SSR and first client render agree.
  const bodyRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const [railWidth, setRailWidth] = useState<number | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem("skynet.rail-width"));
    if (!Number.isFinite(saved) || saved < RAIL_MIN) return;
    // Apply the saved width through the same 0.6-of-container ceiling as the
    // drag/keyboard paths: a width persisted on a wide desktop must never
    // starve the conversation on a narrower window (tablet split).
    const bounds = bodyRef.current?.getBoundingClientRect();
    const containerMax = bounds ? Math.min(bounds.width * 0.6, RAIL_MAX) : RAIL_MAX;
    setRailWidth(Math.round(Math.min(saved, containerMax)));
  }, []);
  // The drag itself is ZERO-React: each (rAF-coalesced) pointer move writes the
  // rail's `--rail-w` var imperatively against container bounds cached once per
  // drag - no layout read, no setState, no re-render per move. React state (and
  // localStorage) commit ONCE on pointerup via persistRailWidth; the committed
  // style prop then re-writes the same var value, so nothing jumps.
  const dragBoundsRef = useRef<DOMRect | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const resizeRailFromPointer = useCallback((pointerX: number) => {
    dragBoundsRef.current ??= bodyRef.current?.getBoundingClientRect() ?? null;
    const bounds = dragBoundsRef.current;
    if (!bounds) return;
    const width = railWidthFromPointer({
      containerRight: bounds.right,
      containerWidth: bounds.width,
      pointerX,
    });
    dragWidthRef.current = width;
    railRef.current?.style.setProperty("--rail-w", `${width}px`);
  }, []);
  const persistRailWidth = useCallback(() => {
    dragBoundsRef.current = null;
    const width = dragWidthRef.current;
    dragWidthRef.current = null;
    if (width === null) return; // pointerdown without movement - nothing to commit
    setRailWidth(width);
    localStorage.setItem("skynet.rail-width", String(width));
  }, []);
  const resetRailWidth = useCallback(() => {
    dragBoundsRef.current = null;
    dragWidthRef.current = null;
    // Clear the imperative var too: a drag that was never committed lives only
    // on the element, where React's style diffing would not remove it.
    railRef.current?.style.removeProperty("--rail-w");
    setRailWidth(null);
    localStorage.removeItem("skynet.rail-width");
  }, []);
  function resizeRailWithKeyboard(key: string) {
    const containerMax = bodyRef.current
      ? Math.min(bodyRef.current.getBoundingClientRect().width * 0.6, RAIL_MAX)
      : RAIL_MAX;
    const current = railWidth ?? Math.min(RAIL_DEFAULT, containerMax);
    const next = railWidthForKey({ key, current, maximum: containerMax });
    if (next === null) return;
    const rounded = Math.round(next);
    setRailWidth(rounded);
    localStorage.setItem("skynet.rail-width", String(rounded));
  }
  // Canonical workpieces opened from the conversation into the Workspace surface.
  // Every open workpiece stays mounted (visibility-toggled) so a tab switch never
  // drops in-flight edits; the Workspace tab appears only once one is open.
  const [openWorkpieces, setOpenWorkpieces] = useState<OpenWorkpieceTab[]>([]);
  const [activeWorkpieceId, setActiveWorkpieceId] = useState<string | null>(null);
  const [workspaceEverOpened, setWorkspaceEverOpened] = useState(false);
  // Tabs auto-opened without stealing focus (the user was mid-edit): flagged in
  // the strip with a quiet dot until the user visits them.
  const [unseenWorkpieceIds, setUnseenWorkpieceIds] = useState<readonly string[]>([]);
  // Read fresh inside the auto-open callback (fired from the org-change listener,
  // outside React's render closure) without re-creating the handler each render.
  const activeWorkpieceIdRef = useRef(activeWorkpieceId);
  activeWorkpieceIdRef.current = activeWorkpieceId;
  const workspaceDirtyRef = useRef<Map<string, boolean>>(new Map());
  // Lets a rail surface (e.g. a conflicted workpiece proposal) seed the reply
  // composer. The nonce re-applies a repeat of the same text; SessionView owns it
  // and hands the setter to the rail via context.
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  const prefillComposer = useCallback((text: string) => {
    setComposerPrefill((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Default to whichever pane actually has content; an explicit pick wins.
  // A quiet thread starts on the provider-neutral surface chooser.
  const [railTabOverride, setRailTabOverride] = useState<SurfaceChoice | "editor" | "workspace" | null>(
    null,
  );
  const railTab =
    railTabOverride ??
    (hasSubagents ? "agents" : hasFiles ? "artifacts" : hasCommands ? "terminal" : null);
  // Mobile sheet grammar: the chooser card grid is a md+ surface - the sheet's
  // pill tabs ARE the chooser on a phone, so opening on a quiet thread lands on
  // a concrete tab (Files); the pane body's null branch falls back the same way.
  const openMobileSurfaces = useCallback(() => {
    setRailOverride(true);
    if (railTab === null) setRailTabOverride("artifacts");
  }, [railTab]);

  const openWorkpiece = useCallback((artifact: TimelineArtifact) => {
    setOpenWorkpieces((prev) =>
      prev.some((w) => w.id === artifact.id) ? prev : [...prev, { id: artifact.id, name: artifact.name }],
    );
    setActiveWorkpieceId(artifact.id);
    setUnseenWorkpieceIds((ids) => ids.filter((id) => id !== artifact.id));
    setRailOverride(true);
    setRailTabOverride("workspace");
  }, []);
  // Selecting a tab clears its unseen dot.
  const selectWorkpiece = useCallback((id: string) => {
    setActiveWorkpieceId(id);
    setUnseenWorkpieceIds((ids) => ids.filter((x) => x !== id));
  }, []);
  const handleWorkspaceDirtyChange = useCallback((id: string, dirty: boolean) => {
    workspaceDirtyRef.current.set(id, dirty);
  }, []);
  // Auto-open a workpiece the agent just published in THIS thread. Default: bring
  // the new tab forward (open the rail on Workspace, focus the tab). Exception: if
  // the user is actively editing a workspace surface (it holds focus AND is dirty),
  // add the tab quietly with an unseen dot instead of yanking their caret away.
  const autoOpenWorkpiece = useCallback((tab: OpenWorkpieceTab) => {
    setOpenWorkpieces((prev) => (prev.some((w) => w.id === tab.id) ? prev : [...prev, tab]));
    setRailOverride(true);
    const activeId = activeWorkpieceIdRef.current;
    const dirty = activeId ? (workspaceDirtyRef.current.get(activeId) ?? false) : false;
    if (shouldFocusAutoOpened({ dirty, focused: workspaceSurfaceHasFocus() })) {
      setActiveWorkpieceId(tab.id);
      setUnseenWorkpieceIds((ids) => ids.filter((id) => id !== tab.id));
      setRailTabOverride("workspace");
    } else {
      setUnseenWorkpieceIds((ids) => (ids.includes(tab.id) ? ids : [...ids, tab.id]));
    }
  }, []);
  useWorkpieceAutoOpen(rootId, autoOpenWorkpiece);
  const closeWorkpiece = useCallback(
    (id: string) => {
      const remaining = openWorkpieces.filter((w) => w.id !== id);
      setOpenWorkpieces(remaining);
      setUnseenWorkpieceIds((ids) => ids.filter((x) => x !== id));
      workspaceDirtyRef.current.delete(id);
      if (activeWorkpieceId === id) {
        setActiveWorkpieceId(remaining[remaining.length - 1]?.id ?? null);
      }
      // The Workspace tab disappears with its last workpiece; land on Files.
      if (remaining.length === 0 && railTabOverride === "workspace") setRailTabOverride("artifacts");
    },
    [activeWorkpieceId, openWorkpieces, railTabOverride],
  );
  const railTabLabel =
    railTab === null
      ? "Surface"
      : railTab === "agents"
        ? "Agents"
        : railTab === "artifacts"
          ? "Files"
          : railTab === "diff"
            ? "Diff"
            : railTab === "editor"
              ? "Editor"
              : railTab === "workspace"
                ? "Workspace"
                : railTab === "terminal"
                  ? "Terminal"
                  : "Desktop";
  const [desktopEverOpened, setDesktopEverOpened] = useState(false);
  useEffect(() => {
    if (railTab === "desktop") setDesktopEverOpened(true);
    if (railTab === "workspace") setWorkspaceEverOpened(true);
  }, [railTab]);
  useEffect(() => {
    if (!railOpen && railExpanded) setRailExpanded(false);
  }, [railExpanded, railOpen]);
  useEffect(() => {
    if (!railExpanded) return;
    const restoreOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailExpanded(false);
    };
    window.addEventListener("keydown", restoreOnEscape);
    return () => window.removeEventListener("keydown", restoreOnEscape);
  }, [railExpanded]);
  // Expand/Restore is md+ grammar; entering the phone layout drops it so the
  // conversation (which railExpanded hides) can never be stranded off-screen.
  useEffect(() => {
    if (isMobile && railExpanded) setRailExpanded(false);
  }, [isMobile, railExpanded]);
  // The mobile sheet dismisses like the nav drawer: Close X, backdrop, or Escape.
  useEffect(() => {
    if (!isMobile || !mobileSurfacesOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailOverride(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isMobile, mobileSurfacesOpen]);

  // Slash-command catalog for the reply composer's "/" autocomplete - the SELECTED engine's
  // real native commands, capability-driven (no provider-name gate). Authoritative source is
  // the DURABLE canonical stream's per-session `commands.updated`, SESSION-SCOPED to the current
  // native session so a historical or other-session snapshot can NEVER mask the active session
  // (a restarted/new session that has not re-advertised falls back to the pre-session priming
  // fetch rather than showing stale commands). The live session snapshot always wins; the priming
  // fetch (GET /api/commands, keyed by engine - one path for OpenCode/Claude/Codex, no per-engine
  // side channel) only primes until this session advertises. `resolveCommandCatalog` folds both
  // into one honest state (loading / unavailable / error / ready[+stale]).
  const engine = normalizeEngine(newest.engine);
  const durableCommands = useMemo(
    () => selectSessionCommands([...snapshot.byId.values()], engineSessionId),
    [snapshot.byId, engineSessionId],
  );
  const hasDurable = durableCommands !== null;
  const [fetchState, setFetchState] = useState<{
    phase: "loading" | "done" | "error";
    commands: CanonicalCommandView[];
  }>({
    phase: "loading",
    commands: [],
  });
  useEffect(() => {
    if (hasDurable) return; // the durable session catalog wins; no priming fetch needed
    let cancelled = false;
    // Clear-on-change: reset immediately so a prior engine's commands never linger while loading.
    setFetchState({ phase: "loading", commands: [] });
    void (async () => {
      const fail = () => !cancelled && setFetchState({ phase: "error", commands: [] });
      try {
        // ONE pre-session priming path for every engine: the org/snapshot catalog via GET
        // /api/commands (keyed by engine). The durable per-session `commands.updated` (now emitted
        // by opencode too, C5) is authoritative and supersedes this the moment the session advertises.
        const res = await backendFetch(`/api/commands?engine=${encodeURIComponent(engine)}`);
        if (!res.ok) return fail();
        const list =
          (
            (await res.json()) as {
              commands?: { name?: string; description?: string; input?: string }[];
            }
          ).commands ?? [];
        if (cancelled) return;
        if (!Array.isArray(list)) return fail();
        setFetchState({
          phase: "done",
          commands: list
            .filter((c): c is { name: string; description?: string; input?: string } => !!c.name)
            .map((c) => ({
              name: c.name,
              description: c.description ?? null,
              input: typeof c.input === "string" ? c.input : null,
            })),
        });
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, hasDurable]);
  // Memoized so the memoized Conversation sees stable prop identities between
  // catalog changes (a re-render here must not re-render the whole timeline).
  const catalogState = useMemo(
    () => resolveCommandCatalog(durableCommands, fetchState, engine),
    [durableCommands, fetchState, engine],
  );
  const commands: SlashCommand[] = useMemo(
    () =>
      catalogState.status === "ready"
        ? catalogState.commands.map((c) => ({ name: c.name, description: c.description ?? null }))
        : [],
    [catalogState],
  );

  return (
    <WorkspaceOpenProvider value={openWorkpiece}>
      <ComposerPrefillProvider value={prefillComposer}>
      {/* The thread's current/latest run, so an agent proposal that lands on an
          open workpiece can tell a requested edit (from the user's own last
          message's run) from an unsolicited one. */}
      <SessionLatestRunProvider value={newest.id}>
      <div className="flex h-full flex-col">
      {/* Compact thread bar. Brand and search belong to the collapsible sidebar. */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-mono-label text-text-tertiary">Session</span>
          {/* The thread's git identity: repos (+ chosen branch) come from the
              ROOT run's durable wire row - repos are inherited across a thread,
              so the SSR-provided root is authoritative for the page lifetime. */}
          <GitChips refs={runGitRefs(root)} />
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <StatusPill status={threadStatus} />
          {/* Stop lives in the composer send button (running+empty -> red Stop),
              threaded through Conversation. The old top-bar Stop was removed so
              there is exactly ONE Stop affordance (user: "i mean stop here"). */}
          <Link
            href="/agent/new"
            aria-label="New session"
            className="flex items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 py-1.5 text-caption-1-medium text-text-secondary shadow-xs transition-colors hover:border-border-button-hover hover:bg-background-primary-hover"
          >
            <RiAddLine className="size-4" aria-hidden />
            <span className="hidden sm:inline">New session</span>
          </Link>
          {/* Below md the surfaces rail is a slide-over sheet; this is its
              opener (the rail's own reopen strip covers md+). */}
          {hasRuntimeSurfaces && !mobileSurfacesOpen && (
            <Button
              variant="ghost"
              size="small"
              iconOnly
              leadingIcon={RiLayoutRightLine}
              onClick={openMobileSurfaces}
              title="Open surfaces panel"
              aria-label="Open surfaces panel"
              className="md:hidden"
            />
          )}
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
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Conversation */}
        <section
          aria-hidden={railExpanded}
          className={cx(
            // min-h-0 (not a vh block) below md too: the conversation is the ONLY
            // in-flow surface on a phone, so this column fills main exactly and
            // its internal scroller pins the composer to the viewport bottom.
            // md:min-w-80 floors the tablet split so a wide rail cannot crush it.
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:min-w-80",
            railExpanded && "hidden",
          )}
        >
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
            commandState={catalogState}
            modelSelection={modelSelection}
            onReply={handleReply}
            pendingQuestion={activeQuestion?.request ?? null}
            answeringQuestion={answeringQuestion}
            questionError={questionError}
            onAnswerQuestion={handleAnswerQuestion}
            pendingApproval={activeApproval?.request ?? null}
            answeringApproval={answeringApproval}
            approvalError={approvalError}
            onAnswerApproval={handleAnswerApproval}
            gatewayApprovals={gatewayApprovals}
            onGatewayApprovalResolved={handleGatewayApprovalResolved}
            sendNowFor={runningTurn ? headQueuedId : null}
            onSendNow={handleSendNow}
            running={runningTurn !== null}
            runStartedAt={runningTurn?.run.created_at ?? null}
            stopping={stopping}
            stopError={stopError}
            onStop={handleStop}
            prefill={composerPrefill}
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

        {railOpen && !railExpanded && (
          <RailResizer
            value={railWidth ?? RAIL_DEFAULT}
            onMove={resizeRailFromPointer}
            onCommit={persistRailWidth}
            onKeyDown={resizeRailWithKeyboard}
            onReset={resetRailWidth}
          />
        )}

        {/* Sheet backdrop (<md only): same dismiss grammar as the nav drawer. */}
        {railOpen && mobileSurfacesOpen && (
          <button
            type="button"
            aria-label="Close surfaces panel"
            onClick={() => setRailOverride(false)}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          />
        )}

        {railOpen ? (
          // ONE bordered panel: the Editor|Terminal switcher + collapse live in
          // its header; the active pane fills the body bare (its own border/round
          // is dropped so this panel owns the single card edge).
          <section
            ref={railRef}
            inert={isMobile && !mobileSurfacesOpen}
            aria-hidden={isMobile && !mobileSurfacesOpen ? true : undefined}
            style={
              railWidth !== null
                ? ({ "--rail-w": `${railWidth}px` } as React.CSSProperties)
                : undefined
            }
            className={cx(
              // transition-[width] smooths the expand/collapse toggle only; while
              // the grip (the `peer` before this section) reports data-dragging,
              // the transition is suppressed so the edge tracks the pointer
              // exactly and the terminal's ResizeObserver stops firing the
              // moment the pointer stops (no post-drag animation tail).
              "bg-background-primary-default flex min-h-0 min-w-0 flex-col overflow-hidden transition-[width] peer-data-[dragging=true]:transition-none",
              // Below md this SAME panel is a bottom slide-over sheet (fixed,
              // safe-area padded, pill-tab header unchanged) with a translate-y
              // open/close transition per the subagent-pane mechanics.
              "max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-50 max-md:h-[85dvh] max-md:rounded-t-2xl max-md:border-t max-md:border-border-button-default max-md:pb-[env(safe-area-inset-bottom)] max-md:transition-transform max-md:duration-300 max-md:ease-out",
              mobileSurfacesOpen
                ? "max-md:translate-y-0"
                : "max-md:pointer-events-none max-md:translate-y-full",
              railExpanded
                ? "flex-1 md:w-auto"
                : // Width always reads the var (drag writes it imperatively even
                  // before any committed state); 360px is the uncustomized default.
                  // The calc ceiling pairs with the conversation's md:min-w-80
                  // floor so a persisted width can never overflow the split.
                  "md:w-[var(--rail-w,360px)] md:max-w-[calc(100%-20rem)] md:shrink-0",
            )}
          >
            <div className="border-border-button-default/50 flex shrink-0 items-center gap-2 border-b p-2">
              <PillTabList aria-label="Surface" className="min-w-0 flex-1 overflow-x-auto">
                {/* Agents leads the switcher, but only once a run has fanned
                    out — no empty tab before then. */}
                {hasSubagents && (
                  <PillTab
                    icon={RiRobot2Line}
                    isSelected={railTab === "agents"}
                    onSelect={() => setRailTabOverride("agents")}
                    data-testid="rail-tab-agents"
                  >
                    Agents
                  </PillTab>
                )}
                <PillTab
                  icon={RiFileList2Line}
                  isSelected={railTab === "artifacts"}
                  onSelect={() => setRailTabOverride("artifacts")}
                  data-testid="rail-tab-artifacts"
                >
                  Files
                </PillTab>
                {/* Workspace holds the canonical workpieces the user opened from
                    the conversation - only present once at least one is open. */}
                {openWorkpieces.length > 0 && (
                  <PillTab
                    icon={RiPagesLine}
                    isSelected={railTab === "workspace"}
                    onSelect={() => setRailTabOverride("workspace")}
                    data-testid="rail-tab-workspace"
                  >
                    Workspace
                  </PillTab>
                )}
                {/* Diff appears once a real change set exists - the chooser
                    card's "available when a real patch exists" promise. */}
                {hasFiles && (
                  <PillTab
                    icon={RiGitMergeLine}
                    isSelected={railTab === "diff"}
                    onSelect={() => setRailTabOverride("diff")}
                    data-testid="rail-tab-diff"
                  >
                    Diff
                  </PillTab>
                )}
                <PillTab
                  icon={RiCodeSSlashLine}
                  isSelected={railTab === "editor"}
                  onSelect={() => setRailTabOverride("editor")}
                  data-testid="rail-tab-editor"
                >
                  Editor
                </PillTab>
                <PillTab
                  icon={RiTerminalBoxLine}
                  isSelected={railTab === "terminal"}
                  onSelect={() => setRailTabOverride("terminal")}
                  data-testid="rail-tab-terminal"
                >
                  Terminal
                </PillTab>
                {/* Desktop is a stable product surface. The pane itself waits
                    for or wakes the thread's sandbox on demand. */}
                <PillTab
                  icon={RiComputerLine}
                  isSelected={railTab === "desktop"}
                  onSelect={() => setRailTabOverride("desktop")}
                  data-testid="rail-tab-desktop"
                >
                  Browser
                </PillTab>
              </PillTabList>
              <Button
                variant="ghost"
                size="small"
                iconOnly
                leadingIcon={railExpanded ? RiCollapseDiagonal2Line : RiExpandDiagonal2Line}
                onClick={() => setRailExpanded((expanded) => !expanded)}
                title={railExpanded ? "Restore panel" : `Expand ${railTabLabel}`}
                aria-label={
                  railExpanded
                    ? `Restore ${railTabLabel} panel to side rail`
                    : `Expand ${railTabLabel} panel to main canvas`
                }
                aria-pressed={railExpanded}
                aria-keyshortcuts={railExpanded ? "Escape" : undefined}
                className="hidden shrink-0 md:flex"
              />
              <Button
                variant="ghost"
                size="small"
                iconOnly
                leadingIcon={RiLayoutRightLine}
                onClick={() => {
                  setRailExpanded(false);
                  setRailOverride(false);
                }}
                title="Collapse panel"
                aria-label="Collapse side panel"
                className="hidden shrink-0 md:flex"
              />
              {/* On the phone sheet a single Close X replaces Expand/Collapse. */}
              <CloseButton
                size="md"
                aria-label="Close surfaces panel"
                onClick={() => setRailOverride(false)}
                className="md:hidden"
              />
            </div>
            <div className="relative min-h-0 flex-1">
              {/* Browser work starts only after an explicit selection. Once
                  opened, keep noVNC mounted across tab switches to preserve the
                  visible desktop and its WebSocket. */}
              {desktopEverOpened ? (
                <div
                  aria-hidden={railTab !== "desktop"}
                  className={cx(
                    "absolute inset-0",
                    railTab === "desktop" ? "visible" : "pointer-events-none invisible",
                  )}
                >
                  <DesktopPane threadId={rootId} />
                </div>
              ) : null}
              {/* Workspace stays mounted once opened (like Desktop) so switching
                  rail tabs never discards a workpiece editor's in-flight edits. */}
              {workspaceEverOpened ? (
                <div
                  aria-hidden={railTab !== "workspace"}
                  className={cx(
                    "absolute inset-0",
                    railTab === "workspace" ? "visible" : "pointer-events-none invisible",
                  )}
                >
                  <WorkspacePane
                    tabs={openWorkpieces}
                    activeId={activeWorkpieceId}
                    unseenIds={unseenWorkpieceIds}
                    onSelect={selectWorkpiece}
                    onClose={closeWorkpiece}
                    onDirtyChange={handleWorkspaceDirtyChange}
                  />
                </div>
              ) : null}
              {railTab !== "desktop" && railTab !== "workspace" && (
                <div className="absolute inset-0">
                  {railTab === null ? (
                    // The chooser card grid is md+ grammar; in the phone sheet
                    // the pill tabs ARE the chooser, so a null tab lands on
                    // Files instead of a full-screen card grid.
                    isMobile ? (
                      <ArtifactsRail threadId={rootId} live={live} />
                    ) : (
                      <SurfaceChooser
                        agentsAvailable={hasSubagents}
                        diffAvailable={hasFiles}
                        onSelect={setRailTabOverride}
                      />
                    )
                  ) : railTab === "agents" ? (
                    <AgentsRail
                      steps={allSteps}
                      live={live}
                      frames={allFrames}
                      canonicalEvents={allCanonicalEvents}
                    />
                  ) : railTab === "artifacts" ? (
                    <ArtifactsRail threadId={rootId} live={live} />
                  ) : railTab === "diff" ? (
                    <DiffPane turns={turns} />
                  ) : railTab === "editor" ? (
                    <EditorPane steps={allSteps} live={live} />
                  ) : (
                    <TerminalPane
                      steps={allSteps}
                      live={live}
                      engine={newest.engine}
                      runId={terminalRunId}
                    />
                  )}
                </div>
              )}
            </div>
          </section>
        ) : hasRuntimeSurfaces ? (
          <button
            type="button"
            onClick={() => setRailOverride(true)}
            title="Open the editor/terminal panel"
            aria-label="Open side panel"
            className="hidden shrink-0 flex-col items-center gap-3 rounded-2xl border border-border-button-default bg-background-primary-default px-2 py-4 text-foreground-icon-tertiary transition-colors hover:bg-background-primary-hover hover:text-foreground-icon-secondary md:flex"
          >
            <RiCodeSSlashLine className="size-4" aria-hidden />
            <RiFileList2Line className="size-4" aria-hidden />
            <RiTerminalBoxLine className="size-4" aria-hidden />
            <RiComputerLine className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
      </div>
      </SessionLatestRunProvider>
      </ComposerPrefillProvider>
    </WorkspaceOpenProvider>
  );
}
