"use client";

import { useEffect, useMemo, useState } from "react";
import { RiCheckLine, RiFolderLine, RiSearchLine } from "@remixicon/react";
import * as Popover from "@/components/ui/popover";
import { cnExt } from "@/utils/cn";

export interface RepoItem {
  full_name: string; // "owner/name" — the value sent + validated
  name: string;
  private?: boolean;
  /** The repo's default branch — the branch picker falls back to this. */
  default_branch: string;
}

export interface RepoMultiPickerProps {
  repos: RepoItem[];
  /** Selected full_names. */
  value: string[];
  onChange: (next: string[]) => void;
}

const RECENTS_KEY = "skynet:recent-repos";
const RECENTS_MAX = 5;

function readRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * multi-repo multi-select repository picker: a popover with a searchable,
 * checkbox list of the org's real repos, sectioned into "Recent" (recently
 * picked, from localStorage) and "All repositories" grouped by org. Selecting
 * toggles a repo and keeps the popover open. The trigger shows the count
 * ("N selected"). Mirrors the composer's other pill triggers + popover shell.
 */
export function RepoMultiPicker({ repos, value, onChange }: RepoMultiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    setRecents(readRecents());
  }, []);

  const selectedSet = useMemo(() => new Set(value), [value]);

  function toggle(fullName: string) {
    const next = selectedSet.has(fullName)
      ? value.filter((r) => r !== fullName)
      : [...value, fullName];
    onChange(next);
    // Record a newly-added repo as "recent" (dedupe, newest first, capped).
    if (!selectedSet.has(fullName)) {
      const nextRecents = [fullName, ...recents.filter((r) => r !== fullName)].slice(0, RECENTS_MAX);
      setRecents(nextRecents);
      try {
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(nextRecents));
      } catch {
        /* private mode / storage full — recents are best-effort */
      }
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || r.full_name.toLowerCase().includes(q),
    );
  }, [repos, query]);

  // "Recent" section: recently-picked repos that still exist + match the search.
  const recentItems = useMemo(() => {
    const inFiltered = new Map(filtered.map((r) => [r.full_name, r]));
    return recents.map((fn) => inFiltered.get(fn)).filter((r): r is RepoItem => Boolean(r));
  }, [recents, filtered]);

  // "All repositories" grouped by org (owner), preserving encounter order.
  const byOrg = useMemo(() => {
    const groups = new Map<string, RepoItem[]>();
    for (const r of filtered) {
      const org = r.full_name.split("/")[0] || "repositories";
      const list = groups.get(org);
      if (list) list.push(r);
      else groups.set(org, [r]);
    }
    return [...groups.entries()];
  }, [filtered]);

  const triggerLabel = value.length === 0 ? "Repositories" : `${value.length} selected`;

  const Row = ({ repo }: { repo: RepoItem }) => {
    const checked = selectedSet.has(repo.full_name);
    return (
      <button
        type="button"
        onClick={() => toggle(repo.full_name)}
        className="flex items-center gap-2.5 rounded-lg p-2 text-left outline-none transition-colors hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50"
      >
        <span
          className={cnExt(
            "flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors",
            checked ? "border-primary-base bg-primary-base" : "border-stroke-sub-300 bg-bg-white-0",
          )}
        >
          {checked ? <RiCheckLine className="size-3.5 text-text-white-0" aria-hidden /> : null}
        </span>
        <RiFolderLine className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">
          {repo.name}
        </span>
      </button>
    );
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Select repositories"
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-label-sm text-text-strong-950 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
        >
          <RiFolderLine className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
          <span className="truncate">{triggerLabel}</span>
        </button>
      </Popover.Trigger>
      <Popover.Content
        unstyled
        showArrow={false}
        align="start"
        sideOffset={6}
        className="w-[280px] overflow-hidden rounded-2xl bg-bg-white-0 p-2.5 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200"
      >
        <div className="-mx-2.5 -mt-2.5 mb-1 flex items-center gap-2 border-b border-stroke-soft-200 px-3 pb-2 pt-1">
          <RiSearchLine className="size-4 shrink-0 text-text-soft-400" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search repositories..."
            aria-label="Search repositories"
            className="min-w-0 flex-1 bg-transparent text-label-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
          />
        </div>
        <div className="flex max-h-[288px] flex-col gap-1.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-label-sm text-text-soft-400">
              {repos.length === 0 ? "No repositories available" : "No results"}
            </p>
          ) : (
            <>
              {recentItems.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-mono-label px-2 pt-1 text-text-soft-400">Recent</span>
                  {recentItems.map((repo) => (
                    <Row key={`recent-${repo.full_name}`} repo={repo} />
                  ))}
                </div>
              ) : null}
              {byOrg.map(([org, items]) => (
                <div key={org} className="flex flex-col gap-1">
                  <span className="text-mono-label px-2 pt-1 text-text-soft-400">{org}</span>
                  {items.map((repo) => (
                    <Row key={repo.full_name} repo={repo} />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
