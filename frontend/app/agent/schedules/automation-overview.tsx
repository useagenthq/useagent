import {
  RiAddLine,
  RiCalendarScheduleLine,
  RiPauseCircleLine,
  RiPulseLine,
} from "@remixicon/react";
import * as Button from "@/components/ui/button";

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof RiPulseLine;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 px-4 py-4 sm:px-5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-bg-weak-50 text-text-sub-600">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-label-xs text-text-soft-400">{label}</p>
        <p className="mt-0.5 truncate text-label-lg text-text-strong-950">{value}</p>
        <p className="mt-0.5 truncate text-paragraph-xs text-text-soft-400">{detail}</p>
      </div>
    </div>
  );
}

export function AutomationOverview({
  active,
  paused,
  latestActivity,
}: {
  active: number;
  paused: number;
  latestActivity: string;
}) {
  return (
    <section
      aria-label="Automation overview"
      className="mt-7 grid overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs sm:grid-cols-3 sm:divide-x sm:divide-stroke-soft-200"
    >
      <Metric icon={RiPulseLine} label="Active" value={String(active)} detail="Running on cadence" />
      <Metric icon={RiPauseCircleLine} label="Paused" value={String(paused)} detail="Waiting for activation" />
      <Metric
        icon={RiCalendarScheduleLine}
        label="Latest activity"
        value={latestActivity}
        detail={latestActivity === "No runs yet" ? "Run one to verify setup" : "Execution history is live"}
      />
    </section>
  );
}

export function EmptyAutomations({ filtered, onCreate }: { filtered: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="flex size-11 items-center justify-center rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 text-text-sub-600 shadow-regular-xs">
        <RiCalendarScheduleLine className="size-5" aria-hidden />
      </span>
      <h2 className="mt-4 text-label-md text-text-strong-950">
        {filtered ? "No matching automations" : "Automate recurring work"}
      </h2>
      <p className="mt-1 max-w-sm text-paragraph-sm text-text-sub-600">
        {filtered
          ? "Try a different search or status filter."
          : "Give an agent repeatable instructions and a cadence. New automations start paused until you activate them."}
      </p>
      {!filtered && (
        <Button.Root className="mt-5 rounded-full" variant="neutral" mode="filled" size="small" onClick={onCreate}>
          <Button.Icon as={RiAddLine} /> Create automation
        </Button.Root>
      )}
    </div>
  );
}
