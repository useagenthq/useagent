"use client";

import { RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { cx as cnExt } from "@/utils/cx";

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
        "flex items-center gap-3 rounded-2xl border border-border-button-default bg-background-secondary-default px-4 py-3",
        className,
      )}
    >
      <RiErrorWarningLine aria-hidden className="size-5 shrink-0 text-yellow-600" />
      <div className="min-w-0 flex-1">
        <p className="text-body-2-medium text-text-primary">Couldn’t reach the backend</p>
        <p className="text-caption-1-regular text-text-secondary">
          A connection problem, not an empty list.
        </p>
      </div>
      <button
        type="button"
        onClick={retry}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-button-default bg-background-primary-default px-3 py-1.5 text-caption-1-medium text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiRefreshLine aria-hidden className="size-3.5" />
        Retry
      </button>
    </div>
  );
}
