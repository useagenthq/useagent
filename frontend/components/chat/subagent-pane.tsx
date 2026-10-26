"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { RiCloseLine, RiEyeLine, RiRobot2Line } from "@remixicon/react";
import { cx as cn } from "@/utils/cx";
import { LoadingState } from "@/components/ai/loading-state";
import type { ApiRun, RunStatus } from "@/components/chat/types";

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
 *
 * This module is what every route mounts, so it stays light: the loaded pane
 * (run fetch, run stream, step rows, pass-down composer) lives in
 * subagent-pane-body.tsx and is code-split behind the first open.
 */

/* ------------------------------------------------------------------ store -- */

type PaneTarget = { runId: string; childSession: boolean };

let openTarget: PaneTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Open (or switch) the peek pane onto `runId`. Callable from anywhere. */
export function openSubagentPane(runId: string, childSession = false) {
  if (openTarget?.runId === runId && openTarget.childSession === childSession) return;
  openTarget = { runId, childSession };
  emit();
}

/** Close the peek pane, returning focus to the page underneath. */
export function closeSubagentPane() {
  if (openTarget === null) return;
  openTarget = null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function useOpenTarget(): PaneTarget | null {
  return useSyncExternalStore(
    subscribe,
    () => openTarget,
    () => null,
  );
}

/* ------------------------------------------------------------- primitives -- */

export function statusTone(status: RunStatus): { pill: string; dot: string; pulse: boolean } {
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

export function CloseButton() {
  return (
    <button
      type="button"
      onClick={closeSubagentPane}
      aria-label="Close pane"
      className="text-text-secondary hover:bg-background-secondary-hover flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
    >
      <RiCloseLine className="size-4" aria-hidden />
    </button>
  );
}

/** Header shell reused for the loading / error states (no run loaded yet). */
export function PaneStub({
  children,
  childSession = false,
  label,
}: {
  children: React.ReactNode;
  childSession?: boolean;
  label?: "Run";
}) {
  return (
    <>
      <header className="border-border-button-default flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <span className="text-mono-label text-text-tertiary">
          {label ?? (childSession ? "Subagent" : "Session")}
        </span>
        <span className="ml-auto" />
        <CloseButton />
      </header>
      <div className="flex flex-1 items-center justify-center p-6">{children}</div>
    </>
  );
}

/* ------------------------------------------------------------- pane shell -- */

const SubagentPaneBody = dynamic(() => import("@/components/chat/subagent-pane-body"), {
  ssr: false,
  loading: () => (
    <PaneStub label="Run">
      <LoadingState label="Loading helper agent" />
    </PaneStub>
  ),
});

/**
 * The global, single-instance pane. Renders a fixed right-hand slide-over via a
 * portal, off-screen (`translate-x-full`) and inert until a run id is set. No
 * overlay/backdrop, so the parent session behind it stays interactive.
 */
export function SubagentPane() {
  const target = useOpenTarget();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Esc closes the pane (parent session regains focus).
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSubagentPane();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  if (!mounted) return null;
  const open = target !== null;

  return createPortal(
    <aside
      aria-hidden={!open}
      aria-label={`${target?.childSession ? "Helper agent" : "Conversation"} pane`}
      className={cn(
        "border-border-button-default bg-background-primary-default shadow-sidebar fixed inset-y-0 right-0 z-40 flex h-dvh w-[440px] max-w-[92vw] flex-col border-l",
        "transition-transform duration-300 ease-out",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      {target !== null && (
        <SubagentPaneBody
          key={target.runId}
          runId={target.runId}
          childSession={target.childSession}
        />
      )}
    </aside>,
    document.body,
  );
}

/* ---------------------------------------------------------------- triggers -- */

type ThreadRun = ApiRun;

function SubagentChip({ run }: { run: ThreadRun }) {
  const tone = statusTone(run.status);
  return (
    <button
      type="button"
      onClick={() => openSubagentPane(run.id, true)}
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
 * A strip of durable gateway-child chips for a session. It derives from the
 * `thread` runs the page already owns: the thread SSE stream keeps that set
 * current, so this surface never polls the full thread independently.
 *
 * `parent_run_id` alone is deliberately insufficient because ordinary replies
 * use it too. Only rows explicitly stamped `child_session` are gateway children.
 */
export function SubagentChips({
  rootId,
  thread,
  excludeIds = [],
}: {
  rootId: string;
  thread: readonly ThreadRun[];
  excludeIds?: string[];
}) {
  const exclude = new Set([rootId, ...excludeIds]);
  const subs = thread.filter(
    (run) => run.child_session === true && run.parent_run_id !== null && !exclude.has(run.id),
  );
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
      aria-label="Peek at this task"
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
