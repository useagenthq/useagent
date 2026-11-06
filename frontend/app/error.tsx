"use client";

import { RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";

/**
 * Root error boundary: what happened, and a Retry that asks the server for the
 * failed segment again and re-renders it. `reset` alone re-renders from what
 * the client already holds, so a server render that failed (a thread that
 * could not load) failed again on every click; `retry` refreshes first.
 * The root layout and its providers survive, so theme tokens apply.
 * It deliberately renders no shell: this file is a client entry of every
 * route, public pages included, so anything it imports ships on first load
 * everywhere (the shell once cost the sign-in page the sidebar, two component
 * libraries and the command palette).
 */
export default function ErrorPage({
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background-full p-6">
      <div className="flex w-full items-center justify-center">
        <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-border-button-default bg-background-secondary-default px-4 py-3">
          <RiErrorWarningLine aria-hidden className="size-5 shrink-0 text-status-yellow-text" />
          <div className="min-w-0 flex-1">
            <p className="text-body-2-medium text-text-primary">Something went wrong</p>
            <p className="text-caption-1-regular text-text-secondary">
              This page hit an error while rendering. Retry, or go back and open it again.
            </p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            className="rounded-full"
            leadingIcon={RiRefreshLine}
            onClick={retry}
          >
            Retry
          </Button>
        </div>
      </div>
    </main>
  );
}
