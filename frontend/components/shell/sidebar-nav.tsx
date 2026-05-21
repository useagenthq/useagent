import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

import { cnExt } from "@/utils/cn";

/**
 * Shared building blocks for the app-shell sidebars (chat + agent). Both rails
 * use one recipe — a scrollable nav column with icon rows, `text-mono-label`
 * section headers, and left-aligned "Recents" rows — so the row + section
 * primitives live here instead of being duplicated per sidebar.
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
    <aside
      aria-label={ariaLabel}
      className="flex h-full w-64 shrink-0 flex-col border-r border-stroke-soft-200/50 bg-bg-white-0"
    >
      {header}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">{children}</nav>
      {footer}
    </aside>
  );
}

export function SidebarSectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-mono-label px-2.5 pb-1 pt-5 text-text-soft-400">{children}</p>;
}

export interface SidebarNavItemProps {
  href?: string;
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
      className={cnExt(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-label-sm transition-colors",
        active
          ? "bg-bg-weak-50 text-text-strong-950"
          : "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950",
      )}
    >
      {leading ??
        (Icon ? (
          <Icon
            className={cnExt(
              "size-3.5 shrink-0",
              active ? "text-text-strong-950" : "text-text-soft-400",
            )}
            aria-hidden
          />
        ) : null)}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}
