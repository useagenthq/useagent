"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { ContributionsCard } from "@/components/application/dashboard/contributions-card";
import { CustomersTable } from "@/components/application/dashboard/customers-table";
import { DashboardHeader } from "@/components/application/dashboard/dashboard-header";
import { DashboardSidebar } from "@/components/application/dashboard/dashboard-sidebar";
import { EarningsChartCard } from "@/components/application/dashboard/earnings-chart-card";
import { RecentHiresCard } from "@/components/application/dashboard/recent-hires-card";
import { LineChartCard } from "@/components/application/dashboard/line-chart-card";
import { StatCards } from "@/components/application/dashboard/stat-cards";
import { cx } from "@/utils/cx";

/**
 * Responsive layout host for the dashboard template.
 *
 *   lg+       sidebar sits in-flow (collapsible via its own control)
 *   below lg  sidebar is hidden; the header shows a hamburger that opens it
 *             as a slide-in drawer with a backdrop
 *
 * Content blocks stack / reflow at their own breakpoints (see each block).
 */
export function DashboardShell({ contained = false }: { contained?: boolean } = {}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div
      className={cx(
        "relative flex w-full bg-background-full max-lg:overflow-hidden",
        contained && "overflow-hidden",
        contained
          ? "h-[var(--template-preview-height)]"
          : "h-dvh lg:h-auto lg:min-h-screen",
      )}
    >
      {/* Desktop sidebar (in-flow) */}
      <div
        className={cx(
          "sticky top-0 z-10 hidden shrink-0 lg:block",
          contained
            ? "h-[var(--template-preview-height)]"
            : "h-dvh",
        )}
      >
        <DashboardSidebar flat />
      </div>

      {/* Mobile sidebar remains beneath the dashboard content. */}
      <div
        className={cx(
          "left-0 z-10 flex w-[272px] py-3 pl-[6px] lg:hidden",
          contained
            ? "absolute top-0 h-[var(--template-preview-height)]"
            : "fixed inset-y-0",
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
          <DashboardSidebar mobile flat onClose={() => setMobileOpen(false)} />
        </motion.div>
      </div>

      <motion.main
        initial={false}
        animate={{ x: mobileOpen ? 272 : 0, borderRadius: mobileOpen ? 32 : 0 }}
        transition={{ duration: 0.325, ease: [0.42, 0, 0.58, 1] }}
        className={cx(
          "relative z-20 flex min-w-0 flex-1 justify-center overflow-x-hidden overflow-y-auto bg-background-full p-3 will-change-transform sm:pt-6 lg:z-0 lg:!transform-none lg:!rounded-none",
          // Contained, the frame around this is a fixed window: the main
          // column keeps its own scrollbar so the rail beside it stays put,
          // instead of the whole shell scrolling and dragging the rail off
          // the top. Standalone, the page scrolls as it should.
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
        <div className="flex w-full max-w-[1300px] flex-col gap-2.5">
          <DashboardHeader onMenuClick={() => setMobileOpen(true)} />
          <div className="flex w-full flex-col gap-4">
            <div className="flex w-full flex-col items-stretch gap-4 xl:flex-row xl:items-start">
              <RecentHiresCard />
              <EarningsChartCard />
            </div>
            <div className="flex w-full flex-col items-stretch gap-4 lg:flex-row lg:items-start">
              <LineChartCard className="h-[337px]" />
              <ContributionsCard />
            </div>
            <StatCards />
            <CustomersTable />
          </div>
        </div>
      </motion.main>
    </div>
  );
}
