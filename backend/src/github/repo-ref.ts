// ---------------------------------------------------------------------------
// One place that encodes/decodes an optional per-repo branch into a run's stored
// repo entry. A run's `repos` are jsonb strings ("owner/name"); to let each carry
// an optional branch WITHOUT a schema change we suffix the ref with ":<branch>".
//
// ":" is a safe, unambiguous delimiter: it is invalid in a GitHub "owner/name"
// ref (that charset is [A-Za-z0-9._-] + one "/") AND invalid in a git ref name
// (git-check-ref-format forbids ":"). So the split is on the FIRST colon and the
// branch tail may itself contain "/" (e.g. "feat/x").
//
//   "owner/name"          -> default branch (clone without -b)
//   "owner/name:feat/x"   -> clone -b "feat/x"
//
// Encoding lives ONLY in the stored `repos` jsonb + the worker/clone path that
// reads it. The wire (POST body, GET /api/runs) stays clean owner/name plus an
// explicit branch field, so nothing leaks the ":" encoding to clients.
// ---------------------------------------------------------------------------

// The RepoRef wire shape (serialized as `repo_specs`) lives in the agent-client
// wire contract; re-exported here alongside the encode/decode helpers that own the
// stored ":branch" representation the wire never exposes.
export type { RepoRef } from "@useagent/agent-client/wire";

import type { RepoRef } from "@useagent/agent-client/wire";

/** Decode a stored repo entry into its repo + optional branch. */
export function parseRepoRef(entry: string): RepoRef {
  const i = entry.indexOf(":");
  if (i === -1) return { repo: entry, branch: null };
  const branch = entry.slice(i + 1);
  return { repo: entry.slice(0, i), branch: branch.length > 0 ? branch : null };
}

/** Encode a repo + optional branch into a stored entry. A blank/absent branch
 *  yields the bare "owner/name" (default branch). */
export function formatRepoRef(repo: string, branch: string | null | undefined): string {
  const b = typeof branch === "string" ? branch.trim() : "";
  return b ? `${repo}:${b}` : repo;
}
