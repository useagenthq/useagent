"use client";

import { useState } from "react";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
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
 * Scatter / bubble chart card on Recharts `ScatterChart` - the correlation
 * view: one dot per record, positioned by two measures, optionally sized by a
 * third (`z`, which turns it into a bubble chart).
 *
 * `series` groups the points so each cohort gets its own colour and legend
 * row. Hovering a point swaps the headline to it and dims the other series;
 * axis captions sit under the plot the way the Sankey card labels its ends.
 */

export type ScatterPoint = {
  x: number;
  y: number;
  /** Bubble size input. Any point carrying `z` switches the card to bubbles. */
  z?: number;
  /** Name shown in the header while the point is hovered. */
  label?: string;
};

export type ScatterSeries = {
  label: string;
  points: ScatterPoint[];
  /** Any CSS colour; defaults to the chart palette by series index. */
  color?: string;
  activeColor?: string;
};

/** A selectable period: pill label + the props it overrides. */
export type ScatterRange = ChartRange<{
  series: ScatterSeries[];
  delta: number;
  headline: number;
}>;

export interface ScatterChartCardProps {
  /** Header label; swaps to the hovered point while hovering. */
  title?: string;
  series?: ScatterSeries[];
  /** Captions under the plot: `[x, y]`. */
  axisLabels?: [string, string];
  /** Force bubbles on/off; by default any `z` in the data turns them on. */
  bubble?: boolean;
  /** Headline number at rest; defaults to the average y across every point. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("This quarter"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: ScatterRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  /** Formats the y measure (headline, axis, tiles). */
  format?: (n: number) => string;
  /** Formats the x measure (axis ticks, hovered point caption). */
  formatX?: (n: number) => string;
  /** Stat tiles under the chart, one per series (its average y). */
  tiles?: boolean;
  className?: string;
}

const points = (pairs: [number, number, number?][], labels: string[]): ScatterPoint[] =>
  pairs.map(([x, y, z], i) => ({ x, y, z, label: labels[i] }));

const DEFAULT_SERIES: ScatterSeries[] = [
  {
    label: "Starter",
    points: points(
      [
        [12, 180, 40],
        [18, 240, 60],
        [24, 210, 30],
        [31, 320, 80],
        [38, 290, 50],
        [45, 380, 70],
      ],
      ["Acme", "Bolt", "Corvus", "Delta", "Ember", "Flux"],
    ),
  },
  {
    label: "Growth",
    points: points(
      [
        [42, 620, 90],
        [55, 740, 120],
        [61, 690, 70],
        [68, 880, 150],
        [74, 810, 100],
        [83, 960, 130],
      ],
      ["Gale", "Helio", "Ionic", "Juno", "Kite", "Lumen"],
    ),
  },
  {
    label: "Scale",
    points: points(
      [
        [78, 1240, 180],
        [86, 1420, 220],
        [92, 1310, 160],
        [97, 1580, 260],
      ],
      ["Meridian", "Nova", "Orbit", "Prism"],
    ),
  },
];

const scaleSeries = (series: ScatterSeries[], factor: number): ScatterSeries[] =>
  series.map((s) => ({
    ...s,
    points: s.points.map((p) => ({ ...p, y: Math.round(p.y * factor) })),
  }));

/** Demo periods used when no data props are given at all. */
const DEFAULT_RANGES: ScatterRange[] = [
  { id: "q3", label: "This quarter", series: DEFAULT_SERIES, delta: 0.068 },
  { id: "q2", label: "Last quarter", series: scaleSeries(DEFAULT_SERIES, 0.82), delta: 0.041 },
  { id: "year", label: "This year", series: scaleSeries(DEFAULT_SERIES, 3.6), delta: -0.019 },
];

const compactNumber = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}K`.replace(".0K", "K") : String(Math.round(n));

/** Bubble area range, px². Big enough to read, small enough not to collide. */
const BUBBLE_RANGE: [number, number] = [90, 620];
/** Opacity of the other series while a point is hovered. */
const DIM = 0.25;

export function ScatterChartCard({
  title = "Revenue per account",
  series: seriesProp,
  axisLabels,
  bubble: bubbleProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = formatNumber,
  formatX = compactNumber,
  tiles = false,
  className,
}: ScatterChartCardProps = {}) {
  const [active, setActive] = useState<{ series: number; index: number } | null>(null);

  // Built-in demo periods when the host supplies neither ranges nor series.
  const demo = ranges === undefined && range === undefined && seriesProp === undefined;
  const rangeList = ranges ?? (demo ? DEFAULT_RANGES : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActive(null);
    select(id);
  };

  const series = selected?.series ?? seriesProp ?? DEFAULT_SERIES;
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;
  const tones = series.map((s, i) => resolveTone(i, s.color, s.activeColor));

  const allPoints = series.flatMap((s) => s.points);
  const bubble = bubbleProp ?? allPoints.some((p) => p.z !== undefined);
  const averageOf = (list: ScatterPoint[]) =>
    list.length ? list.reduce((sum, p) => sum + p.y, 0) / list.length : 0;

  const hovering = active !== null;
  const hoveredSeries = active ? series[active.series] : undefined;
  const hoveredPoint = active ? hoveredSeries?.points[active.index] : undefined;
  const headerLabel = hoveredPoint
    ? `${hoveredPoint.label ?? hoveredSeries?.label} · ${formatX(hoveredPoint.x)}`
    : title;
  // The resting figure is an average, so round it - a fractional headline
  // reads as false precision next to the points' own whole values.
  const headlineValue = hoveredPoint ? hoveredPoint.y : (headline ?? Math.round(averageOf(allPoints)));

  const legendItems = series.map((s, i) => ({
    label: s.label,
    color: tones[i].color,
    value: format(Math.round(averageOf(s.points))),
  }));

  return (
    <ChartCard className={cx(tiles && "h-auto", className)}>
      <ChartHeader
        label={headerLabel}
        value={headlineValue}
        format={format}
        delta={delta !== undefined ? describeDelta(delta) : undefined}
        hovering={hovering}
        fadeKey={`${selectedId ?? ""}:${active ? `${active.series}:${active.index}` : "idle"}`}
        range={range}
        ranges={rangeList}
        rangeId={selectedId}
        onRangeChange={selectRange}
      />

      <div className={cx("min-h-0 w-full flex-1", tiles && "h-[196px] flex-none")}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-chart-track)" strokeDasharray="4 4" />
            <XAxis
              type="number"
              dataKey="x"
              tickCount={5}
              tickFormatter={formatX}
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
            />
            <YAxis
              type="number"
              dataKey="y"
              width={48}
              tickCount={4}
              tickFormatter={compactNumber}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
            />
            {bubble && <ZAxis type="number" dataKey="z" range={BUBBLE_RANGE} />}
            {/* Headless: the header carries the hovered point's values. */}
            <Tooltip content={() => null} cursor={false} isAnimationActive={false} />
            {series.map((s, i) => {
              const dimmed = active !== null && active.series !== i;
              return (
                <Scatter
                  key={s.label}
                  name={s.label}
                  data={s.points}
                  fill={tones[i].color}
                  fillOpacity={dimmed ? DIM : 0.85}
                  stroke={tones[i].activeColor}
                  strokeOpacity={dimmed ? DIM : 1}
                  strokeWidth={1.5}
                  className="cursor-default transition-opacity duration-200 ease-out"
                  onMouseEnter={(_, index: number) => setActive({ series: i, index })}
                  onMouseLeave={() => setActive(null)}
                  isAnimationActive
                  animationDuration={450}
                />
              );
            })}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {axisLabels && (
        <div className="flex w-full justify-between text-caption-1-medium text-text-tertiary">
          <span>{axisLabels[1]}</span>
          <span>{axisLabels[0]}</span>
        </div>
      )}

      {!tiles && <ChartLegend items={legendItems} className="pb-1" />}

      {tiles && (
        <ChartStatTiles
          items={series.map((s, i) => ({
            label: `${s.label} · avg`,
            value: format(Math.round(averageOf(s.points))),
            color: tones[i].color,
            activeColor: tones[i].activeColor,
          }))}
          activeIndex={active?.series ?? null}
          onActiveChange={(index) => setActive(index === null ? null : { series: index, index: 0 })}
        />
      )}
    </ChartCard>
  );
}
