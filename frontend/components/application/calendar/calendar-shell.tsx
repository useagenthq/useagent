"use client";

import { useMemo, useState } from "react";
import type { CalendarDate } from "@internationalized/date";
import { getLocalTimeZone, startOfMonth } from "@internationalized/date";
import { motion } from "motion/react";
import { CalendarHeader } from "@/components/application/calendar/calendar-header";
import { CALENDAR_SHOWCASE_MONTH } from "@/components/application/calendar/calendar-data";
import { CalendarMonthGrid } from "@/components/application/calendar/calendar-month-grid";
import { DashboardSidebar } from "@/components/application/dashboard/dashboard-sidebar";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "calendar_view" (node 3905:9119, 1440×900).
 *
 * Same responsive shell as `DashboardShell` (floating sidebar in-flow at
 * `lg`+, slide-in drawer with backdrop below it) — mirrored here rather than
 * shared, since the two templates' main content differs entirely. The month
 * grid card itself (`background/secondary/default`, `radius/3xl`, 12px
 * inset) is the one piece unique to this page.
 *
 * `contained` swaps viewport heights for the preview frame's own, so the shell
 * fits a fixed window instead of the screen.
 */
export function CalendarShell({ contained = false }: { contained?: boolean } = {}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [month, setMonth] = useState(CALENDAR_SHOWCASE_MONTH);
  // Transient — pulses on the picked day in the main grid, then fades out on
  // its own (see CalendarMonthGrid's onHighlightEnd). Not a persistent
  // "selection": the picker itself never shows a day as selected.
  const [highlightedDate, setHighlightedDate] = useState<CalendarDate | null>(null);

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
        month.toDate(getLocalTimeZone()),
      ),
    [month],
  );

  return (
    <div
      className={cx(
        "relative flex w-full bg-background-full max-lg:h-dvh max-lg:overflow-hidden",
        contained
          ? "h-[var(--template-preview-height)] overflow-hidden"
          : "min-h-screen",
      )}
    >
      {/* Desktop sidebar (in-flow) */}
      <div
        className={cx(
          "sticky top-3 z-10 hidden shrink-0 py-0 pl-3 lg:block",
          contained
            ? "h-[calc(var(--template-preview-height)-24px)]"
            : "h-[calc(100vh-24px)]",
        )}
      >
        <DashboardSidebar selected="calendar" />
      </div>

      {/* Mobile sidebar remains fixed beneath the calendar content. */}
      <div
        className={cx(
          "left-0 z-10 flex w-[272px] py-3 pl-[6px] lg:hidden",
          contained ? "absolute top-0 h-[var(--template-preview-height)]" : "fixed inset-y-0",
        )}
        aria-hidden={!mobileOpen}
      >
        <motion.div
          initial={false}
          animate={{ scale: mobileOpen ? 1 : 0.94, opacity: mobileOpen ? 1 : 0 }}
          transition={{ duration: 0.325, ease: [0.42, 0, 0.58, 1] }}
          className={cx(
            "h-full w-[260px] origin-left will-change-transform",
            mobileOpen ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <DashboardSidebar
            mobile
            flat
            selected="calendar"
            onClose={() => setMobileOpen(false)}
          />
        </motion.div>
      </div>

      <motion.main
        initial={false}
        animate={{ x: mobileOpen ? 272 : 0, borderRadius: mobileOpen ? 32 : 0 }}
        transition={{ duration: 0.325, ease: [0.42, 0, 0.58, 1] }}
        className={cx(
          "relative z-20 flex min-h-0 min-w-0 flex-1 justify-center overflow-hidden bg-background-full p-0 will-change-transform sm:p-3 sm:pt-6 lg:z-0 lg:!transform-none lg:!rounded-none",
          // Contained, the frame around this is a fixed window, so the month
          // grid stays inside it rather than handing overflow to the page.
          !contained && "lg:overflow-visible",
        )}
      >
        <motion.button
          type="button"
          aria-label="Close navigation"
          tabIndex={mobileOpen ? 0 : -1}
          onClick={() => setMobileOpen(false)}
          initial={false}
          animate={{ opacity: mobileOpen ? 1 : 0 }}
          transition={{ duration: 0.325, ease: [0.42, 0, 0.58, 1] }}
          className={cx(
            "absolute inset-0 z-50 cursor-pointer rounded-[inherit] bg-black/10 dark:bg-white/5 lg:hidden",
            mobileOpen ? "pointer-events-auto" : "pointer-events-none",
          )}
        />
        <div className="flex min-h-0 w-full max-w-[1300px] flex-col gap-2.5">
          <div className="shrink-0 px-3 pt-3 sm:px-0 sm:pt-0">
            <CalendarHeader
              month={month}
              monthLabel={monthLabel}
              onMenuClick={() => setMobileOpen(true)}
              onPrevMonth={() => setMonth((m) => m.subtract({ months: 1 }))}
              onNextMonth={() => setMonth((m) => m.add({ months: 1 }))}
              onSelectDate={(date) => {
                setMonth(startOfMonth(date));
                setHighlightedDate(date);
              }}
            />
          </div>
          <div className="min-h-0 w-full flex-1 bg-background-secondary-default sm:flex-none sm:rounded-3xl sm:p-3">
            <CalendarMonthGrid
              month={month}
              highlightedDate={highlightedDate}
              onHighlightEnd={() => setHighlightedDate(null)}
            />
          </div>
        </div>
      </motion.main>
    </div>
  );
}
