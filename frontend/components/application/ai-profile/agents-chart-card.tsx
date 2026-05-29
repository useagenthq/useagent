"use client";

import { useState } from "react";
import { WeekRangePill } from "@/components/application/medical/week-range-pill";
import {
  AGENTS_TRACK_HEIGHT,
  AGENTS_ZERO_BAR,
  agentBarsFor,
  agentCountFor,
  MONTH_NAMES,
} from "@/components/application/ai-profile/ai-profile-data";
import { useCountUp } from "@/hooks/use-count-up";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → ai profile → Agents card (node 4065:8615).
 *
 *   card    bg background/secondary, radius 20px (radius/2,5xl), px 10 py 12
 *   header  "Agents" (Body 1/Medium secondary) over "32 agents"
 *           (Title 2/Medium), month switcher pill pinned top-right
 *   bars    30 bars — one per day — in a 206px track, 7px gap, radius/sm.
 *           Active days use the semantic agents-bar color; zero-agent days
 *           collapse to a 4px neutral stub (nodes 4065:8629 etc.)
 *   x axis  "Jun 14" … "Today" (11px medium, text/tertiary, +0.2 tracking)
 *
 * Hovering a bar rolls the headline to that day's agent count (via
 * `useCountUp`) and swaps the label to the date — the same behaviour as the
 * dashboard's earnings/steps chart cards.
 */

/** ~5px of bar height per agent: the design's tallest 158px bar = 32 agents. */
const agentsFor = (height: number) => (height === 0 ? 0 : Math.max(1, Math.round(height / 5)));

export function AgentsChartCard({ className }: { className?: string }) {
  const [month, setMonth] = useState(11); // December, per the design
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const bars = agentBarsFor(month);

  const hovering = activeIndex !== null && activeIndex < bars.length;
  const targetValue = hovering ? agentsFor(bars[activeIndex]) : agentCountFor(month);
  const label = hovering
    ? `${MONTH_NAMES[month].slice(0, 3)} ${activeIndex + 1}`
    : "Agents";
  const display = useCountUp(targetValue);

  return (
    <section
      className={cx(
        "relative flex w-full flex-col gap-2.5 rounded-[20px] bg-background-secondary-default px-2.5 py-3",
        className,
      )}
    >
      {/* Header */}
      <div className="flex w-full px-1.5 pt-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="w-full text-body-medium text-text-secondary">{label}</p>
          <p
            key={`${month}:${activeIndex}`}
            className="animate-number-fade text-title-2-medium whitespace-nowrap text-text-primary tabular-nums"
          >
            {display} agents
          </p>
        </div>
      </div>

      <WeekRangePill
        label={MONTH_NAMES[month]}
        onPrev={() => setMonth((m) => (m + 11) % 12)}
        onNext={() => setMonth((m) => (m + 1) % 12)}
        className="absolute top-4 right-4 w-[128px]"
      />

      {/* Bars — 30 days */}
      <div
        className="flex w-full items-end gap-[7px]"
        style={{ height: AGENTS_TRACK_HEIGHT }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        {bars.map((height, day) => (
          <div
            key={`${month}:${day}`}
            onMouseEnter={() => setActiveIndex(day)}
            className="flex h-full min-w-0 flex-1 items-end rounded-sm"
          >
            <div
              className={cx(
                "animate-bar-rise w-full rounded-sm transition-[height,background-color] duration-300 ease",
                height === 0
                  ? day === activeIndex
                    ? "bg-chart-cursor"
                    : "bg-chart-track"
                  : day === activeIndex
                    ? "bg-chart-agents-bar-active"
                    : "bg-chart-agents-bar",
              )}
              style={{
                height: height === 0 ? AGENTS_ZERO_BAR : height,
                // Consecutive left→right stagger; replays on month switch
                // since the key includes the month.
                animationDelay: `${day * 22}ms`,
              }}
            />
          </div>
        ))}
      </div>

      {/* X axis */}
      <div className="flex w-full items-start justify-between px-1.5 text-[11px] leading-[15px] font-medium tracking-[0.2px] whitespace-nowrap text-text-tertiary">
        <p>Jun 14</p>
        <p>Today</p>
      </div>
    </section>
  );
}
