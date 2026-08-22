"use client";

import {
  RiBrainLine,
  RiSearchLine,
  RiStarFill,
} from "@remixicon/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import * as Badge from "@/components/ui/badge";
import * as Input from "@/components/ui/input";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { AddKnowledgeModal } from "./add-knowledge-modal";
import { ContextCardStack } from "./context-card";
import { EntryCard, PinnedCard } from "./knowledge-cards";
import {
  deleteKnowledge,
  fetchKnowledgeItems,
  searchKnowledge,
  setKnowledgePinned,
} from "./knowledge-api";
import {
  folderChipColor,
  knowledgeFolderLabel,
  knowledgeItemForDisplay,
  seedFolders,
  type KnowledgeItem,
  type SearchResult,
} from "./knowledge-data";

const MIN_SEARCH_LENGTH = 3;

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
  // the grouped list. If the endpoint is unavailable, degrade to a local match.
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

  const groupSource = isSearchMode && searchFailed ? localFiltered : items;
  const pinned = groupSource.filter((item) => item.pinned);
  const folders = Array.from(new Set(groupSource.map((item) => item.folder)));
  const grouped = folders
    .map((folder) => ({
      folder,
      entries: groupSource.filter(
        (item) => item.folder === folder && !item.pinned,
      ),
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <RiBrainLine
            aria-hidden
            className="mt-0.5 size-5 text-text-primary"
          />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-display-sm text-text-primary">Knowledge</h1>
            <p className="text-body-2-regular text-text-secondary">
              Facts and conventions useAgent remembers across runs
            </p>
          </div>
        </div>
        <AddKnowledgeModal folders={folderOptions} onIngested={refetch} />
      </div>

      {/* Search */}
      <div className="mt-6">
        <Input.Root>
          <Input.Wrapper>
            <Input.Icon as={RiSearchLine} />
            <Input.Input
              aria-label="Search knowledge"
              placeholder="Search knowledge..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Input.Wrapper>
        </Input.Root>
      </div>

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
      ) : pinned.length === 0 && grouped.length === 0 ? (
        isSearchMode ? (
          <p className="mt-10 text-body-2-regular text-text-secondary">
            No knowledge matches “{query.trim()}”.
          </p>
        ) : error ? (
          <BackendUnreachable className="mt-10" onRetry={refetch} />
        ) : (
          <p className="mt-10 text-body-2-regular text-text-secondary">
            No knowledge yet. Add your first fact to teach useAgent.
          </p>
        )
      ) : (
        <>
          {/* Pinned */}
          {pinned.length > 0 && (
            <section className="mt-8 flex flex-col gap-4">
              <div className="flex items-center gap-1.5">
                <RiStarFill className="size-4 text-yellow-500" aria-hidden />
                <h2 className="text-body-2-medium text-text-secondary">Pinned</h2>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {pinned.map((item) => (
                  <PinnedCard
                    key={item.id}
                    item={knowledgeItemForDisplay(item)}
                    onTogglePin={() => togglePin(item)}
                    onDelete={() => removeItem(item)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* All knowledge, grouped by folder */}
          {grouped.length > 0 && (
            <section className="mt-10 flex flex-col gap-8">
              <h2 className="text-body-2-medium text-text-secondary">All knowledge</h2>
              {grouped.map(({ folder, entries }) => (
                <div key={folder} className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <Badge.Root
                      variant="light"
                      size="medium"
                      color={folderChipColor(folder)}
                    >
                      {knowledgeFolderLabel(folder)}
                    </Badge.Root>
                    <span className="text-caption-1-regular text-text-tertiary">
                      {entries.length}{" "}
                      {entries.length === 1 ? "entry" : "entries"}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {entries.map((item) => (
                      <EntryCard
                        key={item.id}
                        item={knowledgeItemForDisplay(item)}
                        onTogglePin={() => togglePin(item)}
                        onDelete={() => removeItem(item)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
