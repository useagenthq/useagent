import type { ReactNode } from "react";
import { cx } from "@/utils/cx";

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
      className={cx(
        "rounded-2xl border border-border-button-default bg-background-primary-default p-5 shadow-card",
        className,
      )}
    >
      {children}
    </section>
  );
}
