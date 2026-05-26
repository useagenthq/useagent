/**
 * Extract GitHub repository references from inbound Slack text.
 *
 * Slack has no repo picker, so Slack-created runs carried `repos: []` - and the
 * run-bound GitHub tools (clone, PR detail) refuse unbound repositories. Asking
 * "test this PR <github.com/org/repo/pull/N>" therefore locked the agent out of
 * the very repository the message names; one run answered by fabricating a
 * local demo instead. Binding every repository the message links restores the
 * same capability a web-composer repo selection grants.
 *
 * Slack wraps URLs as `<https://github.com/org/repo|label>` - the wrapper and
 * label are handled here. Owner/name follow GitHub's own charset; anything
 * after the repo segment (pull/issues/tree/blob) is ignored.
 */

const GITHUB_REPO_RE =
  /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?=[/|>\s?#]|$)/g;

/** Non-repository first path segments on github.com. */
const RESERVED_OWNERS = new Set([
  "orgs", "features", "topics", "collections", "trending", "sponsors",
  "marketplace", "settings", "notifications", "login", "search", "about",
]);

export const MAX_SLACK_REPO_REFS = 3;

/** Unique `owner/repo` references in message order, capped at MAX_SLACK_REPO_REFS. */
export function githubRepoRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(GITHUB_REPO_RE)) {
    const owner = match[1]!;
    const name = match[2]!.replace(/\.git$/, "");
    if (RESERVED_OWNERS.has(owner.toLowerCase())) continue;
    if (!name || name === "." || name === "..") continue;
    const ref = `${owner}/${name}`;
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= MAX_SLACK_REPO_REFS) break;
  }
  return refs;
}
