"use client";

import { useEffect, useRef, useState } from "react";
import { MONTHS, YEAR, ringPct, type SelectedDay } from "@/components/application/medical/medical-data";
import { WeekRangePill } from "@/components/application/medical/week-range-pill";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → medical profile dashboard → Frame 128 (node
 * 3950:5768, "Most active days") with the "Month 1" switcher pill (node
 * 3950:5897, "December") top-right.
 *
 * The grid is a continuous vertical calendar: every month of the year is
 * stacked in one scroll viewport (Jan → Dec), each introduced by a left-
 * aligned 3-letter title (Title 3/Medium, 18px). Scrolling flows straight
 * into the next/previous month, and the top-right pill tracks whichever
 * month currently sits at the top of the viewport — its label soft-fades on
 * change. The prev/next chevrons smooth-scroll to the adjacent month.
 *
 * Day cell (node 3950:6379): p-10, 10px gap between the Body 1/Medium black
 * day number and a 28px 3-ring chart. Clicking a day reports it to the shell
 * (via `onSelectDay`), which feeds the same `ringPct` fractions into the
 * Activity card so both charts agree. Rings are plain stroke-dasharray SVG
 * rather than recharts — dozens render at once as a decorative grid.
 */

const TOTAL_STEPS = 32459;

/** Month to rest on at first paint — July, matching the Activity card's
 *  default selected day (Jul 10, 2026 / today). */
const INITIAL_MONTH = 6;

/** Today — days beyond this haven't happened, so they carry no activity. */
const TODAY = { month: 6, day: 10 };

/** Breathing room above a month's title when it's scrolled to the top, so
 *  the landing spot looks balanced instead of flush against the edge. */
const REST_OFFSET = 9;

function isFuture(month: number, day: number) {
  return month > TODAY.month || (month === TODAY.month && day > TODAY.day);
}

const RINGS = [
  { radius: 12, color: "var(--color-chart-3-active)" },
  { radius: 8.4, color: "var(--color-chart-2)" },
  { radius: 4.8, color: "var(--color-chart-4)" },
];

function MiniActivityRings({ month, day }: { month: number; day: number }) {
  // Future days have no data yet: draw only the faint tracks (no progress
  // arc), leaving every ring dimmed/empty.
  const future = isFuture(month, day);
  return (
    <svg viewBox="0 0 28 28" className="size-7 shrink-0" aria-hidden>
      {RINGS.map((ring, index) => {
        const circumference = 2 * Math.PI * ring.radius;
        const dash = circumference * ringPct(month, day, index);
        return (
          <g key={index} transform="rotate(-90 14 14)">
            <circle cx={14} cy={14} r={ring.radius} fill="none" stroke={ring.color} strokeWidth={2.2} opacity={0.16} />
            {!future && (
              <circle
                cx={14}
                cy={14}
                r={ring.radius}
                fill="none"
                stroke={ring.color}
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeDasharray={`${dash} ${circumference - dash}`}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function MostActiveDaysCard({
  selectedDay = null,
  onSelectDay,
  className,
}: {
  selectedDay?: SelectedDay | null;
  onSelectDay?: (day: SelectedDay) => void;
  className?: string;
} = {}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const monthRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Starts at the top of the list (January); a mount-time smooth scroll then
  // glides to the current month, and the scroll listener walks the pill along.
  const [currentMonth, setCurrentMonth] = useState(0);

  /** Target scrollTop that lands month `m`'s title at the viewport top —
   *  computed from live rects so it's independent of offsetParent quirks. */
  const scrollTopFor = (m: number) => {
    const root = scrollRef.current;
    const el = monthRefs.current[m];
    if (!root || !el) return 0;
    return el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  };

  const scrollToMonth = (m: number, behavior: ScrollBehavior = "smooth") => {
    const target = Math.min(11, Math.max(0, m));
    scrollRef.current?.scrollTo({ top: Math.max(0, scrollTopFor(target) - REST_OFFSET), behavior });
  };

  // Glide from the top (January) to the current month on mount — deferred a
  // frame so the month refs are laid out before the smooth scroll starts.
  useEffect(() => {
    const id = requestAnimationFrame(() => scrollToMonth(INITIAL_MONTH, "smooth"));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync the pill to whichever month header currently sits at the top.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      const rootTop = root.getBoundingClientRect().top;
      let active = 0;
      monthRefs.current.forEach((el, i) => {
        if (el && el.getBoundingClientRect().top - rootTop <= 24) active = i;
      });
      setCurrentMonth(active);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <section
      className={cx(
        "flex h-[330px] w-full min-w-0 flex-col gap-4 rounded-[20px] bg-background-secondary-default p-2.5",
        className,
      )}
    >
      <div className="flex w-full items-start justify-between gap-2 px-1.5 pt-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-body-medium whitespace-nowrap text-text-secondary">Most active days</p>
          <div className="flex items-baseline gap-1">
            <p className="text-title-1-medium whitespace-nowrap text-text-primary tabular-nums">
              {TOTAL_STEPS.toLocaleString()}
            </p>
            <span className="text-caption-1-medium whitespace-nowrap text-text-secondary">total steps</span>
          </div>
        </div>
        <WeekRangePill
          label={MONTHS[currentMonth]}
          onPrev={() => scrollToMonth(currentMonth - 1)}
          onNext={() => scrollToMonth(currentMonth + 1)}
          className="w-[128px]"
        />
      </div>

      {/* Inner panel behind the grid — Figma's "Month 2" frame (node
          3950:6241): background/inner/default, radius/2lg, 10px horizontal
          padding only. The scroll viewport has no vertical padding of its
          own (the content carries it), so months scroll clean to the panel's
          top/bottom edges instead of clipping against a band. */}
      <div className="min-h-0 w-full flex-1 overflow-hidden rounded-2lg bg-background-inner-default px-2.5">
        <div ref={scrollRef} className="h-full w-full overflow-y-auto overscroll-contain">
          {/* py-2.5 lives on the scroll CONTENT (not the viewport), so the
              first/last rows' hover pills keep 10px of air from the panel
              edges at rest, while the padding still scrolls away with the
              content instead of clipping it against a fixed band. */}
          <div className="relative flex flex-col gap-4 py-2.5">
            {MONTHS.map((monthName, month) => {
              const daysInMonth = new Date(YEAR, month + 1, 0).getDate();
              return (
                <div
                  key={monthName}
                  data-month={month}
                  ref={(el) => {
                    monthRefs.current[month] = el;
                  }}
                  className="flex flex-col gap-2.5"
                >
                  <p className="pl-1 text-title-3-medium text-text-primary">{monthName.slice(0, 3)}</p>
                  <div className="grid grid-cols-7 gap-x-[5px]">
                    {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
                      const isSelected = selectedDay?.month === month && selectedDay?.day === day;
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => onSelectDay?.({ month, day })}
                          aria-pressed={isSelected}
                          aria-label={`Activity for ${monthName} ${day}`}
                          className={cx(
                            // border-2 lives on every cell (transparent when idle) so
                            // selecting one never nudges the grid by 2px.
                            "flex h-[78px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2lg border-2 p-2.5",
                            "outline-none transition-colors duration-150 ease focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
                            isSelected
                              ? "border-border-button-hover bg-background-primary-default"
                              : "border-transparent hover:bg-background-primary-hover",
                          )}
                        >
                          <span className="text-body-medium whitespace-nowrap text-text-primary">{day}</span>
                          <MiniActivityRings month={month} day={day} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
