import type { ReactNode } from "react";
import { cx } from "@/utils/cx";

/**
 * Local settings row primitives — a subtle grouping card whose rows are split
 * by hairline dividers, each a label (+ optional description) on the left and a
 * control on the right. Kept here so the settings surface is self-contained.
 */

export function SettingsCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "divide-y divide-separator-border rounded-xl border border-border-button-default bg-background-secondary-default px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-body-2-medium text-text-primary">{label}</p>
        {description && <p className="text-caption-1-regular text-text-tertiary">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
