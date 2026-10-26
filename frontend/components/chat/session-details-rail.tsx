"use client";

// The Details surface of the session rail: what the reference window keeps in
// its right panel. Environment (the project, the runtime, the branch), the
// task plan (the thread's latest todo list, or "No plan yet") and usage tiles
// (input tokens, output tokens, tool calls). Every value is read from the run
// rows and the frames the thread already holds; a number the engine never
// reported reads "not reported" rather than a guess.

import { type ReactNode, useMemo } from "react";
import { PlanChecklist } from "@/components/agent-ui/plan-checklist";
import { modelLabel } from "@/components/chat/model-catalog";
import { latestThreadPlan, type PlanTurn } from "@/components/chat/thread-plan";
import { threadUsage, type UsageTurn } from "@/components/chat/thread-usage";
import type { ApiRun } from "@/components/chat/types";
import { RunLocation } from "@/components/runners/run-location";
import { formatSubagentTokenCount } from "@/components/session-ui/agent-panel-row";
import { repoShortname, runGitRefs } from "@/components/session-ui/git-chip";
import { engineDisplayLabel } from "@/components/session-ui/provider-status-banner";
import { cx } from "@/utils/cx";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-mono-label text-text-tertiary">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-body-2-regular">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-text-primary">{children}</dd>
    </div>
  );
}

/** One usage tile: the number the engine reported, or that it reported none. */
function Tile({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 flex-col gap-0.5 rounded-2xl bg-background-secondary-default px-3 py-2.5"
    >
      <span className="truncate text-caption-1-medium text-text-tertiary">{label}</span>
      <span
        className={cx(
          "truncate tabular-nums",
          value === null
            ? "text-body-2-regular text-text-tertiary"
            : "text-title-3-medium text-text-primary",
        )}
      >
        {value ?? "not reported"}
      </span>
    </div>
  );
}

export function SessionDetailsRail({
  root,
  newest,
  turns,
}: {
  /** The thread's root run: its repositories are inherited across the thread. */
  root: ApiRun;
  /** The thread's newest run: its engine, model and sandbox are the runtime. */
  newest: ApiRun;
  /** The thread's turns (the conversation's Turn satisfies both shapes). A turn
   *  known only by its outline stub (windowed loading) carries no steps yet. */
  turns: readonly (PlanTurn & UsageTurn & { readonly pendingOutline?: unknown })[];
}) {
  const refs = runGitRefs(root);
  const partial = turns.some((turn) => turn.pendingOutline);
  const project = refs.map((ref) => repoShortname(ref.repo)).join(", ");
  const branch = refs.flatMap((ref) => (ref.branch ? [ref.branch] : [])).join(", ");
  const plan = useMemo(() => latestThreadPlan(turns), [turns]);
  const usage = useMemo(() => threadUsage(turns), [turns]);
  return (
    <div data-testid="session-details" className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      {partial && (
        <p data-testid="details-partial" className="text-caption-1-regular text-text-tertiary">
          Older turns are still loading; the plan and the totals cover the loaded ones.
        </p>
      )}
      <Section title="Environment">
        <dl className="flex flex-col gap-1.5 rounded-2xl bg-background-secondary-default px-3 py-2.5">
          <Row label="Project">{project || "No repository"}</Row>
          <Row label="Runtime">
            <span className="flex min-w-0 items-center justify-end gap-2">
              {/* The model is the one the plane asked the runtime for (the run
                  row); no runtime reports back which model answered, so the
                  rail says so instead of presenting the request as a fact. */}
              <span
                className="truncate"
                title="The model this task asked for. Which model actually answered is not sent back."
              >
                {engineDisplayLabel(newest.engine)} · {modelLabel(newest.model, newest.engine)}{" "}
                <span data-testid="runtime-model-requested" className="text-text-tertiary">
                  requested
                </span>
              </span>
              <RunLocation run={newest} />
            </span>
          </Row>
          <Row label="Branch">{branch || "Default branch"}</Row>
        </dl>
      </Section>
      <Section title="Task plan">
        {plan ? (
          <PlanChecklist title="Task plan" entries={plan} testId="details-plan" />
        ) : (
          <p data-testid="details-no-plan" className="text-body-2-regular text-text-tertiary">
            No plan yet
          </p>
        )}
      </Section>
      <Section title="Usage">
        <div className="grid grid-cols-3 gap-2">
          <Tile
            label="Input tokens"
            value={usage.inputTokens === null ? null : formatSubagentTokenCount(usage.inputTokens)}
            testId="usage-input"
          />
          <Tile
            label="Output tokens"
            value={usage.outputTokens === null ? null : formatSubagentTokenCount(usage.outputTokens)}
            testId="usage-output"
          />
          <Tile label="Tool calls" value={String(usage.toolCalls)} testId="usage-tool-calls" />
        </div>
      </Section>
    </div>
  );
}
