"use client";

import { useRef, useState } from "react";
import type { CalendarDate } from "@internationalized/date";
import { isSameDay, isSameMonth } from "@internationalized/date";
import { motion } from "motion/react";
import {
  WEEKDAY_LABELS,
  eventsForDate,
  monthGrid,
  type CalendarEvent,
  type CalendarEventColor,
} from "@/components/application/calendar/calendar-data";
import { EventDetailsModal } from "@/components/application/calendar/event-details-modal";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "calendar_view" → Calendar component (node
 * 3905:9229). Weekday header row (7 grey rounded-xl pills) + a Sun-start
 * month grid of day cells, each up to 115.33px tall in Figma (148.57px
 * wide) — reproduced here as a fluid `grid-cols-7` so it fills any card
 * width instead of Figma's fixed 1112px canvas.
 *
 * Overflow rule (reverse-engineered from the one Figma cell that shows it,
 * Aug 20 — 5 events, only the last 2 rendered plus a "+3 more" label): more
 * than 3 events in a cell shows the last 2, bottom-anchored, with a "+N
 * more" label filling the remaining top space instead of a 3rd chip.
 */

const MAX_VISIBLE_EVENTS = 3;
// Aug 20 has 7 events; showing the last 4 keeps the hidden count at exactly
// 3 ("+3 more"), matching the one Figma cell that shows this overflow state.
const OVERFLOW_VISIBLE_EVENTS = 4;

const CHIP_STYLES: Record<CalendarEventColor, { bg: string; title: string; time: string }> = {
  blue: {
    bg: "bg-calendar-event-blue-background",
    title: "text-calendar-event-blue-title",
    time: "text-calendar-event-blue-time",
  },
  pink: {
    bg: "bg-calendar-event-pink-background",
    title: "text-calendar-event-pink-title",
    time: "text-calendar-event-pink-time",
  },
  purple: {
    bg: "bg-calendar-event-purple-background",
    title: "text-calendar-event-purple-title",
    time: "text-calendar-event-purple-time",
  },
  lime: {
    bg: "bg-calendar-event-lime-background",
    title: "text-calendar-event-lime-title",
    time: "text-calendar-event-lime-time",
  },
  emerald: {
    bg: "bg-calendar-event-emerald-background",
    title: "text-calendar-event-emerald-title",
    time: "text-calendar-event-emerald-time",
  },
};

function EventChip({ event, onSelect }: { event: CalendarEvent; onSelect: () => void }) {
  const c = CHIP_STYLES[event.color];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        "flex min-w-0 cursor-pointer items-center justify-between gap-0.5 rounded-sm px-1 py-0.5 outline-none sm:gap-1 sm:rounded-md sm:px-1.5",
        "transition-[filter] duration-150 ease hover:brightness-95 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        c.bg,
      )}
    >
      <span className={cx("truncate text-[10px] leading-3 sm:text-body-2-medium", c.title)}>
        {event.title}
      </span>
      {event.time && (
        <span
          className={cx(
            "hidden shrink-0 opacity-70 sm:inline sm:text-caption-1-medium",
            c.time,
          )}
        >
          {event.time}
        </span>
      )}
    </button>
  );
}

function DayCell({
  date,
  isCurrentMonth,
  isHighlighted,
  compact,
  onHighlightEnd,
  onSelectEvent,
}: {
  date: CalendarDate;
  isCurrentMonth: boolean;
  isHighlighted: boolean;
  compact: boolean;
  onHighlightEnd: () => void;
  onSelectEvent: (event: CalendarEvent, cardRef: React.RefObject<HTMLDivElement | null>) => void;
}) {
  const events = eventsForDate(date);
  const overflow = events.length > MAX_VISIBLE_EVENTS;
  const visible = overflow ? events.slice(-OVERFLOW_VISIBLE_EVENTS) : events;
  const hiddenCount = events.length - visible.length;
  const cardRef = useRef<HTMLDivElement>(null);

  return (
    <div className="relative h-full border-r border-b border-separator-border-strong dark:border-separator-border last:border-b-0 nth-[7n]:border-r-0 nth-[n+36]:border-b-0 sm:border-0">
      {/* Sibling of the card, not a child, so it's never clipped by the
          card's own overflow-hidden (needed for its rounded corners + event
          chips). */}
      {isHighlighted && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-accent-500 sm:rounded-xl"
          initial={{ opacity: 0, scale: 1 }}
          animate={{ opacity: [0, 1, 0.35, 1, 0.35, 1, 0], scale: [1, 1.015, 1, 1.015, 1, 1, 1] }}
          transition={{ duration: 3, times: [0, 0.08, 0.28, 0.4, 0.6, 0.72, 1], ease: "easeInOut" }}
          onAnimationComplete={onHighlightEnd}
        />
      )}
      <div
        ref={cardRef}
        className={cx(
          "relative flex h-full flex-col overflow-hidden sm:rounded-xl",
          compact
            ? "min-h-[76px]"
            : "min-h-[72px] sm:min-h-[94px] lg:min-h-[105px] xl:min-h-[128px] 2xl:min-h-[164px]",
          // In the dense (mobile) grid, dark mode holds every cell on the same
          // surface as the out-of-month ones: the lighter background/primary
          // fill read as a greyed-out state next to the near-black card, so
          // the current month looked like the disabled one.
          isCurrentMonth
            ? "bg-background-primary-default max-sm:dark:bg-background-secondary-default sm:shadow-card"
            : "bg-background-secondary-default sm:bg-background-tertiary-default",
        )}
      >
        <span
          className={cx(
            "pt-1.5 pl-1.5 text-[11px] leading-4 font-medium sm:pt-2 sm:pl-2.5 sm:text-body-2-medium",
            isCurrentMonth ? "text-text-primary" : "text-text-secondary",
          )}
        >
          {date.day}
        </span>
        {events.length > 0 && (
          <div className="mt-auto flex flex-col gap-0.5 px-1 pb-1 sm:gap-[5px] sm:px-2 sm:pb-2">
            {hiddenCount > 0 && (
              <span className="text-[10px] leading-3 font-medium text-text-secondary sm:text-body-2-medium">
                +{hiddenCount} more
              </span>
            )}
            {visible.map((event) => (
              <EventChip key={event.id} event={event} onSelect={() => onSelectEvent(event, cardRef)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CalendarMonthGrid({
  month,
  highlightedDate = null,
  compact = false,
  onHighlightEnd,
}: {
  month: CalendarDate;
  /** Pulses this day's ring for ~3s then fades it out (not a persistent
   *  selection state — see `DayCell`). */
  highlightedDate?: CalendarDate | null;
  /** Uses short, fixed day rows for embedded previews instead of viewport-responsive rows. */
  compact?: boolean;
  onHighlightEnd?: () => void;
}) {
  const days = monthGrid(month);
  // `selected` is kept (not nulled) on close so the popover's content and
  // anchor stay put while it plays its exit animation — only `isOpen`
  // toggles react-aria's `data-exiting` transition; clearing `selected`
  // immediately would blank the content and skip straight to unmounted.
  const [selected, setSelected] = useState<{
    event: CalendarEvent;
    date: CalendarDate;
    triggerRef: React.RefObject<HTMLDivElement | null>;
  } | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const fallbackTriggerRef = useRef<HTMLDivElement>(null);

  // The dense (mobile) grid rules use separator/border-strong, not
  // border/button/default: in dark mode the button border (neutral/700) drew
  // a bright lattice over the neutral/800 day cells.
  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-0 overflow-hidden border-y border-separator-border-strong dark:border-separator-border sm:h-auto sm:gap-2 sm:overflow-visible sm:rounded-none sm:border-0">
      <div className="grid grid-cols-7 gap-0 border-b border-separator-border-strong dark:border-separator-border sm:gap-2 sm:border-0">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="flex items-center justify-center border-r border-separator-border-strong dark:border-separator-border bg-background-secondary-default px-0.5 py-1 text-center text-[11px] leading-4 text-text-secondary last:border-r-0 sm:rounded-xl sm:border-0 sm:px-2.5 sm:py-[5px] sm:text-body-2-regular"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[repeat(6,minmax(0,1fr))] gap-0 sm:flex-none sm:grid-rows-[repeat(6,minmax(0,auto))] sm:gap-2">
        {days.map((date) => (
          <DayCell
            key={date.toString()}
            date={date}
            isCurrentMonth={isSameMonth(date, month)}
            isHighlighted={highlightedDate !== null && isSameDay(date, highlightedDate)}
            compact={compact}
            onHighlightEnd={() => onHighlightEnd?.()}
            onSelectEvent={(event, triggerRef) => {
              setSelected({ event, date, triggerRef });
              setIsOpen(true);
            }}
          />
        ))}
      </div>
      <EventDetailsModal
        isOpen={isOpen}
        event={selected?.event ?? null}
        date={selected?.date ?? null}
        triggerRef={selected?.triggerRef ?? fallbackTriggerRef}
        onClose={() => setIsOpen(false)}
      />
    </div>
  );
}
