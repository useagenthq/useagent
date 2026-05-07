import { githubConfigured } from "../env";
import { resolveGithubAuth } from "./auth";

// ---------------------------------------------------------------------------
// GitHub skill discovery (multi-repo "import Skills from a repo"). Given an
// `owner/name` repo, walk the default branch's tree (recursive) for any
// `**/SKILL.md` file and read the ones within the size cap. This is pure GitHub
// I/O: it returns the raw file text + the HEAD commit the read was pinned to;
// turning that text into a versioned skill (frontmatter parse, revisions) lives
// in src/skills/import.ts. Auth is resolved through src/github/auth.ts, so the
// same PAT > App > anon precedence and installation-token minting the repo
// listing uses applies here — the credential never leaves the backend.
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 8_000;
/** SKILL.md files above this are skipped, never imported (guards against a huge
 *  file blowing up a revision row / the injected context). */
export const MAX_SKILL_BYTES = 64 * 1024;
/** Upper bound on how many SKILL.md files one scan reads — a repo with more is
 *  reported `truncated` rather than fanning out an unbounded number of blob GETs. */
const MAX_CANDIDATES = 100;

/** One discovered SKILL.md. `text` is null when the file is over the size cap
 *  (still surfaced so the caller can report the skip honestly). */
export interface DiscoveredSkillFile {
  path: string;
  sizeBytes: number;
  text: string | null;
}

/** The result of scanning a repo: every SKILL.md found on the default branch,
 *  pinned to the commit `commitSha`. `truncated` means the tree or the candidate
 *  set was cut off, so the list may be incomplete. */
export interface DiscoverResult {
  commitSha: string;
  files: DiscoveredSkillFile[];
  truncated: boolean;
}

/** A single file fetched at a pinned commit for import. `tooLarge` marks a file
 *  that exists but exceeds the cap; null means the path is not a readable file. */
export type FetchedSkillFile =
  | { path: string; sizeBytes: number; text: string }
  | { path: string; sizeBytes: number; text: null; tooLarge: true };

/** A discovery failure with a routing hint so the HTTP layer maps it to the
 *  right status: a bad ref / unconfigured backend is the client's problem (400),
 *  a GitHub error is upstream (502). */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly kind: "bad_request" | "not_configured" | "upstream",
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/** `owner/name` shape check + split (same char class the repo picker validates). */
export function parseRepoRef(repo: string): { owner: string; name: string } | null {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  const [owner, name] = repo.split("/");
  return owner && name ? { owner, name } : null;
}

/** Is this tree path a SKILL.md (case-insensitive filename, any directory)? */
function isSkillPath(path: string): boolean {
  return (path.split("/").pop() ?? "").toLowerCase() === "skill.md";
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

/** GET with a bounded timeout. A non-2xx is an upstream DiscoveryError naming the
 *  endpoint + status; a 404 is treated specially by callers that need it. */
async function ghGet(url: string, token: string | null): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: ghHeaders(token), signal: ac.signal });
  } catch (err) {
    throw new DiscoveryError(
      `GitHub request failed: ${err instanceof Error ? err.message : "network error"}`,
      "upstream",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the configured GitHub bearer token, or throw a not_configured error
 *  (the feature is dormant, not broken, when no creds are set). */
async function resolveToken(): Promise<string | null> {
  if (!githubConfigured()) {
    throw new DiscoveryError(
      "GitHub is not configured; set a PAT or install the GitHub App.",
      "not_configured",
    );
  }
  return (await resolveGithubAuth()).token;
}

interface RepoHead {
  defaultBranch: string;
  commitSha: string;
  treeSha: string;
}

/** Resolve the default branch and its HEAD commit + tree sha. */
async function resolveRepoHead(
  owner: string,
  name: string,
  token: string | null,
): Promise<RepoHead> {
  const repoRes = await ghGet(`${GITHUB_API}/repos/${owner}/${name}`, token);
  if (!repoRes.ok) {
    throw new DiscoveryError(
      `GitHub repo lookup failed for ${owner}/${name}: HTTP ${repoRes.status}`,
      repoRes.status === 404 ? "bad_request" : "upstream",
    );
  }
  const repo = (await repoRes.json()) as { default_branch?: string };
  const defaultBranch = repo.default_branch || "main";

  const commitRes = await ghGet(
    `${GITHUB_API}/repos/${owner}/${name}/commits/${encodeURIComponent(defaultBranch)}`,
    token,
  );
  if (!commitRes.ok) {
    throw new DiscoveryError(
      `GitHub HEAD lookup failed for ${owner}/${name}@${defaultBranch}: HTTP ${commitRes.status}`,
      "upstream",
    );
  }
  const commit = (await commitRes.json()) as {
    sha?: string;
    commit?: { tree?: { sha?: string } };
  };
  if (!commit.sha || !commit.commit?.tree?.sha) {
    throw new DiscoveryError(
      `GitHub HEAD response for ${owner}/${name} missing commit/tree sha`,
      "upstream",
    );
  }
  return { defaultBranch, commitSha: commit.sha, treeSha: commit.commit.tree.sha };
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

/** GET the recursive tree for a tree sha. */
async function fetchTree(
  owner: string,
  name: string,
  treeSha: string,
  token: string | null,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const res = await ghGet(
    `${GITHUB_API}/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`,
    token,
  );
  if (!res.ok) {
    throw new DiscoveryError(
      `GitHub tree lookup failed for ${owner}/${name}: HTTP ${res.status}`,
      "upstream",
    );
  }
  const body = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean };
  return { entries: body.tree ?? [], truncated: Boolean(body.truncated) };
}

/** Read one blob by sha and decode its (base64) content to UTF-8 text. */
async function fetchBlobText(
  owner: string,
  name: string,
  sha: string,
  token: string | null,
): Promise<string> {
  const res = await ghGet(`${GITHUB_API}/repos/${owner}/${name}/git/blobs/${sha}`, token);
  if (!res.ok) {
    throw new DiscoveryError(
      `GitHub blob read failed for ${owner}/${name}@${sha}: HTTP ${res.status}`,
      "upstream",
    );
  }
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (body.encoding !== "base64" || typeof body.content !== "string") {
    throw new DiscoveryError(
      `GitHub blob ${sha} for ${owner}/${name} has unexpected encoding "${body.encoding}"`,
      "upstream",
    );
  }
  return Buffer.from(body.content, "base64").toString("utf8");
}

/**
 * Scan a repo for SKILL.md files on its default branch. Reads the text of every
 * file within the size cap (oversize ones come back with `text: null` so the
 * caller can skip + report them). Throws a {@link DiscoveryError} on a bad ref,
 * an unconfigured backend, or a GitHub failure.
 */
export async function discoverSkillFiles(repo: string): Promise<DiscoverResult> {
  const ref = parseRepoRef(repo);
  if (!ref) throw new DiscoveryError(`invalid repo ref "${repo}"`, "bad_request");
  const token = await resolveToken();

  const head = await resolveRepoHead(ref.owner, ref.name, token);
  const tree = await fetchTree(ref.owner, ref.name, head.treeSha, token);

  const skillEntries = tree.entries
    .filter((e) => e.type === "blob" && isSkillPath(e.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const truncated = tree.truncated || skillEntries.length > MAX_CANDIDATES;
  const chosen = skillEntries.slice(0, MAX_CANDIDATES);

  const files = await Promise.all(
    chosen.map(async (e): Promise<DiscoveredSkillFile> => {
      const sizeBytes = e.size ?? 0;
      if (sizeBytes > MAX_SKILL_BYTES) return { path: e.path, sizeBytes, text: null };
      const text = await fetchBlobText(ref.owner, ref.name, e.sha, token);
      return { path: e.path, sizeBytes, text };
    }),
  );
  return { commitSha: head.commitSha, files, truncated };
}

/** Resolve just the HEAD commit sha of a repo's default branch (import pins to it). */
export async function resolveRepoHeadSha(repo: string): Promise<string> {
  const ref = parseRepoRef(repo);
  if (!ref) throw new DiscoveryError(`invalid repo ref "${repo}"`, "bad_request");
  const token = await resolveToken();
  return (await resolveRepoHead(ref.owner, ref.name, token)).commitSha;
}

/**
 * Fetch one SKILL.md at a pinned commit (import path — "read the content at HEAD
 * sha"). Returns the decoded text, a `tooLarge` marker when it exceeds the cap,
 * or null when the path is not a readable file at that commit. Rejects a path
 * that is not a SKILL.md up front (fail closed).
 */
export async function fetchSkillFileAtCommit(
  repo: string,
  path: string,
  commitSha: string,
): Promise<FetchedSkillFile | null> {
  const ref = parseRepoRef(repo);
  if (!ref) throw new DiscoveryError(`invalid repo ref "${repo}"`, "bad_request");
  if (!isSkillPath(path)) return null;
  const token = await resolveToken();

  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await ghGet(
    `${GITHUB_API}/repos/${ref.owner}/${ref.name}/contents/${encodedPath}?ref=${commitSha}`,
    token,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new DiscoveryError(
      `GitHub contents read failed for ${repo}/${path}@${commitSha}: HTTP ${res.status}`,
      "upstream",
    );
  }
  const body = (await res.json()) as {
    type?: string;
    size?: number;
    content?: string;
    encoding?: string;
  };
  if (body.type !== "file") return null;
  const sizeBytes = body.size ?? 0;
  if (sizeBytes > MAX_SKILL_BYTES) {
    return { path, sizeBytes, text: null, tooLarge: true };
  }
  if (body.encoding !== "base64" || typeof body.content !== "string") {
    throw new DiscoveryError(
      `GitHub contents ${repo}/${path} has unexpected encoding "${body.encoding}"`,
      "upstream",
    );
  }
  return { path, sizeBytes, text: Buffer.from(body.content, "base64").toString("utf8") };
}
