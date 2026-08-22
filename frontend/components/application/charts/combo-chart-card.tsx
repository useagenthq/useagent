"use client";

import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartCard,
  ChartHeader,
  ChartStatTiles,
  describeDelta,
  formatNumber,
  resolveTone,
  useChartRange,
  type ChartRange,
} from "@/components/application/charts/chart-card";
import { cx } from "@/utils/cx";

/**
 * Combo chart card on Recharts `ComposedChart`: a bar series on the left axis
 * and a line series on its own right axis - the "volume plus rate" shape every
 * dashboard ends up needing (revenue and margin, sessions and conversion).
 *
 * The two axes are independent, so each series keeps its own `format`: the
 * bars count things, the line is usually a percentage. Hovering a category
 * darkens its bar, dims the rest, pops a dot on the line, and swaps the
 * headline to that category - the tiles below hold both series' summaries.
 */

export type ComboPoint = { label: string } & Record<string, number | string>;

export type ComboSeries = {
  /** Field of `ComboPoint` holding this series' values. */
  key: string;
  label: string;
  /** Any CSS colour; defaults to the chart palette (lime bars, blue line). */
  color?: string;
  activeColor?: string;
  /** Axis tick + headline formatting for this series alone. */
  format?: (n: number) => string;
};

/** A selectable period: pill label + the props it overrides. */
export type ComboRange = ChartRange<{
  data: ComboPoint[];
  delta: number;
  headline: number;
}>;

export interface ComboChartCardProps {
  /** Header label; swaps to the hovered category while hovering. */
  title?: string;
  data?: ComboPoint[];
  /** Bar series, read against the left axis. */
  bar?: ComboSeries;
  /** Line series, read against the right axis. */
  line?: ComboSeries;
  /** Headline number at rest; defaults to the bar series' total. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("This year"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: ComboRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  /** Stat tiles under the chart: the bar total and the line average. */
  tiles?: boolean;
  className?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const rowsOf = (sessions: number[], rate: number[]): ComboPoint[] =>
  sessions.map((value, i) => ({ label: MONTHS[i], sessions: value, rate: rate[i] }));

const DEFAULT_DATA = rowsOf(
  [4200, 4800, 5600, 5200, 6400, 7100, 6800, 7600, 8400, 8100, 9200, 9800],
  [2.4, 2.6, 3.1, 2.9, 3.4, 3.8, 3.6, 4.1, 4.4, 4.2, 4.8, 5.2],
);

const compactNumber = (n: number) =>
  n >= 1000 ? `${Math.round(n / 100) / 10}K`.replace(".0K", "K") : String(Math.round(n));

const percent = (n: number) => `${Math.round(n * 10) / 10}%`;

const DEFAULT_BAR: ComboSeries = { key: "sessions", label: "Sessions", format: formatNumber };
const DEFAULT_LINE: ComboSeries = {
  key: "rate",
  label: "Conversion",
  color: "var(--color-chart-6)",
  activeColor: "var(--color-chart-6-active)",
  format: percent,
};

/** Demo periods used when no data props are given at all. */
const DEFAULT_RANGES: ComboRange[] = [
  { id: "year", label: "This year", data: DEFAULT_DATA, delta: 0.094 },
  {
    id: "h2",
    label: "Last 6 months",
    data: rowsOf([6800, 7600, 8400, 8100, 9200, 9800], [3.6, 4.1, 4.4, 4.2, 4.8, 5.2]).map((row, i) => ({
      ...row,
      label: MONTHS[i + 6],
    })),
    delta: 0.121,
  },
  {
    id: "prev",
    label: "Last year",
    data: rowsOf(
      [3100, 3400, 3900, 3700, 4300, 4600, 4400, 5100, 5400, 5200, 5900, 6300],
      [1.9, 2.1, 2.4, 2.2, 2.7, 2.9, 2.8, 3.2, 3.3, 3.1, 3.6, 3.9],
    ),
    delta: -0.028,
  },
];

const BAR_RADIUS: [number, number, number, number] = [8, 8, 8, 8];
/** Opacity of the other bars while one category is hovered. */
const DIM = 0.3;

/** Active point on the line: a solid dot with an outward-pulsing halo, the
 *  same marker the line chart card uses. */
function PulsingDot({ cx: x, cy, color }: { cx?: number; cy?: number; color: string }) {
  if (x == null || cy == null) return null;
  return (
    <g>
      <circle cx={x} cy={cy} r={5} fill={color} opacity={0.3}>
        <animate attributeName="r" values="5;13" dur="1.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.35;0" dur="1.4s" repeatCount="indefinite" />
      </circle>
      <circle
        cx={x}
        cy={cy}
        r={5}
        fill={color}
        stroke="var(--color-background-secondary-default)"
        strokeWidth={3}
      />
    </g>
  );
}

export function ComboChartCard({
  title = "Sessions",
  data: dataProp,
  bar: barProp,
  line: lineProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  tiles = false,
  className,
}: ComboChartCardProps = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Built-in demo periods when the host supplies neither ranges nor data.
  const demo = ranges === undefined && range === undefined && dataProp === undefined;
  const rangeList = ranges ?? (demo ? DEFAULT_RANGES : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActiveIndex(null);
    select(id);
  };

  const data = selected?.data ?? dataProp ?? DEFAULT_DATA;
  const bar = barProp ?? DEFAULT_BAR;
  const line = lineProp ?? DEFAULT_LINE;
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;

  const barTone = resolveTone(0, bar.color, bar.activeColor);
  const lineTone = resolveTone(1, line.color, line.activeColor);
  const barFormat = bar.format ?? formatNumber;
  const lineFormat = line.format ?? percent;

  const valueAt = (key: string, index: number) => Number(data[index]?.[key] ?? 0);
  const barTotal = data.reduce((sum, row) => sum + Number(row[bar.key] ?? 0), 0);
  const lineAverage = data.length
    ? data.reduce((sum, row) => sum + Number(row[line.key] ?? 0), 0) / data.length
    : 0;

  const hovering = activeIndex !== null && activeIndex < data.length;
  const headerLabel = hovering ? String(data[activeIndex].label) : title;
  const headlineValue = hovering ? valueAt(bar.key, activeIndex) : (headline ?? barTotal);
  // While hovering, the line's own value for that category rides along as the
  // caption - the two axes only make sense read together.
  const captionValue = hovering ? valueAt(line.key, activeIndex) : lineAverage;

  return (
    <ChartCard className={cx(tiles && "h-auto", className)}>
      <ChartHeader
        label={`${headerLabel} · ${line.label} ${lineFormat(captionValue)}`}
        value={headlineValue}
        format={barFormat}
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
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            barCategoryGap="22%"
            onMouseMove={(state) => {
              const idx = Number(state?.activeTooltipIndex);
              if (state?.isTooltipActive && Number.isInteger(idx)) setActiveIndex(idx);
              else setActiveIndex(null);
            }}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <CartesianGrid vertical={false} stroke="var(--color-chart-track)" strokeDasharray="4 4" />
            <YAxis
              yAxisId="bars"
              width={44}
              tickCount={4}
              tickFormatter={compactNumber}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
            />
            <YAxis
              yAxisId="line"
              orientation="right"
              width={40}
              tickCount={4}
              tickFormatter={lineFormat}
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
            <Tooltip content={() => null} cursor={false} isAnimationActive={false} />
            <Bar
              yAxisId="bars"
              dataKey={bar.key}
              name={bar.label}
              radius={BAR_RADIUS}
              maxBarSize={34}
              activeBar={false}
              isAnimationActive
              animationDuration={450}
            >
              {data.map((row, index) => (
                <Cell
                  key={String(row.label)}
                  fill={index === activeIndex ? barTone.activeColor : barTone.color}
                  opacity={hovering && index !== activeIndex ? DIM : 1}
                  className="transition-[fill,opacity] duration-200 ease-out"
                />
              ))}
            </Bar>
            {/* The line is drawn twice: first a wide stroke in the card's own
                colour, then the real stroke on top. The casing cuts a clean
                gap wherever the line crosses a bar, so it reads as sitting in
                front of the bars rather than scribbled across them. */}
            <Line
              yAxisId="line"
              type="monotone"
              dataKey={line.key}
              stroke="var(--color-background-secondary-default)"
              strokeWidth={7}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive
              animationDuration={450}
            />
            <Line
              yAxisId="line"
              type="monotone"
              dataKey={line.key}
              name={line.label}
              stroke={lineTone.activeColor}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              // Small anchored dots so each category's reading is unambiguous
              // against the bar behind it; the card-coloured ring keeps them
              // crisp on top of a bar.
              dot={{
                r: 3,
                fill: lineTone.activeColor,
                stroke: "var(--color-background-secondary-default)",
                strokeWidth: 2,
              }}
              activeDot={<PulsingDot color={lineTone.activeColor} />}
              isAnimationActive
              animationDuration={450}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {tiles && (
        <ChartStatTiles
          items={[
            {
              label: `${bar.label} · total`,
              value: barFormat(hovering ? valueAt(bar.key, activeIndex) : barTotal),
              color: barTone.color,
              activeColor: barTone.activeColor,
            },
            {
              label: `${line.label} · ${hovering ? "this month" : "average"}`,
              value: lineFormat(captionValue),
              color: lineTone.color,
              activeColor: lineTone.activeColor,
            },
          ]}
        />
      )}
    </ChartCard>
  );
}
