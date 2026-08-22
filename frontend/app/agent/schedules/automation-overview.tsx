import { RiAddLine, RiCalendarScheduleLine } from "@remixicon/react";
import { StatusDot } from "@/components/base/badges/status-dot";
import { Button } from "@/components/base/buttons/button";

/**
 * Slim overview strip: three real stats derived from the loaded list (active
 * count, paused count, latest firing). Text-only cells - the lone green status
 * dot marks live cadences, matching the row accent bar semantics.
 */
function Stat({
  label,
  value,
  detail,
  live = false,
}: {
  label: string;
  value: string;
  detail: string;
  live?: boolean;
}) {
  return (
    <div className="min-w-0 px-4 py-3.5 sm:px-5">
      <p className="text-caption-1-medium text-text-tertiary">{label}</p>
      <div className="mt-1 flex items-center gap-1.5">
        {live && <StatusDot color="green" />}
        <p className="truncate text-title-3-medium text-text-primary">{value}</p>
      </div>
      <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">{detail}</p>
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
      className="mt-7 grid overflow-hidden rounded-2xl bg-background-primary-default shadow-sm ring-1 ring-inset ring-border-button-default divide-y divide-border-button-default sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      <Stat label="Active" value={String(active)} detail="Running on cadence" live={active > 0} />
      <Stat label="Paused" value={String(paused)} detail="Waiting for activation" />
      <Stat
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
      <RiCalendarScheduleLine className="size-6 text-foreground-icon-tertiary" aria-hidden />
      <h2 className="mt-3 text-body-medium text-text-primary">
        {filtered ? "No matching automations" : "Automate recurring work"}
      </h2>
      <p className="mt-1 max-w-sm text-caption-1-regular text-text-secondary">
        {filtered
          ? "Try a different search or status filter."
          : "Give an agent repeatable instructions and a cadence. New automations start paused until you activate them."}
      </p>
      {!filtered && (
        <Button className="mt-5" variant="secondary" size="small" leadingIcon={RiAddLine} onClick={onCreate}>
          Create automation
        </Button>
      )}
    </div>
  );
}
