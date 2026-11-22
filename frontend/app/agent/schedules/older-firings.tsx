"use client";

import { Button } from "@/components/base/buttons/button";
import type { OlderFiringsState } from "./use-firing-history";

/** Below a history list: asks for the older runs while the server has more. */
export function OlderFirings({
  hasMore,
  state,
  onLoad,
}: {
  hasMore: boolean;
  state: OlderFiringsState;
  onLoad: () => void;
}) {
  if (!hasMore) return null;
  let label = "Show older runs";
  if (state === "loading") label = "Loading older runs";
  else if (state === "failed") label = "Try again";
  return (
    <div className="mt-3 flex items-center justify-center gap-2">
      {state === "failed" && (
        <p role="alert" className="text-caption-1-regular text-text-tertiary">
          Couldn&apos;t load older runs.
        </p>
      )}
      <Button variant="secondary" size="small" disabled={state === "loading"} onClick={onLoad}>
        {label}
      </Button>
    </div>
  );
}

/** The count beside a history's heading: every run once all are loaded, else how many of the newest are shown. */
export function firingCountLabel(count: number, hasMore: boolean): string {
  return hasMore ? `Newest ${count}` : `${count} recorded`;
}
