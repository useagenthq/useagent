"use client";

import { RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { cnExt } from "@/utils/cn";

/**
 * Small inline "couldn't reach the backend" affordance — the honest counterpart
 * to a page's empty state. A caught fetch failure must render THIS (a connection
 * problem the user can retry), never the empty state, so an outage never
 * masquerades as a calm "nothing here yet".
 *
 * `onRetry` is optional so a server-rendered page (which cannot pass a function
 * across the server→client boundary) can drop it in and get a full-page reload
 * on retry; client views pass their own in-place refetch.
 */
export function BackendUnreachable({
  onRetry,
  className,
}: {
  onRetry?: () => void;
  className?: string;
}) {
  const retry = onRetry ?? (() => window.location.reload());
  return (
    <div
      className={cnExt(
        "flex items-center gap-3 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 px-4 py-3",
        className,
      )}
    >
      <RiErrorWarningLine aria-hidden className="size-5 shrink-0 text-warning-base" />
      <div className="min-w-0 flex-1">
        <p className="text-label-sm text-text-strong-950">Couldn’t reach the backend</p>
        <p className="text-paragraph-xs text-text-sub-600">
          A connection problem — not an empty list.
        </p>
      </div>
      <button
        type="button"
        onClick={retry}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-stroke-soft-200 bg-bg-white-0 px-3 py-1.5 text-label-xs text-text-sub-600 outline-none transition-colors hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        <RiRefreshLine aria-hidden className="size-3.5" />
        Retry
      </button>
    </div>
  );
}
