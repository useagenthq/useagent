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
