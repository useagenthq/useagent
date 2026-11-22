"use client";

import { useRef, useState } from "react";
import { appendOlderWikiDocs, fetchPublishedWikiDocuments, type WikiDoc } from "./wiki-data";

export interface WikiDocPages {
  docs: WikiDoc[];
  /** Cursor for the documents past the loaded pages; null when every one is loaded. */
  nextCursor: string | null;
  loadingOlder: boolean;
  olderFailed: boolean;
  loadOlder: () => Promise<void>;
}

/** The published documents loaded so far, from the server-rendered first page,
 *  and the next page on request: appended without repeating a document, with a
 *  failed page kept retryable on the same cursor. */
export function useWikiDocPages(
  initialDocs: WikiDoc[],
  initialNextCursor: string | null,
): WikiDocPages {
  const [docs, setDocs] = useState(initialDocs);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  // A ref, not state: a second click before the re-render must not send a second request.
  const loadingOlderRef = useRef(false);

  const loadOlder = async () => {
    if (!nextCursor || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const page = await fetchPublishedWikiDocuments(nextCursor);
      setDocs((loaded) => appendOlderWikiDocs(loaded, page.docs));
      setNextCursor(page.nextCursor);
    } catch {
      setOlderFailed(true);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  return { docs, nextCursor, loadingOlder, olderFailed, loadOlder };
}

/** Show older pages, past the loaded ones; nothing once every page is loaded. */
export function ShowOlderWikiPages({
  pages,
  className,
}: {
  pages: WikiDocPages;
  className?: string;
}) {
  if (!pages.nextCursor) return null;
  return (
    <div className={className}>
      {pages.olderFailed && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          Couldn't load older pages.
        </p>
      )}
      <button
        type="button"
        onClick={() => void pages.loadOlder()}
        disabled={pages.loadingOlder}
        className="inline-flex h-9 items-center rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50"
      >
        {pages.loadingOlder
          ? "Loading older pages…"
          : pages.olderFailed
            ? "Try again"
            : "Show older pages"}
      </button>
    </div>
  );
}
