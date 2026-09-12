"use client";

import { RiArrowLeftLine, RiArrowRightLine, RiExternalLinkLine, RiRobot2Line } from "@remixicon/react";
import { decodeApiRun, type ThreadRelationship } from "@useagent/agent-client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LoadingState } from "@/components/ai/loading-state";
import { childKindLabel } from "@/components/chat/child-labels";
import { RUN_STATUS_LABEL } from "@/components/chat/gateway-children";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import type { ApiRun } from "@/components/chat/types";
import { useRunStream } from "@/components/chat/use-run-stream";
import { StatusDot } from "@/components/shared/status-dot";
import {
  CHILD_META_CLASS,
  formatChildEngineModel,
  STATUS_TONE,
} from "@/components/session-ui/agent-panel-row";
import { backendFetch } from "@/lib/backend-fetch";
import { cx as cn } from "@/utils/cx";

const runTone = (status: ApiRun["status"]) =>
  STATUS_TONE[status === "queued" ? "pending" : status];

/** The rail detail is inspect-only: replies happen in the thread itself. */
export function ProductChildDetailBody({
  initialRun,
  relationship,
  onBack,
}: {
  initialRun: ApiRun;
  relationship: ThreadRelationship;
  onBack: () => void;
}) {
  const { steps, status, summary, live, liveText } = useRunStream(initialRun);
  const activity = steps.filter((step) => step.kind !== "done");
  const href = `/session/${relationship.threadId}`;
  const kind = relationship.bot ? "bot_thread" : "child_thread";
  // One truncating line: status word, what this is, engine and model.
  const caption = [
    RUN_STATUS_LABEL[status],
    childKindLabel(kind, relationship.bot?.name),
    formatChildEngineModel(initialRun.engine, initialRun.model),
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <header className="border-border-button-default flex shrink-0 items-start gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents list"
          className="text-text-secondary hover:bg-background-secondary-hover mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
        >
          <RiArrowLeftLine className="size-4" aria-hidden />
        </button>
        <span className="bg-background-secondary-default text-foreground-icon-secondary mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
          <RiRobot2Line className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-body-2-medium text-text-primary block truncate">
            {relationship.title}
          </span>
          <p className={cn(CHILD_META_CLASS, "mt-0.5 flex items-center gap-1.5")}>
            <StatusDot tone={runTone(status)} pulse={live} />
            <span className="min-w-0 truncate">{caption}</span>
          </p>
        </div>
        <Link
          href={href}
          aria-label={`Open ${childKindLabel(kind)}: ${relationship.title}`}
          title="Open thread"
          className="text-text-secondary hover:bg-background-secondary-hover mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiExternalLinkLine className="size-4" aria-hidden />
        </Link>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {(summary ?? liveText) ? (
          <section className="border-border-button-default bg-background-secondary-default rounded-xl border p-3">
            <p className="text-mono-label text-text-tertiary mb-1">
              {live ? "Working" : status === "failed" ? "Error" : "Answer"}
            </p>
            <p className="text-body-2-regular text-text-primary whitespace-pre-wrap break-words">
              {summary ?? liveText}
            </p>
          </section>
        ) : null}

        {activity.length > 0 ? (
          <div className="space-y-2.5">
            {activity.map((step, index) => (
              <ToolStepRow
                key={step.id}
                step={step}
                state={live && index === activity.length - 1 ? "running" : "done"}
                nested={false}
              />
            ))}
          </div>
        ) : !summary && !liveText ? (
          <p className="text-body-2-regular text-text-tertiary py-6 text-center">
            {live ? "Waiting for the first activity…" : "No child activity recorded."}
          </p>
        ) : null}
      </div>

      <div className="border-border-button-default shrink-0 border-t p-3">
        <Link
          href={href}
          className="text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-body-2-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          Open thread to reply
          <RiArrowRightLine className="size-4 shrink-0" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

export function ProductChildDetail({
  relationship,
  onBack,
}: {
  relationship: ThreadRelationship;
  onBack: () => void;
}) {
  const [run, setRun] = useState<ApiRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRun(null);
    setError(null);
    void backendFetch(`/api/runs/${encodeURIComponent(relationship.latestRunId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`backend ${response.status}`);
        const decoded = decodeApiRun(await response.json());
        if (!decoded) throw new Error("Child run response was invalid");
        if (!controller.signal.aborted) setRun(decoded);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Could not load this child");
        }
      });
    return () => controller.abort();
  }, [relationship.latestRunId]);

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <button type="button" onClick={onBack} className="m-3 self-start text-body-2-medium">
          Back
        </button>
        <p role="alert" className="text-body-2-regular text-text-error-primary p-6 text-center">
          {error}
        </p>
      </div>
    );
  }
  if (!run) return <LoadingState label="Loading child" />;
  return (
    <ProductChildDetailBody
      key={run.id}
      initialRun={run}
      relationship={relationship}
      onBack={onBack}
    />
  );
}
