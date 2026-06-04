"use client";

import { useEffect, useMemo, useState } from "react";
import { RiFolderLine, RiSearchLine } from "@remixicon/react";
import { CheckboxGlyph } from "@/components/base/checkbox/checkbox-glyph";
import {
  Dropdown,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { cx } from "@/utils/cx";

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
  /** Override the trigger styling (e.g. render as a full-width menu row). */
  triggerClassName?: string;
  /** Trigger label when nothing is selected (defaults to "Repositories"). */
  emptyLabel?: string;
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
 * multi-repo multi-select repository picker: a BoardUI dropdown with a
 * searchable, checkbox list of the org's real repos, sectioned into "Recent"
 * (recently picked, from localStorage) and "All repositories" grouped by org.
 * Selecting toggles a repo and keeps the popover open. The trigger shows the
 * count ("N selected"). Mirrors the composer's other pill triggers + panels.
 */
export function RepoMultiPicker({
  repos,
  value,
  onChange,
  triggerClassName,
  emptyLabel,
}: RepoMultiPickerProps) {
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

  const triggerLabel = value.length === 0 ? (emptyLabel ?? "Repositories") : `${value.length} selected`;

  const Row = ({ repo }: { repo: RepoItem }) => {
    const checked = selectedSet.has(repo.full_name);
    return (
      <DropdownItem onSelect={() => toggle(repo.full_name)} className="gap-2.5">
        <CheckboxGlyph
          state={{
            isSelected: checked,
            isIndeterminate: false,
            isFocusVisible: false,
            isDisabled: false,
            isHovered: false,
          }}
        />
        <RiFolderLine className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">
          {repo.name}
        </span>
      </DropdownItem>
    );
  };

  return (
    <Dropdown
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DropdownTrigger
        aria-label="Select repositories"
        className={cx(
          "inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-body-2-medium text-text-primary outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          triggerClassName,
        )}
      >
        <RiFolderLine className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="truncate">{triggerLabel}</span>
      </DropdownTrigger>
      <DropdownPopover
        aria-label="Select repositories"
        placement="bottom start"
        offset={6}
        className="w-[280px]"
      >
        <div className="-mx-2.5 -mt-1 mb-1 flex items-center gap-2 border-b border-border-button-default px-3 pb-2.5 pt-1">
          <RiSearchLine className="size-4 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search repositories..."
            aria-label="Search repositories"
            className="min-w-0 flex-1 bg-transparent text-body-2-medium text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <div className="flex max-h-[288px] flex-col gap-1.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-body-2-medium text-text-tertiary">
              {repos.length === 0 ? "No repositories available" : "No results"}
            </p>
          ) : (
            <>
              {recentItems.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-mono-label px-2 pt-1 text-text-tertiary">Recent</span>
                  {recentItems.map((repo) => (
                    <Row key={`recent-${repo.full_name}`} repo={repo} />
                  ))}
                </div>
              ) : null}
              {byOrg.map(([org, items]) => (
                <div key={org} className="flex flex-col gap-1">
                  <span className="text-mono-label px-2 pt-1 text-text-tertiary">{org}</span>
                  {items.map((repo) => (
                    <Row key={repo.full_name} repo={repo} />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </DropdownPopover>
    </Dropdown>
  );
}
