import { RiCheckboxCircleFill, RiLoader4Line, RiTimeLine } from "@remixicon/react";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import type { ApiStep } from "@/components/chat/types";

export type ActivityGroupStatus = "pending" | "running" | "completed";

export interface ActivityStepGroup {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly status: ActivityGroupStatus;
  readonly steps: readonly ApiStep[];
}

export interface ActivityStepGroupsProps {
  readonly groups: readonly ActivityStepGroup[];
  readonly activeStepId?: string | null;
  readonly className?: string;
}

const STATUS_LABEL: Record<ActivityGroupStatus, string> = {
  pending: "Pending",
  running: "In progress",
  completed: "Completed",
};

function StatusIcon({ status }: { readonly status: ActivityGroupStatus }) {
  if (status === "completed") {
    return <RiCheckboxCircleFill className="size-4 text-lime-600" aria-hidden />;
  }
  if (status === "running") {
    return <RiLoader4Line className="size-4 animate-spin text-blue-600" aria-hidden />;
  }
  return <RiTimeLine className="size-4 text-text-tertiary" aria-hidden />;
}

/**
 * Groups the existing canonical `ApiStep` projection without introducing a second
 * tool-row grammar. Native details, errors, diffs, and expansion remain owned by
 * `ToolStepRow`; this component only supplies accessible phase boundaries.
 */
export function ActivityStepGroups({
  groups,
  activeStepId = null,
  className,
}: ActivityStepGroupsProps) {
  return (
    <div className={className}>
      <ol className="space-y-3" aria-label="Agent activity">
        {groups.map((group) => {
          return (
            <li key={group.id}>
              <section
                aria-label={group.label}
                className="overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card"
              >
                <div className="flex items-start gap-2.5 border-b border-border-button-default bg-background-secondary-default px-3 py-2.5">
                  <StatusIcon status={group.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-body-2-medium text-text-primary">{group.label}</h3>
                      <span className="font-mono text-caption-1-medium text-text-tertiary">
                        {STATUS_LABEL[group.status]}
                      </span>
                    </div>
                    {group.description && (
                      <p className="mt-0.5 text-caption-1-regular text-text-secondary">
                        {group.description}
                      </p>
                    )}
                  </div>
                </div>
                {group.steps.length > 0 ? (
                  <div className="space-y-0.5 px-2 py-2">
                    {group.steps.map((step) => (
                      <ToolStepRow
                        key={step.id}
                        step={step}
                        state={step.id === activeStepId ? "running" : "done"}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="px-3 py-3 text-caption-1-regular text-text-tertiary">
                    No activity reported yet.
                  </p>
                )}
              </section>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
