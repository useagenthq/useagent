"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/ThreadErrorBanner.tsx (the prominent
// dismissible thread-failure alert + its session-scoped dismissal helpers: a
// dismissal is remembered per thread key + message, so navigating away to a
// thread with no error cannot resurrect the banner, while a DIFFERENT error on
// the same thread still appears).
//
// Port notes:
// - Their shadcn Alert/Button/Tooltip -> hand-rolled with AlignUI error tokens
//   (bg-red-50 / border-red-200 / text-text-error-primary), matching the
//   other session-ui ports; lucide CircleAlertIcon/XIcon -> Remixicon.
// - Their line-clamp + Tooltip full-text affordance -> line-clamp + `title`
//   (this banner sits in the composer's banner stack, not a portal).
// - `onRetry` renders a Retry action ONLY when a real handler is passed. Today
//   NO thread-level retry/resend action exists in session-view/composer
//   (handleReply starts a NEW turn; the composer's internal retry covers failed
//   SUBMITS only), so no call site passes it and the button never renders.

import { RiCloseLine, RiErrorWarningLine } from "@remixicon/react";

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

/** A deliberate user cancel is a neutral outcome, never an alarm. */
export function isUserStopSummary(error: string | null): boolean {
  return error !== null && /^stopped by user/i.test(error.trim());
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  if (isUserStopSummary(error)) return false;
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives session-view remounts, e.g. route
// changes between threads). A dismissal is remembered per thread key plus
// message, so a different error message on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

/**
 * Prominent dismissible banner for a thread whose latest run FAILED: error glyph
 * + "This run failed" + the run's real error summary (run.summary). Purely
 * presentational; the call site computes visibility (failed latest run + the
 * session-dismissal helpers above) from thread-store state it already has.
 */
export function ThreadErrorBanner({
  error,
  onDismiss,
  onRetry,
}: {
  /** The failed run's real error summary (run.summary); null renders nothing. */
  error: string | null;
  onDismiss?: () => void;
  /** Renders a Retry action when a REAL existing retry handler is supplied;
   *  absent (the current product state - no such action exists) means no button. */
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <div
      data-session-ui="thread-error-banner"
      role="alert"
      className="border-border-error-default/60 bg-background-secondary-default flex items-start gap-2 rounded-lg border-l-2 py-2 pl-3 pr-2"
    >
      <RiErrorWarningLine className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-caption-1-regular text-text-secondary line-clamp-2 break-words" title={error}>
          <span className="text-text-error-primary">Run failed</span>
          <span className="text-text-tertiary"> - </span>
          {error}
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="border-red-200 text-text-error-primary hover:bg-red-200/40 shrink-0 rounded-lg border px-2 py-0.5 text-caption-1-medium transition-colors"
        >
          Retry
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={onDismiss}
          className="text-text-tertiary hover:text-text-primary hover:bg-background-tertiary-hover flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <RiCloseLine className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
