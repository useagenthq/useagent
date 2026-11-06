"use client";

// The running footer above the reply composer while a turn runs: the phase
// chip with its details popover, the current step as a sentence, the elapsed
// time in mono and the existing Stop action as the control at the right. Same
// grammar as the composer status bar (its pill trigger, its popover rows).
// Purely presentational; every value is derived by the call site from data the
// session already holds (see running-phase.ts). `onStop` is the durable cancel.

import { RiArrowDownSLine, RiStopFill } from "@remixicon/react";
import { Dropdown, DropdownPopover, DropdownTrigger } from "@/components/base/dropdown/dropdown";
import { StatusRow } from "@/components/pro/composer-status-bar";
import type { RunningStatus } from "@/components/pro/running-phase";
import { ElapsedTimer } from "@/components/session-ui/elapsed-timer";

export function RunningFooter({
  status,
  model,
  startedAt,
  onStop,
  stopping = false,
}: {
  status: RunningStatus;
  /** The running turn's model label. */
  model: string;
  /** ISO start of the running turn; absent hides the elapsed time. */
  startedAt?: string | null;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const elapsed = startedAt ? <ElapsedTimer startedAt={startedAt} /> : null;
  return (
    <div
      data-session-ui="running-footer"
      role="status"
      className="mb-1.5 flex min-h-[26px] w-full items-center gap-2 px-1"
    >
      <Dropdown>
        <DropdownTrigger
          aria-label={`${status.label}. Run details`}
          className="flex shrink-0 items-center gap-1 rounded-[40px] bg-background-tertiary-default py-1 pr-1.5 pl-2 hover:bg-background-tertiary-hover"
        >
          <span className="ai-loading-pixel size-1.5 shrink-0 rounded-full bg-success-base" aria-hidden />
          <span className="max-w-[16rem] truncate text-body-2-medium text-text-primary">
            {status.label}
          </span>
          <RiArrowDownSLine className="size-4 shrink-0 text-text-tertiary" aria-hidden />
        </DropdownTrigger>
        <DropdownPopover aria-label="Run details" placement="top start" className="w-[280px]">
          <div className="px-2 pt-1 pb-1.5 text-body-medium text-text-primary">Run details</div>
          <StatusRow label="Model" value={model} />
          {elapsed && <StatusRow label="Elapsed" value={elapsed} />}
          <StatusRow label="Tool calls" value={String(status.toolCalls)} />
          <StatusRow
            label="Agents"
            value={`${status.agentsRunning} running, ${status.agentsDone} done`}
          />
        </DropdownPopover>
      </Dropdown>
      <span className="min-w-0 flex-1 truncate text-body-2-regular text-text-secondary">
        {status.sentence}
      </span>
      {elapsed && (
        <span className="shrink-0 font-mono text-caption-1-regular text-text-tertiary">{elapsed}</span>
      )}
      {onStop && (
        <button
          type="button"
          aria-label={stopping ? "Stopping this run" : "Stop this run"}
          title={stopping ? "Stopping..." : "Stop this run"}
          disabled={stopping}
          onClick={onStop}
          className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border-button-default text-text-secondary transition-colors hover:bg-background-tertiary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RiStopFill className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
