"use client";

import { useId, useMemo, useState } from "react";
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { Chip } from "@/components/base/badges/chip";
import { TOKENS_SERIES } from "@/components/application/ai-profile/ai-profile-data";
import { useCountUp } from "@/hooks/use-count-up";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → ai profile → Tokens card (node 4065:8696).
 *
 *   card    bg background/secondary, radius 20px, py 12 (chart bleeds to the
 *           card edges — no horizontal padding)
 *   header  "Tokens" (Body 1/Medium secondary) over "667.7M tokens"
 *           (Title 2/Medium) + purple/700 "+9.4%" chip; overlaps the plot
 *           area (Figma header has mb −32)
 *   plot    200px tall purple line over a purple → transparent gradient
 *           area. The design draws smoothed joins, but the implementation
 *           intentionally uses sharp linear segments (per spec).
 *   x axis  "Jun 14" … "Today" (11px medium, text/tertiary, +0.2 tracking)
 *
 * Hovering the plot rolls the headline to that day's tokens (via `useCountUp`,
 * in tenths of a million so the decimal animates too) and swaps the label to
 * the date — the same behaviour as the dashboard's revenue trend card.
 *
 * Zero-usage days draw as a grey dashed baseline instead of the purple line.
 * The series is cut into alternating segments, each rendered as its own Line:
 * dashed grey segments are the zero runs themselves (only the flat part along
 * the baseline), and solid purple segments are everything between — including
 * the bounding zero point on each side, so the purple line still draws the
 * descent into and the climb out of every idle stretch.
 */

/** Day index → "Jun 20"-style label; the series runs Jun 14 → Jul 13. */
function dateLabelFor(day: number) {
  const d = new Date(Date.UTC(2026, 5, 14 + day));
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Headline total when nothing is hovered, per the design. */
const TOTAL_TOKENS = 667.7;

/** Active point marker — the revenue card's pulsing dot; grey on idle days. */
function PulsingDot(props: { cx?: number; cy?: number; payload?: { value?: number } }) {
  const { cx: x, cy: y, payload } = props;
  if (x == null || y == null) return null;
  const color = payload?.value === 0 ? "var(--color-neutral-400)" : "var(--color-purple-500)";
  return (
    <g>
      <circle cx={x} cy={y} r={5} fill={color} opacity={0.3}>
        <animate attributeName="r" values="5;13" dur="1.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.35;0" dur="1.4s" repeatCount="indefinite" />
      </circle>
      <circle
        cx={x}
        cy={y}
        r={5}
        fill={color}
        stroke="var(--color-background-secondary-default)"
        strokeWidth={3}
      />
    </g>
  );
}

/** Solid-segment marker — skips zero days (the boundary points shared with a
 *  dashed segment), so those only get the dashed line's grey dot. */
function SolidDot(props: { cx?: number; cy?: number; payload?: { value?: number } }) {
  if (props.payload?.value === 0) return null;
  return <PulsingDot {...props} />;
}

/**
 * Cut the series into alternating solid/dashed segments. Dashed segments are
 * the zero runs; solid segments span between them and include the bounding
 * zero on each side (so the purple line touches the baseline before the grey
 * dashes take over).
 */
function buildSegments(series: { value: number }[]) {
  const segments: { key: string; dashed: boolean; from: number; to: number }[] = [];
  let i = 0;
  while (i < series.length) {
    const zero = series[i].value === 0;
    let end = i;
    while (end + 1 < series.length && (series[end + 1].value === 0) === zero) end++;
    if (zero) {
      segments.push({ key: `idle-${i}`, dashed: true, from: i, to: end });
    } else {
      // Extend one point into the neighbouring zero runs for the descent/climb
      segments.push({
        key: `run-${i}`,
        dashed: false,
        from: Math.max(0, i - 1),
        to: Math.min(series.length - 1, end + 1),
      });
    }
    i = end + 1;
  }

  const data = series.map((point, index) => {
    const row: Record<string, number | null> & { value: number } = { ...point };
    for (const seg of segments) {
      row[seg.key] = index >= seg.from && index <= seg.to ? point.value : null;
    }
    return row;
  });

  return { segments, data };
}

export function TokensChartCard({ className }: { className?: string }) {
  const gradientId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { segments, data } = useMemo(() => buildSegments(TOKENS_SERIES), []);

  const hovering = activeIndex !== null && activeIndex < TOKENS_SERIES.length;
  const targetValue = hovering ? TOKENS_SERIES[activeIndex].value : TOTAL_TOKENS;
  const label = hovering ? dateLabelFor(activeIndex) : "Tokens";
  // Animate in tenths so the ".7" decimal rolls too (useCountUp rounds to ints)
  const display = useCountUp(Math.round(targetValue * 10)) / 10;

  return (
    <section
      className={cx(
        "flex w-full flex-col rounded-[20px] bg-background-secondary-default py-3",
        className,
      )}
    >
      {/* Header — overlaps the top of the plot like the Figma frame */}
      <div className="relative z-10 -mb-8 flex w-full px-4 pt-1">
        <div className="flex flex-col gap-0.5">
          <p className="text-body-medium whitespace-nowrap text-text-secondary">{label}</p>
          <div className="flex items-center gap-2">
            <p
              key={String(activeIndex)}
              className="animate-number-fade text-title-2-medium whitespace-nowrap text-text-primary tabular-nums"
            >
              {display.toFixed(1)}M tokens
            </p>
            <Chip variant="bold" color="purple">
              +9.4%
            </Chip>
          </div>
        </div>
      </div>

      {/* Plot — clip-path sweep draws the line + area in left→right */}
      <div className="animate-chart-reveal h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            // 2px bottom room so the 2px stroke isn't clipped on zero days
            margin={{ top: 27, right: 0, bottom: 2, left: 0 }}
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
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-purple-400)" stopOpacity={0.32} />
                <stop offset="100%" stopColor="var(--color-purple-400)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip
              content={() => null}
              cursor={{
                stroke: "var(--color-chart-cursor)",
                strokeWidth: 1,
                strokeDasharray: "4 4",
              }}
            />
            {/* Sharp joins on purpose: type="linear", not monotone */}
            <Area
              type="linear"
              dataKey="value"
              stroke="none"
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
            />
            {/* Alternating segments: dashed grey along zero runs, solid purple
                (incl. the descent/climb touching the baseline) in between */}
            {segments.map((seg) => (
              <Line
                key={seg.key}
                type="linear"
                dataKey={seg.key}
                stroke={seg.dashed ? "var(--color-neutral-400)" : "var(--color-purple-400)"}
                strokeWidth={2}
                strokeDasharray={seg.dashed ? "5 5" : undefined}
                dot={false}
                activeDot={seg.dashed ? <PulsingDot /> : <SolidDot />}
                // The container's clip-path reveal handles the entrance;
                // recharts' own interpolation would fight it.
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* X axis */}
      <div className="mt-2 flex w-full items-start justify-between px-4 text-[11px] leading-[15px] font-medium tracking-[0.2px] whitespace-nowrap text-text-tertiary">
        <p>Jun 14</p>
        <p>Today</p>
      </div>
    </section>
  );
}
