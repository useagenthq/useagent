"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Cell,
  LabelList,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
} from "recharts";
import {
  ChartCard,
  ChartCenterReadout,
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
 * Radial chart card on Recharts `RadialBarChart` (and `PieChart` for the
 * half gauge). Six looks from one prop:
 *
 *   rings    one ring per item over a grey track, first item innermost
 *   labels   rings with the item name set along the start of each arc
 *   grid     rings without tracks, over a circular grid
 *   gauge    a single thin ring showing `value / max`, percent in the centre
 *   solid    the same, thicker, on a raised inner disc
 *   stacked  a half gauge of stacked segments; the centre shows the primary
 *            segment's share and follows the hovered segment
 *
 * `data` is a flat list of `{ label, value, color? }` items; add or remove
 * an item and the rings / segments follow, colours cycle the chart palette
 * unless overridden. Hovering an item darkens it (400 → 500, like every
 * other chart card) and swaps the headline to its value.
 *
 * The period pill is a dropdown when `ranges` is given: each range carries
 * its own `data` (and optionally `max`, `delta`, `headline`) and the arcs
 * re-animate on selection. With no data props the card ships three demo
 * ranges per variant family.
 */

export type RadialDatum = {
  label: string;
  value: number;
  /** Any CSS colour; defaults to the chart palette by index. */
  color?: string;
  activeColor?: string;
};

export type RadialVariant = "rings" | "labels" | "grid" | "gauge" | "solid" | "stacked";

/** A selectable period: pill label + the props it overrides. */
export type RadialRange = ChartRange<{
  data: RadialDatum[];
  max: number;
  delta: number;
  headline: number;
}>;

export interface RadialChartCardProps {
  variant?: RadialVariant;
  /** Header label; swaps to the hovered item's name while hovering. */
  title?: string;
  data?: RadialDatum[];
  /**
   * The full-circle value. Rings default to 110% of the largest item so the
   * biggest ring stops just short of closing; gauges default to the item
   * total (so `stacked` fills the whole arc unless you pass a bigger goal).
   */
  max?: number;
  /** Headline number at rest; defaults to the total of all items. */
  headline?: number;
  /** Delta ratio for the chip, e.g. `0.052` → "+5.2%". */
  delta?: number;
  /** Static period pill ("Jan – Jun 2024"). Ignored when `ranges` is set. */
  range?: string;
  /** Selectable periods - the pill becomes a dropdown and the selected
   *  range's fields override the top-level props. */
  ranges?: RadialRange[];
  /** Initially selected range id (defaults to the first). */
  defaultRange?: string;
  onRangeChange?: (id: string) => void;
  format?: (n: number) => string;
  /** Caption under the centre percentage of the gauge variants
   *  (default "of goal" for gauge/solid, the segment name for stacked). */
  centerCaption?: string;
  /** Stat tiles under the chart, one per item: three per row, the last row
   *  stretched full width (5 items → 3 + 2). The card grows to fit. */
  tiles?: boolean;
  className?: string;
}

const DEFAULT_RINGS: RadialDatum[] = [
  { label: "Other", value: 90 },
  { label: "Edge", value: 173 },
  { label: "Firefox", value: 187 },
  { label: "Safari", value: 200 },
  { label: "Chrome", value: 275 },
];

const DEFAULT_GAUGE: RadialDatum[] = [{ label: "Visitors", value: 1260 }];
const DEFAULT_GAUGE_MAX = 2000;

const DEFAULT_STACKED: RadialDatum[] = [
  { label: "Desktop", value: 1260 },
  { label: "Mobile", value: 570 },
];

const rings = (values: number[]): RadialDatum[] =>
  DEFAULT_RINGS.map((d, i) => ({ label: d.label, value: values[i] }));

/** Demo periods used when no data props are given at all. */
const DEFAULT_RING_RANGES: RadialRange[] = [
  { id: "7d", label: "Last 7 days", data: DEFAULT_RINGS, delta: 0.052 },
  { id: "30d", label: "Last 30 days", data: rings([410, 520, 760, 690, 1120]), delta: 0.081 },
  { id: "90d", label: "Last 90 days", data: rings([1480, 1720, 1900, 2610, 3260]), delta: -0.024 },
];

const DEFAULT_GAUGE_RANGES: RadialRange[] = [
  { id: "7d", label: "Last 7 days", data: DEFAULT_GAUGE, max: DEFAULT_GAUGE_MAX, delta: 0.052 },
  { id: "30d", label: "Last 30 days", data: [{ label: "Visitors", value: 4820 }], max: 6000, delta: 0.081 },
  { id: "90d", label: "Last 90 days", data: [{ label: "Visitors", value: 12400 }], max: 15000, delta: -0.024 },
];

const DEFAULT_STACKED_RANGES: RadialRange[] = [
  { id: "7d", label: "Last 7 days", data: DEFAULT_STACKED, delta: 0.052 },
  {
    id: "30d",
    label: "Last 30 days",
    data: [
      { label: "Desktop", value: 4820 },
      { label: "Mobile", value: 2410 },
    ],
    delta: 0.081,
  },
  {
    id: "90d",
    label: "Last 90 days",
    data: [
      { label: "Desktop", value: 12400 },
      { label: "Mobile", value: 7900 },
    ],
    delta: -0.024,
  },
];

const OUTER = 106;
/** The half gauge only needs the top half of the area, so it can run larger. */
const HALF_OUTER = 128;
const HALF_INNER = 96;
/** Gap between the half gauge's segments, in degrees.
 *
 *  Note for callers: a rounded cap eats `thickness / 2` of arc at each end, so
 *  a segment thinner than ~10% of the gauge can't round both ends and Recharts
 *  draws it as a sharp wedge. Recharts offers no per-segment cap radius that
 *  survives its entrance animation, so keep small slices grouped into an
 *  "Other" bucket rather than plotting them individually. */
const HALF_PADDING_ANGLE = 3;

const HALF_CY = "78%";
const START = 90;
const END = -270;

const pctFormat = (n: number) => `${n}%`;

const ANIMATION_MS = 450;

export function RadialChartCard({
  variant = "rings",
  title = "Visitors",
  data: dataProp,
  max: maxProp,
  headline: headlineProp,
  delta: deltaProp,
  range,
  ranges,
  defaultRange,
  onRangeChange,
  format = formatNumber,
  centerCaption,
  tiles = false,
  className,
}: RadialChartCardProps = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const isRingFamily = variant === "rings" || variant === "labels" || variant === "grid";
  const isGauge = variant === "gauge" || variant === "solid";

  // Built-in demo periods when the host supplies neither ranges nor data.
  const demo = ranges === undefined && range === undefined && dataProp === undefined;
  const rangeList =
    ranges ??
    (demo
      ? isRingFamily
        ? DEFAULT_RING_RANGES
        : variant === "stacked"
          ? DEFAULT_STACKED_RANGES
          : DEFAULT_GAUGE_RANGES
      : undefined);
  const { selected, selectedId, select } = useChartRange(rangeList, defaultRange, onRangeChange);
  const selectRange = (id: string) => {
    setActiveIndex(null);
    select(id);
  };

  const data =
    selected?.data ??
    dataProp ??
    (isRingFamily ? DEFAULT_RINGS : variant === "stacked" ? DEFAULT_STACKED : DEFAULT_GAUGE);
  const headline = selected?.headline ?? headlineProp;
  const delta = selected?.delta ?? deltaProp;
  // Memoised so hovering (which only changes `activeIndex`) doesn't hand
  // Recharts a brand-new `data` array. A new array reads as new data, which
  // replays the entrance animation - and RadialBar hides its LabelList while
  // animating, so the arc names would blink on every hover.
  const tones = useMemo(
    () => data.map((d, i) => resolveTone(i, d.color, d.activeColor)),
    [data],
  );

  const values = data.map((d) => d.value);
  const total = values.reduce((sum, v) => sum + v, 0);
  const largest = Math.max(1, ...values);
  const max =
    selected?.max ??
    maxProp ??
    (isRingFamily
      ? Math.ceil(largest * 1.1)
      : isGauge && dataProp === undefined
        ? DEFAULT_GAUGE_MAX
        : Math.max(1, total));

  const hovering = activeIndex !== null && activeIndex < data.length;
  const headerLabel = hovering ? data[activeIndex].label : title;
  const headlineValue = hovering ? data[activeIndex].value : (headline ?? total);

  const pct = (v: number) => Math.round((v / Math.max(1, max)) * 100);

  const rows = useMemo(
    () => data.map((d, i) => ({ ...d, fill: tones[i].color, index: i })),
    [data, tones],
  );

  /**
   * Recharts mints a new animation id whenever a graphical item re-renders
   * (`useAnimationId` compares the whole props object by reference), which
   * replays the entrance animation - and `RadialBar` hides its `LabelList`
   * while animating (`showLabels: !isAnimating`). Every hover re-renders this
   * card, so the arc names blinked each time.
   *
   * The entrance therefore runs once per dataset and is then disarmed, so a
   * hover has nothing to replay (the values didn't change) and the labels
   * stay put; a new dataset re-arms it, so switching period still animates.
   *
   * Disarming waits for Recharts' own `onAnimationEnd`, which fires only when
   * a cycle completes - a cancelled cycle never calls it. Cutting the
   * animation short on a timer instead would leave Recharts' internal
   * `isAnimating` stuck true and hide the labels for good.
   */
  const [settled, setSettled] = useState<RadialDatum[] | null>(null);
  const animate = settled !== data;
  // Stable across hover re-renders: a fresh identity would re-run Recharts'
  // animation effect and restart the very cycle we're waiting to finish.
  const handleEntranceEnd = useCallback(() => setSettled(data), [data]);

  /* -------------------------------------------------------------- centre */

  let center: { value: number; caption: string } | null = null;
  if (isGauge) {
    center = { value: pct(data[0]?.value ?? 0), caption: centerCaption ?? "of goal" };
  } else if (variant === "stacked") {
    const focus = hovering ? activeIndex : 0;
    center = {
      value: pct(data[focus]?.value ?? 0),
      caption: centerCaption ?? data[focus]?.label ?? "",
    };
  }

  /** Stacked segments + a transparent filler for the unclaimed remainder, so
   *  the arcs stay proportional to `max`. Memoised for the same reason as
   *  `rows` above. */
  const stackedData = useMemo(() => {
    const remainder = Math.max(0, max - total);
    return [
      ...rows.map((r) => ({ value: r.value, fill: r.fill })),
      ...(remainder > 0 ? [{ value: remainder, fill: "transparent" }] : []),
    ];
  }, [rows, max, total]);

  /* --------------------------------------------------------------- chart */

  let chart: React.ReactNode;

  if (variant === "stacked") {
    // Half gauge on a Pie: rounded, gapped segments over a grey track - the
    // sleep score card's recipe, folded to 180°.
    const pieData = stackedData;
    chart = (
      <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <Pie
          data={[{ value: 1 }]}
          dataKey="value"
          cx="50%"
          cy={HALF_CY}
          innerRadius={HALF_INNER}
          outerRadius={HALF_OUTER}
          startAngle={180}
          endAngle={0}
          cornerRadius={99}
          fill="var(--color-chart-track)"
          stroke="none"
          isAnimationActive={false}
        />
        <Pie
          data={pieData}
          dataKey="value"
          cx="50%"
          cy={HALF_CY}
          innerRadius={HALF_INNER}
          outerRadius={HALF_OUTER}
          startAngle={180}
          endAngle={0}
          cornerRadius={99}
          paddingAngle={HALF_PADDING_ANGLE}
          stroke="none"
          onMouseEnter={(_, index) => setActiveIndex(index < rows.length ? index : null)}
          onMouseLeave={() => setActiveIndex(null)}
          // The half gauge carries no labels, so it keeps the plain entrance
          // animation - the disarm below is only needed by `RadialBar`, whose
          // `LabelList` hides while animating.
          isAnimationActive
          animationDuration={ANIMATION_MS}
        >
          {pieData.map((entry, index) => {
            const isItem = index < rows.length;
            const active = hovering && activeIndex === index;
            return (
              <Cell
                key={index}
                fill={isItem && active ? tones[index].activeColor : entry.fill}
                opacity={isItem && hovering && !active ? 0.3 : 1}
                className="transition-opacity duration-200 ease-out"
              />
            );
          })}
        </Pie>
      </PieChart>
    );
  } else {
    const inner = variant === "labels" ? 26 : isGauge ? (variant === "solid" ? 72 : 88) : 44;
    const outer = isGauge ? 104 : OUTER;
    chart = (
      <RadialBarChart
        data={rows}
        innerRadius={inner}
        outerRadius={outer}
        startAngle={START}
        endAngle={END}
        barCategoryGap={variant === "labels" ? "14%" : "22%"}
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
      >
        <PolarAngleAxis type="number" domain={[0, max]} tick={false} axisLine={false} />
        {variant === "grid" && (
          <PolarGrid
            gridType="circle"
            stroke="var(--color-chart-cursor)"
            strokeWidth={1}
            polarAngles={[0, 45, 90, 135, 180, 225, 270, 315]}
          />
        )}
        {variant === "solid" && (
          <PolarGrid
            gridType="circle"
            radialLines={false}
            stroke="none"
            fill="var(--color-background-inner-default)"
            polarRadius={[inner - 8]}
          />
        )}
        <RadialBar
          dataKey="value"
          cornerRadius={99}
          background={variant === "grid" ? false : { fill: "var(--color-chart-track)" }}
          onMouseEnter={(_, index) => setActiveIndex(index)}
          onMouseLeave={() => setActiveIndex(null)}
          isAnimationActive={animate}
          animationDuration={ANIMATION_MS}
          onAnimationEnd={handleEntranceEnd}
        >
          {rows.map((row) => (
            <Cell
              key={row.label}
              fill={activeIndex === row.index ? tones[row.index].activeColor : row.fill}
              // The hovered ring keeps full strength; every other ring drops
              // hard so it lifts out of the stack.
              opacity={hovering && activeIndex !== row.index ? 0.25 : 1}
              className="transition-[fill,opacity] duration-200 ease-out"
            />
          ))}
          {variant === "labels" && (
            <LabelList
              dataKey="label"
              position="insideStart"
              fill="var(--color-background-secondary-default)"
              fontSize={10}
              fontWeight={500}
              offset={10}
              className="pointer-events-none"
            />
          )}
        </RadialBar>
      </RadialBarChart>
    );
  }

  return (
    // With tiles the card is content-sized: the chart keeps its usual height
    // and the tile rows add to it, like the stage bars.
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

      <div className={cx("relative min-h-0 w-full flex-1", tiles && "h-[231px] flex-none")}>
        <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
        {center && (
          <div
            className={
              variant === "stacked"
                ? "pointer-events-none absolute inset-x-0 top-0 h-[78%]"
                : "pointer-events-none absolute inset-0"
            }
          >
            <ChartCenterReadout
              value={center.value}
              format={pctFormat}
              caption={center.caption}
              fadeKey={`${selectedId ?? ""}:${activeIndex}`}
              className={variant === "stacked" ? "justify-end" : undefined}
            />
          </div>
        )}
      </div>

      {variant === "stacked" && !tiles && (
        <ChartLegend
          items={rows.map((r, i) => ({ label: r.label, color: tones[i].color, value: format(r.value) }))}
          activeIndex={hovering ? activeIndex : null}
          onActiveChange={setActiveIndex}
          className="pb-1"
        />
      )}

      {tiles && (
        <ChartStatTiles
          items={rows.map((r, i) => ({
            label: r.label,
            value: format(r.value),
            color: tones[i].color,
            activeColor: tones[i].activeColor,
          }))}
          activeIndex={hovering ? activeIndex : null}
          onActiveChange={setActiveIndex}
        />
      )}
    </ChartCard>
  );
}
