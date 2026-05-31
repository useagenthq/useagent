"use client";

import {
  RiBookMarkedLine,
  RiDashboardLine,
  RiSettings3Line,
  RiSidebarUnfoldLine,
} from "@remixicon/react";
import Link from "next/link";
import type { ReactNode, Ref } from "react";

import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { SearchCommand } from "./search-command";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { useWorkingSignal } from "./working-signal";

const RAIL_ITEM =
  "flex size-9 items-center justify-center rounded-2lg text-foreground-icon-secondary outline-none transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring";

function RailLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <Link href={href} aria-label={label} title={label} className={RAIL_ITEM}>
      {children}
    </Link>
  );
}

/** The useful state of a folded project sidebar: brand, core destinations, and
 * account controls remain reachable instead of collapsing to an empty gutter.
 * Rendered as the BoardUI collapsed floating rail: a 60px rounded panel with
 * shadow-sidebar, inset from the viewport edge. */
export function CompactSidebarRail({
  expandButtonRef,
  onExpand,
}: {
  expandButtonRef?: Ref<HTMLButtonElement>;
  onExpand: () => void;
}) {
  const working = useWorkingSignal();

  return (
    <aside aria-label="Compact navigation" className="hidden h-full shrink-0 py-3 pl-3 md:flex">
      <div className="flex h-full w-[60px] flex-col items-center rounded-3xl border border-border-button-white bg-background-secondary-default px-[11px] py-3 shadow-sidebar">
        <RailLink href="/agent/new" label="New thread">
          <OrbitKnotMark className="size-7" active={working} />
        </RailLink>

        <nav
          aria-label="Compact workspace navigation"
          className="flex flex-1 flex-col items-center justify-center gap-1"
        >
          <button
            ref={expandButtonRef}
            type="button"
            onClick={onExpand}
            aria-label="Expand navigation"
            title="Expand navigation"
            className={RAIL_ITEM}
          >
            <RiSidebarUnfoldLine className="size-4" aria-hidden />
          </button>
          <SearchCommand compact />
          <RailLink href="/dashboard" label="Dashboard">
            <RiDashboardLine className="size-4" aria-hidden />
          </RailLink>
          <RailLink href="/skills" label="Customize">
            <RiBookMarkedLine className="size-4" aria-hidden />
          </RailLink>
          <RailLink href="/settings" label="Settings">
            <RiSettings3Line className="size-4" aria-hidden />
          </RailLink>
        </nav>

        <div className="flex flex-col items-center gap-1">
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </aside>
  );
}
