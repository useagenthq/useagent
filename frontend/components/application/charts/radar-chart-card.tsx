"use client";

import { useState } from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  ChartCard,
  ChartHeader,
  ChartLegend,
  ChartStatTiles,
  describeDelta,
  formatNumber,
  resolveTone,
  useChartRange,
  type ChartRange,
} from "@/components/application/charts/chart-card";
import { cx } from "@/utils/cx";

/**
 * Radar chart card on Recharts `RadarChart`. Four looks from one prop:
 *
 *   filled  soft fill + 2px outline (default)
 *   dots    filled + a dot on every vertex
 *   lines   outline only - the multi-series comparison look
 *   score   filled + dots, each axis label carries its value, and a raised
 *           disc in the centre shows the average score (0-100) with a
 *           qualitative caption. Values under `alertBelow` turn rose.
 *
 * Data is a plain array of rows keyed by category `label`, with one numeric
 * field per series - add a row to add an axis, add a series entry to draw
 * another polygon. Hovering an axis swaps the headline to that category's
 * value (primary series), darkens its label, and pops a pulsing dot on every
 * series; the legend (multi-series only) follows along with per-series values.
 *
 * The period pill is a dropdown when `ranges` is given: each range carries
 * its own `data` (and optionally `series`, `delta`, `headline`, `max`) and
 * the chart re-animates on selection. With no data props at all the card
 * ships three demo ranges so it works out of the box.
 */

export type RadarPoint = { label: string } & Record<string, number | string>;

export type RadarSeries = {
  /** Field of `RadarPoint` holding this series' values. */
  key: string;
  label: string;
  /** Any CSS colour; defaults to the chart palette by series index. */
  color?: string;
  /** Hover / outline step; defaults to the palette's 500 tone. */
  activeColor?: string;
};

export type RadarVariant = "filled" | "dots" | "lines" | "score";

/** A selectable period: pill label + the props it overrides. */
export type RadarRange = ChartRange<{
  data: RadarPoint[];
  series: RadarSeries[];
  delta: number;
  headline: number;
  max: number;
}>;

export interface RadarChartCardProps {
  variant?: RadarVariant;
  /** Header label ("Visitors"); swaps to the hovered category while hovering. */
  title?: string;
  data?: RadarPoint[];
  series?: RadarSeries[];
  /** Radius axis ceiling; defaults to the largest value across all series
   *  (100 for `score`). */
  max?: number;
  /** Headline number at rest; defaults to the primary series' total. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("Jan – Jun 2024"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: RadarRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  format?: (n: number) => string;
  /** `score` only: axis values below this are painted rose. */
  alertBelow?: number;
  /** `score` only: caption under the centre score. Defaults to a
   *  qualitative label (Excellent / Strong / Fair / Needs work). */
  scoreCaption?: string | ((score: number) => string);
  /** Stat tiles under the chart, one per axis (primary series value): three
   *  per row, the last row stretched full width. The card grows to fit. */
  tiles?: boolean;
  /** Scales the plotted polygon inside the same chart area - `1.15` draws it
   *  15% larger without touching the card, header or tiles. Axis labels move
   *  outward with it, so leave headroom above ~1.2. */
  radiusScale?: number;
  /** Nudges the plot (and the `score` disc that sits on it) within the chart
   *  area, in px - negative moves it up. Everything else stays put. */
  plotOffsetY?: number;
  /** Where the multi-series legend sits: under the chart (default, adds a
   *  row), in the header beside the period pill, or overlaid along the
   *  bottom edge of the chart area (the radar nudges up to make room) -
   *  the last two keep the card the same height as a single-series one. */
  legend?: "bottom" | "top" | "overlay";
  className?: string;
}

const DEFAULT_DATA: RadarPoint[] = [
  { label: "January", desktop: 186, mobile: 80 },
  { label: "February", desktop: 305, mobile: 200 },
  { label: "March", desktop: 237, mobile: 120 },
  { label: "April", desktop: 273, mobile: 190 },
  { label: "May", desktop: 209, mobile: 130 },
  { label: "June", desktop: 214, mobile: 140 },
];

const DEFAULT_SERIES: RadarSeries[] = [{ key: "desktop", label: "Desktop" }];

const DEFAULT_SCORE_DATA: RadarPoint[] = [
  { label: "Focus", score: 100 },
  { label: "Consistency", score: 9 },
  { label: "Target", score: 100 },
  { label: "Balance", score: 100 },
  { label: "Deep work", score: 97 },
];

const DEFAULT_SCORE_SERIES: RadarSeries[] = [{ key: "score", label: "Score" }];

const H2: RadarPoint[] = [
  { label: "July", desktop: 244, mobile: 160 },
  { label: "August", desktop: 198, mobile: 122 },
  { label: "September", desktop: 286, mobile: 190 },
  { label: "October", desktop: 312, mobile: 210 },
  { label: "November", desktop: 262, mobile: 175 },
  { label: "December", desktop: 331, mobile: 240 },
];

/** Demo periods used when no data props are given at all. */
const DEFAULT_RANGES: RadarRange[] = [
  { id: "h1", label: "H1 2024", data: DEFAULT_DATA, delta: 0.052 },
  { id: "h2", label: "H2 2024", data: H2, delta: 0.081 },
  {
    id: "year",
    label: "2024",
    data: [...DEFAULT_DATA, ...H2].map((row) => ({ ...row, label: String(row.label).slice(0, 3) })),
    delta: 0.067,
  },
];

const DEFAULT_SCORE_RANGES: RadarRange[] = [
  { id: "this-week", label: "This week", data: DEFAULT_SCORE_DATA },
  {
    id: "last-week",
    label: "Last week",
    data: [
      { label: "Focus", score: 82 },
      { label: "Consistency", score: 64 },
      { label: "Target", score: 90 },
      { label: "Balance", score: 71 },
      { label: "Deep work", score: 88 },
    ],
  },
  {
    id: "this-month",
    label: "This month",
    data: [
      { label: "Focus", score: 91 },
      { label: "Consistency", score: 48 },
      { label: "Target", score: 96 },
      { label: "Balance", score: 84 },
      { label: "Deep work", score: 93 },
    ],
  },
];

function defaultScoreCaption(score: number) {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Strong";
  if (score >= 50) return "Fair";
  return "Needs work";
}

/** Active vertex marker: solid dot with an outward-pulsing halo, the same
 *  recipe as the revenue trend card's active point. */
function PulsingDot({ cx, cy, color }: { cx?: number; cy?: number; color: string }) {
  if (cx == null || cy == null) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={5} fill={color} opacity={0.3}>
        <animate attributeName="r" values="5;13" dur="1.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.35;0" dur="1.4s" repeatCount="indefinite" />
      </circle>
      <circle
        cx={cx}
        cy={cy}
        r={5}
        fill={color}
        stroke="var(--color-background-secondary-default)"
        strokeWidth={3}
      />
    </g>
  );
}

type AngleTickProps = {
  x?: number | string;
  y?: number | string;
  textAnchor?: "start" | "middle" | "end" | "inherit";
  payload?: { value?: string | number; coordinate?: number; index?: number };
  index?: number;
};

export function RadarChartCard({
  variant = "filled",
  title,
  data: dataProp,
  series: seriesProp,
  max: maxProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = formatNumber,
  alertBelow,
  scoreCaption,
  tiles = false,
  legend = "bottom",
  radiusScale = 1,
  plotOffsetY = 0,
  className,
}: RadarChartCardProps = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const isScore = variant === "score";
  // Built-in demo periods when the host supplies neither ranges nor data.
  const demo = ranges === undefined && range === undefined && dataProp === undefined;
  const rangeList = ranges ?? (demo ? (isScore ? DEFAULT_SCORE_RANGES : DEFAULT_RANGES) : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActiveIndex(null);
    select(id);
  };

  const data = selected?.data ?? dataProp ?? (isScore ? DEFAULT_SCORE_DATA : DEFAULT_DATA);
  const series = selected?.series ?? seriesProp ?? (isScore ? DEFAULT_SCORE_SERIES : DEFAULT_SERIES);
  const max = selected?.max ?? maxProp;
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;
  const label = title ?? (isScore ? "Weekly score" : "Visitors");
  const tones = series.map((s, i) => resolveTone(i, s.color, s.activeColor));

  const valueAt = (key: string, index: number) => Number(data[index]?.[key] ?? 0);
  const totalOf = (key: string) => data.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);

  const hovering = activeIndex !== null && activeIndex < data.length;
  const primary = series[0];
  const domainMax =
    max ?? (isScore ? 100 : Math.max(1, ...series.flatMap((s) => data.map((row) => Number(row[s.key] ?? 0)))));

  const headlineValue = hovering ? valueAt(primary.key, activeIndex) : (headline ?? totalOf(primary.key));
  const headerLabel = hovering ? String(data[activeIndex].label) : label;

  const score = Math.round(totalOf(primary.key) / Math.max(1, data.length));
  const caption =
    typeof scoreCaption === "function"
      ? scoreCaption(score)
      : (scoreCaption ?? defaultScoreCaption(score));

  const renderTick = (props: AngleTickProps) => {
    const x = Number(props.x);
    const y = Number(props.y);
    const index = props.payload?.index ?? props.index ?? 0;
    const text = String(props.payload?.value ?? "");
    const active = index === activeIndex;
    const anchor = props.textAnchor ?? "middle";

    if (!isScore) {
      return (
        <text
          x={x}
          y={y}
          dy={4}
          textAnchor={anchor}
          fontSize={12}
          fontWeight={500}
          fill={active ? "var(--color-text-primary)" : "var(--color-text-tertiary)"}
          className="transition-[fill] duration-150 ease-out"
        >
          {text}
        </text>
      );
    }

    // Score labels are two lines (name over value), so they need to clear
    // the vertex on the side they sit: lift the block above the top axes,
    // drop it under the bottom ones, and centre it beside the side ones.
    const angle = ((props.payload?.coordinate ?? 90) * Math.PI) / 180;
    const sin = Math.sin(angle);
    const base = sin > 0.3 ? -22 : sin < -0.3 ? 12 : -6;
    const value = valueAt(primary.key, index);
    const alert = alertBelow !== undefined && value < alertBelow;
    return (
      <g>
        <text
          x={x}
          y={y}
          dy={base}
          textAnchor={anchor}
          fontSize={11}
          fontWeight={500}
          letterSpacing="0.02em"
          fill={active ? "var(--color-text-primary)" : "var(--color-text-tertiary)"}
          className="transition-[fill] duration-150 ease-out"
        >
          {text}
        </text>
        <text
          x={x}
          y={y}
          dy={base + 17}
          textAnchor={anchor}
          fontSize={16}
          fontWeight={500}
          fill={alert ? "var(--color-status-rose-text)" : "var(--color-text-primary)"}
          className="tabular-nums"
        >
          {format(value)}
        </text>
      </g>
    );
  };

  const legendItems =
    series.length > 1
      ? series.map((s, i) => ({
          label: s.label,
          color: tones[i].color,
          value: format(hovering ? valueAt(s.key, activeIndex) : totalOf(s.key)),
        }))
      : null;

  return (
    // With tiles the card is content-sized: the chart keeps its usual height
    // and the tile rows add to it.
    <ChartCard className={cx(tiles && "h-auto", className)}>
      <ChartHeader
        label={headerLabel}
        value={isScore ? undefined : headlineValue}
        format={format}
        delta={delta !== undefined ? describeDelta(delta) : undefined}
        hovering={hovering}
        fadeKey={`${selectedId ?? ""}:${activeIndex}`}
        range={range}
        ranges={rangeList}
        rangeId={selectedId}
        onRangeChange={selectRange}
        trailing={
          legendItems && legend === "top" ? (
            <ChartLegend items={legendItems} className="h-8 w-auto shrink-0 justify-end gap-x-3" />
          ) : undefined
        }
      />

      <div className={cx("relative min-h-0 w-full flex-1", tiles && "h-[231px] flex-none")}>
        {/* The plot and the score disc move together as one unit; an overlay
            legend stays anchored to the bottom of the chart area. */}
        <div
          className="absolute inset-0"
          style={plotOffsetY ? { transform: `translateY(${plotOffsetY}px)` } : undefined}
        >
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart
              data={data}
              cy={legend === "overlay" && legendItems ? "44%" : "50%"}
              // Per-variant base radius (the score disc and an overlaid legend
              // both need room), scaled by `radiusScale`.
              outerRadius={`${Math.round((isScore ? 62 : legend === "overlay" && legendItems ? 66 : 74) * radiusScale)}%`}
              margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
              // Long axis labels may run a few px past the plot into the card
              // padding; better than clipping them mid-word.
              className="[&_svg]:overflow-visible"
              onMouseMove={(state) => {
                const idx = Number(state?.activeTooltipIndex);
                if (state?.isTooltipActive && Number.isInteger(idx)) setActiveIndex(idx);
                else setActiveIndex(null);
              }}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <PolarGrid stroke="var(--color-chart-cursor)" strokeWidth={1} />
              <PolarAngleAxis dataKey="label" tick={renderTick} tickLine={false} />
              <PolarRadiusAxis domain={[0, domainMax]} tick={false} axisLine={false} />
              {/* Headless tooltip: only used to drive the active index. */}
              <Tooltip content={() => null} cursor={false} isAnimationActive={false} />
              {series.map((s, i) => {
                const tone = tones[i];
                const filled = variant !== "lines";
                const dotted = variant === "dots" || isScore;
                return (
                  <Radar
                    key={s.key}
                    name={s.label}
                    dataKey={s.key}
                    stroke={tone.activeColor}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    fill={filled ? tone.color : "none"}
                    fillOpacity={filled ? 0.28 : 0}
                    dot={
                      dotted
                        ? {
                            r: 3.5,
                            fill: tone.activeColor,
                            fillOpacity: 1,
                            stroke: "var(--color-background-secondary-default)",
                            strokeWidth: 2,
                          }
                        : false
                    }
                    activeDot={<PulsingDot color={tone.activeColor} />}
                    isAnimationActive
                    animationDuration={450}
                  />
                );
              })}
            </RadarChart>
          </ResponsiveContainer>

          {isScore && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={cx(
                  "flex size-[84px] flex-col items-center justify-center rounded-full",
                  "bg-background-inner-default shadow-card backdrop-blur-[2px]",
                )}
              >
                <span className="text-title-1-medium leading-none text-text-primary tabular-nums">
                  {format(score)}
                </span>
                <span className="mt-1 max-w-[72px] truncate text-caption-1-medium text-text-tertiary">
                  {caption}
                </span>
              </div>
            </div>
          )}
        </div>

        {legendItems && legend === "overlay" && (
          <ChartLegend items={legendItems} className="absolute inset-x-0 bottom-0" />
        )}
      </div>

      {legendItems && legend === "bottom" && (
        <ChartLegend items={legendItems} className={tiles ? undefined : "pb-1"} />
      )}

      {tiles && (
        <ChartStatTiles
          // No swatch: every axis belongs to the same (primary) series, so a
          // dot per tile would carry no information.
          items={data.map((row, i) => ({
            label: String(row.label),
            value: format(valueAt(primary.key, i)),
          }))}
          activeIndex={hovering ? activeIndex : null}
          onActiveChange={setActiveIndex}
        />
      )}
    </ChartCard>
  );
}
