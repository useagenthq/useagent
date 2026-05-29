"use client";

import { useState } from "react";
import { RiMenuLine } from "@remixicon/react";
import { motion } from "motion/react";
import { AgentsChartCard } from "@/components/application/ai-profile/agents-chart-card";
import { AiProfileCard } from "@/components/application/ai-profile/ai-profile-card";
import { TokensChartCard } from "@/components/application/ai-profile/tokens-chart-card";
import { DashboardSidebar } from "@/components/application/dashboard/dashboard-sidebar";
import { IconButton } from "@/components/base/buttons/icon-button";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "ai profile" (node 4063:5675, 1440×900). Same
 * floating sidebar / mobile-drawer shell as `MedicalShell` — the content is
 * a single centered 680px column: profile card, agents bar chart, tokens
 * line chart, stacked with a 16px gap.
 */
export function AiProfileShell({ contained = false }: { contained?: boolean } = {}) {
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
          "sticky top-3 z-10 hidden shrink-0 py-0 pl-3 lg:block",
          contained
            ? "h-[calc(var(--template-preview-height)-24px)]"
            : "h-[calc(100vh-24px)]",
        )}
      >
        <DashboardSidebar selected="profile" />
      </div>

      {/* The mobile sidebar stays beneath the page while its contents reveal. */}
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
          <DashboardSidebar mobile flat selected="profile" onClose={() => setMobileOpen(false)} />
        </motion.div>
      </div>

      <motion.main
        initial={false}
        animate={{ x: mobileOpen ? 272 : 0, borderRadius: mobileOpen ? 32 : 0 }}
        transition={{ duration: 0.325, ease: [0.42, 0, 0.58, 1] }}
        className={cx(
          "relative z-20 flex min-w-0 flex-1 justify-center overflow-x-hidden overflow-y-auto bg-background-full p-3 will-change-transform sm:p-6 lg:z-0 lg:!transform-none lg:!rounded-none",
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
        <div className="flex w-full max-w-[680px] flex-col items-center gap-4">
          <div className="relative w-full">
            <IconButton
              icon={RiMenuLine}
              size="medium"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
              className="absolute top-3 left-3 z-10 rounded-full lg:hidden"
            />
            <AiProfileCard />
          </div>
          <AgentsChartCard />
          <TokensChartCard />
        </div>
      </motion.main>
    </div>
  );
}
