// Public stand-in for a component the private edition draws with a licensed UI kit.
// Same exports and props, written from scratch for the open-source build.
"use client";

import { RiFolder2Line, RiGitMergeLine, RiInfinityLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { Dropdown, DropdownPopover, DropdownTrigger } from "@/components/base/dropdown/dropdown";
import { UsageCard } from "@/components/pro/usage-card";
import { type LocatedRun, RunLocation } from "@/components/runners/run-location";
import { spendCapped, spendLabel, type SpendSnapshot } from "@/lib/spend";
import { cx } from "@/utils/cx";
import { formatTokens } from "@/utils/format";

export { formatTokens };

export interface ConversationContext {
  /** Tokens the last model call carried. */
  readonly used: number;
  /** The cache-read share of `used`. */
  readonly cached: number;
  /** Context window in tokens; null when the runtime did not report one. */
  readonly window: number | null;
  /** The call's other buckets when the frame carried them, for the usage card's bar. */
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cacheWrite?: number;
}

export interface ComposerStatusBarProps {
  /** The thread's newest run, for where it executes; absent before any run. */
  run?: LocatedRun | null;
  branch?: string | null;
  project?: string | null;
  /** The engine answering this thread, e.g. "Codex". */
  agent: string;
  context: ConversationContext | null;
  /** The member's settled spend; the chip shows only while a cap is set. */
  spend?: SpendSnapshot | null;
  /** Present when the thread's engine offers a compaction command. */
  onCompact?: () => void;
  className?: string;
}

/** The share of the window the last call filled, 0 to 100; null without a known window. */
export function contextPercent(context: ConversationContext): number | null {
  if (!context.window || context.window <= 0) return null;
  return Math.min(100, Math.round((context.used / context.window) * 100));
}

/** One label / value line of a status popover. */
export function StatusRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1">
      <span className="shrink-0 text-body-2-regular text-text-tertiary">{label}</span>
      <span className="min-w-0 truncate text-right text-body-2-medium text-text-primary">{value}</span>
    </div>
  );
}

function TrayItem({ icon: Icon, title, children }: { icon: typeof RiFolder2Line; title: string; children: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={title}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-36 truncate">{children}</span>
    </span>
  );
}

/** A small ring filled to the share of the window in use. */
function ContextRing({ percent }: { percent: number }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-chart-track" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2"
        pathLength={100}
        strokeDasharray={`${percent} 100`}
        stroke="currentColor"
      />
    </svg>
  );
}

const NO_CONTEXT: ConversationContext = { used: 0, cached: 0, window: null };

export function ComposerStatusBar({
  run,
  branch,
  project,
  agent,
  context,
  spend,
  onCompact,
  className,
}: ComposerStatusBarProps) {
  const percent = context ? contextPercent(context) : null;
  const reading = context ? (percent === null ? `${formatTokens(context.used)} tokens` : `${percent}%`) : null;
  return (
    <div
      data-testid="composer-status-tab"
      className={cx(
        "mx-7 flex min-w-0 items-center gap-3 rounded-b-2xl bg-composer-panel-tab-background px-3 py-1 text-caption-1-regular text-text-tertiary",
        className,
      )}
    >
      {run && <RunLocation run={run} />}
      {branch && (
        <TrayItem icon={RiGitMergeLine} title="Branch">
          {branch}
        </TrayItem>
      )}
      {project && (
        <TrayItem icon={RiFolder2Line} title="Project">
          {project}
        </TrayItem>
      )}
      <TrayItem icon={RiInfinityLine} title="Agent">
        {agent}
      </TrayItem>
      {spend && spend.allowance !== null && (
        <span
          className={cx("shrink-0 whitespace-nowrap", spendCapped(spend) && "text-text-error-primary")}
          title={spendCapped(spend) ? "Spend cap reached" : "Your spend against its cap"}
        >
          {spendLabel(spend)}
        </span>
      )}
      <div className="ml-auto shrink-0">
        <Dropdown>
          <DropdownTrigger
            aria-label={reading ? `Conversation context, ${reading} used` : "Conversation context"}
            className="button-press-motion flex items-center gap-1 rounded-[40px] px-1.5 py-0.5 text-text-secondary hover:bg-background-tertiary-hover"
          >
            <ContextRing percent={percent ?? 0} />
            {reading && <span className="tabular-nums">{reading}</span>}
          </DropdownTrigger>
          <DropdownPopover aria-label="Conversation context" placement="top end" className="w-[300px]">
            <UsageCard context={context ?? NO_CONTEXT} spend={spend} onCompact={onCompact} />
          </DropdownPopover>
        </Dropdown>
      </div>
    </div>
  );
}
