"use client";

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { WeekRangePill } from "@/components/application/medical/week-range-pill";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → medical profile dashboard → Frame 127 (node
 * 3950:5729). A full neutral-200 ring sits behind three colored arcs (one
 * per sub-score below; 49 + 29 + 20 = 98, the headline score) — the arcs
 * have fully rounded caps and small gaps, and the 2 unearned points stay
 * visible as exposed grey track. Hovering an arc swaps the center "98"
 * for that sub-score's own number.
 */

type Metric = { label: string; detail: string; score: number; max: number; color: string };

const METRICS: Metric[] = [
  { label: "Duration", detail: "7h 50m", score: 49, max: 50, color: "var(--color-chart-5)" },
  { label: "Bedtime", detail: "20m earlier", score: 29, max: 30, color: "var(--color-chart-3)" },
  { label: "Interruptions", detail: "5m wake up", score: 20, max: 20, color: "var(--color-chart-6)" },
];

const TOTAL_SCORE = METRICS.reduce((sum, m) => sum + m.score, 0);
const TOTAL_MAX = METRICS.reduce((sum, m) => sum + m.max, 0);

/** Colored arcs + a transparent filler for the unearned points, so the
 *  segments occupy exactly score/100 of the circle and the grey base ring
 *  shows through the rest. */
const RING_DATA = [
  ...METRICS.map((m) => ({ value: m.score, fill: m.color })),
  { value: TOTAL_MAX - TOTAL_SCORE, fill: "transparent" },
];

function scoreLabel(total: number) {
  if (total >= 90) return "Excellent";
  if (total >= 75) return "Good";
  if (total >= 50) return "Fair";
  return "Poor";
}

export function SleepScoreCard({ className }: { className?: string } = {}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const hovering = activeIndex !== null && activeIndex < METRICS.length;
  const centerValue = hovering ? METRICS[activeIndex].score : TOTAL_SCORE;

  return (
    <section
      className={cx(
        "flex h-[330px] w-full min-w-0 flex-col gap-4 rounded-[20px] bg-background-secondary-default p-2.5",
        className,
      )}
    >
      <div className="flex w-full items-start justify-between gap-2 px-1.5 pt-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-body-medium text-text-secondary">Sleep score</p>
          <p className="text-title-1-medium whitespace-nowrap text-text-primary">
            {scoreLabel(TOTAL_SCORE)}
          </p>
        </div>
        <WeekRangePill label="29 Jun - 5 Jul" />
      </div>

      <div className="relative -mt-2 h-[104px] w-full shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            {/* Full grey track behind the arcs, per Figma. */}
            <Pie
              data={[{ value: 1 }]}
              dataKey="value"
              cx="50%"
              cy="50%"
              innerRadius={37}
              outerRadius={52}
              fill="var(--color-chart-track)"
              stroke="none"
              isAnimationActive={false}
            />
            <Pie
              data={RING_DATA}
              dataKey="value"
              cx="50%"
              cy="50%"
              innerRadius={37}
              outerRadius={52}
              startAngle={90}
              endAngle={-270}
              cornerRadius={99}
              paddingAngle={4}
              stroke="none"
              onMouseEnter={(_, index) => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
              isAnimationActive
              animationDuration={450}
            >
              {RING_DATA.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.fill}
                  opacity={hovering && activeIndex !== index && index < METRICS.length ? 0.7 : 1}
                  className="transition-opacity duration-200 ease-out"
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span
            key={String(activeIndex)}
            className="animate-number-fade text-display-4-medium text-text-primary tabular-nums"
          >
            {centerValue}
          </span>
        </div>
      </div>

      {/* Figma pads this panel on the left only (pl-10) and each row on the
          right (pr-10), so the hairline dividers run all the way to the
          panel's right edge but stay inset on the left. */}
      <div className="flex w-full flex-1 flex-col rounded-2lg bg-background-inner-default pl-2.5">
        {METRICS.map((metric, index) => (
          <div
            key={metric.label}
            className={cx(
              // flex-1 lets the rows share the panel height evenly so the last
              // row sits flush to the bottom instead of leaving a gap below it.
              "flex w-full flex-1 items-center justify-between py-2 pr-2.5",
              index < METRICS.length - 1 && "border-b border-separator-border-strong",
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="size-3 shrink-0 rounded-[4px]" style={{ backgroundColor: metric.color }} />
              <span className="text-body-regular whitespace-nowrap text-text-secondary">
                {metric.label}: {metric.detail}
              </span>
            </div>
            <span className="text-body-medium whitespace-nowrap text-text-primary tabular-nums">
              {metric.score}/{metric.max}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
