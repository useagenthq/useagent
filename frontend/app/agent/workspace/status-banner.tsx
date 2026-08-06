"use client";

import { NumberTicker } from "@/components/shared/number-ticker";
import { cnExt } from "@/utils/cn";
import type { FleetStats } from "./workspace-data";

/**
 * Mission-control status strip (mirrors the reference's top banner). A quiet
 * status dot + "ALL CLEAR" (green) when nothing has failed; amber "NEEDS
 * ATTENTION" the moment any run fails. All counts come from real GET /api/runs
 * data. (The dot replaces an earlier thick left border that, on the rounded
 * pill, read as a stray curved "(" bracket.)
 */
export function StatusBanner({ stats }: { stats: FleetStats }) {
  const orgName = "Skynet";
  const failing = stats.failed > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 py-3 pr-5 pl-4 shadow-regular-xs">
      <p className="text-mono-label text-text-strong-950">
        <span
          aria-hidden
          className="mr-2 inline-flex size-3 shrink-0 items-center justify-center align-middle"
        >
          <span
            className={cnExt(
              "size-1.5 rounded-full",
              failing ? "bg-warning-base" : "bg-success-base",
            )}
          />
        </span>
        <span className={failing ? "text-warning-base" : "text-success-base"}>
          {failing ? "NEEDS ATTENTION" : "ALL CLEAR"}
        </span>
        <span className="text-text-soft-400">
          {" — "}
          <NumberTicker value={stats.working} /> working,{" "}
          <NumberTicker value={stats.queued} /> queued ·{" "}
          <NumberTicker value={stats.completed} /> done
          {failing ? (
            <>
              {" · "}
              <NumberTicker value={stats.failed} /> failed
            </>
          ) : (
            ""
          )}
        </span>
      </p>
      <p className="text-mono-label text-text-soft-400">
        <span className="text-text-sub-600">{orgName}</span>
        {" · updated just now"}
      </p>
    </div>
  );
}
