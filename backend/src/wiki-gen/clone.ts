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
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(
      `x-access-token:${token}`,
    ).toString("base64")}`;
  }

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
