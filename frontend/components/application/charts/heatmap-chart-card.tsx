"use client";

import { useState } from "react";
import {
  ChartCard,
  ChartHeader,
  describeDelta,
  formatNumber,
  resolveTone,
  useChartRange,
  type ChartRange,
} from "@/components/application/charts/chart-card";
import { cx } from "@/utils/cx";

/**
 * Matrix heatmap card: rows × columns of tinted cells (weekday × hour,
 * region × month, feature × cohort…), row labels on the left, column labels
 * underneath, and a Less → More ramp legend in the footer. Plain CSS grid -
 * no chart library needed for a matrix.
 *
 * Each cell mixes the accent (`color`, default chart-6 blue) into the chart
 * track by its share of `max`, so the ramp follows the theme in both modes.
 * Hovering a cell rings it in the cursor colour and swaps the headline to
 * its value with a "Row · Column" label; the whole row and column of labels
 * darken to help reading position.
 *
 * `rows` is `{ label, values[] }[]` and `columns` names the value slots -
 * add a row or a column entry and the grid reflows.
 */

export type HeatmapRow = { label: string; values: number[] };

/** A selectable period: pill label + the props it overrides. */
export type HeatmapRange = ChartRange<{
  rows: HeatmapRow[];
  columns: string[];
  max: number;
  delta: number;
  headline: number;
}>;

export interface HeatmapChartCardProps {
  /** Header label; swaps to "Row · Column" while hovering a cell. */
  title?: string;
  rows?: HeatmapRow[];
  columns?: string[];
  /** Accent for the ramp; any CSS colour, defaults to chart-6 (blue). */
  color?: string;
  activeColor?: string;
  /** Value that maps to the fully saturated cell; defaults to the largest value. */
  max?: number;
  /** Headline number at rest; defaults to the sum of all cells. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("Last 7 days"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: HeatmapRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  format?: (n: number) => string;
  /** Show every n-th column label (default fits ~12 labels). */
  columnLabelEvery?: number;
  className?: string;
}

const DEFAULT_COLUMNS = ["00", "02", "04", "06", "08", "10", "12", "14", "16", "18", "20", "22"];

const DEFAULT_ROWS: HeatmapRow[] = [
  { label: "Mon", values: [4, 2, 1, 6, 28, 46, 52, 58, 44, 30, 18, 9] },
  { label: "Tue", values: [3, 2, 2, 8, 32, 50, 55, 62, 48, 33, 20, 10] },
  { label: "Wed", values: [5, 3, 1, 7, 30, 48, 57, 60, 47, 31, 19, 8] },
  { label: "Thu", values: [4, 2, 2, 9, 34, 52, 60, 64, 50, 35, 22, 11] },
  { label: "Fri", values: [6, 3, 2, 8, 29, 44, 49, 46, 36, 24, 15, 9] },
  { label: "Sat", values: [8, 5, 3, 4, 12, 20, 26, 28, 25, 22, 16, 12] },
  { label: "Sun", values: [7, 4, 2, 3, 10, 17, 22, 24, 23, 20, 14, 10] },
];

/** Longer demo periods: scale the week up with a small deterministic wobble
 *  so the pattern shifts rather than just brightening. */
const scaleRows = (rows: HeatmapRow[], factor: number): HeatmapRow[] =>
  rows.map((row, r) => ({
    label: row.label,
    values: row.values.map((v, c) => Math.round(v * factor * (1 + (((r * 7 + c * 3) % 5) - 2) * 0.06))),
  }));

/** Demo periods used when no rows / range are given at all. */
const DEFAULT_RANGES: HeatmapRange[] = [
  { id: "7d", label: "Last 7 days", rows: DEFAULT_ROWS, delta: 0.052 },
  { id: "4w", label: "Last 4 weeks", rows: scaleRows(DEFAULT_ROWS, 3.8), delta: 0.118 },
  { id: "quarter", label: "Last quarter", rows: scaleRows(DEFAULT_ROWS, 11.4), delta: 0.034 },
];

/** Ramp stops for the legend swatches (share of `max`). */
const LEGEND_STOPS = [0, 0.25, 0.5, 0.75, 1];

export function HeatmapChartCard({
  title = "Active users",
  rows: rowsProp,
  columns: columnsProp,
  color,
  activeColor,
  max: maxProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = formatNumber,
  columnLabelEvery,
  className,
}: HeatmapChartCardProps = {}) {
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);

  // Built-in demo periods when the host supplies neither ranges nor rows.
  const demo = ranges === undefined && range === undefined && rowsProp === undefined;
  const rangeList = ranges ?? (demo ? DEFAULT_RANGES : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActive(null);
    select(id);
  };
  const rows = selected?.rows ?? rowsProp ?? DEFAULT_ROWS;
  const columns = selected?.columns ?? columnsProp ?? DEFAULT_COLUMNS;
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;

  const tone = resolveTone(1, color, activeColor); // palette index 1 = chart-6 blue
  const all = rows.flatMap((r) => r.values);
  const max = selected?.max ?? maxProp ?? Math.max(1, ...all);
  const total = all.reduce((s, v) => s + v, 0);
  const cols = columns.length;
  const labelEvery = columnLabelEvery ?? Math.max(1, Math.ceil(cols / 12));

  const hovering = active !== null;
  const hoveredValue = hovering ? (rows[active.row]?.values[active.col] ?? 0) : 0;
  const headerLabel = hovering ? `${rows[active.row]?.label} · ${columns[active.col]}` : title;
  const headlineValue = hovering ? hoveredValue : (headline ?? total);

  /** Accent mixed into the track by share of max: 8% floor so empty cells
   *  still read as cells, 100% at max. */
  const cellColor = (v: number, base = tone.color) => {
    const share = Math.max(0, Math.min(1, v / max));
    const pct = Math.round(8 + share * 92);
    return `color-mix(in srgb, ${base} ${pct}%, var(--color-chart-track))`;
  };

  return (
    <ChartCard className={className}>
      <ChartHeader
        label={headerLabel}
        value={headlineValue}
        format={format}
        delta={delta !== undefined ? describeDelta(delta) : undefined}
        hovering={hovering}
        fadeKey={`${selectedId ?? ""}:${active ? `${active.row}:${active.col}` : "idle"}`}
        range={range}
        ranges={rangeList}
        rangeId={selectedId}
        onRangeChange={selectRange}
      />

      <div
        className="grid min-h-0 w-full flex-1 gap-1"
        style={{
          gridTemplateColumns: `auto repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr)) auto`,
        }}
        onMouseLeave={() => setActive(null)}
      >
        {rows.map((row, r) => (
          <div key={row.label} className="contents">
            <span
              className={cx(
                "flex items-center pr-2 text-caption-1-medium whitespace-nowrap transition-colors duration-150 ease-out",
                active?.row === r ? "text-text-primary" : "text-text-tertiary",
              )}
            >
              {row.label}
            </span>
            {columns.map((column, c) => {
              const v = row.values[c] ?? 0;
              const isActive = active?.row === r && active?.col === c;
              return (
                <div
                  key={column}
                  role="img"
                  aria-label={`${row.label} ${column}: ${format(v)}`}
                  className={cx(
                    "min-h-0 rounded-[4px] transition-[background-color,box-shadow] duration-150 ease-out",
                    isActive && "ring-2 ring-chart-cursor",
                  )}
                  style={{ backgroundColor: cellColor(v, isActive ? tone.activeColor : tone.color) }}
                  onMouseEnter={() => setActive({ row: r, col: c })}
                />
              );
            })}
          </div>
        ))}
        {/* Column labels */}
        <span aria-hidden />
        {columns.map((column, c) => (
          <span
            key={column}
            className={cx(
              "truncate pt-0.5 text-center text-caption-1-medium transition-colors duration-150 ease-out",
              active?.col === c ? "text-text-primary" : "text-text-tertiary",
              c % labelEvery !== 0 && "invisible",
            )}
          >
            {column}
          </span>
        ))}
      </div>

      <div className="flex w-full items-center justify-end gap-1.5 pb-1 text-caption-1-medium text-text-tertiary">
        <span>Less</span>
        {LEGEND_STOPS.map((stop) => (
          <span
            key={stop}
            className="size-3 rounded-[3px]"
            style={{ backgroundColor: cellColor(stop * max) }}
          />
        ))}
        <span>More</span>
      </div>
    </ChartCard>
  );
}
