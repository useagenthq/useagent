"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  RiBuilding2Line,
  RiEyeLine,
  RiFlashlightLine,
  RiGroupLine,
  RiUserAddLine,
  RiVipCrownLine,
} from "@remixicon/react";
import {
  ChartCard,
  ChartHeader,
  MONO_TONE,
  describeDelta,
  formatNumber,
  resolveTone,
  useChartRange,
  type ChartRange,
} from "@/components/application/charts/chart-card";
import { cx } from "@/utils/cx";

/**
 * Stage bars card - the funnel as a list: one rounded horizontal pill per
 * stage over the chart track, name on the left, value and share of the top
 * stage on the right, and a 3-up grid of stat tiles underneath (swatch · name
 * over value - the activity rings tile recipe) so every stage reads at a
 * glance. The card is content-sized, so more stages make it taller.
 * Widths animate in on mount; hovering a stage or its tile darkens the pill
 * (400 → 500), fades the other rows and tiles, and swaps the headline to its
 * value.
 *
 * `stages` is the same flat `{ label, value, color? }` list the flow funnel
 * takes - add a stage and it gets a row; colours cycle the chart palette
 * unless overridden, and `mono` paints every pill in a single ink (mid grey
 * on light, near-white on dark) for the reference's mono look.
 */

export type StageBar = {
  label: string;
  value: number;
  /** Any CSS colour; defaults to the chart palette by index. */
  color?: string;
  activeColor?: string;
  /** 14px glyph drawn at the left end, inside the bar. Omit for none. */
  icon?: ReactNode;
};

/** A selectable period: pill label + the props it overrides. */
export type StageBarsRange = ChartRange<{ stages: StageBar[]; delta: number; headline: number }>;

export interface StageBarsCardProps {
  /** Header label; swaps to the hovered stage's name while hovering. */
  title?: string;
  stages?: StageBar[];
  /** Single-ink look: every pill in one grey, no per-stage hues. */
  mono?: boolean;
  /** Draw each stage's `icon` inside its bar (default). Set false to hide
   *  them without stripping the icons from your data. */
  showIcons?: boolean;
  /** Headline number at rest; defaults to the first stage's value. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("Last 30 days"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: StageBarsRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  format?: (n: number) => string;
  className?: string;
}

/** The bars are the bright 400 chart tones in both themes, so a glyph sitting
 *  on one always wants the same near-black ink. */
const BAR_ICON = "size-3.5 shrink-0 text-neutral-950";

const DEFAULT_STAGES: StageBar[] = [
  { label: "Visits", value: 4820, icon: <RiEyeLine className={BAR_ICON} aria-hidden /> },
  { label: "Sign-up", value: 3260, icon: <RiUserAddLine className={BAR_ICON} aria-hidden /> },
  { label: "Active", value: 2010, icon: <RiFlashlightLine className={BAR_ICON} aria-hidden /> },
  { label: "Pro", value: 1160, icon: <RiVipCrownLine className={BAR_ICON} aria-hidden /> },
  { label: "Team", value: 540, icon: <RiGroupLine className={BAR_ICON} aria-hidden /> },
  { label: "Enterprise", value: 180, icon: <RiBuilding2Line className={BAR_ICON} aria-hidden /> },
];

const stagesOf = (values: number[]): StageBar[] =>
  DEFAULT_STAGES.map((s, i) => ({ ...s, value: values[i] }));

/** Demo periods used when no stages / range are given at all. */
const DEFAULT_RANGES: StageBarsRange[] = [
  { id: "7d", label: "Last 7 days", stages: stagesOf([1180, 790, 460, 250, 120, 40]), delta: 0.024 },
  { id: "30d", label: "Last 30 days", stages: DEFAULT_STAGES, delta: 0.061 },
  { id: "90d", label: "Last 90 days", stages: stagesOf([13900, 9410, 5720, 3300, 1520, 510]), delta: -0.012 },
];

/** Opacity of the other rows while one stage is hovered. */
const DIM = 0.35;

/** Rows mount at 0 width and grow. A short timeout (not rAF) so the 0-width
 *  frame is painted first and the grow still runs if the tab was hidden. */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);
  return mounted;
}

export function StageBarsCard({
  title = "Pipeline",
  stages: stagesProp,
  mono = false,
  showIcons = true,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = formatNumber,
  className,
}: StageBarsCardProps = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const mounted = useMounted();

  // Built-in demo periods when the host supplies neither ranges nor stages.
  const demo = ranges === undefined && range === undefined && stagesProp === undefined;
  const rangeList = ranges ?? (demo ? DEFAULT_RANGES : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActiveIndex(null);
    select(id);
  };
  const stages = selected?.stages ?? stagesProp ?? DEFAULT_STAGES;
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;

  const tones = stages.map((s, i) => (mono ? MONO_TONE : resolveTone(i, s.color, s.activeColor)));
  const top = Math.max(1, stages[0]?.value ?? 1);
  const n = Math.max(1, stages.length);
  const hovering = activeIndex !== null && activeIndex < stages.length;
  const headerLabel = hovering ? stages[activeIndex].label : title;
  const headlineValue = hovering ? stages[activeIndex].value : (headline ?? top);

  return (
    // Content-sized: the bar list plus the tile grid set the height, so more
    // stages simply make the card taller (min-height matches the other cards).
    <ChartCard className={cx("h-auto min-h-[329px]", className)}>
      <ChartHeader
        label={headerLabel}
        value={headlineValue}
        format={format}
        delta={delta !== undefined ? describeDelta(delta) : undefined}
        hovering={hovering}
        fadeKey={`${selectedId ?? ""}:${activeIndex}`}
        range={range}
        ranges={rangeList}
        rangeId={selectedId}
        onRangeChange={selectRange}
      />

      {/* Grid so the label column sizes to the longest stage name instead of
          truncating; each row is a `contents` wrapper carrying the hover. Rows
          are content-sized with a fixed 12px gap and the block sits centred,
          rather than stretching to fill the card. */}
      <div
        className="grid min-h-0 w-full flex-1 content-center items-center gap-x-3 gap-y-3 py-2"
        style={{
          gridTemplateColumns: "auto minmax(0, 1fr) auto",
          gridTemplateRows: `repeat(${n}, auto)`,
        }}
      >
        {stages.map((stage, i) => {
          const active = activeIndex === i;
          const share = Math.round((stage.value / top) * 100);
          const dim = hovering && !active;
          const fade = "transition-opacity duration-200 ease-out";
          return (
            <div
              key={stage.label}
              className="contents"
              onMouseEnter={() => setActiveIndex(i)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <span
                className={cx("text-right text-body-regular whitespace-nowrap text-text-secondary", fade)}
                style={{ opacity: dim ? DIM : 1 }}
              >
                {stage.label}
              </span>
              <div
                className={cx("relative h-5 min-w-0 overflow-hidden rounded-full bg-chart-track", fade)}
                style={{ opacity: dim ? DIM : 1 }}
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-500 ease-out"
                  style={{
                    width: mounted ? `${Math.max(2, (stage.value / top) * 100)}%` : 0,
                    backgroundColor: active ? tones[i].activeColor : tones[i].color,
                  }}
                />
                {/* Pinned to the left of the track (not the fill) so it stays
                    at one x down the column; the track's clip keeps it inside
                    the pill. */}
                {showIcons && stage.icon && (
                  <span className="pointer-events-none absolute inset-y-0 left-1 flex items-center">
                    {stage.icon}
                  </span>
                )}
              </div>
              <span
                className={cx("flex items-baseline justify-end gap-1.5 whitespace-nowrap", fade)}
                style={{ opacity: dim ? DIM : 1 }}
              >
                <span className="text-body-medium text-text-primary tabular-nums">{format(stage.value)}</span>
                <span className="text-caption-1-medium text-text-tertiary tabular-nums">{share}%</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Stat tiles: swatch + name over value, three per row. The grid pulls
          8px past the card padding on the sides and bottom, so the tiles read
          wider than the list above - a deliberate break in alignment that
          frames the narrower content. */}
      <div className="-mx-2 -mb-1 grid grid-cols-3 gap-2">
        {stages.map((stage, i) => {
          const active = activeIndex === i;
          const dim = hovering && !active;
          return (
            <div
              key={stage.label}
              className="flex min-w-0 flex-col items-start gap-px rounded-2lg bg-background-inner-default px-2.5 py-2 transition-opacity duration-200 ease-out"
              style={{ opacity: dim ? 0.5 : 1 }}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <div className="flex min-w-0 max-w-full items-center gap-1.5">
                {!mono && (
                  <span
                    className="size-3 shrink-0 rounded-[4px] transition-colors duration-150 ease-out"
                    style={{ backgroundColor: active ? tones[i].activeColor : tones[i].color }}
                  />
                )}
                <span className="truncate text-body-regular text-text-secondary">{stage.label}</span>
              </div>
              <span className="text-body-medium whitespace-nowrap text-text-primary tabular-nums">
                {format(stage.value)}
              </span>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}
