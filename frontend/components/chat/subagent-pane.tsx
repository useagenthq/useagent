"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RiCloseLine, RiEyeLine, RiRobot2Line } from "@remixicon/react";
import { backendFetch } from "@/lib/backend-fetch";
import { createRun } from "@/lib/create-run";
import { cx as cn } from "@/utils/cx";
import { Composer } from "@/components/chat/composer";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { LoadingState } from "@/components/ai/loading-state";
import { useRunStream } from "@/components/chat/use-run-stream";
import {
  engineLabel,
  isLiveStatus,
  type ApiRun,
  type EngineId,
  type RunStatus,
} from "@/components/chat/types";
import { deriveSubagents } from "@/components/chat/subagents";

/**
 * Subagent viewing pane — the Omni pattern ported to the web. A subagent (any
 * child/thread run) opens in a *temporary* slide-over on the right so you can
 * watch its work and pass instructions down **without leaving the parent
 * session**: the pane is backdrop-free, so the parent conversation stays fully
 * interactive underneath. Close it (✕ / Esc) and you're exactly where you were.
 *
 * The pane is driven by a tiny module-level store rather than React context so
 * any surface — a subagent chip in the conversation, a "peek" button in the
 * Active-runs list, or a future fan-out UI — can pop it open with a bare
 * `openSubagentPane(runId)` call and no prop-drilling. Mount `<SubagentPane />`
 * exactly once (globally, in the provider stack).
 */

/* ------------------------------------------------------------------ store -- */

let openRunId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Open (or switch) the subagent pane onto `runId`. Callable from anywhere. */
export function openSubagentPane(runId: string) {
  if (openRunId === runId) return;
  openRunId = runId;
  emit();
}

/** Close the subagent pane, returning focus to the parent session. */
export function closeSubagentPane() {
  if (openRunId === null) return;
  openRunId = null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function useOpenRunId(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => openRunId,
    () => null,
  );
}

/* ------------------------------------------------------------- primitives -- */

function statusTone(status: RunStatus): { pill: string; dot: string; pulse: boolean } {
  switch (status) {
    case "queued":
    case "running":
      return { pill: "bg-blue-50 text-blue-500", dot: "bg-blue-500", pulse: true };
    case "completed":
      return { pill: "bg-green-50 text-green-600", dot: "bg-green-500", pulse: false };
    case "failed":
      return { pill: "bg-red-50 text-red-600", dot: "bg-red-500", pulse: false };
  }
}

function StatusPill({ status }: { status: RunStatus }) {
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-caption-1-medium capitalize",
        tone.pill,
      )}
    >
      {isLiveStatus(status) && (
        <span className={cn("ai-loading-pixel size-1.5 rounded-full", tone.dot)} />
      )}
      {status}
    </span>
  );
}

function CloseButton() {
  return (
    <button
      type="button"
      onClick={closeSubagentPane}
      aria-label="Close subagent pane"
      className="text-text-secondary hover:bg-background-secondary-hover flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
    >
      <RiCloseLine className="size-4" aria-hidden />
    </button>
  );
}

/* -------------------------------------------------------------- pane body -- */

/**
 * The live inner pane once the child run is loaded. Owns the SSE subscription
 * (via `useRunStream`) so the trace streams in real time, and the pass-down
 * composer that spawns a further child and follows it in-place.
 */
function SubagentPaneBody({ initialRun }: { initialRun: ApiRun }) {
  const { steps, status, summary, live } = useRunStream(initialRun);
  const [sending, setSending] = useState(false);
  const activity = steps.filter((s) => s.kind !== "done");
  // Prefer native child-session grouping where available: when this run fanned
  // out, indent each nested step under the subagent whose native child session
  // it ran in (falls back to the "↳ " label indent for pre-native-stamp runs).
  const { ownerByStep } = deriveSubagents(steps);

  const passDown = useCallback(
    async (text: string, engine: EngineId, _model: string, idempotencyKey: string) => {
      setSending(true);
      try {
        const res = await createRun(
          {
            prompt: text,
            engine,
            parent_run_id: initialRun.id,
          },
          idempotencyKey,
        );
        if (!res.ok) throw new Error(`backend ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        // Follow the freshly-spawned child in-pane (remounts this body).
        openSubagentPane(id);
      } catch {
        setSending(false);
      }
    },
    [initialRun.id],
  );

  return (
    <>
      <header className="border-border-button-default flex shrink-0 items-start gap-2.5 border-b px-4 py-3">
        <span className="bg-background-secondary-default text-foreground-icon-secondary mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
          <RiRobot2Line className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-mono-label text-text-tertiary">Subagent</span>
            <span className="text-text-tertiary">·</span>
            <span className="text-mono-label text-text-tertiary">
              {engineLabel(initialRun.engine)}
            </span>
            <StatusPill status={status} />
          </div>
          <p className="text-body-2-medium text-text-primary mt-1 line-clamp-2">
            {initialRun.prompt}
          </p>
        </div>
        <CloseButton />
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {summary && (
          <p className="text-body-2-regular text-text-secondary border-border-button-default border-b pb-3">
            {summary}
          </p>
        )}

        {activity.length === 0 ? (
          <p className="text-body-2-regular text-text-tertiary py-6 text-center">
            {live ? "Waiting for the first step…" : "No activity recorded."}
          </p>
        ) : (
          <div className="space-y-2.5">
            {activity.map((step, i) => (
              <ToolStepRow
                key={step.id}
                step={step}
                state={live && i === activity.length - 1 ? "running" : "done"}
                nested={ownerByStep.has(step.id) ? true : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <div className="border-border-button-default shrink-0 border-t p-3">
        <Composer
          variant="compact"
          placeholder="Pass instructions down…"
          defaultEngine={initialRun.engine}
          pending={sending}
          onSubmit={passDown}
        />
      </div>
    </>
  );
}

/** Header shell reused for the loading / error states (no run loaded yet). */
function PaneStub({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-border-button-default flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <span className="text-mono-label text-text-tertiary">Subagent</span>
        <span className="ml-auto" />
        <CloseButton />
      </header>
      <div className="flex flex-1 items-center justify-center p-6">{children}</div>
    </>
  );
}

/* ------------------------------------------------------------- pane shell -- */

/**
 * The global, single-instance pane. Renders a fixed right-hand slide-over via a
 * portal, off-screen (`translate-x-full`) and inert until a run id is set. No
 * overlay/backdrop, so the parent session behind it stays interactive.
 */
export function SubagentPane() {
  const runId = useOpenRunId();
  const [mounted, setMounted] = useState(false);
  const [run, setRun] = useState<ApiRun | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => setMounted(true), []);

  // Fetch the run to view whenever the target id changes.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setRun(null);
    setErrored(false);
    (async () => {
      try {
        const res = await backendFetch(`/api/runs/${runId}`);
        if (!res.ok) throw new Error(`backend ${res.status}`);
        const data = (await res.json()) as ApiRun;
        if (!cancelled) setRun(data);
      } catch {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Esc closes the pane (parent session regains focus).
  useEffect(() => {
    if (!runId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSubagentPane();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runId]);

  if (!mounted) return null;
  const open = runId !== null;

  return createPortal(
    <aside
      aria-hidden={!open}
      aria-label="Subagent pane"
      className={cn(
        "border-border-button-default bg-background-primary-default shadow-sidebar fixed inset-y-0 right-0 z-40 flex h-dvh w-[440px] max-w-[92vw] flex-col border-l",
        "transition-transform duration-300 ease-out",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      {open &&
        (run ? (
          <SubagentPaneBody key={run.id} initialRun={run} />
        ) : errored ? (
          <PaneStub>
            <p className="text-body-2-regular text-text-secondary text-center">
              Couldn&apos;t load this run.
            </p>
          </PaneStub>
        ) : (
          <PaneStub>
            <LoadingState label="Loading run" />
          </PaneStub>
        ))}
    </aside>,
    document.body,
  );
}

/* ---------------------------------------------------------------- triggers -- */

/** A run carrying the (forthcoming) threading fields. */
type ThreadRun = ApiRun & {
  parent_run_id?: string | null;
  thread_id?: string | null;
};
type ThreadEnvelope = ApiRun & { thread?: ThreadRun[] };

function SubagentChip({ run }: { run: ThreadRun }) {
  const tone = statusTone(run.status);
  return (
    <button
      type="button"
      onClick={() => openSubagentPane(run.id)}
      title={run.prompt}
      className="border-border-button-default bg-background-primary-default text-text-secondary hover:bg-background-primary-hover inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-caption-1-medium transition-colors"
    >
      <RiRobot2Line className="text-purple-500 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 max-w-[16rem] truncate">{run.prompt}</span>
      <span
        className={cn("size-1.5 shrink-0 rounded-full", tone.dot, tone.pulse && "animate-pulse")}
        aria-hidden
      />
    </button>
  );
}

/**
 * A strip of subagent chips for a session. Polls `GET /api/runs/:id?thread=1`
 * for the thread rooted at `rootId` and renders every related run that is *not*
 * already shown inline in the conversation (`excludeIds`) as a clickable chip —
 * i.e. genuine fan-out subagents beyond the main reply line. Clicking a chip
 * opens that run in the pane.
 *
 * The linear conversation already renders its own thread turns, so excluding
 * them keeps this strip free of duplicates. It renders nothing until threading
 * lands (no `thread` array → nothing extra), so it is safe to mount today.
 */
export function SubagentChips({
  rootId,
  excludeIds = [],
}: {
  rootId: string;
  excludeIds?: string[];
}) {
  const [thread, setThread] = useState<ThreadRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await backendFetch(`/api/runs/${rootId}?thread=1`);
        if (!res.ok) return;
        const data = (await res.json()) as ThreadEnvelope;
        if (!cancelled) setThread(Array.isArray(data.thread) ? data.thread : []);
      } catch {
        // threading not live yet — leave the strip empty
      }
    };
    void load();
    const timer = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rootId]);

  const exclude = new Set([rootId, ...excludeIds]);
  const subs = thread.filter((r) => !exclude.has(r.id));
  if (subs.length === 0) return null;

  return (
    <div className="border-border-button-default bg-background-primary-default flex shrink-0 items-center gap-2 overflow-x-auto border-b px-4 py-2">
      <span className="text-mono-label text-text-tertiary shrink-0">Subagents</span>
      {subs.map((c) => (
        <SubagentChip key={c.id} run={c} />
      ))}
    </div>
  );
}

/**
 * Generic "peek" affordance — opens any run id in the pane temporarily. Wired
 * into the Active-runs rows so you can inspect a run without navigating away,
 * and reusable by any future fan-out UI.
 */
export function SubagentPeekButton({
  runId,
  className,
}: {
  runId: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Peek run"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openSubagentPane(runId);
      }}
      className={cn(
        "text-text-tertiary hover:bg-background-primary-hover hover:text-text-secondary flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
        className,
      )}
    >
      <RiEyeLine className="size-4" aria-hidden />
    </button>
  );
}
