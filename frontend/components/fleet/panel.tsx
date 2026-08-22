import type { ReactNode } from "react";
import { cnExt } from "@/utils/cn";

/** A bordered surface panel — the fleet's repeated card frame. */
export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cnExt(
        "rounded-2xl border border-border-button-default bg-background-primary-default p-5 shadow-card",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Mono micro-heading row used at the top of each panel. */
export function PanelHeading({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <span className="text-mono-label text-text-tertiary">{children}</span>
      {right}
    </div>
  );
}
