"use client";

import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiBrainLine,
  RiSearchLine,
  RiStarFill,
} from "@remixicon/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Chip } from "@/components/base/badges/chip";
import { Input } from "@/components/base/input/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { AddKnowledgeModal } from "./add-knowledge-modal";
import { ContextCardStack } from "./context-card";
import { KnowledgeRow } from "./knowledge-rows";
import {
  deleteKnowledge,
  fetchKnowledgeItems,
  searchKnowledge,
  setKnowledgePinned,
} from "./knowledge-api";
import {
  knowledgeFolderLabel,
  knowledgeItemForDisplay,
  seedFolders,
  type KnowledgeItem,
  type SearchResult,
} from "./knowledge-data";

const MIN_SEARCH_LENGTH = 3;
// Compact rows keep the page scannable; beyond this the rest sits behind a
// Show-more disclosure (the sidebar-threads pattern) so a large org corpus
// never floods the initial render.
const VISIBLE_ROWS = 30;

/** Shared list shell: bordered card containing divided compact rows. */
function RowList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-separator-border overflow-hidden rounded-2xl bg-background-primary-default shadow-sm ring-1 ring-inset ring-border-button-default">
      {children}
    </ul>
  );
}

export function KnowledgeGallery({
  initialItems,
  initialLive,
  initialError,
}: {
  initialItems: KnowledgeItem[];
  initialLive: boolean;
  initialError: boolean;
}) {
  const [items, setItems] = useState<KnowledgeItem[]>(initialItems);
  const [live, setLive] = useState(initialLive);
  const [error, setError] = useState(initialError);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [activeFolder, setActiveFolder] = useState("all");
  const [showAll, setShowAll] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const fresh = await fetchKnowledgeItems();
      setItems(fresh);
      setLive(true);
      setError(false);
    } catch {
      // backend still unreachable — flag the distinct error state (an empty
      // list here would masquerade an outage as "no knowledge yet")
      setError(true);
    }
  }, []);

  // Self-heal: if we SSR'd the mock fallback, try once on the client in case
  // the backend came online after the server render.
  useEffect(() => {
    if (!initialLive) void refetch();
  }, [initialLive, refetch]);

  // Search: ≥3 chars → POST search (debounced). Below the threshold, restore
  // the row list. If the endpoint is unavailable, degrade to a local match.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH_LENGTH) {
      setSearchResults(null);
      setSearchFailed(false);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchKnowledge(q);
        if (cancelled) return;
        setSearchResults(results);
        setSearchFailed(false);
      } catch {
        if (cancelled) return;
        setSearchResults(null);
        setSearchFailed(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const togglePin = useCallback(
    (item: KnowledgeItem) => {
      const next = !item.pinned;
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, pinned: next } : it)),
      );
      if (!live) return;
      setKnowledgePinned(item.id, next).catch(() => {
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, pinned: !next } : it)),
        );
      });
    },
    [live],
  );

  const removeItem = useCallback(
    (item: KnowledgeItem) => {
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      if (!live) return;
      deleteKnowledge(item.id).catch(() => {
        setItems((prev) =>
          prev.some((it) => it.id === item.id) ? prev : [...prev, item],
        );
      });
    },
    [live],
  );

  const folderOptions = useMemo(
    () => Array.from(new Set([...seedFolders, ...items.map((i) => i.folder)])),
    [items],
  );

  // Local fallback filtering, used only when the search endpoint is down.
  const localFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      [
        item.title,
        item.trigger ?? "",
        item.body,
        item.folder,
        knowledgeFolderLabel(item.folder),
        item.kind ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  const isSearchMode = query.trim().length >= MIN_SEARCH_LENGTH;
  const showRanked = isSearchMode && !searchFailed && searchResults !== null;

  const folders = useMemo(
    () => Array.from(new Set(items.map((item) => item.folder))),
    [items],
  );
  // A stale selection (folder emptied by delete/refetch) falls back to All.
  const folderFilter = folders.includes(activeFolder) ? activeFolder : "all";

  const rowSource = isSearchMode && searchFailed ? localFiltered : items;
  const filtered =
    folderFilter === "all"
      ? rowSource
      : rowSource.filter((item) => item.folder === folderFilter);
  const pinned = filtered.filter((item) => item.pinned);
  const unpinned = filtered.filter((item) => !item.pinned);
  const visibleRows = showAll ? unpinned : unpinned.slice(0, VISIBLE_ROWS);
  const overflowCount = unpinned.length - VISIBLE_ROWS;

  const renderRow = (item: KnowledgeItem) => (
    <KnowledgeRow
      key={item.id}
      item={knowledgeItemForDisplay(item)}
      onTogglePin={() => togglePin(item)}
      onDelete={() => removeItem(item)}
    />
  );

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <RiBrainLine
              aria-hidden
              className="size-5 text-foreground-icon-primary"
            />
            <h1 className="text-title-2-medium text-text-primary">Knowledge</h1>
          </div>
          <p className="mt-1.5 text-body-2-regular text-text-secondary">
            Facts and conventions useAgent remembers across runs
          </p>
        </div>
        <AddKnowledgeModal folders={folderOptions} onIngested={refetch} />
      </div>

      {/* Search */}
      <div className="mt-6">
        <Input
          aria-label="Search knowledge"
          placeholder="Search knowledge..."
          leadingIcon={RiSearchLine}
          value={query}
          onChange={setQuery}
        />
      </div>

      {/* Folder filter — page-level, applies to both sections below. */}
      {!showRanked && folders.length > 1 && (
        <div className="mt-4">
          <SegmentedControl
            aria-label="Filter knowledge by folder"
            className="flex-wrap"
            selectedKeys={[folderFilter]}
            onSelectionChange={(keys) => {
              const next = [...(keys as Set<string>)][0];
              if (typeof next === "string") setActiveFolder(next);
            }}
          >
            <SegmentedControlItem id="all">All</SegmentedControlItem>
            {folders.map((folder) => (
              <SegmentedControlItem key={folder} id={folder}>
                {knowledgeFolderLabel(folder)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      )}

      {showRanked ? (
        /* Ranked search results — the retrieved-context stack */
        <section className="mt-8 flex flex-col gap-4">
          {searching ? (
            <h2 className="text-body-2-medium text-text-secondary">Searching…</h2>
          ) : searchResults.length === 0 ? (
            <p className="text-body-2-regular text-text-secondary">
              No knowledge matches “{query.trim()}”.
            </p>
          ) : (
            <ContextCardStack
              label="Matches"
              count={searchResults.length}
              cards={searchResults.map((result) => ({
                title: result.title,
                body: result.text,
                meta: result.citation || undefined,
              }))}
            />
          )}
        </section>
      ) : pinned.length === 0 && unpinned.length === 0 ? (
        isSearchMode ? (
          <p className="mt-10 text-body-2-regular text-text-secondary">
            No knowledge matches “{query.trim()}”.
          </p>
        ) : items.length === 0 ? (
          error ? (
            <BackendUnreachable className="mt-10" onRetry={refetch} />
          ) : (
            <p className="mt-10 text-body-2-regular text-text-secondary">
              No knowledge yet. Add your first fact to teach useAgent.
            </p>
          )
        ) : (
          <p className="mt-10 text-body-2-regular text-text-secondary">
            Nothing in {knowledgeFolderLabel(folderFilter)} yet.
          </p>
        )
      ) : (
        <>
          {/* Pinned */}
          {pinned.length > 0 && (
            <section className="mt-8 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <RiStarFill aria-hidden className="size-4 text-yellow-500" />
                <h2 className="text-body-2-medium text-text-secondary">Pinned</h2>
                <Chip variant="caption" color="soft">
                  {pinned.length}
                </Chip>
              </div>
              <RowList>{pinned.map(renderRow)}</RowList>
            </section>
          )}

          {/* All knowledge */}
          {unpinned.length > 0 && (
            <section className="mt-8 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-body-2-medium text-text-secondary">
                  All knowledge
                </h2>
                <Chip variant="caption" color="soft">
                  {unpinned.length}
                </Chip>
              </div>
              <RowList>
                {visibleRows.map(renderRow)}
                {overflowCount > 0 && (
                  <li>
                    <button
                      type="button"
                      onClick={() => setShowAll((v) => !v)}
                      className="flex w-full items-center justify-center gap-1.5 px-4 py-2.5 text-caption-1-regular text-text-tertiary transition-colors hover:bg-background-secondary-default hover:text-text-secondary"
                    >
                      {showAll ? (
                        <RiArrowUpSLine aria-hidden className="size-4" />
                      ) : (
                        <RiArrowDownSLine aria-hidden className="size-4" />
                      )}
                      {showAll ? "Show fewer" : `Show ${overflowCount} more`}
                    </button>
                  </li>
                )}
              </RowList>
            </section>
          )}
        </>
      )}
    </div>
  );
}
