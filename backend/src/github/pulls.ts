import { resolveGithubCatalogAuth } from "./auth";
import { githubOrgAccessErrorForOrg, listRepos } from "./repos";

// ---------------------------------------------------------------------------
// Real open pull requests across the org's App/PAT-accessible repositories — the
// source for the /review page (replacing the old hard-coded PR + findings mock).
// Backend-only: the credential is resolved here and NEVER sent to React; the API
// returns just PR identities + links to GitHub. Same degrade-honestly contract as
// the repo listing: unconfigured → {configured:false}; a failed fetch →
// {configured:true, error}. A short cache keeps the page snappy; work is bounded
// (repos scanned + PRs returned are capped, and truncation is reported, never
// silent).
// ---------------------------------------------------------------------------

/** The minimal PR identity the review list needs. */
export interface PullInfo {
  /** Stable id: "owner/name#number". */
  id: string;
  /** "owner/name". */
  repo: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  author_avatar_url: string | null;
  /** The PR's page on GitHub (the row links here). */
  url: string;
  updated_at: string;
}

/** What GET /api/pulls returns. `configured:false` = feature dormant (no creds);
 *  `error` = configured but the fetch failed (still 200, empty list). `truncated`
 *  = more accessible repos exist than we scanned (reported, never hidden). */
export interface PullListing {
  configured: boolean;
  pulls: PullInfo[];
  error?: string;
  truncated?: boolean;
}

/** GitHub's PR shape (only the fields we read). */
interface GhPull {
  id: number;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
  updated_at: string;
  user: { login?: string; avatar_url?: string } | null;
}

const GITHUB_API = "https://api.github.com";
const PER_PAGE = 30; // open PRs per repo — most repos have few; bounded regardless
const MAX_REPOS_SCAN = 60; // cap the fan-out; more than this is reported truncated
const MAX_PULLS = 100; // cap the returned list after the global recency sort
const CONCURRENCY = 6; // simultaneous per-repo PR fetches
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000; // PR state moves faster than the repo set

const cache = new Map<string, { at: number; listing: PullListing }>();

function ghHeaders(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "useagent",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Open PRs for one repo (newest activity first, bounded). A per-repo failure
 *  yields [] so one bad repo can't sink the whole page. */
async function fetchRepoPulls(
  repo: string,
  token: string | null,
  signal: AbortSignal,
): Promise<PullInfo[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PER_PAGE}`,
    { headers: ghHeaders(token), signal },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const batch = (await res.json()) as GhPull[];
  if (!Array.isArray(batch)) return [];
  return batch.map((p) => ({
    id: `${repo}#${p.number}`,
    repo,
    number: p.number,
    title: p.title,
    state: p.state,
    draft: Boolean(p.draft),
    author: p.user?.login ?? "unknown",
    author_avatar_url: p.user?.avatar_url ?? null,
    url: p.html_url,
    updated_at: p.updated_at,
  }));
}

/** Run `work` over `items` with a fixed concurrency ceiling, collecting results
 *  (a thrown item contributes nothing). */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      try {
        out.push(...(await work(item)));
      } catch {
        // one repo's failure is not the page's failure
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * List open PRs across the accessible repos, cached ~60s. Never throws: an
 * unconfigured backend → {configured:false}; a failed resolve → {configured:true,
 * error}. Work is bounded (≤MAX_REPOS_SCAN repos, ≤MAX_PULLS returned); when more
 * repos exist than we scan, `truncated:true` says so.
 */
export async function listPulls(orgId: string): Promise<PullListing> {
  const accessError = await githubOrgAccessErrorForOrg(orgId);
  if (accessError) return { configured: true, pulls: [], error: accessError };
  const now = Date.now();
  const hit = cache.get(orgId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.listing;

  try {
    const repoListing = await listRepos(orgId);
    if (!repoListing.configured) {
      const listing: PullListing = { configured: false, pulls: [] };
      cache.set(orgId, { at: now, listing });
      return listing;
    }
    // A failed repo listing surfaces as an honest error rather than "no PRs".
    if (repoListing.error && repoListing.repos.length === 0) {
      const listing: PullListing = { configured: true, pulls: [], error: repoListing.error };
      cache.set(orgId, { at: now, listing });
      return listing;
    }

    const truncated = repoListing.repos.length > MAX_REPOS_SCAN;
    const scan = repoListing.repos.slice(0, MAX_REPOS_SCAN).map((r) => r.full_name);
    if (truncated) {
      console.warn(
        `[pulls] scanning ${MAX_REPOS_SCAN} of ${repoListing.repos.length} accessible repos (truncated)`,
      );
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let pulls: PullInfo[];
    try {
      const auth = await resolveGithubCatalogAuth(orgId);
      const all = await mapPool(scan, CONCURRENCY, (repo) =>
        fetchRepoPulls(repo, auth.token, ac.signal),
      );
      pulls = all
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, MAX_PULLS);
    } finally {
      clearTimeout(timer);
    }

    const listing: PullListing = { configured: true, pulls, ...(truncated ? { truncated } : {}) };
    cache.set(orgId, { at: now, listing });
    return listing;
  } catch (err) {
    const listing: PullListing = {
      configured: true,
      pulls: [],
      error: err instanceof Error ? err.message : "github fetch failed",
    };
    cache.set(orgId, { at: now, listing });
    return listing;
  }
}

/** Test/ops hook: drop the cache so the next list re-fetches. */
export function clearPullsCache(): void {
  cache.clear();
}
