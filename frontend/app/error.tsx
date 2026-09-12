"use client";

import { RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

/**
 * Root error boundary. Renders inside the normal shell (the root layout and
 * its providers survive, so theme tokens apply) with the same inline
 * affordance as BackendUnreachable: what happened, and a Retry that re-renders
 * the failed segment.
 */
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-border-button-default bg-background-secondary-default px-4 py-3">
          <RiErrorWarningLine aria-hidden className="size-5 shrink-0 text-status-yellow-text" />
          <div className="min-w-0 flex-1">
            <p className="text-body-2-medium text-text-primary">Something went wrong</p>
            <p className="text-caption-1-regular text-text-secondary">
              This page hit an error while rendering. Retry, or open a new thread from the sidebar.
            </p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            className="rounded-full"
            leadingIcon={RiRefreshLine}
            onClick={reset}
          >
            Retry
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
