"use client";

import { RiDatabase2Line, RiLockLine, RiSearchLine } from "@remixicon/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import * as Badge from "@/components/ui/badge";
import * as Input from "@/components/ui/input";
import * as SegmentedControl from "@/components/ui/segmented-control";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { CaptureInbox } from "./capture-inbox";
import { RecallLedger } from "./recall-ledger";
import { StoredMemoryCard } from "./stored-memory-card";
import {
  correctMemory,
  deleteMemory,
  fetchBrowse,
  fetchCaptures,
  fetchRecalls,
  resolveCapture,
  retryCapture,
  searchMemory,
} from "./memory-api";
import {
  SCOPE_META,
  SCOPES,
  type BrowseResponse,
  type CaptureRow,
  type MemoryScope,
  type RecallItem,
  type RecallLedgerRow,
  type StoredMemory,
} from "./memory-data";

const MIN_SEARCH_LENGTH = 3;

/**
 * Memory Hub client owner. Scope tabs (Organization | Personal) drive the recall
 * search + the stored-memory list for that pool; the organization tab also shows
 * the capture outbox (inspect + operate) and the retrieval ledger. Personal scope
 * fails closed with no authenticated user, exactly like the runtime.
 */
export function MemoryHub({
  initialBrowse,
  initialCaptures,
  initialRecalls,
  initialError,
}: {
  initialBrowse: BrowseResponse | null;
  initialCaptures: CaptureRow[];
  initialRecalls: RecallLedgerRow[];
  initialError: boolean;
}) {
  const [scope, setScope] = useState<MemoryScope>("org");

  // Browse cache per scope (org SSR'd; personal fetched on first switch).
  const [browses, setBrowses] = useState<Partial<Record<MemoryScope, BrowseResponse>>>(
    initialBrowse ? { org: initialBrowse } : {},
  );
  const [browseError, setBrowseError] = useState(initialError);

  // Recall search (scoped, debounced).
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecallItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  // Organization activity.
  const [captures, setCaptures] = useState<CaptureRow[]>(initialCaptures);
  const [capturesError, setCapturesError] = useState(false);
  const [recalls, setRecalls] = useState<RecallLedgerRow[]>(initialRecalls);
  const [recallsError, setRecallsError] = useState(false);

  const browse = browses[scope] ?? null;

  const loadBrowse = useCallback(async (target: MemoryScope) => {
    try {
      const res = await fetchBrowse(target);
      setBrowses((prev) => ({ ...prev, [target]: res }));
      setBrowseError(false);
    } catch {
      setBrowseError(true);
    }
  }, []);

  // Self-heal org SSR failure, and load a scope the first time it is shown.
  useEffect(() => {
    if (!browses[scope]) void loadBrowse(scope);
  }, [scope, browses, loadBrowse]);

  // Reset the search when switching scope (results are pool-specific).
  useEffect(() => {
    setQuery("");
    setResults(null);
    setSearchFailed(false);
  }, [scope]);

  // Debounced recall search against the active scope.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH_LENGTH) {
      setResults(null);
      setSearchFailed(false);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await searchMemory(scope, q);
        if (cancelled) return;
        setResults(res.items);
        setSearchFailed(false);
      } catch {
        if (cancelled) return;
        setResults(null);
        setSearchFailed(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scope]);

  const onCorrect = useCallback(
    async (id: string, content: string) => {
      await correctMemory(id, scope, content);
      setBrowses((prev) => {
        const cur = prev[scope];
        if (!cur) return prev;
        return {
          ...prev,
          [scope]: {
            ...cur,
            items: cur.items.map((it) =>
              it.id === id ? { ...it, content, updatedAt: new Date().toISOString() } : it,
            ),
          },
        };
      });
    },
    [scope],
  );

  const onDelete = useCallback(
    async (id: string) => {
      await deleteMemory(id, scope);
      setBrowses((prev) => {
        const cur = prev[scope];
        if (!cur) return prev;
        return {
          ...prev,
          [scope]: { ...cur, items: cur.items.filter((it) => it.id !== id), total: Math.max(0, cur.total - 1) },
        };
      });
    },
    [scope],
  );

  const refetchCaptures = useCallback(async () => {
    try {
      setCaptures(await fetchCaptures());
      setCapturesError(false);
    } catch {
      setCapturesError(true);
    }
  }, []);

  const refetchRecalls = useCallback(async () => {
    try {
      setRecalls(await fetchRecalls());
      setRecallsError(false);
    } catch {
      setRecallsError(true);
    }
  }, []);

  const onRetry = useCallback(
    async (runId: string) => {
      await retryCapture(runId);
      await refetchCaptures();
    },
    [refetchCaptures],
  );

  const onResolve = useCallback(
    async (runId: string, resolution: "delivered" | "discard") => {
      await resolveCapture(runId, resolution);
      await refetchCaptures();
    },
    [refetchCaptures],
  );

  const meta = SCOPE_META[scope];
  const isSearchMode = query.trim().length >= MIN_SEARCH_LENGTH;
  const failedClosed = browse?.failedClosed === true;
  const memoryDisabled = browse?.enabled === false;

  const storedList = useMemo(() => browse?.items ?? [], [browse]);

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <RiDatabase2Line aria-hidden className="mt-0.5 size-5 text-text-strong-950" />
        <div className="flex flex-col gap-0.5">
          <h1 className="text-display-sm text-text-strong-950">Memory</h1>
          <p className="text-paragraph-sm text-text-sub-600">
            The team memory Skynet recalls, captures, and can correct
          </p>
        </div>
      </div>

      {/* Scope tabs */}
      <div className="mt-6">
        <SegmentedControl.Root
          value={scope}
          onValueChange={(v) => setScope(v as MemoryScope)}
        >
          <SegmentedControl.List aria-label="Memory scope" className="w-[320px]">
            {SCOPES.map((s) => (
              <SegmentedControl.Trigger key={s} value={s}>
                {SCOPE_META[s].short}
              </SegmentedControl.Trigger>
            ))}
          </SegmentedControl.List>
        </SegmentedControl.Root>
        <p className="mt-2 text-paragraph-xs text-text-soft-400">{meta.hint}</p>
      </div>

      {failedClosed ? (
        <PersonalSignInNeeded />
      ) : memoryDisabled ? (
        <p className="mt-8 text-paragraph-sm text-text-sub-600">
          Team memory is not configured on this deployment.
        </p>
      ) : (
        <>
          {/* Recall search */}
          <div className="mt-6">
            <Input.Root>
              <Input.Wrapper>
                <Input.Icon as={RiSearchLine} />
                <Input.Input
                  aria-label={`Search ${meta.label}`}
                  placeholder={`Recall from ${meta.label.toLowerCase()}...`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </Input.Wrapper>
            </Input.Root>
          </div>

          {isSearchMode ? (
            <RecallResults
              query={query.trim()}
              results={results}
              searching={searching}
              failed={searchFailed}
            />
          ) : browseError ? (
            <BackendUnreachable className="mt-8" onRetry={() => loadBrowse(scope)} />
          ) : storedList.length === 0 ? (
            <p className="mt-10 text-paragraph-sm text-text-sub-600">
              No {meta.short.toLowerCase()} memory stored yet. It fills as runs
              capture outcomes into this pool.
            </p>
          ) : (
            <section className="mt-8 flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <h2 className="text-label-sm text-text-sub-600">Stored memory</h2>
                <span className="text-paragraph-xs text-text-soft-400">
                  showing {storedList.length} of {browse?.total ?? storedList.length}
                </span>
              </div>
              <p className="-mt-2 text-paragraph-xs text-text-soft-400">
                Delete removes a fact from the upstream pool. Correcting a fact is
                wired to MemoryCore /v3/atomic/update, which currently rejects edits
                to org-pool memory (&ldquo;belongs to a different user&rdquo;) - a
                known upstream limitation, surfaced honestly per fact.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {storedList.map((item: StoredMemory) => (
                  <StoredMemoryCard
                    key={item.id}
                    item={item}
                    scope={scope}
                    onCorrect={onCorrect}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Organization activity (outbox + ledger) - org scope only. */}
      {scope === "org" && (
        <>
          <div className="mt-12 border-t border-stroke-soft-200" />
          <CaptureInbox
            captures={captures}
            error={capturesError}
            onRetry={onRetry}
            onResolve={onResolve}
            onRefetch={refetchCaptures}
          />
          <RecallLedger recalls={recalls} error={recallsError} onRefetch={refetchRecalls} />
        </>
      )}
    </div>
  );
}

/** Labeled recall hits ([org]/[personal] + citation score). */
function RecallResults({
  query,
  results,
  searching,
  failed,
}: {
  query: string;
  results: RecallItem[] | null;
  searching: boolean;
  failed: boolean;
}) {
  if (searching) {
    return <p className="mt-8 text-label-sm text-text-sub-600">Searching...</p>;
  }
  if (failed) {
    return <BackendUnreachable className="mt-8" />;
  }
  if (!results || results.length === 0) {
    return (
      <p className="mt-8 text-paragraph-sm text-text-sub-600">
        No memory matches &ldquo;{query}&rdquo;.
      </p>
    );
  }
  return (
    <section className="mt-8 flex flex-col gap-3">
      <h2 className="text-label-sm text-text-sub-600">
        Recalled for &ldquo;{query}&rdquo;
      </h2>
      {results.map((it, i) => (
        <article
          key={`${it.citation.assetId}-${i}`}
          className="flex flex-col gap-2 rounded-2xl bg-bg-white-0 p-4 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200"
        >
          <p className="text-paragraph-sm text-text-strong-950">{it.content}</p>
          <div className="flex items-center gap-2">
            <Badge.Root
              variant="light"
              size="medium"
              color={it.sourceScope === "org" ? "blue" : "purple"}
            >
              {SCOPE_META[it.sourceScope].tag}
            </Badge.Root>
            {typeof it.citation.score === "number" && (
              <span className="text-paragraph-xs text-text-soft-400">
                score {it.citation.score.toFixed(2)}
              </span>
            )}
            <span className="truncate text-paragraph-xs text-text-soft-400">
              {it.citation.provider}:{it.citation.assetId.slice(0, 14)}
            </span>
          </div>
        </article>
      ))}
    </section>
  );
}

/** Fail-closed panel for personal scope with no authenticated user. */
function PersonalSignInNeeded() {
  return (
    <div className="mt-8 flex items-start gap-3 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 px-4 py-4">
      <RiLockLine aria-hidden className="mt-0.5 size-5 shrink-0 text-text-sub-600" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-label-sm text-text-strong-950">Personal memory needs sign-in</p>
        <p className="text-paragraph-sm text-text-sub-600">
          Personal memory is private to your account. Sign in to browse, search,
          and correct it. Organization memory is available on the other tab.
        </p>
      </div>
    </div>
  );
}
