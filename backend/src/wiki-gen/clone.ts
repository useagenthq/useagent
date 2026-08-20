/**
 * Server-side shallow clone of a repo into a temp dir, using the backend-held
 * GitHub credential (PAT or a freshly-minted App installation token, resolved
 * through src/github/auth.ts). First-party harness code, so this runs OUTSIDE
 * any sandbox — no Daytona spend. The clone is deleted after the wiki is built.
 *
 * The credential is applied one-shot as an http.extraHeader for THIS clone only
 * (never written to .git/config), and Basic auth with the "x-access-token"
 * username is the form GitHub's smart-HTTP endpoint accepts for both a PAT and
 * an App token (a Bearer header is API-only). Same convention as the sandbox
 * clone in src/engines/opencode-server.ts.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveGithubToken } from "../github/auth";

const exec = promisify(execFile);
const CLONE_TIMEOUT_MS = 120_000;

export interface ClonedRepo {
  dir: string;
  defaultBranch: string;
  cleanup: () => Promise<void>;
}

/** `owner/name` shape guard — the same cheap gate the repo picker uses. */
export function isValidRepoRef(ref: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ref);
}

/** One-shot git auth env (http.extraHeader, never written to .git/config). */
function gitAuthEnv(token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(
      `x-access-token:${token}`,
    ).toString("base64")}`;
  }
  return env;
}

/**
 * Resolve a repo's remote HEAD commit sha over the git smart-HTTP protocol
 * (`ls-remote`), the same transport the clone uses. This exists because the
 * REST git-data surface (`/commits/{ref}`, `/git/trees`) 404s under the
 * backend's credentials against this org while the git protocol works.
 */
export async function resolveRemoteHeadSha(repo: string): Promise<string> {
  if (!isValidRepoRef(repo)) throw new Error(`invalid repo ref: ${repo}`);
  const token = await resolveGithubToken();
  const url = `https://github.com/${repo}.git`;
  try {
    const { stdout } = await exec("git", ["ls-remote", url, "HEAD"], {
      env: gitAuthEnv(token),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim().split(/\s+/)[0];
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`no HEAD ref returned for ${repo}`);
    }
    return sha;
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message.replace(/x-access-token:[^@\s]+/g, "x-access-token:***")
        : String(e);
    throw new Error(`failed to resolve HEAD of ${repo}: ${msg.slice(0, 200)}`);
  }
}

/**
 * Shallow-clone `owner/name` into a fresh temp dir. Returns the dir, the checked
 * out default branch, and a cleanup fn. Throws (honestly, credential-free) on
 * failure; the caller turns that into a failed job.
 */
export async function cloneRepoToTemp(repo: string): Promise<ClonedRepo> {
  if (!isValidRepoRef(repo)) throw new Error(`invalid repo ref: ${repo}`);
  const token = await resolveGithubToken();
  const url = `https://github.com/${repo}.git`;
  const dir = await mkdtemp(join(tmpdir(), "skynet-wiki-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  // Token via env only. Absent token -> public clone.
  const env = gitAuthEnv(token);

  try {
    await exec("git", ["clone", "--depth", "1", url, dir], {
      env,
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    await cleanup();
    // Never echo the credential — git failures reference only the URL.
    const msg = e instanceof Error ? e.message.replace(/x-access-token:[^@\s]+/g, "x-access-token:***") : String(e);
    throw new Error(`failed to clone ${repo}: ${msg.slice(0, 200)}`);
  }

  let defaultBranch = "main";
  try {
    const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 15_000,
    });
    defaultBranch = stdout.trim() || "main";
  } catch {
    // Keep the "main" default.
  }

  return { dir, defaultBranch, cleanup };
}

export interface ClonedRepoAtHead extends ClonedRepo {
  commitSha: string;
}

/** Shallow-clone and pin the checked-out HEAD commit sha (skill discovery reads
 *  files from disk and reports the commit those reads were pinned to). */
export async function cloneRepoAtHead(repo: string): Promise<ClonedRepoAtHead> {
  const cloned = await cloneRepoToTemp(repo);
  try {
    const { stdout } = await exec("git", ["-C", cloned.dir, "rev-parse", "HEAD"], {
      timeout: 15_000,
    });
    const commitSha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) {
      throw new Error(`clone of ${repo} has no HEAD commit`);
    }
    return { ...cloned, commitSha };
  } catch (e) {
    await cloned.cleanup();
    throw e;
  }
}

/**
 * Fetch ONE file's text at an EXACT commit (not necessarily HEAD) over the git
 * smart-HTTP protocol. Used by context_read to return the cited `code:` excerpt
 * from the pinned commit. `git init` + shallow `fetch <sha>` + `show <sha>:<path>`
 * avoids a full history clone. Returns null when the path is absent at that
 * commit; throws (credential-free) on a transport/ref failure. `path` is
 * repo-relative and must be a plain path (no `..`, no leading `/`).
 */
export async function readFileAtCommit(
  repo: string,
  commitSha: string,
  path: string,
): Promise<string | null> {
  if (!isValidRepoRef(repo)) throw new Error(`invalid repo ref: ${repo}`);
  if (!/^[0-9a-f]{7,40}$/.test(commitSha)) throw new Error(`invalid commit sha`);
  if (path.includes("..") || path.startsWith("/")) throw new Error(`invalid file path`);
  const token = await resolveGithubToken();
  const url = `https://github.com/${repo}.git`;
  const env = gitAuthEnv(token);
  const dir = await mkdtemp(join(tmpdir(), "skynet-read-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await exec("git", ["-C", dir, "init", "-q"], { env, timeout: 15_000 });
    await exec("git", ["-C", dir, "remote", "add", "origin", url], { env, timeout: 15_000 });
    await exec(
      "git",
      ["-C", dir, "fetch", "-q", "--depth", "1", "origin", commitSha],
      { env, timeout: CLONE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    try {
      const { stdout } = await exec("git", ["-C", dir, "show", `${commitSha}:${path}`], {
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch {
      // Path absent at that commit (git show exits non-zero) -> honest null.
      return null;
    }
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message.replace(/x-access-token:[^@\s]+/g, "x-access-token:***")
        : String(e);
    throw new Error(`failed to read ${repo}@${commitSha}:${path}: ${msg.slice(0, 200)}`);
  } finally {
    await cleanup();
  }
}
