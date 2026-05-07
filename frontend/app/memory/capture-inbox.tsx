"use client";

import { RiInboxLine, RiRefreshLine } from "@remixicon/react";
import { useState } from "react";
import Link from "next/link";

import * as Badge from "@/components/ui/badge";
import { relativeTime } from "@/utils/format";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import {
  CAPTURE_STATE_META,
  SCOPE_META,
  type CaptureRow,
} from "./memory-data";

/**
 * "Recently captured" - our OWN capture-outbox rows for this org: the envelopes
 * we sent (or are trying to send) to team memory, with real delivered / pending /
 * delivering / dead state. Two manual-recovery paths live here:
 *  - a `dead` row can be re-enqueued (Retry) with a fresh attempt budget;
 *  - a crash-orphaned `delivering` row (at-most-once, never auto-retried) is
 *    resolved by an explicit operator decision: it landed (Mark delivered) or it
 *    did not (Discard).
 */
export function CaptureInbox({
  captures,
  error,
  onRetry,
  onResolve,
  onRefetch,
}: {
  captures: CaptureRow[];
  error: boolean;
  onRetry: (runId: string) => Promise<void>;
  onResolve: (runId: string, resolution: "delivered" | "discard") => Promise<void>;
  onRefetch: () => void;
}) {
  return (
    <section className="mt-10 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <RiInboxLine className="size-4 text-text-sub-600" aria-hidden />
        <h2 className="text-label-sm text-text-sub-600">Recently captured</h2>
        {captures.length > 0 && (
          <span className="text-paragraph-xs text-text-soft-400">
            {captures.length} {captures.length === 1 ? "run" : "runs"}
          </span>
        )}
      </div>
      <p className="-mt-2 text-paragraph-xs text-text-soft-400">
        Outcomes queued to team memory. Dead rows can be retried; a lingering
        Delivering row is a crash orphan awaiting an explicit decision.
      </p>

      {error ? (
        <BackendUnreachable onRetry={onRefetch} />
      ) : captures.length === 0 ? (
        <p className="text-paragraph-sm text-text-sub-600">
          No captures yet - completed runs queue their outcome here.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {captures.map((row) => (
            <CaptureRowCard
              key={row.runId}
              row={row}
              onRetry={onRetry}
              onResolve={onResolve}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CaptureRowCard({
  row,
  onRetry,
  onResolve,
}: {
  row: CaptureRow;
  onRetry: (runId: string) => Promise<void>;
  onResolve: (runId: string, resolution: "delivered" | "discard") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = CAPTURE_STATE_META[row.state];

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await fn();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col gap-2 rounded-2xl bg-bg-white-0 p-4 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200">
      <div className="flex items-center gap-2">
        <Badge.Root variant="light" size="medium" color={state.color}>
          {state.label}
        </Badge.Root>
        {row.scope && (
          <Badge.Root variant="light" size="medium" color={row.scope === "org" ? "blue" : "purple"}>
            {SCOPE_META[row.scope].tag}
          </Badge.Root>
        )}
        <Link
          href={`/session/${row.runId}`}
          className="truncate text-paragraph-xs text-text-soft-400 hover:text-text-sub-600"
        >
          run {row.runId.slice(0, 8)}
        </Link>
        <span className="ml-auto text-paragraph-xs text-text-soft-400">
          {relativeTime(row.updatedAt)}
        </span>
      </div>

      {row.promptPreview && (
        <p className="line-clamp-2 text-paragraph-sm text-text-strong-950">
          {row.promptPreview}
        </p>
      )}

      <p className="text-paragraph-xs text-text-soft-400">{state.note}</p>

      {(row.state === "dead" || row.state === "pending") && (
        <p className="text-paragraph-xs text-text-soft-400">
          Attempt {row.attemptCount}/{row.maxAttempts}
          {row.lastError ? ` - ${row.lastError}` : ""}
        </p>
      )}

      {(row.state === "dead" || row.state === "delivering") && (
        <div className="mt-1 flex items-center gap-2">
          {row.state === "dead" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => onRetry(row.runId))}
              className="inline-flex items-center gap-1.5 rounded-full border border-stroke-soft-200 px-3 py-1 text-label-xs text-text-sub-600 transition-colors hover:text-text-strong-950 disabled:opacity-60"
            >
              <RiRefreshLine className="size-3.5" aria-hidden />
              Retry
            </button>
          )}
          {row.state === "delivering" && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => onResolve(row.runId, "delivered"))}
                className="inline-flex items-center gap-1 rounded-full border border-stroke-soft-200 px-3 py-1 text-label-xs text-success-base transition-colors hover:bg-bg-weak-50 disabled:opacity-60"
              >
                Mark delivered
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => onResolve(row.runId, "discard"))}
                className="inline-flex items-center gap-1 rounded-full border border-stroke-soft-200 px-3 py-1 text-label-xs text-error-base transition-colors hover:bg-bg-weak-50 disabled:opacity-60"
              >
                Discard
              </button>
            </>
          )}
          {failed && <span className="text-paragraph-xs text-error-base">Failed - retry.</span>}
        </div>
      )}
    </article>
  );
}
