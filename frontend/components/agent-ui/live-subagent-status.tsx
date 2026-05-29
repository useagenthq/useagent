import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiLoader4Line,
  RiPauseCircleLine,
  RiRobot2Line,
  RiTimeLine,
} from "@remixicon/react";
import type { CanonicalChildModel } from "@/components/chat/canonical-children";
import type { ChildStatus } from "@/components/chat/native-events";

export interface LiveSubagentStatusProps {
  readonly model: CanonicalChildModel;
  readonly emptyLabel?: string;
  readonly className?: string;
}

const STATUS_LABEL: Record<ChildStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

function StatusIcon({ status }: { readonly status: ChildStatus }) {
  if (status === "completed") {
    return <RiCheckboxCircleFill className="size-4 text-lime-600" aria-hidden />;
  }
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return <RiCloseCircleFill className="size-4 text-text-error-primary" aria-hidden />;
  }
  if (status === "running") {
    return <RiLoader4Line className="size-4 animate-spin text-blue-600" aria-hidden />;
  }
  if (status === "waiting" || status === "idle") {
    return <RiPauseCircleLine className="size-4 text-orange-600" aria-hidden />;
  }
  return <RiTimeLine className="size-4 text-text-tertiary" aria-hidden />;
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    tokens,
  );
}

export function LiveSubagentStatus({
  model,
  emptyLabel = "No subagents started.",
  className,
}: LiveSubagentStatusProps) {
  return (
    <section
      aria-label="Subagents"
      aria-live="polite"
      className={`overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-button-default bg-background-secondary-default px-4 py-3">
        <span className="flex items-center gap-2">
          <RiRobot2Line className="size-4 text-purple-600" aria-hidden />
          <h3 className="text-body-2-medium text-text-primary">Subagents</h3>
        </span>
        <span className="font-mono text-caption-1-medium text-text-tertiary tabular-nums">
          {model.cards.length}
        </span>
      </div>
      {model.cards.length === 0 ? (
        <p className="px-4 py-4 text-body-2-regular text-text-tertiary">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-border-button-default">
          {model.cards.map((card) => {
            const fidelity = card.aliases
              .map((alias) => model.fidelity.get(alias))
              .find((value) => value !== undefined);
            const status = fidelity?.status ?? "pending";
            const activity = fidelity?.progress ?? card.status;
            return (
              <li key={card.id} className="px-4 py-3">
                <div className="flex items-start gap-2.5">
                  <StatusIcon status={status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <p className="truncate text-body-2-medium text-text-primary">{card.title}</p>
                      <span className="text-caption-1-medium text-text-secondary">
                        {STATUS_LABEL[status]}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-caption-1-regular text-text-tertiary">
                      {fidelity?.role && <span>{fidelity.role}</span>}
                      {fidelity?.model && <span className="font-mono">{fidelity.model}</span>}
                      {fidelity?.usage && (
                        <span className="font-mono tabular-nums">
                          {formatTokens(fidelity.usage.totalTokens)} tokens
                        </span>
                      )}
                    </div>
                    {activity && (
                      <p className="mt-1 truncate text-caption-1-regular text-text-secondary">
                        {activity}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
