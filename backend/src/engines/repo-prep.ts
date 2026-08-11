// ---------------------------------------------------------------------------
// Shared, ENGINE-NEUTRAL repository preparation. Both the OpenCode adapter and
// the ACP (claude/codex) adapter clone the thread's selected repos into the
// retained sandbox BEFORE the provider session starts, so the agent always works
// inside the chosen repositories - never an empty workspace. One implementation,
// one trust boundary; do not copy this per engine.
// ---------------------------------------------------------------------------
import type { SandboxHandle } from "../sandboxes/provider";
import { resolveGithubToken } from "../github/auth";
import { parseRepoRef } from "../github/repo-ref";
import type { EngineRunContext } from "./types";
import { truncate } from "./util";

/** POSIX single-quote a string for safe interpolation into a shell command. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  sandbox: SandboxHandle,
  workdir: string,
  entry: string,
  ctx: EngineRunContext,
): Promise<void> {
  // The stored entry may carry a branch ("owner/name:branch"); split it so the
  // subdir/URL use the clean repo and the clone checks out the chosen branch.
  const { repo, branch } = parseRepoRef(entry);
  const url = `https://github.com/${repo}.git`;
  // OWNER-QUALIFIED subdir (`<workdir>/<owner>/<name>`), NOT a bare basename. Two selected
  // repos that share a basename (`a/widget` + `b/widget`) get distinct checkouts instead of
  // colliding on one directory (same-basename collision).
  const dir = `${workdir}/${repo}`;
  const wantBranch = branch ?? "";
  // NON-DESTRUCTIVE identity pre-check for a warm/reused sandbox. Report the EXACT state of the
  // destination so we NEVER rm -rf an unexpected directory:
  //   reuse       - a checkout of the RIGHT repo on the right branch -> fast skip.
  //   branch      - the RIGHT repo, wrong branch -> switch in place (fetch+checkout).
  //   owned-stale - a checkout WE created (carries the `.git/skynet-owned` marker) of a
  //                 different repo -> safe to replace (we own it).
  //   foreign     - a git repo we do NOT own with a different origin -> FAIL CLOSED.
  //   occupied    - a non-git file/dir we do NOT own -> FAIL CLOSED.
  //   absent      - nothing there -> clone.
  // The ownership marker lives INSIDE `.git` so it never lands in the working tree or a commit.
  const idScript =
    `DIR=${shq(dir)}; ` +
    `if [ ! -e "$DIR" ]; then echo state:absent; ` +
    `elif [ -d "$DIR/.git" ]; then ` +
    `U="$(git -C "$DIR" remote get-url origin 2>/dev/null)"; ` +
    `B="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"; ` +
    `if [ "$U" = ${shq(url)} ]; then ` +
    `if [ -z ${shq(wantBranch)} ] || [ "$B" = ${shq(wantBranch)} ]; then echo state:reuse; else echo state:branch; fi; ` +
    `elif [ -f "$DIR/.git/skynet-owned" ]; then echo state:owned-stale; ` +
    `else echo state:foreign; fi; ` +
    `else echo state:occupied; fi`;
  const idState = (await sandbox.process.executeCommand(idScript, undefined, undefined, 15)).result ?? "";
  if (idState.includes("state:reuse")) return;

  // Refuse to touch a destination we do not own: never delete unrelated workspace content.
  if (idState.includes("state:foreign")) {
    throw new Error(`refusing to prepare ${repo}: ${dir} holds a different git repository not created by Skynet`);
  }
  if (idState.includes("state:occupied")) {
    throw new Error(`refusing to prepare ${repo}: ${dir} holds existing content not created by Skynet`);
  }

  // One-shot GitHub credential (a PAT or a FRESHLY-valid App installation token). Passed via
  // GIT_CONFIG_* ENV ONLY (never the git argv / .git-config / logs / prompt), applied for THIS
  // operation and never persisted. Absent -> public repo. Shared by the switch + clone paths.
  const token = await resolveGithubToken();
  const authEnv: Record<string, string> = token
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }
    : {};

  // SAME repo, WRONG branch: switch in place (fetch + checkout). NON-DESTRUCTIVE - we never
  // rm -rf a checkout that IS the requested repo, so a warm checkout's local work survives.
  if (idState.includes("state:branch") && branch) {
    const switchScript =
      `set -e; DIR=${shq(dir)}; L="$(mktemp)"; ` +
      `if git -C "$DIR" fetch origin ${shq(branch)} --quiet >"$L" 2>&1 && git -C "$DIR" checkout ${shq(branch)} >"$L" 2>&1; ` +
      `then rm -f "$L"; echo switch:ok; else echo switch:failed; tail -c 300 "$L"; rm -f "$L"; exit 1; fi`;
    await ctx.emit({ kind: "command", label: `Checking out ${repo} (${branch})`, chip: "git" });
    const sw = await sandbox.process.executeCommand(switchScript, undefined, authEnv, 120);
    const sout = (sw.result ?? "").trim();
    if ((sw.exitCode ?? 1) !== 0 || /switch:failed/.test(sout)) {
      const detail = sout.replace(/switch:\w+/g, "").trim() || "git checkout error";
      throw new Error(`failed to switch ${repo} to ${branch}: ${truncate(detail, 200)}`);
    }
    return;
  }

  // ABSENT or a Skynet-OWNED stale checkout: clone into a UNIQUE TEMP sibling first, validate its
  // origin, stamp the ownership marker, then ATOMICALLY rename into place - so a failed/interrupted
  // clone only ever leaves the temp dir (which we clean), never a partial at the destination, and
  // we replace the destination ONLY when it is absent or one WE own. A destination that turns
  // unowned during preparation (race) fails closed. `-b <branch>` selects the branch; a missing
  // branch fails the clone (and the run) honestly.
  const allowReplace = idState.includes("state:owned-stale") ? "yes" : "no";
  const branchArg = branch ? `-b ${shq(branch)} ` : "";
  const script =
    `set -e; DIR=${shq(dir)}; ALLOW=${allowReplace}; PARENT="$(dirname "$DIR")"; mkdir -p "$PARENT"; ` +
    `TMP="$(mktemp -d "$PARENT/.skynet-clone.XXXXXX")"; L="$(mktemp)"; ` +
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
  if ((res.exitCode ?? 1) !== 0 || /clone:(failed|badorigin|collision)/.test(out)) {
    if (/clone:collision/.test(out)) {
      throw new Error(`refusing to prepare ${repo}: ${dir} was occupied by unowned content during preparation`);
    }
    if (/clone:badorigin/.test(out)) throw new Error(`failed to clone ${repo}: unexpected origin after clone`);
    // Never echo the credential - surface only the sanitized git tail.
    const detail = out.replace(/clone:\w+/g, "").trim() || "git clone error";
    const what = branch ? `${repo} (${branch})` : repo;
    throw new Error(`failed to clone ${what}: ${truncate(detail, 200)}`);
  }
}

/**
 * Prepare EVERY selected repo for the thread into the sandbox workspace before
 * the provider session starts - engine-neutral entry point used by both the
 * OpenCode and ACP adapters. Idempotent for a retained warm sandbox (each repo
 * is a fast skip once cloned); a fresh clone that fails fails the run honestly.
 */
export async function prepareRepos(
  sandbox: SandboxHandle,
  workdir: string,
  ctx: EngineRunContext,
): Promise<void> {
  for (const r of ctx.repos ?? []) {
    if (ctx.signal.aborted) throw new Error("run aborted (timeout)");
    await ensureRepoClone(sandbox, workdir, r, ctx);
  }
}
