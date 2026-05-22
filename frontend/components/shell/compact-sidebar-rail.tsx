"use client";

import {
  RiBookMarkedLine,
  RiFolderLine,
  RiSettings3Line,
  RiSidebarUnfoldLine,
} from "@remixicon/react";
import Link from "next/link";
import type { ReactNode, Ref } from "react";

import { PulseMark } from "@/components/foundations/brand/pulse-mark";
import { SearchCommand } from "./search-command";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { useWorkingSignal } from "./working-signal";

function RailLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="flex size-9 items-center justify-center rounded-lg text-text-soft-400 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
    >
      {children}
    </Link>
  );
}

/** The useful state of a folded project sidebar: brand, core destinations, and
 * account controls remain reachable instead of collapsing to an empty gutter. */
export function CompactSidebarRail({
  expandButtonRef,
  onExpand,
}: {
  expandButtonRef?: Ref<HTMLButtonElement>;
  onExpand: () => void;
}) {
  const working = useWorkingSignal();

  return (
    <aside
      aria-label="Compact navigation"
      className="hidden h-full w-14 shrink-0 flex-col items-center bg-bg-white-0 py-2 md:flex"
    >
      <RailLink href="/agent/new" label="New thread">
        <PulseMark className="size-7 text-brand-orbit" active={working} />
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
          className="flex size-9 items-center justify-center rounded-lg text-text-soft-400 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
        >
          <RiSidebarUnfoldLine className="size-4" aria-hidden />
        </button>
        <SearchCommand compact />
        <RailLink href="/dashboard" label="All projects">
          <RiFolderLine className="size-4" aria-hidden />
        </RailLink>
        <RailLink href="/skills" label="Library">
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
    </aside>
  );
}
