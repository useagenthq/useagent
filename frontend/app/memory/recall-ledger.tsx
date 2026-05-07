"use client";

import { RiHistoryLine } from "@remixicon/react";
import Link from "next/link";

import * as Badge from "@/components/ui/badge";
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
        <RiHistoryLine className="size-4 text-text-sub-600" aria-hidden />
        <h2 className="text-label-sm text-text-sub-600">Recently recalled</h2>
        {recalls.length > 0 && (
          <span className="text-paragraph-xs text-text-soft-400">
            {recalls.length} {recalls.length === 1 ? "run" : "runs"}
          </span>
        )}
      </div>
      <p className="-mt-2 text-paragraph-xs text-text-soft-400">
        What each run pulled from memory at start, straight from the retrieval
        ledger.
      </p>

      {error ? (
        <BackendUnreachable onRetry={onRefetch} />
      ) : recalls.length === 0 ? (
        <p className="text-paragraph-sm text-text-sub-600">
          No recalls yet - runs record what memory they used here.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {recalls.map((row) => (
            <article
              key={row.runId}
              className="flex flex-col gap-2 rounded-2xl bg-bg-white-0 p-4 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200"
            >
              <div className="flex items-center gap-2">
                <Badge.Root
                  variant="light"
                  size="medium"
                  color={row.memoryScope === "org" ? "blue" : "purple"}
                >
                  {SCOPE_META[row.memoryScope].tag}
                </Badge.Root>
                <span className="text-paragraph-xs text-text-soft-400">
                  {row.itemCount} {row.itemCount === 1 ? "item" : "items"} - {row.latencyMs}ms
                </span>
                <Link
                  href={`/session/${row.runId}`}
                  className="ml-auto text-paragraph-xs text-primary-base hover:underline"
                >
                  Open run
                </Link>
              </div>

              <p className="line-clamp-1 text-paragraph-sm text-text-strong-950">
                {row.query}
              </p>

              {row.items.length > 0 && (
                <ul className="flex flex-col gap-1 border-l-2 border-stroke-soft-200 pl-3">
                  {row.items.map((it, i) => (
                    <li key={i} className="line-clamp-1 text-paragraph-xs text-text-sub-600">
                      <span className="text-text-soft-400">[{SCOPE_META[it.sourceScope].tag}]</span>{" "}
                      {it.content}
                    </li>
                  ))}
                </ul>
              )}

              <span className="text-paragraph-xs text-text-soft-400">
                {relativeTime(row.createdAt)}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
