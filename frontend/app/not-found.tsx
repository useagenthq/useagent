import { RiAddLine } from "@remixicon/react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/base/buttons/button";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

export const metadata: Metadata = {
  title: "Page not found",
};

/**
 * Root 404: unknown routes and `notFound()` from a page (a missing or foreign
 * thread id) land here inside the normal shell, on the theme tokens, with one
 * way forward.
 */
export default function NotFound() {
  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-mono-label text-text-tertiary">404</p>
          <h1 className="text-display-sm text-text-primary">Page not found</h1>
          <p className="text-body-2-regular text-text-secondary">
            This page does not exist, or the thread it pointed to is not in this workspace.
          </p>
          <ButtonLink
            href="/agent/new"
            variant="primary"
            size="small"
            leadingIcon={RiAddLine}
            className="mt-2 rounded-full"
          >
            Go to new thread
          </ButtonLink>
        </div>
      </div>
    </AppShell>
  );
}
