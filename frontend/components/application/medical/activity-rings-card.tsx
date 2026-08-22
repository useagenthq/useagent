"use client";

import { useState } from "react";
import { MONTHS, YEAR, dayActivity, type SelectedDay } from "@/components/application/medical/medical-data";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → medical profile dashboard → Frame 127 (node
 * 3950:5906). Three concentric goal rings, Apple Watch-style.
 *
 * Each ring uses its progress color again at 16% opacity for the empty track,
 * matching the mini rings in MostActiveDaysCard. Keeping the track and arc in
 * one SVG avoids Recharts' hard-coded #eee background sectors, which stayed
 * light in dark mode. No ring is ever fully closed, matching the design.
 *
 * Hovering a ring darkens it one tone (400 → 500, same recipe as the
 * Steps bars) and highlights its stat tile by dropping the other tiles to
 * 50% opacity.
 *
 * When a day is picked in the Most active days calendar, `selectedDay`
 * swaps the rings and tile values to that day's `dayActivity` numbers —
 * the same `ringPct` fractions the calendar's mini rings draw, so the two
 * charts always agree.
 */

type Ring = {
  label: string;
  value: string;
  /** % of the ring's own goal — kept strictly < 100 so no ring closes. */
  goalPct: number;
  color: string;
  hoverColor: string;
};

/** Tile order (Move / Exercise / Running), matching Figma's stat row.
 *  Values here are the no-selection defaults straight from Figma. */
const DEFAULT_RINGS: Ring[] = [
  { label: "Move", value: "1,592 kcal", goalPct: 82, color: "var(--color-chart-3)", hoverColor: "var(--color-chart-3-active)" },
  { label: "Exercise", value: "1h 45m", goalPct: 60, color: "var(--color-chart-2)", hoverColor: "var(--color-chart-2-active)" },
  { label: "Running", value: "5.2 km", goalPct: 75, color: "var(--color-chart-4)", hoverColor: "var(--color-chart-4-active)" },
];

const RING_RADII = [82, 58, 34];
const RING_STROKE_WIDTH = 18;

export function ActivityRingsCard({
  selectedDay = null,
  className,
}: {
  selectedDay?: SelectedDay | null;
  className?: string;
} = {}) {
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  const activity = selectedDay ? dayActivity(selectedDay.month, selectedDay.day) : null;
  const rings: Ring[] = activity
    ? [
        { ...DEFAULT_RINGS[0], value: activity.move.value, goalPct: Math.round(activity.move.pct * 100) },
        { ...DEFAULT_RINGS[1], value: activity.exercise.value, goalPct: Math.round(activity.exercise.pct * 100) },
        { ...DEFAULT_RINGS[2], value: activity.running.value, goalPct: Math.round(activity.running.pct * 100) },
      ]
    : DEFAULT_RINGS;

  return (
    <section
      className={cx(
        "flex h-[330px] w-full min-w-0 flex-col gap-4 rounded-[20px] bg-background-secondary-default p-2.5",
        className,
      )}
    >
      {/* Title + tiles as one block — Figma puts the tiles 11px under the
          title (y=36 → y=47), tighter than the card's 16px section gap. */}
      <div className="flex w-full flex-col gap-[11px]">
        <p className="px-1.5 pt-1.5 text-body-medium text-text-secondary">
          {selectedDay
            ? `Activity for ${MONTHS[selectedDay.month]} ${selectedDay.day}, ${YEAR}`
            : "Activity"}
        </p>
        <div className="flex h-[57px] w-full shrink-0 items-stretch gap-2">
          {rings.map((ring) => (
            <div
              key={ring.label}
              className={cx(
                "flex flex-1 flex-col items-start justify-end gap-px rounded-2lg bg-background-inner-default px-2.5 py-2",
                "transition-opacity duration-200 ease-out",
                activeLabel !== null && activeLabel !== ring.label && "opacity-50",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="size-3 shrink-0 rounded-[4px]" style={{ backgroundColor: ring.color }} />
                <span className="text-body-regular whitespace-nowrap text-text-secondary">{ring.label}</span>
              </div>
              <span className="text-body-medium whitespace-nowrap text-text-primary">{ring.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <svg
          viewBox="0 0 200 200"
          className="h-full max-h-[210px] w-full overflow-visible"
          role="img"
          aria-label="Move, exercise, and running activity progress"
          onMouseLeave={() => setActiveLabel(null)}
        >
          {rings.map((ring, index) => {
            const dimmed = activeLabel !== null && activeLabel !== ring.label;
            return (
              <g
                key={ring.label}
                className="cursor-pointer"
                transform="rotate(-90 100 100)"
                onMouseEnter={() => setActiveLabel(ring.label)}
              >
                <circle
                  cx={100}
                  cy={100}
                  r={RING_RADII[index]}
                  fill="none"
                  stroke={ring.color}
                  strokeWidth={RING_STROKE_WIDTH}
                  opacity={dimmed ? 0.06 : 0.16}
                  className="transition-opacity duration-200 ease-out"
                />
                <circle
                  cx={100}
                  cy={100}
                  r={RING_RADII[index]}
                  pathLength={100}
                  fill="none"
                  stroke={activeLabel === ring.label ? ring.hoverColor : ring.color}
                  strokeWidth={RING_STROKE_WIDTH}
                  strokeLinecap="round"
                  strokeDasharray={`${ring.goalPct} ${100 - ring.goalPct}`}
                  opacity={dimmed ? 0.5 : 1}
                  className="transition-[stroke,stroke-dasharray,opacity] duration-200 ease-out"
                />
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
