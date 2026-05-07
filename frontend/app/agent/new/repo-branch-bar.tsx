"use client";

import { useEffect, useRef, useState } from "react";
import { RiGitBranchLine } from "@remixicon/react";
import { backendFetch } from "@/lib/backend-fetch";
import { SearchablePicker, type PickerGroup } from "./searchable-picker";
import type { RepoItem } from "./repo-multi-picker";

/**
 * Per-repo branch strip for the New Task composer. For each SELECTED repo it
 * renders a real branch picker fed by GET /api/repos/:owner/:name/branches
 * (backend resolves the GitHub credential; branches are the org's real refs).
 *
 * Honest by construction: until (or unless) the branch list loads, the only
 * option offered is the repo's own default branch, so the control never invents
 * branches. `value[full_name]` holds the chosen branch; an absent entry (or the
 * default) means "clone the default branch" and is dropped from the POST body.
 */
export function RepoBranchBar({
  repos,
  value,
  onChange,
}: {
  /** The currently selected repos (each carries its default_branch). */
  repos: RepoItem[];
  /** repo full_name -> chosen branch. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [branchesByRepo, setBranchesByRepo] = useState<Record<string, string[]>>({});
  // One fetch attempt per repo, ever — a failed/empty probe leaves the picker
  // default-only rather than retrying on every render.
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    for (const repo of repos) {
      if (attempted.current.has(repo.full_name)) continue;
      attempted.current.add(repo.full_name);
      void (async () => {
        try {
          const res = await backendFetch(`/api/repos/${repo.full_name}/branches`);
          if (!res.ok) return;
          const data = (await res.json()) as { branches?: string[] };
          if (cancelled || !Array.isArray(data.branches)) return;
          setBranchesByRepo((prev) => ({ ...prev, [repo.full_name]: data.branches ?? [] }));
        } catch {
          // network/backend down — the picker stays default-branch only
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [repos]);

  if (repos.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {repos.map((repo) => {
        const fetched = branchesByRepo[repo.full_name] ?? [];
        // Default branch always present + first; the rest follow (deduped).
        const names = [
          repo.default_branch,
          ...fetched.filter((b) => b !== repo.default_branch),
        ];
        const groups: PickerGroup[] = [
          {
            label: repo.name,
            options: names.map((n) => ({
              value: n,
              label: n,
              icon: RiGitBranchLine,
              mono: true,
            })),
          },
        ];
        const selected = value[repo.full_name] ?? repo.default_branch;
        return (
          <div
            key={repo.full_name}
            className="inline-flex items-center gap-1 rounded-xl border border-stroke-soft-200 py-1 pl-2 pr-1"
          >
            <span className="max-w-[120px] truncate text-paragraph-xs text-text-soft-400">
              {repo.name}
            </span>
            <SearchablePicker
              ariaLabel={`Branch for ${repo.name}`}
              triggerLabel={repo.default_branch}
              searchPlaceholder="Search branches..."
              groups={groups}
              value={selected}
              onChange={(branch) => onChange({ ...value, [repo.full_name]: branch })}
            />
          </div>
        );
      })}
    </div>
  );
}
