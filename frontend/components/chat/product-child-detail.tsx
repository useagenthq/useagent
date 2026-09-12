"use client";

import { RiArrowLeftLine, RiRobot2Line } from "@remixicon/react";
import { decodeApiRun, type ThreadRelationship } from "@useagent/agent-client";
import { useEffect, useState } from "react";
import { LoadingState } from "@/components/ai/loading-state";
import { Composer } from "@/components/chat/composer";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { type ApiRun, engineLabel } from "@/components/chat/types";
import { useRunStream } from "@/components/chat/use-run-stream";
import { StatusDot } from "@/components/shared/status-dot";
import { STATUS_TONE } from "@/components/session-ui/agent-panel-row";
import { backendFetch } from "@/lib/backend-fetch";
import { createThreadMessage, runCreateFailureMessage } from "@/lib/create-run";

const runTone = (status: ApiRun["status"]) =>
  STATUS_TONE[status === "queued" ? "pending" : status];

export function ProductChildDetailBody({
  initialRun,
  relationship,
  onBack,
  onRunAccepted,
}: {
  initialRun: ApiRun;
  relationship: ThreadRelationship;
  onBack: () => void;
  onRunAccepted: (run: ApiRun) => void;
}) {
  const { steps, status, summary, live, liveText } = useRunStream(initialRun);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const activity = steps.filter((step) => step.kind !== "done");

  const send = async (
    text: string,
    _engine: ApiRun["engine"],
    _model: string,
    idempotencyKey: string,
  ) => {
    setSending(true);
    setSendError(null);
    try {
      const response = await createThreadMessage(
        relationship.threadId,
        { text },
        idempotencyKey,
      );
      if (!response.ok) {
        throw new Error(await runCreateFailureMessage(response, "Could not message this child"));
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id) {
        throw new Error("Child message response did not include a run");
      }
      const nextResponse = await backendFetch(`/api/runs/${encodeURIComponent(body.id)}`);
      if (!nextResponse.ok) throw new Error(`backend ${nextResponse.status}`);
      const nextRun = decodeApiRun(await nextResponse.json());
      if (!nextRun) throw new Error("Child run response was invalid");
      onRunAccepted(nextRun);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not message this child");
    } finally {
      setSending(false);
    }
  };

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
          <div className="flex items-center gap-2">
            <span className="text-body-2-medium text-text-primary min-w-0 flex-1 truncate">
              {relationship.title}
            </span>
            <StatusDot tone={runTone(status)} pulse={live} />
          </div>
          <p className="text-mono-label text-text-tertiary mt-0.5">
            Product child · {engineLabel(initialRun.engine)} · {initialRun.model} · {status}
          </p>
        </div>
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

        {sendError ? (
          <p role="alert" className="text-caption-1-regular text-text-error-primary">
            {sendError}
          </p>
        ) : null}
      </div>

      <div className="border-border-button-default shrink-0 border-t p-3">
        <Composer
          variant="compact"
          placeholder="Message this child…"
          defaultEngine={initialRun.engine}
          defaultModel={initialRun.model}
          enableAgentCommand={false}
          enableModelPicker={false}
          pending={sending}
          draftKey={`product-child:${relationship.threadId}`}
          onSubmit={send}
        />
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
      onRunAccepted={setRun}
    />
  );
}
