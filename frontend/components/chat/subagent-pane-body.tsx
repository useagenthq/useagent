"use client";

import { useCallback, useEffect, useState } from "react";
import { RiArrowRightLine, RiRobot2Line } from "@remixicon/react";
import { decodeApiRun } from "@useagent/agent-client";
import Link from "next/link";
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
import {
  CloseButton,
  openSubagentPane,
  PaneStub,
  statusTone,
} from "@/components/chat/subagent-pane";

/**
 * The loaded half of the peek pane: fetches the run, then streams its step rows.
 * Child-only controls and the run stream stay out of every route's initial
 * bundle (the shell in subagent-pane.tsx is what every page mounts).
 */
export default function SubagentPaneBody({
  runId,
  childSession = false,
}: {
  runId: string;
  childSession?: boolean;
}) {
  const [run, setRun] = useState<ApiRun | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setErrored(false);
    (async () => {
      try {
        const res = await backendFetch(`/api/runs/${runId}`);
        if (!res.ok) throw new Error(`backend ${res.status}`);
        const data = decodeApiRun(await res.json());
        if (!data) throw new Error("invalid run response");
        if (!cancelled) setRun(data);
      } catch {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (errored) {
    return (
      <PaneStub childSession={childSession}>
        <p className="text-body-2-regular text-text-secondary text-center">
          Couldn&apos;t load this run.
        </p>
      </PaneStub>
    );
  }
  if (!run) {
    return (
      <PaneStub childSession={childSession}>
        <LoadingState label="Loading helper agent" />
      </PaneStub>
    );
  }
  return <LoadedPane key={run.id} initialRun={run} />;
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

/**
 * The live inner pane once the run is loaded. Owns the SSE subscription so the
 * trace streams in real time. Gateway children also get the pass-down composer.
 */
export function LoadedPane({ initialRun }: { initialRun: ApiRun }) {
  const { steps, status, summary, live } = useRunStream(initialRun);
  const childSession = initialRun.child_session === true;
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
            <span className="text-mono-label text-text-tertiary">
              {childSession ? "Subagent" : "Session"}
            </span>
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
        {childSession ? (
          <Composer
            variant="compact"
            placeholder="Pass instructions down…"
            defaultEngine={initialRun.engine}
            pending={sending}
            onSubmit={passDown}
          />
        ) : (
          <Link
            href={`/session/${initialRun.thread_id}`}
            className="text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-body-2-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            Open thread
            <RiArrowRightLine className="size-4 shrink-0" aria-hidden />
          </Link>
        )}
      </div>
    </>
  );
}
