"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { DashboardSidebar } from "@/components/application/dashboard/dashboard-sidebar";
import { ActivityRingsCard } from "@/components/application/medical/activity-rings-card";
import { ImportantAlertsCard } from "@/components/application/medical/important-alerts-card";
import type { SelectedDay } from "@/components/application/medical/medical-data";
import { MedicalHeader } from "@/components/application/medical/medical-header";
import { MostActiveDaysCard } from "@/components/application/medical/most-active-days-card";
import { PatientInfoCard } from "@/components/application/medical/patient-info-card";
import { PatientsTable } from "@/components/application/medical/patients-table";
import { SleepScoreCard } from "@/components/application/medical/sleep-score-card";
import { StepsCard } from "@/components/application/medical/steps-card";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "medical profile dashboard" (node 3950:5573,
 * 1440×900). Same floating sidebar / mobile-drawer shell as `DashboardShell`
 * and `CalendarShell` — two rows of three 330px-tall cards (node 3950:5655),
 * then the patients table.
 */
export function MedicalShell({ contained = false }: { contained?: boolean } = {}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Selected calendar day — Most active days reports clicks here, and the
  // Activity card swaps its rings/values to that day's data. Defaults to
  // today (Jul 10, 2026) so the Activity card opens on the current day.
  const [selectedDay, setSelectedDay] = useState<SelectedDay | null>({ month: 6, day: 10 });

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
          "sticky top-3 z-10 hidden shrink-0 py-0 pl-3 lg:block",
          contained
            ? "h-[calc(var(--template-preview-height)-24px)]"
            : "h-[calc(100vh-24px)]",
        )}
      >
        <DashboardSidebar selected="medical" />
      </div>

      {/* Mobile sidebar remains beneath the medical dashboard content. */}
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
          <DashboardSidebar
            mobile
            flat
            selected="medical"
            onClose={() => setMobileOpen(false)}
          />
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
          <MedicalHeader onMenuClick={() => setMobileOpen(true)} />
          <div className="flex w-full flex-col gap-4">
            {/* One grid for all six cards: at md (tablet) they flow 2-per-row
                with no empty cell; at xl it's the Figma 2 rows of 3. */}
            <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <PatientInfoCard />
              <StepsCard />
              <SleepScoreCard />
              <MostActiveDaysCard selectedDay={selectedDay} onSelectDay={setSelectedDay} />
              <ActivityRingsCard selectedDay={selectedDay} />
              <ImportantAlertsCard />
            </div>
            <PatientsTable />
          </div>
        </div>
      </motion.main>
    </div>
  );
}
