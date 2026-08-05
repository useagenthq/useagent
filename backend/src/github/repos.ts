import { githubConfig, type GithubConfig } from "../env";

// ---------------------------------------------------------------------------
// Real GitHub repository listing — the source for the New Task composer's repo
// picker (replacing the old hardcoded mock). Backend-only: the token is read
// here from env and NEVER sent to React; the API returns just the repo
// identities. A short in-memory cache keeps the picker snappy without hammering
// GitHub, and every failure degrades to an honest empty list rather than a 500.
// ---------------------------------------------------------------------------

/** The minimal repo identity the picker + run validation need. */
export interface RepoInfo {
  /** "owner/name" — the value persisted on the run and used to clone. */
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
}

/** What GET /api/repos returns. `configured:false` means no token AND no owner
 *  are set — the feature is dormant, not broken. `error` is set when configured
 *  but the fetch failed (still a 200 with an empty list — the UI stays usable). */
export interface RepoListing {
  configured: boolean;
  repos: RepoInfo[];
  error?: string;
}

/** GitHub's repo shape (only the fields we read). */
interface GhRepo {
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  archived?: boolean;
}

const GITHUB_API = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 3; // ≤300 repos — bounded; the picker is searchable, not a mirror
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60_000;

/** Process-global cache. The token/owner are process env (one identity), so a
 *  single entry keyed by the resolved scope is enough. */
let cache: { key: string; at: number; listing: RepoListing } | null = null;

function scopeKey(cfg: GithubConfig): string {
  return `${cfg.owner ?? ""}|${cfg.token ? "auth" : "anon"}`;
}

function ghHeaders(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skynet-a",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function toRepoInfo(r: GhRepo): RepoInfo {
  return {
    full_name: r.full_name,
    name: r.name,
    private: Boolean(r.private),
    default_branch: r.default_branch || "main",
  };
}

/** Fetch every page (bounded) of a repos endpoint, following the `page` param. */
async function fetchAllPages(
  base: string,
  token: string | null,
  signal: AbortSignal,
): Promise<GhRepo[]> {
  const out: GhRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = base.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${sep}per_page=${PER_PAGE}&page=${page}`, {
      headers: ghHeaders(token),
      signal,
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const batch = (await res.json()) as GhRepo[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PER_PAGE) break; // last page
  }
  return out;
}

/**
 * Resolve the org's repositories. Uncached probe:
 *  - `owner` set → GET /orgs/{owner}/repos, falling back to /users/{owner}/repos
 *    (we don't know upfront whether the owner is an org or a user);
 *  - no owner but a token → GET /user/repos (the token user's own + org repos).
 * Sorted newest-activity first (GitHub's `sort=updated`), archived repos dropped.
 */
async function fetchRepos(cfg: GithubConfig): Promise<RepoInfo[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    let raw: GhRepo[];
    if (cfg.owner) {
      const orgUrl = `${GITHUB_API}/orgs/${encodeURIComponent(cfg.owner)}/repos?sort=updated&type=all`;
      try {
        raw = await fetchAllPages(orgUrl, cfg.token, ac.signal);
      } catch {
        // Not an org (404) or org path unavailable — treat the owner as a user.
        const userUrl = `${GITHUB_API}/users/${encodeURIComponent(cfg.owner)}/repos?sort=updated&type=owner`;
        raw = await fetchAllPages(userUrl, cfg.token, ac.signal);
      }
    } else {
      // Token only: the authenticated user's repos across their orgs.
      raw = await fetchAllPages(
        `${GITHUB_API}/user/repos?sort=updated&affiliation=owner,organization_member`,
        cfg.token,
        ac.signal,
      );
    }
    return raw
      .filter((r) => !r.archived)
      .map(toRepoInfo)
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List repositories for the composer, cached ~5 min. Never throws: an
 * unconfigured backend returns `{configured:false, repos:[]}` and a failed fetch
 * returns `{configured:true, repos:[], error}` so the picker degrades to empty
 * rather than breaking the page.
 */
export async function listRepos(): Promise<RepoListing> {
  const cfg = githubConfig();
  const configured = Boolean(cfg.token || cfg.owner);
  if (!configured) return { configured: false, repos: [] };

  const key = scopeKey(cfg);
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) {
    return cache.listing;
  }

  try {
    const repos = await fetchRepos(cfg);
    const listing: RepoListing = { configured: true, repos };
    cache = { key, at: now, listing };
    return listing;
  } catch (err) {
    const listing: RepoListing = {
      configured: true,
      repos: [],
      error: err instanceof Error ? err.message : "github fetch failed",
    };
    // Cache the failure briefly too, so a hard-down GitHub doesn't get hammered
    // on every keystroke; the short TTL means it recovers within minutes.
    cache = { key, at: now, listing };
    return listing;
  }
}

/** `owner/name` shape check — cheap gate before the membership lookup. */
export function isValidRepoRef(ref: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ref);
}

/**
 * Validate a requested repo against the listed set (the run's repo must be one
 * the backend actually offers). Returns false when unconfigured — a repo can't
 * be accepted if the feature is off.
 */
export async function isKnownRepo(fullName: string): Promise<boolean> {
  if (!isValidRepoRef(fullName)) return false;
  const listing = await listRepos();
  if (!listing.configured) return false;
  return listing.repos.some((r) => r.full_name === fullName);
}

/** Test/ops hook: drop the cache so the next list re-fetches. */
export function clearRepoCache(): void {
  cache = null;
}
