"use client";

import { useState, type CSSProperties } from "react";
import { Calendar } from "react-aria-components";
import type { CalendarDate } from "@internationalized/date";
import { AnimatePresence, motion } from "motion/react";
import { MonthPanel } from "@/components/base/date-picker/shared";
import { ChevronDownSmall } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";

/** Bare `MonthPanel`'s own content width (296px) plus this wrapper's px-3
 *  padding (12px each side) — the pill is fixed at this same width whether
 *  open or closed, so opening only ever grows its height, never its width. */
const PANEL_WIDTH = 320;

/**
 * Figma source: Board UI → "calendar_view" → "Month 1" switcher,
 * enlarging in place to reveal its own single-month
 * calendar (the same one `DatePicker` ships) — one continuous surface, not a
 * separate popover: the pill's own title/chevron row stays the *only*
 * header (the day grid below uses `MonthPanel`'s `hideHeader`, so there's
 * never a second "August 2026" or a second pair of chevrons), and it's
 * `position: absolute` inside a fixed-footprint wrapper so growing it never
 * pushes the month grid — or the notification/inbox/"New event" buttons
 * beside it — down or sideways. Card chrome (border/button/default border,
 * shadow/dropdown, white — not the other pickers' grey
 * background/secondary/default) matches `DashboardTeamMenu`'s dropdown.
 *
 * No Cancel/Apply step and no persistent "selected" day: picking one commits
 * immediately (`onSelectDate`), closes the panel, and pulses that day in the
 * main grid instead (see `CalendarMonthGrid`). `Calendar`'s `value` stays
 * `null` here always, and it's re-keyed on every `month` change (not just on
 * open) so browsing months — via this pill's own chevrons, which keep
 * working while it's open — never leaves a stale focused/"selected"-looking
 * day from a previous month behind.
 */
export function CalendarMonthSwitcher({
  month,
  monthLabel,
  onPrevMonth,
  onNextMonth,
  onSelectDate,
  width = PANEL_WIDTH,
  className,
}: {
  month: CalendarDate;
  monthLabel: string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onSelectDate: (date: CalendarDate) => void;
  /** Optional compact width for embedded previews. */
  width?: number;
  /** Optional layout override for compact embedded previews. */
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const shortMonthLabel = new Intl.DateTimeFormat(undefined, { month: "short" }).format(
    month.toDate("UTC"),
  );
  const widthStyle = { "--month-switcher-width": `${width}px` } as CSSProperties;

  return (
    <div
      className={cx(
        "relative h-9 min-w-0 flex-1 sm:w-[var(--month-switcher-width)] sm:flex-none",
        className,
      )}
      style={widthStyle}
    >
      <div
        className={cx(
          "absolute top-0 right-0 left-0 z-10 flex w-full flex-col overflow-hidden rounded-2lg border border-border-button-default bg-background-primary-default shadow-dropdown transition-[width] duration-300 ease-in-out sm:right-auto sm:w-[var(--month-switcher-width)]",
          isOpen && "!w-[min(320px,calc(100vw-24px))]",
        )}
      >
        <div className="flex w-full shrink-0 items-center justify-between p-2">
          <button
            type="button"
            aria-label="Previous month"
            onClick={onPrevMonth}
            className={cx(
              "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[3px] text-foreground-icon-primary outline-none",
              "transition-colors duration-150 ease hover:bg-background-secondary-hover",
            )}
          >
            <ChevronDownSmall className="size-4 rotate-90" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.matchMedia("(max-width: 639px)").matches) return;
              setIsOpen((open) => !open);
            }}
            className="flex-1 cursor-default truncate text-center text-body-medium text-text-primary outline-none sm:cursor-pointer"
          >
            <span className="sm:hidden">{shortMonthLabel}</span>
            <span className="hidden sm:inline">{monthLabel}</span>
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={onNextMonth}
            className={cx(
              "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[3px] text-foreground-icon-primary outline-none",
              "transition-colors duration-150 ease hover:bg-background-secondary-hover",
            )}
          >
            <ChevronDownSmall className="size-4 -rotate-90" />
          </button>
        </div>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{
                height: { duration: 0.38, ease: [0.34, 1.2, 0.64, 1] },
                opacity: { duration: 0.28, ease: "easeOut" },
              }}
            >
              <Calendar<CalendarDate>
                key={month.toString()}
                aria-label="Jump to date"
                value={null}
                defaultFocusedValue={month}
                onChange={(date) => {
                  onSelectDate(date);
                  setIsOpen(false);
                }}
              >
                <div className="px-3 pb-3">
                  <MonthPanel offset={0} bare hideHeader />
                </div>
              </Calendar>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
