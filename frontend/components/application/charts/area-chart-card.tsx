"use client";

import { useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
 * Multi-series area chart card on Recharts `AreaChart` - the composition-over-
 * time counterpart to the single-series line card. Three looks from one prop:
 *
 *   stacked  areas stacked into one silhouette (default)
 *   overlap  translucent areas drawn over each other, for comparison
 *   percent  100% stacked: every category fills the height, so the chart
 *            reads as share rather than volume
 *
 * `data` is a flat list of rows keyed by category `label` with one numeric
 * field per series; `series` names those fields. Hovering a category swaps
 * the headline to that category's total (its own value in `overlap`), draws
 * a dashed cursor, and moves the legend and tiles to that category's values.
 */

export type AreaPoint = { label: string } & Record<string, number | string>;

export type AreaSeries = {
  /** Field of `AreaPoint` holding this series' values. */
  key: string;
  label: string;
  /** Any CSS colour; defaults to the chart palette by series index. */
  color?: string;
  activeColor?: string;
};

export type AreaVariant = "stacked" | "overlap" | "percent";
export type AreaShape = "curved" | "sharp";

/** A selectable period: pill label + the props it overrides. */
export type AreaRange = ChartRange<{
  data: AreaPoint[];
  series: AreaSeries[];
  delta: number;
  headline: number;
}>;

export interface AreaChartCardProps {
  variant?: AreaVariant;
  /** Monotone spline (default) or straight segments between points. */
  shape?: AreaShape;
  /** Header label; swaps to the hovered category while hovering. */
  title?: string;
  data?: AreaPoint[];
  series?: AreaSeries[];
  /** Headline number at rest; defaults to the total across every series. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("Jan – Jun 2024"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: AreaRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  format?: (n: number) => string;
  /** Stat tiles under the chart, one per series (its total, or the hovered
   *  category's value). The card grows to fit. */
  tiles?: boolean;
  className?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const rowsOf = (organic: number[], referral: number[], paid: number[]): AreaPoint[] =>
  organic.map((value, i) => ({
    label: MONTHS[i],
    organic: value,
    referral: referral[i],
    paid: paid[i],
  }));

const DEFAULT_SERIES: AreaSeries[] = [
  { key: "organic", label: "Organic" },
  { key: "referral", label: "Referral" },
  { key: "paid", label: "Paid" },
];

const DEFAULT_DATA = rowsOf(
  [2400, 2800, 3200, 3000, 3600, 4200, 4600, 4400, 5100, 5600, 5400, 6200],
  [1200, 1400, 1300, 1700, 1900, 1800, 2200, 2500, 2400, 2900, 3200, 3400],
  [800, 700, 1100, 900, 1300, 1500, 1400, 1800, 2000, 1900, 2300, 2600],
);

/** Demo periods used when no data props are given at all. */
const DEFAULT_RANGES: AreaRange[] = [
  { id: "year", label: "This year", data: DEFAULT_DATA, delta: 0.082 },
  {
    id: "h2",
    label: "Last 6 months",
    data: rowsOf(
      [4600, 4400, 5100, 5600, 5400, 6200],
      [2200, 2500, 2400, 2900, 3200, 3400],
      [1400, 1800, 2000, 1900, 2300, 2600],
    ).map((row, i) => ({ ...row, label: MONTHS[i + 6] })),
    delta: 0.114,
  },
  {
    id: "prev",
    label: "Last year",
    data: rowsOf(
      [1900, 2100, 2000, 2400, 2600, 2500, 3100, 3000, 3400, 3800, 3600, 4100],
      [900, 1100, 1000, 1300, 1200, 1500, 1600, 1800, 1700, 2100, 2300, 2200],
      [600, 500, 800, 700, 900, 1100, 1000, 1200, 1400, 1300, 1600, 1800],
    ),
    delta: -0.036,
  },
];

const compactNumber = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}K`.replace(".0K", "K") : String(Math.round(n));

export function AreaChartCard({
  variant = "stacked",
  shape = "curved",
  title = "Visitors",
  data: dataProp,
  series: seriesProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = formatNumber,
  tiles = false,
  className,
}: AreaChartCardProps = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const gradientId = useId();

  // Built-in demo periods when the host supplies neither ranges nor data.
  const demo = ranges === undefined && range === undefined && dataProp === undefined;
  const rangeList = ranges ?? (demo ? DEFAULT_RANGES : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActiveIndex(null);
    select(id);
  };

  const data = selected?.data ?? dataProp ?? DEFAULT_DATA;
  const series = selected?.series ?? seriesProp ?? DEFAULT_SERIES;
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;
  const tones = series.map((s, i) => resolveTone(i, s.color, s.activeColor));

  const valueAt = (key: string, index: number) => Number(data[index]?.[key] ?? 0);
  const totalOf = (key: string) => data.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
  const rowTotal = (index: number) => series.reduce((sum, s) => sum + valueAt(s.key, index), 0);

  const hovering = activeIndex !== null && activeIndex < data.length;
  const grandTotal = series.reduce((sum, s) => sum + totalOf(s.key), 0);
  // In `overlap` the series aren't parts of a whole, so the primary series
  // carries the headline rather than a sum that means nothing.
  const restingValue = headline ?? (variant === "overlap" ? totalOf(series[0].key) : grandTotal);
  const hoveredValue = hovering
    ? variant === "overlap"
      ? valueAt(series[0].key, activeIndex)
      : rowTotal(activeIndex)
    : 0;

  const headerLabel = hovering ? String(data[activeIndex].label) : title;
  const headlineValue = hovering ? hoveredValue : restingValue;

  const isPercent = variant === "percent";
  const curve = shape === "sharp" ? "linear" : "monotone";
  const stackId = variant === "overlap" ? undefined : "total";

  const legendItems = series.map((s, i) => ({
    label: s.label,
    color: tones[i].color,
    value: format(hovering ? valueAt(s.key, activeIndex) : totalOf(s.key)),
  }));

  return (
    <ChartCard className={cx(tiles && "h-auto", className)}>
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

      <div className={cx("min-h-0 w-full flex-1", tiles && "h-[196px] flex-none")}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            stackOffset={isPercent ? "expand" : "none"}
            margin={{ top: 4, right: 6, bottom: 0, left: 0 }}
            onMouseMove={(state) => {
              const idx = Number(state?.activeTooltipIndex);
              if (state?.isTooltipActive && Number.isInteger(idx)) setActiveIndex(idx);
              else setActiveIndex(null);
            }}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s.key} id={`${gradientId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={tones[i].color} stopOpacity={variant === "overlap" ? 0.4 : 0.55} />
                  <stop offset="100%" stopColor={tones[i].color} stopOpacity={0.04} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="var(--color-chart-track)" strokeDasharray="4 4" />
            <YAxis
              width={44}
              // `stackOffset="expand"` yields a 0-1 domain that Recharts then
              // pads, which would put a 105% tick on a 100% chart - so the
              // percent variant pins the domain and its ticks.
              domain={isPercent ? [0, 1] : undefined}
              ticks={isPercent ? [0, 0.25, 0.5, 0.75, 1] : undefined}
              tickCount={4}
              tickFormatter={isPercent ? (v: number) => `${Math.round(v * 100)}%` : compactNumber}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={12}
              interval="preserveStartEnd"
              tick={{ fontSize: 13, fill: "var(--color-text-tertiary)" }}
            />
            {/* Headless: the cursor line is the only thing drawn, the header
                and legend carry the values. */}
            <Tooltip
              content={() => null}
              cursor={{ stroke: "var(--color-chart-cursor)", strokeWidth: 1, strokeDasharray: "4 4" }}
            />
            {series.map((s, i) => (
              <Area
                key={s.key}
                type={curve}
                dataKey={s.key}
                name={s.label}
                stackId={stackId}
                stroke={tones[i].activeColor}
                strokeWidth={2}
                fill={`url(#${gradientId}-${i})`}
                isAnimationActive
                animationDuration={450}
                activeDot={{
                  r: 4,
                  fill: tones[i].activeColor,
                  stroke: "var(--color-background-secondary-default)",
                  strokeWidth: 2,
                }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {!tiles && <ChartLegend items={legendItems} className="pb-1" />}

      {tiles && (
        <ChartStatTiles
          items={series.map((s, i) => ({
            label: s.label,
            value: format(hovering ? valueAt(s.key, activeIndex) : totalOf(s.key)),
            color: tones[i].color,
            activeColor: tones[i].activeColor,
          }))}
        />
      )}
    </ChartCard>
  );
}
