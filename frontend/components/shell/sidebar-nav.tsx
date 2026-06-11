import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

import { cx } from "@/utils/cx";

/**
 * Shared building blocks for the app-shell sidebars (chat + agent). The
 * expanded rail is a flat, edge-to-edge column (single hairline border-r, no
 * inset or shadow); only the collapsed compact rail keeps the floating-dock
 * treatment. Each holds a scrollable nav column with icon rows,
 * `text-mono-label` section headers, and left-aligned "Recents" rows — so the
 * row + section primitives live here instead of being duplicated per sidebar.
 *
 * Server component: presentational + `next/link` only, no hooks.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export function Sidebar({
  ariaLabel,
  children,
  header,
  footer,
}: {
  ariaLabel: string;
  children: ReactNode;
  header?: ReactNode;
  /** Optional pinned block below the scroll area (e.g. "Connect apps"). */
  footer?: ReactNode;
}) {
  return (
    <div className="h-full w-full">
      <aside
        aria-label={ariaLabel}
        className="flex h-full w-full flex-col overflow-hidden border-r border-border-button-white bg-background-secondary-default"
      >
        {header}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1.5">{children}</nav>
        {footer}
      </aside>
    </div>
  );
}

export function SidebarSectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-mono-label px-2.5 pb-1 pt-3 text-text-tertiary">{children}</p>;
}

export type NavIconTone = "blue" | "purple" | "green" | "orange" | "primary";

/** A brand tint for a nav icon - a touch of color in an otherwise mono rail. */
const NAV_ICON_TONE: Record<NavIconTone, string> = {
  blue: "text-blue-500",
  purple: "text-purple-500",
  green: "text-green-600",
  orange: "text-orange-500",
  primary: "text-accent-500",
};

export interface SidebarNavItemProps {
  href?: string;
  /** Optional brand tint for the leading icon (adds subtle color). */
  tone?: NavIconTone;
  /** Leading remixicon component. Omit for icon-less "Recents" rows. */
  icon?: IconComponent;
  /** Custom leading node (e.g. a status dot) — wins over `icon`. */
  leading?: ReactNode;
  label: string;
  active?: boolean;
  /** Trailing node, e.g. a "New" chip. */
  trailing?: ReactNode;
}

export function SidebarNavItem({
  href = "#",
  tone,
  icon: Icon,
  leading,
  label,
  active = false,
  trailing,
}: SidebarNavItemProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex items-center gap-2 rounded-2lg px-2.5 py-1.5 text-body-2-medium transition-colors",
        active
          ? "bg-linear-to-b from-accent-500 to-accent-600 text-white shadow-nav-selected"
          : "text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
      )}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {leading ??
          (Icon ? (
            <Icon
              className={cx(
                "size-3.5 shrink-0",
                active ? "text-white" : tone ? NAV_ICON_TONE[tone] : "text-foreground-icon-tertiary",
              )}
              aria-hidden
            />
          ) : null)}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}
