/**
 * In-memory job registry for repo-wiki generation. A generation is a background
 * job (clone -> read -> structure -> pages -> publish); the route returns a job
 * id and the client polls status. Jobs are org-scoped on read, deduped per
 * (org, repo) so a re-submit joins the active job, and evicted a while after they
 * finish. Single-replica scope (matches the platform's current realtime scope);
 * a durable queue is a later slice.
 */
import { randomUUID } from "node:crypto";
import { cloneRepoToTemp } from "./clone";
import { resolveGithubRepositoryAccess } from "../github/auth";
import { generateWiki, type GenerateResult } from "./generate";
import { openRouterLlm } from "./llm";
import { readRepoFiles } from "./repo";
import { errorMessage } from "../util/error-message";

export type JobStatus =
  | "pending"
  | "cloning"
  | "structuring"
  | "generating"
  | "completed"
  | "failed";

export interface WikiJob {
  id: string;
  orgId: string;
  repo: string; // "owner/name"
  status: JobStatus;
  pagesTotal: number;
  pagesDone: number;
  error: string | null;
  result: GenerateResult | null;
  submittedAt: number;
}

const TERMINAL_TTL_MS = 10 * 60_000;

const jobs = new Map<string, WikiJob>();

function isTerminal(s: JobStatus): boolean {
  return s === "completed" || s === "failed";
}

/** The org-scoped, client-facing view of a job (never leaks another org's job). */
export function getJob(orgId: string, id: string): WikiJob | null {
  const job = jobs.get(id);
  return job && job.orgId === orgId ? job : null;
}

/** An active (non-terminal) job for this org+repo, if any. */
function activeFor(orgId: string, repo: string): WikiJob | null {
  for (const job of jobs.values()) {
    if (job.orgId === orgId && job.repo === repo && !isTerminal(job.status)) return job;
  }
  return null;
}

function scheduleEviction(id: string): void {
  setTimeout(() => {
    const job = jobs.get(id);
    if (job && isTerminal(job.status)) jobs.delete(id);
  }, TERMINAL_TTL_MS).unref?.();
}

async function runJob(job: WikiJob, userId: string | null): Promise<void> {
  const [owner, repo] = job.repo.split("/");
  let cleanup: (() => Promise<void>) | null = null;
  try {
    job.status = "cloning";
    const access = await resolveGithubRepositoryAccess(job.orgId);
    const cloned = await cloneRepoToTemp(job.repo, access);
    cleanup = cloned.cleanup;

    const files = await readRepoFiles(cloned.dir);
    if (files.size === 0) throw new Error("clone contained no readable files");

    job.status = "structuring";
    const result = await generateWiki({
      orgId: job.orgId,
      userId,
      owner: owner!,
      repo: repo!,
      defaultBranch: cloned.defaultBranch,
      files,
      llm: openRouterLlm,
      onProgress: ({ pagesTotal, pagesDone }) => {
        job.status = "generating";
        job.pagesTotal = pagesTotal;
        job.pagesDone = pagesDone;
      },
    });
    job.result = result;
    job.status = "completed";
  } catch (e) {
    job.status = "failed";
    job.error = errorMessage(e);
  } finally {
    if (cleanup) await cleanup();
    scheduleEviction(job.id);
  }
}

/**
 * Submit a generation for `repo` ("owner/name"). Get-or-create: a re-submit while
 * a job for the same org+repo is running joins that job instead of starting a
 * second. Returns the job (already running in the background).
 */
export function submitJob(orgId: string, userId: string | null, repo: string): WikiJob {
  const existing = activeFor(orgId, repo);
  if (existing) return existing;

  const job: WikiJob = {
    id: randomUUID(),
    orgId,
    repo,
    status: "pending",
    pagesTotal: 0,
    pagesDone: 0,
    error: null,
    result: null,
    submittedAt: Date.now(),
  };
  jobs.set(job.id, job);
  // Fire-and-forget: the job drives itself and is polled via getJob.
  void runJob(job, userId);
  return job;
}

/** Test/ops hook: drop all jobs. */
export function _clearJobs(): void {
  jobs.clear();
}
