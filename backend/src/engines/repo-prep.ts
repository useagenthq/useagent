// ---------------------------------------------------------------------------
// Shared, ENGINE-NEUTRAL repository preparation. Both the OpenCode adapter and
// the ACP (claude/codex) adapter clone the thread's selected repos into the
// retained sandbox BEFORE the provider session starts, so the agent always works
// inside the chosen repositories - never an empty workspace. One implementation,
// one trust boundary; do not copy this per engine.
// ---------------------------------------------------------------------------
import type { SandboxHandle } from "../sandboxes/provider";
import { createHash } from "node:crypto";
import { resolveGithubSandboxToken } from "../github/auth";
import { parseRepoRef } from "../github/repo-ref";
import { RUN_TIMING_OUTCOMES, RUN_TIMING_STAGES } from "../runs/run-timing";
import { hasExactGitHubRepositoryUrlProvenance } from "../resources/public-github";
import type { RunResource } from "../resources/types";
import type { EngineRunContext } from "./types";
import { truncate } from "./util";

type RepoSandbox = { readonly process: Pick<SandboxHandle["process"], "executeCommand"> };
type RepoCloneContext = Pick<EngineRunContext, "emit" | "orgId">;
type RepoCheckoutContext = RepoCloneContext & Pick<EngineRunContext, "repos">;
type RepoCloneOptions = { readonly useGithubCredential?: boolean };
const RUNTIME_USER_OWNERSHIP_ROOT = "/root/.skynet/repo-runtime-ownership";

export function runtimeUserOwnershipMarker(repoPath: string): string {
  const digest = createHash("sha256").update(repoPath).digest("hex");
  return `${RUNTIME_USER_OWNERSHIP_ROOT}/${digest}`;
}

/** POSIX single-quote a string for safe interpolation into a shell command. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function githubAuthEnv(
  repository: string,
  orgId: string | null | undefined,
  options: RepoCloneOptions,
): Promise<Record<string, string>> {
  const token = options.useGithubCredential === false
    ? null
    : await resolveGithubSandboxToken(repository, orgId);
  return token
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }
    : {};
}

function shouldUseGithubCredential(
  entry: string,
  resources: readonly RunResource[],
): boolean {
  const { repo } = parseRepoRef(entry);
  const resource = resources.find(
    (candidate) =>
      candidate.locator.type === "github.repository" &&
      candidate.locator.repository === repo,
  );
  return resource ? !hasExactGitHubRepositoryUrlProvenance(resource) : true;
}

/**
 * Clone ONE selected repo into its OWN subdir of the sandbox workspace
 * (`<workdir>/<name>`), idempotently - so multiple repos coexist (multi-repo)
 * and a resumed thread (that subdir already cloned) is a fast skip. Public repos
 * need no credential.
 *
 * TRUST BOUNDARY (narrowest practical credential): a PRIVATE clone uses the
 * backend-held GitHub token, and the sandbox is untrusted - so the token is
 * handled as narrowly as possible:
 *   - passed via GIT_CONFIG_* ENV, never in the command string / git argv (so it
 *     is not in our source, our logs, or `ps` inside the box);
 *   - applied one-shot as an http.extraHeader for THIS clone only;
 *   - NOT written to .git/config - the stored remote stays the clean https URL,
 *     so the token does not persist on the sandbox disk.
 * Only this narrow read-scoped token ever enters the sandbox; broad backend
 * credentials never do. A fresh clone that FAILS fails the run honestly rather
 * than silently leaving the user's chosen repo missing.
 */
export async function ensureRepoClone(
  sandbox: RepoSandbox,
  workdir: string,
  entry: string,
  ctx: RepoCloneContext,
  options: RepoCloneOptions = {},
): Promise<boolean> {
  // The stored entry may carry a branch ("owner/name:branch"); split it so the
  // subdir/URL use the clean repo and the clone checks out the chosen branch.
  const { repo, branch } = parseRepoRef(entry);
  const url = `https://github.com/${repo}.git`;
  // OWNER-QUALIFIED subdir (`<workdir>/<owner>/<name>`), NOT a bare basename. Two selected
  // repos that share a basename (`a/widget` + `b/widget`) get distinct checkouts instead of
  // colliding on one directory (same-basename collision).
  const dir = `${workdir}/${repo}`;
  const runtimeOwnershipMarker = runtimeUserOwnershipMarker(dir);
  const wantBranch = branch ?? "";
  // NON-DESTRUCTIVE identity pre-check for a warm/reused sandbox. Report the EXACT state of the
  // destination so we NEVER rm -rf an unexpected directory:
  //   reuse       - a checkout of the RIGHT repo on the right branch -> fast skip.
  //   branch      - the RIGHT repo, wrong branch -> switch in place (fetch+checkout).
  //   owned-stale - a checkout WE created (carries the `.git/useAgent-owned` marker) of a
  //                 different repo -> safe to replace (we own it).
  //   foreign     - a git repo we do NOT own with a different origin -> FAIL CLOSED.
  //   occupied    - a non-git file/dir we do NOT own -> FAIL CLOSED.
  //   absent      - nothing there -> clone.
  // The ownership marker lives INSIDE `.git` so it never lands in the working tree or a commit.
  const idScript =
    `DIR=${shq(dir)}; ` +
    `if [ ! -e "$DIR" ]; then echo state:absent; ` +
    `elif [ -d "$DIR/.git" ]; then ` +
    `O="$(stat -c %u "$DIR" 2>/dev/null)"; ` +
    `U="$(git -c safe.directory="$DIR" -C "$DIR" remote get-url origin 2>/dev/null)"; ` +
    `B="$(git -c safe.directory="$DIR" -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"; ` +
    `if [ "$U" = ${shq(url)} ]; then ` +
    `if [ -z ${shq(wantBranch)} ] || [ "$B" = ${shq(wantBranch)} ]; then ` +
    `if [ "$O" = 1000 ] && [ -f ${shq(runtimeOwnershipMarker)} ]; then echo state:reuse; else echo state:ownership; fi; ` +
    `elif [ "$O" = 0 ]; then echo state:branch; else echo state:agent-branch; fi; ` +
    `elif [ "$O" = 0 ] && [ -f "$DIR/.git/skynet-owned" ]; then echo state:owned-stale; ` +
    `else echo state:foreign; fi; ` +
    `else echo state:occupied; fi`;
  const idState = (await sandbox.process.executeCommand(idScript, undefined, undefined, 15)).result ?? "";
  if (idState.includes("state:reuse")) return false;
  if (idState.includes("state:ownership")) return true;

  if (idState.includes("state:agent-branch")) {
    throw new Error(
      `refusing to switch ${repo}: retained agent-owned checkout requires a fresh workspace`,
    );
  }
  if (idState.includes("state:branch")) {
    throw new Error(`refusing to switch ${repo}: branch changes require a fresh workspace`);
  }

  // Refuse to touch a destination we do not own: never delete unrelated workspace content.
  if (idState.includes("state:foreign")) {
    throw new Error(`refusing to prepare ${repo}: ${dir} holds a different git repository not created by useAgent`);
  }
  if (idState.includes("state:occupied")) {
    throw new Error(`refusing to prepare ${repo}: ${dir} holds existing content not created by useAgent`);
  }

  // One-shot GitHub credential (an exact-repo App token, or a dev-gated local PAT). Passed via
  // GIT_CONFIG_* ENV ONLY (never the git argv / .git-config / logs / prompt), applied for THIS
  // operation and never persisted. Absent -> public repo. Shared by the switch + clone paths.
  const authEnv = await githubAuthEnv(repo, ctx.orgId, options);

  // ABSENT or a useAgent-OWNED stale checkout: clone into a UNIQUE TEMP directory under a
  // root-owned staging root, validate its origin, stamp the ownership marker, then ATOMICALLY
  // rename into place. The owner-qualified destination parent is also root-owned, so the runtime
  // user cannot swap workspace pathnames while credentialed Git is running or during placement.
  // A failed/interrupted clone only ever leaves root-owned staging content (which we clean), never
  // a partial destination. `-b <branch>` selects the branch; a missing branch fails honestly.
  const allowReplace = idState.includes("state:owned-stale") ? "yes" : "no";
  const branchArg = branch ? `-b ${shq(branch)} ` : "";
  const script =
    `set -e; DIR=${shq(dir)}; ALLOW=${allowReplace}; PARENT="$(dirname "$DIR")"; ` +
    `if [ ! -e "$PARENT" ]; then mkdir "$PARENT" 2>/dev/null || true; fi; ` +
    `if [ ! -d "$PARENT" ] || [ -L "$PARENT" ] || [ "$(stat -c %u "$PARENT" 2>/dev/null)" != 0 ]; ` +
    `then echo clone:parent-untrusted; exit 1; fi; chmod 755 "$PARENT"; ` +
    `STAGE_ROOT=/root/.skynet/repo-staging; install -d -o 0 -g 0 -m 700 "$STAGE_ROOT"; ` +
    `rm -f ${shq(runtimeOwnershipMarker)}; ` +
    `TMP="$(mktemp -d "$STAGE_ROOT/clone.XXXXXX")"; L="$(mktemp)"; ` +
    `if ! git clone ${branchArg}${shq(url)} "$TMP" >"$L" 2>&1; then echo clone:failed; tail -c 300 "$L"; rm -rf "$TMP" "$L"; exit 1; fi; ` +
    `RU="$(git -C "$TMP" remote get-url origin 2>/dev/null)"; ` +
    `if [ "$RU" != ${shq(url)} ]; then echo clone:badorigin; rm -rf "$TMP" "$L"; exit 1; fi; ` +
    `printf 'skynet-owned repo=%s\\n' ${shq(repo)} > "$TMP/.git/skynet-owned"; ` +
    // RACE-SAFE placement (no rm-then-mv TOCTOU, no nesting): if the destination exists and we
    // own it (or ALLOW=yes), move it ATOMICALLY aside to a unique backup first; then rename the
    // temp into place with `mv -T` (atomic, and it FAILS rather than nesting if the destination
    // reappeared during a concurrent race). Any failure restores the moved-aside dir and fails
    // closed. Unowned content is never removed.
    `BAK="$TMP.old"; ` +
    `if [ -e "$DIR" ]; then ` +
    `if [ "$ALLOW" = yes ] || [ -f "$DIR/.git/skynet-owned" ]; then ` +
    `mv "$DIR" "$BAK" 2>/dev/null || { echo clone:collision; rm -rf "$TMP" "$L"; exit 1; }; ` +
    `else echo clone:collision; rm -rf "$TMP" "$L"; exit 1; fi; fi; ` +
    `if mv -T "$TMP" "$DIR" 2>/dev/null; then rm -rf "$BAK" "$L"; echo clone:ok; ` +
    `else [ -e "$BAK" ] && mv "$BAK" "$DIR" 2>/dev/null; rm -rf "$TMP" "$L"; echo clone:collision; exit 1; fi`;
  await ctx.emit({
    kind: "command",
    label: branch ? `Cloning ${repo} (${branch})` : `Cloning ${repo}`,
    chip: "git",
  });
  const res = await sandbox.process.executeCommand(script, undefined, authEnv, 300);
  const out = (res.result ?? "").trim();
  if ((res.exitCode ?? 1) !== 0 || /clone:(failed|badorigin|collision|parent-untrusted)/.test(out)) {
    if (/clone:parent-untrusted/.test(out)) {
      throw new Error(
        `refusing to prepare ${repo}: workspace repository parent is not root-owned`,
      );
    }
    if (/clone:collision/.test(out)) {
      throw new Error(`refusing to prepare ${repo}: ${dir} was occupied by unowned content during preparation`);
    }
    if (/clone:badorigin/.test(out)) throw new Error(`failed to clone ${repo}: unexpected origin after clone`);
    // Never echo the credential - surface only the sanitized git tail.
    const detail = out.replace(/clone:\w+/g, "").trim() || "git clone error";
    const what = branch ? `${repo} (${branch})` : repo;
    throw new Error(`failed to clone ${what}: ${truncate(detail, 200)}`);
  }
  return true;
}

/**
 * Check out each authorized GitHub pull-request resource after its base
 * repository has been prepared. GitHub exposes the contributor head through
 * the base repository's `refs/pull/<number>/head`, including for fork PRs, so
 * this never needs a contributor-controlled remote URL or persisted credential.
 */
export async function checkoutPullRequestResources(
  sandbox: RepoSandbox,
  workdir: string,
  resources: readonly RunResource[],
  ctx: RepoCheckoutContext,
): Promise<readonly string[]> {
  const selectedRepos = new Set(
    (ctx.repos ?? []).map((entry) => parseRepoRef(entry).repo.toLowerCase()),
  );
  const changes = resources.filter(
    (resource): resource is Extract<RunResource, { kind: "code.change" }> =>
      resource.kind === "code.change" &&
      resource.provider === "github" &&
      resource.locator.type === "github.pull_request" &&
      selectedRepos.has(resource.locator.repository.toLowerCase()),
  );
  if (changes.length === 0) return [];

  const changedPaths: string[] = [];

  for (const change of changes) {
    const { repository, number, revision } = change.locator;
    const authEnv = await githubAuthEnv(repository, ctx.orgId, {});
    const dir = `${workdir}/${repository}`;
    const runtimeOwnershipMarker = runtimeUserOwnershipMarker(dir);
    const remoteRef = `refs/pull/${number}/head`;
    const localRef = `refs/skynet/pull/${number}/head`;
    const expected = revision ?? "";
    const script =
      `set -e; DIR=${shq(dir)}; EXPECTED=${shq(expected)}; L="$(mktemp)"; ` +
      `OWNER="$(stat -c %u "$DIR" 2>/dev/null)"; ` +
      `if [ "$OWNER" = 1000 ]; then ` +
      `ACTUAL="$(git -c safe.directory="$DIR" -C "$DIR" rev-parse HEAD 2>/dev/null)"; ` +
      `if [ -n "$EXPECTED" ] && [ "$ACTUAL" = "$EXPECTED" ]; then rm -f "$L"; echo "pr:reuse sha=$ACTUAL"; exit 0; fi; ` +
      `echo pr:agent-owned; rm -f "$L"; exit 1; fi; ` +
      `if [ "$OWNER" != 0 ]; then echo pr:ownership-untrusted; rm -f "$L"; exit 1; fi; ` +
      // A previous depth-first ownership transfer may have been interrupted before changing the
      // repository root itself. Prove every entry is still root-owned and not writable by the
      // runtime user before any credentialed Git mutation; otherwise require a fresh workspace.
      `if ! UNTRUSTED="$(find "$DIR" -xdev \\( ! -uid 0 -o ! -gid 0 -o -perm /022 \\) -print -quit 2>/dev/null)"; ` +
      `then echo pr:ownership-check-failed; rm -f "$L"; exit 1; fi; ` +
      `if [ -n "$UNTRUSTED" ]; then echo pr:ownership-incomplete; rm -f "$L"; exit 1; fi; ` +
      `rm -f ${shq(runtimeOwnershipMarker)}; ` +
      `if ! git -c safe.directory="$DIR" -C "$DIR" fetch --force --quiet origin ${shq(`${remoteRef}:${localRef}`)} >"$L" 2>&1; ` +
      `then echo pr:fetch-failed; tail -c 300 "$L"; rm -f "$L"; exit 1; fi; ` +
      `ACTUAL="$(git -c safe.directory="$DIR" -C "$DIR" rev-parse ${shq(localRef)} 2>/dev/null)"; ` +
      `if [ -z "$ACTUAL" ]; then echo pr:verify-failed; rm -f "$L"; exit 1; fi; ` +
      `if [ -n "$EXPECTED" ] && [ "$ACTUAL" != "$EXPECTED" ]; ` +
      `then echo "pr:sha-mismatch actual=$ACTUAL"; rm -f "$L"; exit 1; fi; ` +
      `if ! git -c safe.directory="$DIR" -C "$DIR" checkout --detach ${shq(localRef)} >"$L" 2>&1; ` +
      `then echo pr:checkout-failed; tail -c 300 "$L"; rm -f "$L"; exit 1; fi; ` +
      `rm -f "$L"; echo "pr:ok sha=$ACTUAL"`;

    await ctx.emit({
      kind: "command",
      label: `Checking out ${repository} pull request #${number}`,
      chip: "git",
    });
    const result = await sandbox.process.executeCommand(
      script,
      undefined,
      authEnv,
      120,
    );
    const output = (result.result ?? "").trim();
    if ((result.exitCode ?? 1) === 0 && /(?:^|\n)pr:(?:ok|reuse)(?:\s|$)/u.test(output)) {
      if (/pr:ok/u.test(output)) changedPaths.push(dir);
      continue;
    }
    if (/pr:sha-mismatch/u.test(output)) {
      const actual = /\bactual=([0-9a-f]{40})\b/iu.exec(output)?.[1] ?? "unknown";
      throw new Error(
        `pull request ${repository}#${number} head SHA mismatch: expected ${expected}, fetched ${actual}`,
      );
    }
    const detail = output.replace(/pr:\S+/gu, "").trim();
    if (/pr:checkout-failed/u.test(output)) {
      throw new Error(
        `failed to check out pull request ${repository}#${number}: ${truncate(detail || "git checkout error", 200)}`,
      );
    }
    if (/pr:agent-owned/u.test(output)) {
      throw new Error(
        `refusing to update pull request ${repository}#${number} in an agent-owned retained checkout; start a fresh workspace`,
      );
    }
    if (/pr:ownership-(?:untrusted|incomplete|check-failed)/u.test(output)) {
      throw new Error(
        `refusing to update pull request ${repository}#${number} in a partially transferred retained checkout; start a fresh workspace`,
      );
    }
    throw new Error(
      `failed to fetch pull request ${repository}#${number}: ${truncate(detail || "git fetch error", 200)}`,
    );
  }
  return changedPaths;
}

/**
 * Prepare EVERY selected repo for the thread into the sandbox workspace before
 * the provider session starts - engine-neutral entry point used by both the
 * OpenCode and ACP adapters. Idempotent for a retained warm sandbox (each repo
 * is a fast skip once cloned); a fresh clone that fails fails the run honestly.
 */
export async function prepareRepos(
  sandbox: RepoSandbox,
  workdir: string,
  ctx: EngineRunContext,
): Promise<readonly string[]> {
  const repos = ctx.repos ?? [];
  const end = ctx.timing?.begin(RUN_TIMING_STAGES.repoPrep);
  if (repos.length === 0) {
    end?.(RUN_TIMING_OUTCOMES.skipped);
    return [];
  }
  const changedPaths: string[] = [];
  try {
    for (const r of repos) {
      if (ctx.signal.aborted) throw new Error("run aborted (timeout)");
      const changed = await ensureRepoClone(sandbox, workdir, r, ctx, {
        useGithubCredential: shouldUseGithubCredential(r, ctx.resolvedResources ?? []),
      });
      if (changed) changedPaths.push(`${workdir}/${parseRepoRef(r).repo}`);
    }
    end?.(RUN_TIMING_OUTCOMES.success);
    return changedPaths;
  } catch (error) {
    end?.(ctx.signal.aborted ? RUN_TIMING_OUTCOMES.aborted : RUN_TIMING_OUTCOMES.failure);
    throw error;
  }
}
