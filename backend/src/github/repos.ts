import { githubConfigured, githubTenantOrgId } from "../env";
import {
  resolveGithubCatalogAuth,
  type GithubAuth,
  type GithubRepositoryAccess,
} from "./auth";
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
  /** Stable provider repository id; survives rename and transfer. */
  external_id?: string;
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

export interface GithubCatalogListing extends RepoListing {
  /** Internal connection identity. Never returned by the public repos route. */
  connectionId: string | null;
  /** True only when GitHub reported that no further repository page exists. */
  complete: boolean;
  /** Opaque provider continuation used only by the internal resource catalog. */
  nextCursor: string | null;
}

/** GitHub's repo shape (only the fields we read). */
interface GhRepo {
  id?: number;
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
const cache = new Map<string, { at: number; listing: GithubCatalogListing }>();

/** Cache key from product tenant + sync config only — never mints a token. The
 *  App path's rotating installation token does not change the scope, so it is
 *  intentionally absent from the key. */
function scopeKey(orgId: string, auth: GithubAuth): string {
  return `${orgId}|${auth.connectionId ?? "legacy"}|${auth.owner ?? ""}|${auth.source}`;
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
    external_id: Number.isSafeInteger(r.id) && (r.id ?? 0) > 0
      ? String(r.id)
      : undefined,
    full_name: r.full_name,
    name: r.name,
    private: Boolean(r.private),
    default_branch: r.default_branch || "main",
  };
}

interface GithubPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
}

function nextPageCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (!match || match[2] !== "next") continue;
    const page = new URL(match[1] as string).searchParams.get("page");
    if (page && /^[1-9]\d*$/.test(page)) return page;
  }
  return null;
}

function githubPageNumber(cursor: string | null): number {
  if (!cursor) return 1;
  const page = Number(cursor);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("GitHub cursor is invalid");
  return page;
}

/** Fetch a bounded window from a repos endpoint while preserving GitHub's
 * continuation cursor for the next request. */
async function fetchAllPages(
  base: string,
  token: string | null,
  signal: AbortSignal,
  cursor: string | null,
  maxPages: number,
): Promise<GithubPage<GhRepo>> {
  const out: GhRepo[] = [];
  let pageCursor = cursor;
  let nextCursor: string | null = cursor;
  for (let fetched = 0; fetched < maxPages; fetched++) {
    const page = githubPageNumber(pageCursor);
    const sep = base.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${sep}per_page=${PER_PAGE}&page=${page}`, {
      headers: ghHeaders(token),
      signal,
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const batch = (await res.json()) as GhRepo[];
    if (!Array.isArray(batch) || batch.length === 0) {
      return { items: out, nextCursor: null, complete: true };
    }
    out.push(...batch);
    nextCursor = nextPageCursor(res.headers.get("link"));
    if (!nextCursor) return { items: out, nextCursor: null, complete: true };
    pageCursor = nextCursor;
  }
  return { items: out, nextCursor, complete: false };
}

/**
 * GET /installation/repositories — exactly the repos a GitHub App installation
 * can access (private + public). Its payload is wrapped (`{repositories:[...]}`)
 * rather than a bare array, so it needs its own pager.
 */
async function fetchInstallationRepos(
  token: string,
  signal: AbortSignal,
  cursor: string | null,
  maxPages: number,
): Promise<GithubPage<GhRepo>> {
  const out: GhRepo[] = [];
  let pageCursor = cursor;
  let nextCursor: string | null = cursor;
  for (let fetched = 0; fetched < maxPages; fetched++) {
    const page = githubPageNumber(pageCursor);
    const res = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      { headers: ghHeaders(token), signal },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const body = (await res.json()) as { repositories?: GhRepo[] };
    const batch = body.repositories ?? [];
    if (batch.length === 0) return { items: out, nextCursor: null, complete: true };
    out.push(...batch);
    nextCursor = nextPageCursor(res.headers.get("link"));
    if (!nextCursor) return { items: out, nextCursor: null, complete: true };
    pageCursor = nextCursor;
  }
  return { items: out, nextCursor, complete: false };
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
async function fetchRepos(
  auth: GithubAuth,
  cursor: string | null,
  maxPages: number,
): Promise<GithubPage<RepoInfo>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    let page: GithubPage<GhRepo>;
    if (auth.source === "app") {
      // The installation token already scopes the result to the org's repos.
      page = await fetchInstallationRepos(auth.token as string, ac.signal, cursor, maxPages);
    } else if (auth.owner) {
      const orgUrl = `${GITHUB_API}/orgs/${encodeURIComponent(auth.owner)}/repos?sort=updated&type=all`;
      try {
        page = await fetchAllPages(orgUrl, auth.token, ac.signal, cursor, maxPages);
      } catch {
        // Not an org (404) or org path unavailable — treat the owner as a user.
        const userUrl = `${GITHUB_API}/users/${encodeURIComponent(auth.owner)}/repos?sort=updated&type=owner`;
        page = await fetchAllPages(userUrl, auth.token, ac.signal, cursor, maxPages);
      }
    } else {
      // Token only: the authenticated user's repos across their orgs.
      page = await fetchAllPages(
        `${GITHUB_API}/user/repos?sort=updated&affiliation=owner,organization_member`,
        auth.token,
        ac.signal,
        cursor,
        maxPages,
      );
    }
    return {
      items: page.items
        .filter((r) => !r.archived)
        .map(toRepoInfo)
        .toSorted((a, b) => a.full_name.localeCompare(b.full_name)),
      nextCursor: page.nextCursor,
      complete: page.complete,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List a bounded repository window, cached ~5 min. The resource catalog follows
 * `nextCursor` until GitHub reports completion; the public picker intentionally
 * requests only its existing first three pages. Never throws: failures remain
 * explicit in the listing so callers can degrade without leaking credentials.
 */
async function listGithubCatalogWithAuth(
  orgId: string,
  auth: GithubAuth,
  cursor: string | null,
  maxPages: number,
): Promise<GithubCatalogListing> {
  const now = Date.now();
  const key = `${scopeKey(orgId, auth)}|${cursor ?? "start"}|${maxPages}`;
  try {
    if (!auth.token && !auth.owner) {
      return {
        configured: false,
        repos: [],
        connectionId: auth.connectionId ?? null,
        complete: true,
        nextCursor: null,
      };
    }
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return { ...hit.listing, connectionId: auth.connectionId ?? null };
    }
    const page = await fetchRepos(auth, cursor, maxPages);
    const listing: GithubCatalogListing = {
      configured: true,
      repos: page.items,
      connectionId: auth.connectionId ?? null,
      complete: page.complete,
      nextCursor: page.nextCursor,
    };
    cache.set(key, { at: now, listing });
    return listing;
  } catch (err) {
    const listing: GithubCatalogListing = {
      configured: true,
      repos: [],
      error: err instanceof Error ? err.message : "github fetch failed",
      connectionId: null,
      complete: false,
      nextCursor: cursor,
    };
    // Cache the failure briefly too, so a hard-down GitHub doesn't get hammered
    // on every keystroke; the short TTL means it recovers within minutes.
    cache.set(key, { at: now, listing });
    return listing;
  }
}

export async function listGithubCatalog(
  orgId: string,
  options: { readonly cursor?: string | null; readonly maxPages?: number } = {},
): Promise<GithubCatalogListing> {
  const cursor = options.cursor ?? null;
  const maxPages = options.maxPages ?? MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new Error(`maxPages must be between 1 and ${MAX_PAGES}`);
  }
  try {
    return await listGithubCatalogWithAuth(
      orgId,
      await resolveGithubCatalogAuth(orgId),
      cursor,
      maxPages,
    );
  } catch (err) {
    return {
      configured: true,
      repos: [],
      error: err instanceof Error ? err.message : "github fetch failed",
      connectionId: null,
      complete: false,
      nextCursor: cursor,
    };
  }
}

/** List repositories with an already-resolved tenant access object. Background
 * jobs use this so list/head/clone/read share one connection and revocation can
 * never trigger a later fallback to deployment credentials. */
export async function listReposWithAccess(
  access: GithubRepositoryAccess,
): Promise<RepoListing> {
  const {
    connectionId: _connectionId,
    complete: _complete,
    nextCursor: _nextCursor,
    ...listing
  } = await listGithubCatalogWithAuth(access.orgId, access, null, MAX_PAGES);
  return {
    ...listing,
    repos: listing.repos.map(({ external_id: _externalId, ...repo }) => repo),
  };
}

export async function listRepos(orgId: string): Promise<RepoListing> {
  const {
    connectionId: _connectionId,
    complete: _complete,
    nextCursor: _nextCursor,
    ...listing
  } = await listGithubCatalog(orgId);
  return {
    ...listing,
    repos: listing.repos.map(({ external_id: _externalId, ...repo }) => repo),
  };
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
