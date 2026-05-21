"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/ThreadSyncStatusPill.tsx - the floating
// centered status chip shown while a thread hydrates/catches up.
//
// Port notes: label is a plain prop (upstream derives it from their threadSync
// phase machine); lucide LoaderCircleIcon -> RiLoader4Line with motion-safe spin;
// tokens are AlignUI semantic.

import { RiLoader4Line } from "@remixicon/react";

export function T3SyncStatusPill({ label }: { label: string }) {
  return (
    <div
      data-t3-ui="sync-status-pill"
      aria-label={label}
      className="pointer-events-none mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-stroke-soft-200 bg-bg-weak-50 px-3 py-1.5 text-xs font-medium text-text-strong-950 shadow-regular-sm"
      role="status"
    >
      <RiLoader4Line
        aria-hidden
        className="size-3.5 shrink-0 text-text-soft-400 motion-safe:animate-spin"
      />
      <span className="truncate">{label}</span>
    </div>
  );
}
