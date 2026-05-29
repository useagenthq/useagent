"use client";

import { useId, useState } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Chip } from "@/components/base/badges/chip";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { useCountUp } from "@/hooks/use-count-up";
import { cx } from "@/utils/cx";

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
    total: 18240,
    delta: "+9.4%",
    deltaColor: "lime",
    data: zip([1400, 1900, 2600, 2300, 3400, 3100, 2700, 3800, 4600, 4200, 3600, 5200]),
  },
  monthly: {
    id: "monthly",
    total: 64820,
    delta: "+12.6%",
    deltaColor: "lime",
    data: zip([3200, 4100, 3800, 5200, 6400, 5900, 5100, 6800, 8100, 7600, 8400, 9600]),
  },
  yearly: {
    id: "yearly",
    total: 512400,
    delta: "-3.2%",
    deltaColor: "rose",
    data: zip([28000, 34000, 46000, 41000, 52000, 49000, 61000, 55000, 68000, 72000, 64000, 83000]),
  },
};

const formatK = (v: number) => (v === 0 ? "$0" : `$${Math.round(v / 1000)}K`);

/**
 * Line chart card ("Revenue" on the home dashboard): a Recharts area + line
 * over a soft gradient, Weekly/Monthly/Yearly switcher, count-up headline
 * that follows the hovered point, and a pulsing active dot.
 *
 * `shape` picks the interpolation: `curved` (default) is the monotone spline;
 * `sharp` joins the points with straight segments for a crisp, cornered line.
 */
export type LineChartShape = "curved" | "sharp";

/** Active point marker: a solid lime dot with an outward-pulsing halo. */
function PulsingDot(props: { cx?: number; cy?: number }) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={5} fill="var(--color-chart-2-active)" opacity={0.3}>
        <animate attributeName="r" values="5;13" dur="1.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.35;0" dur="1.4s" repeatCount="indefinite" />
      </circle>
      <circle
        cx={cx}
        cy={cy}
        r={5}
        fill="var(--color-chart-2-active)"
        stroke="var(--color-background-secondary-default)"
        strokeWidth={3}
      />
    </g>
  );
}

export function LineChartCard({
  shape = "curved",
  className,
}: {
  shape?: LineChartShape;
  className?: string;
} = {}) {
  const [period, setPeriod] = useState("weekly");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const gradientId = useId();
  const active = PERIODS[period];

  const hovering = activeIndex !== null && activeIndex < active.data.length;
  const targetValue = hovering ? active.data[activeIndex].value : active.total;
  const label = hovering ? MONTH_FULL[active.data[activeIndex].label] : "Revenue";
  const display = useCountUp(targetValue);

  const values = active.data.map((d) => d.value);
  const yMax = Math.max(...values);
  const curve = shape === "sharp" ? "linear" : "monotone";

  return (
    <section className={cx("flex h-[329px] min-w-0 flex-1 flex-col gap-6 rounded-2xl bg-background-secondary-default px-4 pt-4 pb-3", className)}>
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
          aria-label="Revenue period"
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
          <ComposedChart
            data={active.data}
            margin={{ top: 4, right: 6, bottom: 0, left: 0 }}
            onMouseMove={(state) => {
              const idx = Number(state?.activeTooltipIndex);
              if (state?.isTooltipActive && Number.isFinite(idx)) {
                setActiveIndex(idx);
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-2)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-chart-2)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis
              width={44}
              domain={[0, yMax * 1.1]}
              tickCount={4}
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
              interval="preserveStartEnd"
              tick={{ fontSize: 13, fill: "var(--color-text-tertiary)" }}
            />
            <Tooltip
              content={() => null}
              cursor={{
                stroke: "var(--color-chart-cursor)",
                strokeWidth: 1,
                strokeDasharray: "4 4",
              }}
            />
            <Area
              type={curve}
              dataKey="value"
              stroke="none"
              fill={`url(#${gradientId})`}
              isAnimationActive
              animationDuration={450}
            />
            <Line
              type={curve}
              dataKey="value"
              stroke="var(--color-chart-2-active)"
              strokeWidth={2.5}
              dot={false}
              activeDot={<PulsingDot />}
              isAnimationActive
              animationDuration={450}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
