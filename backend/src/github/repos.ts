import { githubConfigured, githubTenantOrgId } from "../env";
import { resolveGithubCatalogAuth, type GithubAuth } from "./auth";
import {
  findConnectedOrgIntegrationRecord,
  findLatestOrgIntegrationRecord,
} from "../integrations/connection-repo";
import {
  GITHUB_NATIVE_RUNTIME_BINDING_ID,
  githubNativeConnectionConfigFromEnv,
} from "../integrations/github-native-backend";

// ---------------------------------------------------------------------------
// Real GitHub repository listing — the source for the New Task composer's repo
// picker (replacing the old hardcoded mock). Backend-only: the credential is
// resolved here (PAT, GitHub App installation token, or anonymous) and NEVER
// sent to React; the API returns just the repo identities. A short in-memory
// cache keeps the picker snappy without hammering GitHub, and every failure
// degrades to an honest empty list rather than a 500.
// ---------------------------------------------------------------------------

/** The minimal repo identity the picker + run validation need. */
export interface RepoInfo {
  /** "owner/name" — the value persisted on the run and used to clone. */
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
}

/** What GET /api/repos returns. `configured:false` means no PAT, no GitHub App,
 *  and no owner are set — the feature is dormant, not broken. `error` is set when
 *  configured but the fetch failed (still a 200 with an empty list — the UI stays
 *  usable). */
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

/** Repository listings are isolated by the product org that owns the shared
 *  credential. There is currently one configured tenant, but keeping separate
 *  entries prevents an unauthorized request from ever reading or poisoning an
 *  authorized tenant's cached result. */
const cache = new Map<string, { at: number; listing: RepoListing }>();

/** Cache key from product tenant + sync config only — never mints a token. The
 *  App path's rotating installation token does not change the scope, so it is
 *  intentionally absent from the key. */
function scopeKey(orgId: string, auth: GithubAuth): string {
  return `${orgId}|${auth.owner ?? ""}|${auth.source}`;
}

/** Legacy deployment-wide credential ownership check. Tenant GitHub App
 * connections use {@link githubOrgAccessErrorForOrg} instead. */
export function githubOrgAccessError(orgId: string): string | null {
  const tenantOrgId = githubTenantOrgId();
  if (!tenantOrgId) {
    return (
      "GitHub is connected but not assigned to a product organization; set " +
      "GITHUB_TENANT_ORG_ID to the owning organization id and retry"
    );
  }
  if (orgId !== tenantOrgId) {
    return "GitHub repository access is not available to this organization";
  }
  return null;
}

/** Accept an org-owned customer App installation before consulting the legacy
 * deployment-wide credential boundary. */
export async function githubOrgAccessErrorForOrg(orgId: string): Promise<string | null> {
  const tenant = await findConnectedOrgIntegrationRecord({
    orgId,
    provider: "github",
    runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
  });
  if (tenant) {
    return githubNativeConnectionConfigFromEnv()
      ? null
      : "GitHub tenant integration backend is unavailable";
  }
  const latest = await findLatestOrgIntegrationRecord({
    orgId,
    provider: "github",
    runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
  });
  if (latest?.status === "revoked") {
    return "GitHub integration has been revoked for this organization";
  }
  return githubConfigured() || process.env.GITHUB_TENANT_ORG_ID?.trim()
    ? githubOrgAccessError(orgId)
    : null;
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
 * GET /installation/repositories — exactly the repos a GitHub App installation
 * can access (private + public). Its payload is wrapped (`{repositories:[...]}`)
 * rather than a bare array, so it needs its own pager.
 */
async function fetchInstallationRepos(
  token: string,
  signal: AbortSignal,
): Promise<GhRepo[]> {
  const out: GhRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      { headers: ghHeaders(token), signal },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const body = (await res.json()) as { repositories?: GhRepo[] };
    const batch = body.repositories ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PER_PAGE) break; // last page
  }
  return out;
}

/**
 * Resolve the org's repositories from the resolved auth. Uncached probe:
 *  - App installation token → GET /installation/repositories (private + public
 *    repos the App is installed on);
 *  - `owner` set → GET /orgs/{owner}/repos, falling back to /users/{owner}/repos
 *    (we don't know upfront whether the owner is an org or a user);
 *  - no owner but a token → GET /user/repos (the token user's own + org repos).
 * Sorted newest-activity first (GitHub's `sort=updated`), archived repos dropped.
 */
async function fetchRepos(auth: GithubAuth): Promise<RepoInfo[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    let raw: GhRepo[];
    if (auth.source === "app") {
      // The installation token already scopes the result to the org's repos.
      raw = await fetchInstallationRepos(auth.token as string, ac.signal);
    } else if (auth.owner) {
      const orgUrl = `${GITHUB_API}/orgs/${encodeURIComponent(auth.owner)}/repos?sort=updated&type=all`;
      try {
        raw = await fetchAllPages(orgUrl, auth.token, ac.signal);
      } catch {
        // Not an org (404) or org path unavailable — treat the owner as a user.
        const userUrl = `${GITHUB_API}/users/${encodeURIComponent(auth.owner)}/repos?sort=updated&type=owner`;
        raw = await fetchAllPages(userUrl, auth.token, ac.signal);
      }
    } else {
      // Token only: the authenticated user's repos across their orgs.
      raw = await fetchAllPages(
        `${GITHUB_API}/user/repos?sort=updated&affiliation=owner,organization_member`,
        auth.token,
        ac.signal,
      );
    }
    return raw
      .filter((r) => !r.archived)
      .map(toRepoInfo)
      .toSorted((a, b) => a.full_name.localeCompare(b.full_name));
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
export async function listRepos(orgId: string): Promise<RepoListing> {
  const now = Date.now();
  let key: string | null = null;
  try {
    const auth = await resolveGithubCatalogAuth(orgId);
    if (!auth.token && !auth.owner) return { configured: false, repos: [] };
    key = scopeKey(orgId, auth);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.listing;
    const repos = await fetchRepos(auth);
    const listing: RepoListing = { configured: true, repos };
    if (key) cache.set(key, { at: now, listing });
    return listing;
  } catch (err) {
    const listing: RepoListing = {
      configured: true,
      repos: [],
      error: err instanceof Error ? err.message : "github fetch failed",
    };
    // Cache the failure briefly too, so a hard-down GitHub doesn't get hammered
    // on every keystroke; the short TTL means it recovers within minutes.
    if (key) cache.set(key, { at: now, listing });
    return listing;
  }
}

// ---------------------------------------------------------------------------
// Branch listing — the source for the New Task composer's per-repo branch picker.
// Same auth + degrade-honestly contract as the repo listing: unconfigured →
// {configured:false}, configured-but-failed → {configured:true, error}. Scoped to
// the repos we actually offer (a branch probe for an unknown repo is refused), so
// it can't be used to proxy arbitrary repos.
// ---------------------------------------------------------------------------

/** GitHub's branch shape (only the fields we read). */
interface GhBranch {
  name: string;
  protected?: boolean;
}

/** What GET /api/repos/:owner/:name/branches returns. `default_branch` is echoed
 *  from the repo listing so the picker can mark/prefer it without a second call. */
export interface BranchListing {
  configured: boolean;
  branches: string[];
  default_branch?: string;
  error?: string;
}

/** Branch cache keyed by `scope|full_name` (one identity per process). */
const branchCache = new Map<string, { at: number; listing: BranchListing }>();

/** Fetch up to one page (cap 100) of a repo's branches, name-sorted so the
 *  picker order is stable. */
async function fetchBranches(fullName: string, token: string | null): Promise<string[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${fullName}/branches?per_page=${PER_PAGE}`,
      { headers: ghHeaders(token), signal: ac.signal },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const batch = (await res.json()) as GhBranch[];
    if (!Array.isArray(batch)) return [];
    return batch
      .map((b) => b.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .toSorted((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List branches for one of the org's repos, cached ~5 min. Never throws: an
 * unconfigured backend → {configured:false}; an unknown repo (not in the offered
 * set) → {configured, error}; a failed fetch → {configured:true, error}. The UI
 * degrades to the repo's default branch on anything but a clean list.
 */
export async function listBranches(
  fullName: string,
  orgId: string,
): Promise<BranchListing> {
  const listing = await listRepos(orgId);
  if (!listing.configured) return { configured: false, branches: [] };
  if (!isValidRepoRef(fullName)) {
    return { configured: true, branches: [], error: "invalid repo reference" };
  }

  // Only branches for a repo we actually offer — this scopes the proxy AND gives
  // us the default_branch to echo back.
  const known = listing.repos.find((r) => r.full_name === fullName);
  if (!known) {
    return {
      configured: listing.configured,
      branches: [],
      error: listing.error ?? "repository not available",
    };
  }

  let auth: GithubAuth;
  try {
    auth = await resolveGithubCatalogAuth(orgId);
  } catch (error) {
    return {
      configured: true,
      branches: [],
      default_branch: known.default_branch,
      error: error instanceof Error ? error.message : "github auth failed",
    };
  }
  const key = `${scopeKey(orgId, auth)}|${fullName}`;
  const now = Date.now();
  const hit = branchCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.listing;

  try {
    const branches = await fetchBranches(fullName, auth.token);
    const result: BranchListing = {
      configured: true,
      branches,
      default_branch: known.default_branch,
    };
    branchCache.set(key, { at: now, listing: result });
    return result;
  } catch (err) {
    const result: BranchListing = {
      configured: true,
      branches: [],
      default_branch: known.default_branch,
      error: err instanceof Error ? err.message : "github fetch failed",
    };
    branchCache.set(key, { at: now, listing: result });
    return result;
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
export async function isKnownRepo(
  fullName: string,
  orgId: string,
): Promise<boolean> {
  if (!isValidRepoRef(fullName)) return false;
  const listing = await listRepos(orgId);
  if (!listing.configured) return false;
  return listing.repos.some((r) => r.full_name === fullName);
}

/**
 * Return the subset of `refs` that the backend does NOT offer (malformed or not
 * in the listed set). Empty result → every ref is valid. One cached listing
 * lookup for the whole batch. When unconfigured, everything is "unknown" — a
 * repo can't be accepted if the feature is off.
 */
export async function unknownRepos(
  refs: string[],
  orgId: string,
): Promise<string[]> {
  const listing = await listRepos(orgId);
  if (!listing.configured) return [...refs];
  const known = new Set(listing.repos.map((r) => r.full_name));
  return refs.filter((r) => !isValidRepoRef(r) || !known.has(r));
}

/** Test/ops hook: drop the repo + branch caches so the next list re-fetches. */
export function clearRepoCache(): void {
  cache.clear();
  branchCache.clear();
}
