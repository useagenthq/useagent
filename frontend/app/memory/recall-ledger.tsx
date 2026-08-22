"use client";

import { RiHistoryLine } from "@remixicon/react";
import Link from "next/link";

import { Chip } from "@/components/base/badges/chip";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { relativeTime } from "@/utils/format";
import { SCOPE_META, type RecallLedgerRow } from "./memory-data";

/**
 * "Recently recalled" - per-run recall frames from the retrieval ledger
 * (durable `context.retrieved` events). Each row shows WHAT a run pulled from
 * memory (query, scope, cited items) and links back to /session/{runId}. Read
 * only: it is an audit trail, not an editable surface.
 */
export function RecallLedger({
  recalls,
  error,
  onRefetch,
}: {
  recalls: RecallLedgerRow[];
  error: boolean;
  onRefetch: () => void;
}) {
  return (
    <section className="mt-10 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <RiHistoryLine className="size-4 text-foreground-icon-secondary" aria-hidden />
        <h2 className="text-body-2-medium text-text-secondary">Recently recalled</h2>
        {recalls.length > 0 && (
          <span className="text-caption-1-regular text-text-tertiary">
            {recalls.length} {recalls.length === 1 ? "run" : "runs"}
          </span>
        )}
      </div>
      <p className="-mt-2 text-caption-1-regular text-text-tertiary">
        What each run pulled from memory at start, straight from the retrieval
        ledger.
      </p>

      {error ? (
        <BackendUnreachable onRetry={onRefetch} />
      ) : recalls.length === 0 ? (
        <p className="text-body-2-regular text-text-secondary">
          No recalls yet - runs record what memory they used here.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {recalls.map((row) => (
            <article
              key={row.runId}
              className="flex flex-col gap-2 rounded-2xl bg-background-primary-default p-4 shadow-card ring-1 ring-inset ring-border-button-default"
            >
              <div className="flex items-center gap-2">
                <Chip
                  variant="caption"
                  color={row.memoryScope === "org" ? "blue" : "purple"}
                >
                  {SCOPE_META[row.memoryScope].tag}
                </Chip>
                <span className="text-caption-1-regular text-text-tertiary">
                  {row.itemCount} {row.itemCount === 1 ? "item" : "items"} - {row.latencyMs}ms
                </span>
                <Link
                  href={`/session/${row.runId}`}
                  className="ml-auto text-caption-1-regular text-accent-500 hover:underline"
                >
                  Open run
                </Link>
              </div>

              <p className="line-clamp-1 text-body-2-regular text-text-primary">
                {row.query}
              </p>

              {row.items.length > 0 && (
                <ul className="flex flex-col gap-1 border-l-2 border-separator-border pl-3">
                  {row.items.map((it, i) => (
                    <li key={i} className="line-clamp-1 text-caption-1-regular text-text-secondary">
                      <span className="text-text-tertiary">[{SCOPE_META[it.sourceScope].tag}]</span>{" "}
                      {it.content}
                    </li>
                  ))}
                </ul>
              )}

              <span className="text-caption-1-regular text-text-tertiary">
                {relativeTime(row.createdAt)}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
