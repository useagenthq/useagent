import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { isKnownRepo } from "../github/repos";
import { isValidRepoRef } from "./clone";
import { wikiLlmEnabled } from "./llm";
import { getJob, submitJob, type WikiJob } from "./jobs";

/**
 * Repo-wiki generation API — mounted at /api/wiki. Org-scoped (orgScope resolves
 * the tenant server-side; callers never select an org). POST kicks off a
 * background job that clones the repo, generates a per-page architecture wiki,
 * and publishes each page as an org-scoped document + immutable revision; GET
 * polls the job. The generated pages are then readable via the knowledge/wiki
 * document routes and searchable via knowledge_search.
 */
export const wikiGenRoutes = new Hono<AppEnv>();

wikiGenRoutes.use("*", orgScope);

/** Client-facing job shape (no internal fields beyond what the UI polls). */
function toApi(job: WikiJob) {
  return {
    jobId: job.id,
    repo: job.repo,
    status: job.status,
    pagesTotal: job.pagesTotal,
    pagesDone: job.pagesDone,
    error: job.error,
    result: job.result,
    submittedAt: job.submittedAt,
  };
}

// POST /api/wiki/generate {repo} — start (or join) a generation job.
wikiGenRoutes.post("/generate", async (c) => {
  if (!wikiLlmEnabled()) {
    return c.json({ error: "wiki generation is not configured (OPENROUTER_API_KEY)" }, 503);
  }
  let body: { repo?: unknown };
  try {
    body = (await c.req.json()) as { repo?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!isValidRepoRef(repo)) return c.json({ error: "`repo` must be 'owner/name'" }, 400);
  // Only generate for repos the backend actually offers (same gate as run.repo).
  if (!(await isKnownRepo(repo))) {
    return c.json({ error: `repo not available: ${repo}` }, 400);
  }
  const job = submitJob(c.get("orgId"), c.get("userId"), repo);
  return c.json(toApi(job));
});

// GET /api/wiki/generate/:jobId — poll a generation job (org-scoped).
wikiGenRoutes.get("/generate/:jobId", (c) => {
  const job = getJob(c.get("orgId"), c.req.param("jobId"));
  if (!job) return c.json({ error: "job not found" }, 404);
  return c.json(toApi(job));
});

export default wikiGenRoutes;
