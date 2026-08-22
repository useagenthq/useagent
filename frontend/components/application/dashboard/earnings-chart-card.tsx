"use client";

import { useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Chip } from "@/components/base/badges/chip";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { useCountUp } from "@/hooks/use-count-up";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → dashboard 1 → Frame 68 (node 3731:3088).
 *
 * "Earned so far" card. The static Figma bars are now a live Recharts
 * BarChart: lime rounded bars sit over a neutral track (Bar `background`),
 * the y-axis keeps the Figma ticks ($0 / $3K / $5K / $10K), hovering a bar
 * shows a tooltip, and the Weekly / Monthly / Yearly control swaps the
 * dataset + headline figures.
 */

type Point = { label: string; value: number };

type Period = {
  id: string;
  total: number;
  delta: string;
  deltaColor: "lime" | "rose" | "neutral";
  data: Point[];
};

const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONTH_FULL: Record<string, string> = {
  Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June",
  Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December",
};

const zip = (values: number[]): Point[] => values.map((value, i) => ({ label: M[i], value }));

const PERIODS: Record<string, Period> = {
  weekly: {
    id: "weekly",
    total: 7462,
    delta: "+14.8%",
    deltaColor: "lime",
    data: zip([3240, 7420, 9650, 7130, 3670, 2300, 3820, 5040, 6840, 4540, 11520, 8210]),
  },
  monthly: {
    id: "monthly",
    total: 32180,
    delta: "+8.2%",
    deltaColor: "lime",
    data: zip([5200, 6100, 7300, 8900, 9600, 10800, 11200, 9800, 8600, 7400, 6900, 8100]),
  },
  yearly: {
    id: "yearly",
    total: 389204,
    delta: "+21.4%",
    deltaColor: "lime",
    data: zip([4200, 4800, 5600, 6100, 6800, 7500, 8200, 8900, 9600, 10300, 11000, 11600]),
  },
};

const Y_TICKS = [0, 3000, 5000, 10000];
const Y_MAX = 12000;
const BAR_RADIUS: [number, number, number, number] = [10, 10, 10, 10];

const formatK = (v: number) => (v === 0 ? "$0" : `$${v / 1000}K`);

/** Gap between the track and the hover outline, and the outline thickness. */
const HOVER_PADDING = 3;
const HOVER_STROKE = 2;

export function EarningsChartCard({ className }: { className?: string }) {
  const [period, setPeriod] = useState("weekly");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const active = PERIODS[period];

  const hovering = activeIndex !== null && activeIndex < active.data.length;
  const targetValue = hovering ? active.data[activeIndex].value : active.total;
  const label = hovering ? MONTH_FULL[active.data[activeIndex].label] : "Earned so far";
  const display = useCountUp(targetValue);

  return (
    <section className={cx("flex h-[329px] w-full min-w-0 flex-col gap-6 rounded-2xl bg-background-secondary-default px-4 pt-4 pb-3 xl:w-[673px] xl:shrink-0", className)}>
      {/* Header — stacks on mobile so the tabs never overlap the delta chip */}
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:gap-0.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="w-full text-body-medium text-text-secondary">{label}</p>
          <div className="flex w-full items-center gap-2">
            <p
              key={`${period}:${activeIndex}`}
              className="animate-number-fade text-title-1-medium whitespace-nowrap text-text-primary tabular-nums"
            >
              ${display.toLocaleString()}
            </p>
            <Chip variant="bold" color={active.deltaColor} className={hovering ? "invisible" : undefined}>
              {active.delta}
            </Chip>
          </div>
        </div>
        <SegmentedControl
          selectedKeys={[period]}
          onSelectionChange={(keys) => {
            const next = [...(keys as Set<string>)][0];
            if (next) setPeriod(next);
          }}
          aria-label="Earnings period"
          // Mobile: drop the track padding so the selected pill's left edge lines
          // up with the heading text above. Restored to the Figma p-1 from sm up.
          className="p-0 sm:p-1"
        >
          <SegmentedControlItem id="weekly">Weekly</SegmentedControlItem>
          <SegmentedControlItem id="monthly">Monthly</SegmentedControlItem>
          <SegmentedControlItem id="yearly">Yearly</SegmentedControlItem>
        </SegmentedControl>
      </div>

      {/* Chart */}
      <div className="min-h-0 w-full flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={active.data}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            barCategoryGap="18%"
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
            <YAxis
              width={44}
              domain={[0, Y_MAX]}
              ticks={Y_TICKS}
              tickFormatter={formatK}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12, fill: "var(--color-text-tertiary)" }}
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={12}
              tick={{ fontSize: 13, fill: "var(--color-text-tertiary)" }}
            />
            <Tooltip cursor={false} content={() => null} isAnimationActive={false} />
            <Bar
              dataKey="value"
              fill="var(--color-chart-2)"
              radius={BAR_RADIUS}
              maxBarSize={40}
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
                    <rect
                      x={x}
                      y={y}
                      width={width}
                      height={height}
                      rx={10}
                      ry={10}
                      fill="var(--color-chart-track)"
                    />
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
              {active.data.map((point, index) => (
                <Cell
                  key={point.label}
                  fill={index === activeIndex ? "var(--color-chart-2-active)" : "var(--color-chart-2)"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
