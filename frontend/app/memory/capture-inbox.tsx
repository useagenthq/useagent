"use client";

import { RiInboxLine, RiRefreshLine } from "@remixicon/react";
import { useState } from "react";
import Link from "next/link";

import { Chip } from "@/components/base/badges/chip";
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
        <RiInboxLine className="size-4 text-foreground-icon-secondary" aria-hidden />
        <h2 className="text-body-2-medium text-text-secondary">Recently captured</h2>
        {captures.length > 0 && (
          <span className="text-caption-1-regular text-text-tertiary">
            {captures.length} {captures.length === 1 ? "run" : "runs"}
          </span>
        )}
      </div>
      <p className="-mt-2 text-caption-1-regular text-text-tertiary">
        Outcomes queued to team memory. Dead rows can be retried; a lingering
        Delivering row is a crash orphan awaiting an explicit decision.
      </p>

      {error ? (
        <BackendUnreachable onRetry={onRefetch} />
      ) : captures.length === 0 ? (
        <p className="text-body-2-regular text-text-secondary">
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
    <article className="flex flex-col gap-2 rounded-2xl bg-background-primary-default p-4 shadow-card ring-1 ring-inset ring-border-button-default">
      <div className="flex items-center gap-2">
        <Chip variant="caption" color={state.color}>
          {state.label}
        </Chip>
        {row.scope && (
          <Chip variant="caption" color={row.scope === "org" ? "blue" : "purple"}>
            {SCOPE_META[row.scope].tag}
          </Chip>
        )}
        <Link
          href={`/session/${row.runId}`}
          className="truncate text-caption-1-regular text-text-tertiary hover:text-text-secondary"
        >
          run {row.runId.slice(0, 8)}
        </Link>
        <span className="ml-auto text-caption-1-regular text-text-tertiary">
          {relativeTime(row.updatedAt)}
        </span>
      </div>

      {row.promptPreview && (
        <p className="line-clamp-2 text-body-2-regular text-text-primary">
          {row.promptPreview}
        </p>
      )}

      <p className="text-caption-1-regular text-text-tertiary">{state.note}</p>

      {(row.state === "dead" || row.state === "pending") && (
        <p className="text-caption-1-regular text-text-tertiary">
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
              className="inline-flex items-center gap-1.5 rounded-full border border-border-button-default px-3 py-1 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary disabled:opacity-60"
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
                className="inline-flex items-center gap-1 rounded-full border border-border-button-default px-3 py-1 text-caption-1-medium text-status-lime-text transition-colors hover:bg-background-primary-hover disabled:opacity-60"
              >
                Mark delivered
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => onResolve(row.runId, "discard"))}
                className="inline-flex items-center gap-1 rounded-full border border-border-button-default px-3 py-1 text-caption-1-medium text-text-error-primary transition-colors hover:bg-background-primary-hover disabled:opacity-60"
              >
                Discard
              </button>
            </>
          )}
          {failed && (
            <span className="text-caption-1-regular text-text-error-primary">
              Failed - retry.
            </span>
          )}
        </div>
      )}
    </article>
  );
}
