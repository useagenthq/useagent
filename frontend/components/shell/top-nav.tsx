"use client";

import Link from "next/link";

import { PulseMark } from "@/components/foundations/brand/pulse-mark";
import { SearchCommand } from "./search-command";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { useWorkingSignal } from "./working-signal";

export function TopNav() {
  // The brand mark pulses inward while any agent is working (ref-counted signal),
  // and sits static otherwise.
  const working = useWorkingSignal();
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-stroke-soft-200 bg-bg-white-0 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1">
        <Link
          href="/"
          aria-label="skynet-a home"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-text-strong-950 transition-colors hover:bg-bg-weak-50"
        >
          <PulseMark className="size-5" active={working} />
        </Link>
      </div>

      <div className="flex justify-center">
        <SearchCommand />
      </div>

      {/* Right: org chip, theme, account */}
      <div className="flex min-w-0 items-center justify-end gap-1">
        <button
          type="button"
          className="hidden items-center gap-1.5 rounded-lg px-2 py-1.5 text-label-sm text-text-sub-600 transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 lg:inline-flex"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-feature-base text-[10px] font-medium text-static-white">
            S
          </span>
          Skynet Dev
        </button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
