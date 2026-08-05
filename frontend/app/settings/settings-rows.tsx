import type { ReactNode } from "react";
import { cnExt } from "@/utils/cn";

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
      className={cnExt(
        "divide-y divide-stroke-soft-200 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 px-4",
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
        <p className="text-label-sm text-text-strong-950">{label}</p>
        {description && <p className="text-paragraph-xs text-text-soft-400">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
