"use client";

// Git identity chips for thread rows + the session bar, following the T3 Code
// sidebar chip treatment (apps/web/src/components/LegacySidebar.tsx, upstream
// commit 7c1bdd6e1, MIT - T3 Tools Inc): a compact h-5 rounded-full bordered
// mono chip. Rebuilt on AlignUI tokens (stroke-soft border, text-soft tone, no
// color noise) and bound to OUR wire shape.
//
// Data contract (GET /api/runs run rows): `repo_specs` is authoritative - each
// entry is the clean "owner/name" plus the branch the sandbox actually clones
// (null = the repo's default branch), decoded server-side from the stored
// "owner/name:branch" refs. `repos` (clean names) and the legacy single `repo`
// are fallbacks for older payload shapes. All three are read defensively so a
// leaner run projection (e.g. an SSE upsert) simply renders no chips.

import { cn } from "@/utils/cn";

export interface GitRef {
  /** Clean "owner/name". */
  repo: string;
  /** Explicit branch, or null for the repo's default branch. */
  branch: string | null;
}

/** Extract the git identity of a run row: prefer `repo_specs` (repo + chosen
 * branch), fall back to `repos`, then the legacy single `repo`. Deduped by
 * repo; malformed entries are skipped. Takes any run-row shape - the chat
 * `ApiRun` does not declare these wire fields, so they are read as unknowns. */
export function runGitRefs(row: object): GitRef[] {
  const run = row as { repo?: unknown; repos?: unknown; repo_specs?: unknown };
  const refs: GitRef[] = [];
  const seen = new Set<string>();
  const push = (repo: unknown, branch: unknown) => {
    if (typeof repo !== "string" || repo.length === 0 || seen.has(repo)) return;
    seen.add(repo);
    refs.push({
      repo,
      branch: typeof branch === "string" && branch.length > 0 ? branch : null,
    });
  };
  if (Array.isArray(run.repo_specs)) {
    for (const spec of run.repo_specs) {
      if (spec && typeof spec === "object") {
        push((spec as { repo?: unknown }).repo, (spec as { branch?: unknown }).branch);
      }
    }
  }
  if (refs.length === 0 && Array.isArray(run.repos)) {
    for (const repo of run.repos) push(repo, null);
  }
  if (refs.length === 0) push(run.repo, null);
  return refs;
}

/** "owner/name" -> "name" (chips are compact; the title attr carries the full ref). */
export function repoShortname(repo: string): string {
  const i = repo.lastIndexOf("/");
  return i === -1 ? repo : repo.slice(i + 1);
}

/** Full ref for the title attr, in the git-native colon form. */
export function gitRefTitle(ref: GitRef): string {
  return ref.branch ? `${ref.repo}:${ref.branch}` : ref.repo;
}

/**
 * A truncating row of git identity chips: `name` on the default branch,
 * `name:branch` when one was chosen. Mono micro-label tone, stroke-soft
 * border, no color. Renders nothing for a bare-workdir run.
 */
export function GitChips({ refs, className }: { refs: GitRef[]; className?: string }) {
  if (refs.length === 0) return null;
  return (
    <span
      data-session-ui="git-chips"
      className={cn("flex min-w-0 items-center gap-1 overflow-hidden", className)}
    >
      {refs.map((ref) => (
        <span
          key={ref.repo}
          data-session-ui="git-chip"
          title={gitRefTitle(ref)}
          className="border-stroke-soft-200 text-text-soft-400 inline-flex h-5 min-w-0 shrink items-center rounded-full border px-1.5 font-mono text-[10px] font-medium tracking-tight"
        >
          <span className="truncate">
            {repoShortname(ref.repo)}
            {ref.branch ? `:${ref.branch}` : ""}
          </span>
        </span>
      ))}
    </span>
  );
}
