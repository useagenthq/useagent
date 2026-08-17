"use client";

import Link from "next/link";

import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { useWorkingSignal } from "./working-signal";

export function SidebarBrand({ label = "Skynet" }: { label?: string }) {
  const working = useWorkingSignal();

  return (
    <div className="flex h-14 shrink-0 items-center px-3">
      <Link
        href="/agent/new"
        aria-label="Skynet new thread"
        className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-label-sm text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        <OrbitKnotMark className="size-6" active={working} />
        <span className="truncate">{label}</span>
      </Link>
    </div>
  );
}
