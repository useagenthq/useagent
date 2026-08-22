"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { MONTHS, YEAR } from "@/components/application/medical/medical-data";
import { WeekRangePill } from "@/components/application/medical/week-range-pill";
import { useCountUp } from "@/hooks/use-count-up";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → medical profile dashboard → Frame 126 (node
 * 3950:5682). Weekly step count as a teal rounded BarChart over a neutral
 * track, same "background bar" recipe as `EarningsChartCard` — including
 * its hover behaviour: hovering a bar rolls the headline to that day's
 * count (via `useCountUp`) and swaps the label to the full day name, same
 * as the dashboard's revenue/earnings cards.
 *
 * Padding is NOT uniform: the card's own inset is 10px (`p-2.5`), but the
 * header row sits 16px from the edge — 6px more than the card's base inset,
 * added via the header's own `px-1.5 pt-1.5` — while the bar chart and every
 * other content block below just inherit the card's plain 10px. Matching
 * this exactly (not a uniform `p-4`) is what makes the bar width/gap line up
 * with Figma's `gap-[11px]` / `w-[340px]` (340 = a 360px card minus 2×10px).
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const DAY_FULL: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

/** Monday of the week shown at offset 0 (the Figma "29 Jun - 5 Jul" week). */
const BASE_WEEK_START = new Date(YEAR, 5, 29);

const BAR_RADIUS: [number, number, number, number] = [10, 10, 10, 10];

/** Gap between the track and the hover outline, and the outline thickness —
 *  matched to the dashboard's earnings chart hover state. */
const HOVER_PADDING = 3;
const HOVER_STROKE = 2;

/** Deterministic hash (same technique as `medical-data`) so each week's bars
 *  are stable across renders/SSR instead of random. */
function hash(seed: number) {
  let h = Math.imul(seed ^ 0x9e3779b9, 2654435761);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Mock step counts for the week `offset` weeks from the base week — rounded
 *  to the nearest 100 to read like real daily totals (~1,800–9,000). */
function weekData(offset: number) {
  return DAYS.map((label, i) => {
    let value = Math.round((1800 + hash(offset * 100 + i) * 7000) / 100) * 100;
    // Base ("29 Jun - 5 Jul") week tweaks: trim the high Thursday, and split
    // Tuesday/Wednesday apart since they'd otherwise round to the same value.
    if (offset === 0 && label === "Thu") value = Math.round((value * 0.8) / 100) * 100;
    if (offset === 0 && label === "Wed") value = Math.round((value * 0.85) / 100) * 100;
    return { label, value };
  });
}

/** "29 Jun - 5 Jul"-style label for a given week offset. */
function weekLabel(offset: number) {
  const start = new Date(BASE_WEEK_START);
  start.setDate(start.getDate() + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const abbr = (d: Date) => MONTHS[d.getMonth()].slice(0, 3);
  return `${start.getDate()} ${abbr(start)} - ${end.getDate()} ${abbr(end)}`;
}

export function StepsCard({ className }: { className?: string } = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);

  const data = useMemo(() => weekData(weekOffset), [weekOffset]);
  const total = useMemo(() => data.reduce((sum, d) => sum + d.value, 0), [data]);

  const hovering = activeIndex !== null && activeIndex < data.length;
  const targetValue = hovering ? data[activeIndex].value : total;
  const label = hovering ? DAY_FULL[data[activeIndex].label] : "Steps";
  const suffix = hovering ? "steps" : "total steps";
  const display = useCountUp(targetValue);

  return (
    <section
      className={cx(
        "flex h-[330px] w-full min-w-0 flex-col gap-4 rounded-[20px] bg-background-secondary-default p-2.5",
        className,
      )}
    >
      <div className="flex w-full items-start justify-between gap-2 px-1.5 pt-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-body-medium text-text-secondary">{label}</p>
          <div className="flex items-baseline gap-1">
            <p
              key={String(activeIndex)}
              className="animate-number-fade text-title-1-medium whitespace-nowrap text-text-primary tabular-nums"
            >
              {display.toLocaleString()}
            </p>
            <span className="text-caption-1-medium whitespace-nowrap text-text-secondary">
              {suffix}
            </span>
          </div>
        </div>
        <WeekRangePill
          label={weekLabel(weekOffset)}
          onPrev={() => setWeekOffset((o) => o - 1)}
          onNext={() => setWeekOffset((o) => o + 1)}
        />
      </div>

      {/* The card's 10px inset plus recharts' ~5.5px outer bar-gap would push
          the first/last bar ~16px in — as wide as the 16px-inset header above.
          Stretching the chart out by that outer gap (negative x-margin, still
          inside the card padding) lands the bars ~10px from the card edge, so
          the graph reads wider than the title/total. */}
      <div className="-mx-[5.5px] min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {/* recharts applies a numeric `barCategoryGap` on EACH side of a
              category slot; 4.5 → ~9px between adjacent bars, tightened from
              the earlier 5.5 (11px) so the bars breathe less at max width. */}
          <BarChart
            data={data}
            // 4px top room so the hover outline (which pads 3px + a 2px stroke
            // above the track) isn't clipped at the chart's top edge.
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            barCategoryGap={4.5}
            onMouseMove={(state) => {
              const index = Number(state?.activeTooltipIndex);
              if (state?.isTooltipActive && Number.isInteger(index)) {
                setActiveIndex(index);
              } else {
                setActiveIndex(null);
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <Tooltip cursor={false} content={() => null} isAnimationActive={false} />
            <Bar
              dataKey="value"
              fill="var(--color-chart-1)"
              radius={BAR_RADIUS}
              // Cap sized to the widest (xl 3-col ≈ 420px card) layout so bars
              // nearly fill their slot there; narrower breakpoints stay slot-
              // constrained (well under this), preserving Figma's 360px look.
              maxBarSize={50}
              background={(props: unknown) => {
                const { x = 0, y = 0, width = 0, height = 0, index } = props as {
                  x?: number;
                  y?: number;
                  width?: number;
                  height?: number;
                  index?: number;
                };
                const isActive = index === activeIndex;
                return (
                  <g>
                    <rect x={x} y={y} width={width} height={height} rx={10} ry={10} fill="var(--color-chart-track)" />
                    <rect
                      className="transition-opacity duration-150 ease-out"
                      x={x - HOVER_PADDING}
                      y={y - HOVER_PADDING}
                      width={width + HOVER_PADDING * 2}
                      height={height + HOVER_PADDING * 2}
                      rx={10 + HOVER_PADDING}
                      ry={10 + HOVER_PADDING}
                      fill="none"
                      stroke="var(--color-chart-cursor)"
                      strokeWidth={HOVER_STROKE}
                      opacity={isActive ? 1 : 0}
                    />
                  </g>
                );
              }}
              activeBar={false}
              isAnimationActive
              animationDuration={450}
            >
              {data.map((point, index) => (
                <Cell
                  key={point.label}
                  fill={index === activeIndex ? "var(--color-chart-1-active)" : "var(--color-chart-1)"}
                />
              ))}
            </Bar>
            {/* 26px label row (16px Caption 1 text + 8px gap to the bars +
                2px breathing room below): vs the tight 24px, this lifts the
                whole bars+labels group 2px and trims the bars 2px, keeping the
                fixed container height. */}
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              height={26}
              tick={{ fontSize: 12, fill: "var(--color-text-secondary)" }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
