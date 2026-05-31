"use client";

import Link from "next/link";

import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { useWorkingSignal } from "./working-signal";

export function SidebarBrand({ label = "UseAgent" }: { label?: string }) {
  const working = useWorkingSignal();

  return (
    <div className="flex h-12 shrink-0 items-center px-3">
      <Link
        href="/agent/new"
        aria-label="UseAgent new thread"
        className="flex min-w-0 items-center gap-2.5 rounded-2lg px-2 py-1.5 text-body-2-medium text-text-primary outline-none transition-colors hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <OrbitKnotMark className="size-8" active={working} />
        <span className="truncate">{label}</span>
      </Link>
    </div>
  );
}
