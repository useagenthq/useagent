import { Hono } from "hono";
import { DiscoveryError, parseRepoRef } from "../github/discovery";
import { isKnownRepo } from "../github/repos";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { importSkills, scanSkillCandidates } from "./import";

// ---------------------------------------------------------------------------
// GitHub skill import routes (multi-repo "import Skills from a repo"). Mounted
// at /api/skills/import, org-scoped like the rest of the skills surface. The
// GitHub credential stays server-side; a bad ref / unconfigured backend is a 400
// (client's problem) and a GitHub failure is a 502 (upstream), so the caller can
// tell "you asked wrong" from "GitHub is down".
// ---------------------------------------------------------------------------

export const skillImportRoutes = new Hono<AppEnv>();

skillImportRoutes.use("*", orgScope);

/** A bad ref / unconfigured backend is the caller's problem (400); a GitHub
 *  failure is upstream (502). */
function discoveryErrorStatus(e: DiscoveryError): 400 | 502 {
  return e.kind === "upstream" ? 502 : 400;
}

// GET /api/skills/import/scan?repo=owner/name — the SKILL.md files the repo
// offers, each tagged with whether this org already imported it.
skillImportRoutes.get("/scan", async (c) => {
  const repo = c.req.query("repo")?.trim() ?? "";
  if (!parseRepoRef(repo)) {
    return c.json({ error: "repo query param must be owner/name" }, 400);
  }
  if (!(await isKnownRepo(repo, c.get("orgId")))) {
    return c.json({ error: "repository is not available to this organization" }, 403);
  }
  try {
    return c.json(await scanSkillCandidates(c.get("orgId"), repo));
  } catch (e) {
    if (e instanceof DiscoveryError) return c.json({ error: e.message }, discoveryErrorStatus(e));
    throw e;
  }
});

// POST /api/skills/import { repo, paths[] } — fetch each path at the repo's
// current HEAD and create/update the corresponding org skill (unchanged is a
// no-op). Returns a per-path outcome.
skillImportRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!parseRepoRef(repo)) {
    return c.json({ error: "repo must be owner/name" }, 400);
  }
  if (!(await isKnownRepo(repo, c.get("orgId")))) {
    return c.json({ error: "repository is not available to this organization" }, 403);
  }
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];
  if (paths.length === 0) {
    return c.json({ error: "paths must be a non-empty array of file paths" }, 400);
  }

  try {
    return c.json(await importSkills(c.get("orgId"), repo, paths));
  } catch (e) {
    if (e instanceof DiscoveryError) return c.json({ error: e.message }, discoveryErrorStatus(e));
    throw e;
  }
});
