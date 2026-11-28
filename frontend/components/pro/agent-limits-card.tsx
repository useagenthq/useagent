// Public stand-in for a component the private edition draws with a licensed UI kit.
// Same exports and props, written from scratch for the open-source build.
"use client";

import { RiArrowDownSLine, RiArrowRightLine } from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { EASE_OUT } from "@/lib/motion";
import { cx } from "@/utils/cx";
import { formatTokens } from "@/utils/format";

export type ContextSegment = {
  label: string;
  tokens: number;
  /** Any CSS colour; defaults to the chart palette by index (blue first). */
  color?: string;
  /** Deferred buckets are listed but neither drawn in the bar nor counted. */
  deferred?: boolean;
};

export type ContextGroup = {
  label: string;
  tokens: number;
  items: { label: string; tokens: number }[];
};

export type UsageLimit = {
  label: string;
  /** 0-1 share of the limit already used; absent when there is no cap (no bar, no percent). */
  used?: number;
  /** "Resets in 2 hr 46 min", "Resets Tue 3:00 PM"… absent when nothing is periodic. */
  resets?: string;
  /** The figures in words, "12 of 600 min", shown where the reset line goes. */
  detail?: string;
};

export interface AgentLimitsCardProps {
  context?: {
    /** Window size in tokens (e.g. 1_000_000); null when the runtime reports none. */
    max: number | null;
    /** The used total when it is not the sum of the segments (the ring's figure). */
    used?: number;
    segments: ContextSegment[];
    groups?: ContextGroup[];
  };
  /** The limits section's title; "Plan usage limits" by default. */
  limitsTitle?: string;
  /** Plan name shown after "Plan usage limits ·". */
  plan?: string;
  /** Where the plan arrow points (omit to hide the arrow). */
  planHref?: string;
  limits?: UsageLimit[];
  /** Start with the context breakdown open. */
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

/** The chart palette, blue first. */
const PALETTE = [6, 1, 5, 4, 3, 8, 7, 2].map((n) => `var(--color-chart-${n})`);
const DEFAULT_LIMITS: UsageLimit[] = [];

/** Kept as an export: the private edition's card exports it too. */
export { formatTokens };

/** A 0-1 share as a whole percent, clamped to 0-100. */
const percent = (share: number) => `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;

export function AgentLimitsCard({
  context,
  plan = "Max (5x)",
  planHref,
  limitsTitle = "Plan usage limits",
  limits = DEFAULT_LIMITS,
  defaultExpanded = false,
  onExpandedChange,
  className,
}: AgentLimitsCardProps = {}) {
  return (
    <div className={cx("flex flex-col gap-4 rounded-2xl bg-background-primary-default p-3", className)}>
      {context && (
        <ContextWindow
          context={context}
          defaultExpanded={defaultExpanded}
          onExpandedChange={onExpandedChange}
        />
      )}
      {limits.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1 text-body-2-medium text-text-primary">
            <span>{limitsTitle}</span>
            {plan && <span className="text-text-secondary">{`· ${plan}`}</span>}
            {planHref && (
              <a
                href={planHref}
                aria-label={plan ? `View the ${plan} plan` : "View the plan"}
                className="ml-auto rounded-lg p-0.5 text-foreground-icon-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                <RiArrowRightLine className="size-4" aria-hidden />
              </a>
            )}
          </h3>
          <ul className="flex flex-col gap-3">
            {limits.map((limit, index) => (
              <LimitRow key={index} limit={limit} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ContextWindow({
  context,
  defaultExpanded,
  onExpandedChange,
}: {
  context: NonNullable<AgentLimitsCardProps["context"]>;
  defaultExpanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();
  const segments = context.segments.map((segment, index) => ({
    ...segment,
    color: segment.color ?? PALETTE[index % PALETTE.length],
  }));
  const drawn = segments.filter((segment) => !segment.deferred && segment.tokens > 0);
  const used = context.used ?? drawn.reduce((sum, segment) => sum + segment.tokens, 0);
  // A window reported as 0 is no window.
  const max = context.max && context.max > 0 ? context.max : null;
  const groups = context.groups ?? [];
  const canExpand = segments.length > 0 || groups.length > 0;

  const toggle = () => {
    setExpanded(!expanded);
    onExpandedChange?.(!expanded);
  };

  const heading = (
    <>
      {canExpand && (
        <RiArrowDownSLine
          className={cx(
            "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-150",
            !expanded && "-rotate-90",
          )}
          aria-hidden
        />
      )}
      <span className="text-body-2-medium text-text-primary">Context window</span>
      <span className="ml-auto text-body-2-regular text-text-secondary tabular-nums">
        {max === null ? `${formatTokens(used)} tok` : `${formatTokens(used)} / ${formatTokens(max)}`}
        {max !== null && <span className="text-text-tertiary">{` (${percent(used / max)})`}</span>}
      </span>
    </>
  );

  return (
    <section className="flex flex-col gap-2">
      {canExpand ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={toggle}
          className="-mx-1 flex cursor-pointer items-center gap-1 rounded-lg px-1 py-0.5 text-left outline-none hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-1 py-0.5">{heading}</div>
      )}
      {max !== null && drawn.length > 0 && (
        <div className="flex h-2 overflow-hidden rounded-full bg-chart-track">
          {drawn.map((segment, index) => (
            <span
              key={index}
              title={`${segment.label} · ${formatTokens(segment.tokens)}`}
              className="h-full shrink-0"
              style={{ width: `${(segment.tokens / max) * 100}%`, backgroundColor: segment.color }}
            />
          ))}
        </div>
      )}
      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            key="breakdown"
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <ul className="flex flex-col gap-1.5 pt-1">
              {segments.map((segment, index) => (
                <BreakdownRow
                  key={index}
                  label={segment.deferred ? `${segment.label} (deferred)` : segment.label}
                  tokens={segment.tokens}
                  color={segment.color}
                  max={segment.deferred ? null : max}
                />
              ))}
              {max !== null && (
                <BreakdownRow
                  label="Free space"
                  tokens={Math.max(0, max - used)}
                  color="var(--color-chart-track)"
                  max={max}
                />
              )}
              {groups.map((group, index) => (
                <GroupRow key={index} group={group} />
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function BreakdownRow({
  label,
  tokens,
  color,
  max,
}: {
  label: string;
  tokens: number;
  color: string;
  max: number | null;
}) {
  return (
    <li className="flex items-center gap-2 text-body-2-regular">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="min-w-0 truncate text-text-secondary">{label}</span>
      <span className="ml-auto text-text-primary tabular-nums">
        {max === null ? formatTokens(tokens) : `${formatTokens(tokens)} (${percent(tokens / max)})`}
      </span>
    </li>
  );
}

function GroupRow({ group }: { group: ContextGroup }) {
  const [open, setOpen] = useState(true);
  const itemsId = useId();
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={itemsId}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex cursor-pointer items-center gap-1 rounded-lg px-1 text-left text-body-2-medium outline-none hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiArrowDownSLine
          className={cx(
            "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-150",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 truncate text-text-primary">{group.label}</span>
        <span className="ml-auto text-text-primary tabular-nums">{formatTokens(group.tokens)}</span>
      </button>
      {open && (
        <ul id={itemsId} className="flex flex-col gap-1 pl-5">
          {group.items.map((item, index) => (
            <li key={index} className="flex items-center gap-2 text-body-2-regular">
              <span className="min-w-0 truncate text-text-secondary">{item.label}</span>
              <span className="ml-auto text-text-secondary tabular-nums">{formatTokens(item.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function LimitRow({ limit }: { limit: UsageLimit }) {
  const share = limit.used === undefined ? null : Math.min(1, Math.max(0, limit.used));
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body-2-medium text-text-primary">{limit.label}</span>
        {share !== null && (
          <span className="text-body-2-regular text-text-secondary tabular-nums">{percent(share)}</span>
        )}
      </div>
      {share !== null && (
        <div
          role="progressbar"
          aria-label={limit.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-1.5 overflow-hidden rounded-full bg-chart-track"
        >
          <div className="h-full rounded-full bg-accent-500" style={{ width: percent(share) }} />
        </div>
      )}
      {(limit.detail || limit.resets) && (
        <div className="flex justify-between gap-3 text-caption-1-regular text-text-tertiary">
          {limit.detail && <span>{limit.detail}</span>}
          {limit.resets && <span>{limit.resets}</span>}
        </div>
      )}
    </li>
  );
}
