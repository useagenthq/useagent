// ---------------------------------------------------------------------------
// Shared, ENGINE-NEUTRAL repository preparation. Both the OpenCode adapter and
// the ACP (claude/codex) adapter clone the thread's selected repos into the
// retained sandbox BEFORE the provider session starts, so the agent always works
// inside the chosen repositories - never an empty workspace. One implementation,
// one trust boundary; do not copy this per engine.
// ---------------------------------------------------------------------------
import type { Sandbox } from "@daytona/sdk";
import { resolveGithubToken } from "../github/auth";
import { parseRepoRef } from "../github/repo-ref";
import type { EngineRunContext } from "./types";
import { basename, truncate } from "./util";

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
  sandbox: Sandbox,
  workdir: string,
  entry: string,
  ctx: EngineRunContext,
): Promise<void> {
  // The stored entry may carry a branch ("owner/name:branch"); split it so the
  // subdir/URL use the clean repo and the clone checks out the chosen branch.
  const { repo, branch } = parseRepoRef(entry);
  const dir = `${workdir}/${basename(repo)}`;
  // Cheap pre-check so a resumed thread (this repo already cloned) shows no noisy
  // "Cloning" step - we only emit + clone when the subdir has no repo yet.
  const check = await sandbox.process.executeCommand(
    `[ -d ${shq(`${dir}/.git`)} ] && echo yes || echo no`,
    undefined,
    undefined,
    15,
  );
  if ((check.result ?? "").includes("yes")) return;

  // Resolve a credential per clone: a PAT, or a FRESHLY-valid GitHub App
  // installation token (they expire ~1h, so we mint/reuse one here rather than
  // carry a stale token). Absent -> public clone.
  const token = await resolveGithubToken();
  const url = `https://github.com/${repo}.git`;
  // A chosen branch clones with `-b <branch>` (a bare entry clones the repo's
  // default branch). A branch that does not exist fails the clone, and so the
  // run, honestly - better than silently landing on the wrong branch.
  const branchArg = branch ? `-b ${shq(branch)} ` : "";
  // Ensure the workspace root exists (the ACP boot creates ~/work; opencode's
  // workspace also exists) then clone into a fresh subdir (clear any partial dir
  // first so the clone starts clean).
  const script =
    `set -e; mkdir -p ${shq(workdir)}; DIR=${shq(dir)}; ` +
    `if [ -d "$DIR/.git" ]; then echo clone:exists; exit 0; fi; ` +
    `rm -rf "$DIR"; L="$(mktemp)"; ` +
    `if git clone ${branchArg}${shq(url)} "$DIR" >"$L" 2>&1; then rm -f "$L"; echo clone:ok; ` +
    `else echo clone:failed; tail -c 300 "$L"; rm -rf "$L" "$DIR"; exit 1; fi`;
  // Token via ENV only (see trust-boundary note). Absent token -> public clone.
  // Basic auth with the "x-access-token" username is the form GitHub's git
  // smart-HTTP endpoint accepts for BOTH a PAT and an App installation token; a
  // Bearer header is API-only and git falls back to an interactive prompt (fails
  // in a sandbox). The header is applied one-shot for THIS clone and never
  // persisted to .git/config.
  const cloneEnv: Record<string, string> = token
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
          `x-access-token:${token}`,
        ).toString("base64")}`,
      }
    : {};

  await ctx.emit({
    kind: "command",
    label: branch ? `Cloning ${repo} (${branch})` : `Cloning ${repo}`,
    chip: "git",
  });
  const res = await sandbox.process.executeCommand(script, undefined, cloneEnv, 300);
  const out = (res.result ?? "").trim();
  if ((res.exitCode ?? 1) !== 0 || /clone:failed/.test(out)) {
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
  sandbox: Sandbox,
  workdir: string,
  ctx: EngineRunContext,
): Promise<void> {
  for (const r of ctx.repos ?? []) {
    if (ctx.signal.aborted) throw new Error("run aborted (timeout)");
    await ensureRepoClone(sandbox, workdir, r, ctx);
  }
}
