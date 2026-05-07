/**
 * Client data layer for the /review page: real open pull requests from
 * GET /api/pulls (the backend resolves the GitHub credential and returns PR
 * identities + links only). The page renders PRs and links out to GitHub;
 * AI-review findings are intentionally out of scope here.
 */
import { backendFetch } from "@/lib/backend-fetch";

export interface PullRequestItem {
  /** "owner/name#number". */
  id: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  author_avatar_url: string | null;
  /** The PR's page on GitHub. */
  url: string;
  updated_at: string;
}

export interface PullsResult {
  /** false = GitHub not wired (no PAT/App) — a distinct, honest empty reason. */
  configured: boolean;
  pulls: PullRequestItem[];
  /** Set when configured but the GitHub fetch failed (distinct from an outage). */
  error?: string;
  /** True when more accessible repos exist than were scanned. */
  truncated?: boolean;
}

/**
 * Fetch the real PR list. Throws on a transport/backend failure (the caller
 * renders the "backend unreachable" state); a 200 with `configured:false` or an
 * `error` field is a normal, distinct result, not a throw.
 */
export async function fetchPulls(): Promise<PullsResult> {
  const res = await backendFetch("/api/pulls");
  if (!res.ok) throw new Error(`pulls ${res.status}`);
  const data = (await res.json()) as Partial<PullsResult>;
  return {
    configured: Boolean(data.configured),
    pulls: Array.isArray(data.pulls) ? data.pulls : [],
    error: typeof data.error === "string" ? data.error : undefined,
    truncated: data.truncated === true,
  };
}
