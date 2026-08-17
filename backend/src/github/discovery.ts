import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { githubConfigured } from "../env";
import { cloneRepoAtHead, resolveRemoteHeadSha } from "../wiki-gen/clone";
import { resolveGithubAuth } from "./auth";

// ---------------------------------------------------------------------------
// GitHub skill discovery (multi-repo "import Skills from a repo"). Given an
// `owner/name` repo, find every `**/SKILL.md` on the default branch and read
// the ones within the size cap. This is pure GitHub I/O: it returns the raw
// file text + the HEAD commit the read was pinned to; turning that text into a
// versioned skill (frontmatter parse, revisions) lives in src/skills/import.ts.
//
// The scan works from a shallow server-side clone (src/wiki-gen/clone.ts) and
// HEAD resolution uses `git ls-remote`, NOT the REST git-data endpoints
// (`/commits/{ref}`, `/git/trees`, `/git/blobs`): those 404 under the
// backend's credentials against this org while the git protocol and the
// `/contents` API work. The pinned-commit import read stays on `/contents`.
// Auth is resolved through src/github/auth.ts (PAT > App > anon precedence);
// the credential never leaves the backend.
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 8_000;
/** SKILL.md files above this are skipped, never imported (guards against a huge
 *  file blowing up a revision row / the injected context). */
export const MAX_SKILL_BYTES = 64 * 1024;
/** Upper bound on how many SKILL.md files one scan reads. Reads come from a
 *  local shallow clone (cheap disk I/O, not per-file API calls), so this only
 *  bounds the response payload; a repo with more is reported `truncated`.
 *  Sized above the largest real skill repo (120+) with headroom. */
const MAX_CANDIDATES = 500;

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

/** Recursively list SKILL.md paths (repo-relative) inside a clone, `.git` excluded. */
export async function listSkillPathsInDir(dir: string): Promise<string[]> {
  const all = (await readdir(dir, { recursive: true })) as string[];
  return all
    .filter((p) => !p.startsWith(".git/") && p !== ".git" && isSkillPath(p))
    .sort((a, b) => a.localeCompare(b));
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
  await resolveToken();

  let cloned: Awaited<ReturnType<typeof cloneRepoAtHead>>;
  try {
    cloned = await cloneRepoAtHead(repo);
  } catch (e) {
    throw new DiscoveryError(e instanceof Error ? e.message : String(e), "upstream");
  }
  try {
    const paths = await listSkillPathsInDir(cloned.dir);
    const truncated = paths.length > MAX_CANDIDATES;
    const chosen = paths.slice(0, MAX_CANDIDATES);

    const files = await Promise.all(
      chosen.map(async (path): Promise<DiscoveredSkillFile> => {
        const abs = join(cloned.dir, path);
        const sizeBytes = (await stat(abs)).size;
        if (sizeBytes > MAX_SKILL_BYTES) return { path, sizeBytes, text: null };
        return { path, sizeBytes, text: await readFile(abs, "utf8") };
      }),
    );
    return { commitSha: cloned.commitSha, files, truncated };
  } finally {
    await cloned.cleanup();
  }
}

/** Resolve just the HEAD commit sha of a repo's default branch (import pins to it). */
export async function resolveRepoHeadSha(repo: string): Promise<string> {
  const ref = parseRepoRef(repo);
  if (!ref) throw new DiscoveryError(`invalid repo ref "${repo}"`, "bad_request");
  await resolveToken();
  try {
    return await resolveRemoteHeadSha(repo);
  } catch (e) {
    throw new DiscoveryError(e instanceof Error ? e.message : String(e), "upstream");
  }
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
