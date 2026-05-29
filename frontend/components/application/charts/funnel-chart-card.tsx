"use client";

import { useEffect, useRef, useState } from "react";
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
 * Horizontal flow funnel. Recharts' `FunnelChart` only draws stacked
 * vertical trapezoids, so this one is a small hand-rolled SVG: one column
 * per stage (3px apart), each a band that starts at its own height and
 * tapers to the next stage's height at its right edge - `shape="curved"`
 * runs flat then eases down in an S-curve, with two translucent layers
 * behind it for a pipe-like edge; `shape="sharp"` is a plain trapezoid with
 * no layers (and a faint backing band so tiny stages still read). Every
 * column carries a centred percentage pill (share of the top stage) and a
 * stat tile (swatch · name over value) sits under each column, bleeding
 * slightly past the card padding.
 *
 * `stages` is a flat `{ label, value, color? }` list - add a stage and it
 * gets a column, colours cycle the chart palette unless overridden; `mono`
 * paints everything in a single ink (mid grey on light, near-white on
 * dark). Hovering a stage darkens it (400 → 500) and swaps the headline to
 * its value. The stage-list sibling is `StageBarsCard`.
 */

export type FunnelStage = {
  label: string;
  value: number;
  /** Any CSS colour; defaults to the chart palette by index. */
  color?: string;
  activeColor?: string;
};

export type FunnelShape = "curved" | "sharp";

/** A selectable period: pill label + the props it overrides. */
export type FunnelRange = ChartRange<{ stages: FunnelStage[]; delta: number; headline: number }>;

export interface FunnelChartCardProps {
  /** S-curve taper with layered edges (default) or a plain straight-edged
   *  trapezoid. */
  shape?: FunnelShape;
  /** Single-ink look: bands in one grey, no per-stage hues. */
  mono?: boolean;
  /** Header label; swaps to the hovered stage's name while hovering. */
  title?: string;
  stages?: FunnelStage[];
  /** Headline number at rest; defaults to the first stage's value. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("Last 30 days"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: FunnelRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  format?: (n: number) => string;
  className?: string;
}

const DEFAULT_STAGES: FunnelStage[] = [
  { label: "Link opened", value: 197 },
  { label: "Started", value: 110 },
  { label: "Completed", value: 77 },
  { label: "Converted", value: 38 },
];

const stagesOf = (values: number[]): FunnelStage[] =>
  DEFAULT_STAGES.map((s, i) => ({ label: s.label, value: values[i] }));

/** Demo periods used when no stages / range are given at all. */
const DEFAULT_RANGES: FunnelRange[] = [
  { id: "7d", label: "Last 7 days", stages: DEFAULT_STAGES, delta: 0.052 },
  { id: "30d", label: "Last 30 days", stages: stagesOf([842, 463, 301, 152]), delta: 0.034 },
  { id: "90d", label: "Last 90 days", stages: stagesOf([2510, 1380, 902, 455]), delta: -0.018 },
];

/** Gap between funnel columns, px. */
const COL_GAP = 3;
/** Share of a curved column that stays flat before the S-curve taper. */
const FLAT = 0.42;
/** The two translucent edge layers behind a curved band: bleed px + opacity. */
const LAYERS: { pad: number; opacity: number }[] = [
  { pad: 12, opacity: 0.1 },
  { pad: 6, opacity: 0.22 },
];
/** `sharp` only: faint backing band behind every column so stages thinner
 *  than the pill still read as a column (the pill overflows onto it). */
const BACKING_H = 36;
const BACKING_OPACITY = 0.14;
/** Opacity of every other column while one stage is hovered. */
const DIM = 0.3;
const DIM_CLASS = "transition-opacity duration-200 ease-out";
/** Percentage pill metrics. */
const PILL_H = 20;
const PILL_PAD = 8;
const PILL_CHAR = 7.2;

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

/**
 * Column band from height `hL` at `x0` to `hR` at `x1`. Curved: flat for
 * `FLAT` of the width, then an S-curve into the right edge. Sharp: a
 * straight trapezoid.
 */
function bandPath(x0: number, x1: number, cy: number, hL: number, hR: number, shape: FunnelShape) {
  const topL = cy - hL / 2;
  const botL = cy + hL / 2;
  const topR = cy - hR / 2;
  const botR = cy + hR / 2;
  if (shape === "sharp") {
    return `M${x0},${topL} L${x1},${topR} L${x1},${botR} L${x0},${botL} Z`;
  }
  const xf = x0 + (x1 - x0) * FLAT;
  const c = (xf + x1) / 2;
  return [
    `M${x0},${topL}`,
    `L${xf},${topL}`,
    `C${c},${topL} ${c},${topR} ${x1},${topR}`,
    `L${x1},${botR}`,
    `C${c},${botR} ${c},${botL} ${xf},${botL}`,
    `L${x0},${botL}`,
    "Z",
  ].join(" ");
}

export function FunnelChartCard({
  shape = "curved",
  mono = false,
  title = "Sign-up funnel",
  stages: stagesProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = formatNumber,
  className,
}: FunnelChartCardProps = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const { ref, width, height } = useElementSize<HTMLDivElement>();

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
  const hovering = activeIndex !== null && activeIndex < stages.length;
  const headerLabel = hovering ? stages[activeIndex].label : title;
  const headlineValue = hovering ? stages[activeIndex].value : (headline ?? top);

  const n = Math.max(1, stages.length);
  const layered = shape === "curved";
  const bleed = layered ? LAYERS[0].pad : 0;
  const colW = Math.max(0, (width - COL_GAP * (n - 1)) / n);
  const usable = Math.max(0, height - bleed * 2);
  const cy = height / 2;
  const heightOf = (v: number) => Math.max(2, (v / top) * usable);
  const columnX = (i: number) => {
    const x0 = i * (colW + COL_GAP);
    return { x0, x1: x0 + colW };
  };
  /** Everything belonging to a non-hovered column fades hard, so the hovered
   *  stage reads as lifted out of the funnel. */
  const dimOf = (i: number) => (hovering && activeIndex !== i ? DIM : 1);

  return (
    <ChartCard className={className}>
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

      <div ref={ref} className="relative min-h-0 w-full flex-1">
        {width > 0 && height > 0 && (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="absolute inset-0 overflow-visible"
            onMouseLeave={() => setActiveIndex(null)}
          >
            {/* Sharp: faint backing band per column, under everything. */}
            {!layered &&
              stages.map((stage, i) => {
                const { x0, x1 } = columnX(i);
                return (
                  <rect
                    key={`backing-${stage.label}`}
                    x={x0}
                    y={cy - BACKING_H / 2}
                    width={x1 - x0}
                    height={BACKING_H}
                    fill={tones[i].color}
                    fillOpacity={BACKING_OPACITY}
                    opacity={dimOf(i)}
                    className={cx("cursor-default", DIM_CLASS)}
                    onMouseEnter={() => setActiveIndex(i)}
                  />
                );
              })}
            {/* Edge layers first so every band paints over them. */}
            {layered &&
              LAYERS.map((layer) =>
                stages.map((stage, i) => {
                  const { x0, x1 } = columnX(i);
                  const hL = heightOf(stage.value);
                  const hR = i < n - 1 ? heightOf(stages[i + 1].value) : hL;
                  return (
                    <path
                      key={`layer-${layer.pad}-${stage.label}`}
                      d={bandPath(x0, x1, cy, hL + layer.pad * 2, hR + layer.pad * 2, shape)}
                      fill={tones[i].color}
                      fillOpacity={layer.opacity}
                      opacity={dimOf(i)}
                      className={cx("pointer-events-none", DIM_CLASS)}
                    />
                  );
                }),
              )}
            {stages.map((stage, i) => {
              const { x0, x1 } = columnX(i);
              const hL = heightOf(stage.value);
              const hR = i < n - 1 ? heightOf(stages[i + 1].value) : hL;
              const active = activeIndex === i;
              return (
                <path
                  key={stage.label}
                  d={bandPath(x0, x1, cy, hL, hR, shape)}
                  fill={active ? tones[i].activeColor : tones[i].color}
                  opacity={dimOf(i)}
                  className="cursor-default transition-[fill,opacity] duration-200 ease-out"
                  onMouseEnter={() => setActiveIndex(i)}
                />
              );
            })}
            {/* Percentage pills, centred in every column. */}
            {stages.map((stage, i) => {
              const { x0, x1 } = columnX(i);
              const label = `${Math.round((stage.value / top) * 100)}%`;
              const w = label.length * PILL_CHAR + PILL_PAD * 2;
              const midX = (x0 + x1) / 2;
              if (w > colW + COL_GAP) return null;
              return (
                <g
                  key={`pill-${stage.label}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  opacity={dimOf(i)}
                  className={cx("cursor-default", DIM_CLASS)}
                >
                  <rect
                    x={midX - w / 2}
                    y={cy - PILL_H / 2}
                    width={w}
                    height={PILL_H}
                    rx={PILL_H / 2}
                    fill="var(--color-background-secondary-default)"
                  />
                  <text
                    x={midX}
                    y={cy}
                    dy={4}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={500}
                    fill="var(--color-text-primary)"
                    className="pointer-events-none tabular-nums"
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Stat tiles: swatch + name over value, one under every column. The grid
          pulls 8px past the card padding on the sides and bottom, so the tiles
          read wider than the funnel above - a deliberate break in alignment
          that frames the narrower content (same recipe as the stage bars). */}
      <div
        className="-mx-2 -mb-1 grid gap-2"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
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
