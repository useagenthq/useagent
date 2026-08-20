import { resolveRepoHeadSha } from "../github/discovery";
import { listRepos } from "../github/repos";
import { DEV_ORG_ID } from "../seed";
import { importSkills, scanSkillCandidates } from "./import";

// ---------------------------------------------------------------------------
// Periodic GitHub skill resync — the automatic counterpart to the manual
// GET /api/skills/import/scan + POST /api/skills/import flow. The org's repos
// carry real `.claude/skills/**/SKILL.md` files; this boot-started interval job
// lists them through the same repo listing the composer uses, scans each with
// the same scan function, and imports new/changed skills through the same
// source-keyed upsert, so nothing depends on an operator remembering to import
// each repo by hand.
//
// Config (both operator decisions, read once at boot in startSkillsResync):
//   SKILLS_RESYNC_INTERVAL_MIN  minutes between sweeps. Default 0 = DISABLED —
//                               enabling background GitHub traffic is an
//                               explicit operator choice, never implicit.
//   SKILLS_RESYNC_ORG_ID        org that receives the imports. The GitHub
//                               credential is process-global (one installation
//                               per backend), so the target org is deployment
//                               config, not per-request. Defaults to the seeded
//                               dev org for a single-tenant dev bring-up; a
//                               production deploy enabling the job sets it.
//
// Sweep shape: serial over the listed repos with a small pacing delay between
// them and a hard per-sweep repo bound. Steady state is cheap: a repo whose
// HEAD sha is unchanged since its last successful sync is skipped on a single
// `git ls-remote` (no clone, no per-file reads). A failed repo logs and the
// sweep continues — a resync failure never affects anything else.
//
// Idempotency + races: safe to run while a manual import happens. The import
// goes through importSkillFromSource (src/skills/import-repo.ts) — a
// transactional upsert keyed by (org_id, source_repo, source_path) that
// compares the rendered content hash and no-ops when unchanged, so re-importing
// unchanged content from either lane is free. Concurrent changed-content
// imports of the same path cannot double-append: uq_skill_rev(skill_id,
// version) lets exactly one transaction win; the loser errors, is counted as a
// failed repo here, and resolves to "unchanged" on the next sweep. No extra
// locking is needed in this job.
// ---------------------------------------------------------------------------

/** Repos processed per sweep, hard cap. Above the org's ~120 real repos with
 *  headroom; anything beyond is picked up next sweep after its turn. */
const MAX_REPOS_PER_SWEEP = 200;
/** Delay between repos — gentle on GitHub and on local clone I/O. */
const REPO_PACING_MS = 2_000;

export interface SkillsResyncConfig {
  intervalMin: number;
  orgId: string;
}

/** Resolve the resync config, or null when disabled (the default). A garbage
 *  interval (non-numeric / <= 0) disables with a warning rather than looping. */
export function skillsResyncConfig(
  env: Record<string, string | undefined> = process.env,
): SkillsResyncConfig | null {
  const raw = env.SKILLS_RESYNC_INTERVAL_MIN?.trim();
  if (!raw) return null; // unset → disabled by default
  const intervalMin = Number(raw);
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
    if (intervalMin !== 0) {
      console.warn(
        `[skills-resync] SKILLS_RESYNC_INTERVAL_MIN=${raw} is not a positive number — resync disabled.`,
      );
    }
    return null;
  }
  return {
    intervalMin,
    orgId: env.SKILLS_RESYNC_ORG_ID?.trim() || DEV_ORG_ID,
  };
}

/** The sweep's collaborators, injectable so tests drive orchestration (pacing,
 *  bounds, error isolation) with fakes and zero GitHub/DB traffic. Structural
 *  subsets of the real functions' types — the defaults satisfy them as-is. */
export interface SkillsResyncDeps {
  listRepos: (orgId: string) => Promise<{
    configured: boolean;
    repos: readonly { full_name: string }[];
    error?: string;
  }>;
  resolveHeadSha: (repo: string) => Promise<string>;
  scan: (
    orgId: string,
    repo: string,
  ) => Promise<{ sha: string; candidates: readonly { path: string }[] }>;
  importPaths: (
    orgId: string,
    repo: string,
    paths: string[],
  ) => Promise<{
    results: readonly { path: string; action: "created" | "updated" | "unchanged" | "skipped" | "protected" }[];
  }>;
  sleep: (ms: number) => Promise<void>;
  maxReposPerSweep: number;
  repoPacingMs: number;
}

function defaultDeps(): SkillsResyncDeps {
  return {
    listRepos,
    resolveHeadSha: resolveRepoHeadSha,
    scan: scanSkillCandidates,
    importPaths: importSkills,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    maxReposPerSweep: MAX_REPOS_PER_SWEEP,
    repoPacingMs: REPO_PACING_MS,
  };
}

export interface SkillsResyncSummary {
  reposListed: number;
  reposScanned: number;
  /** HEAD sha unchanged since the last successful sync — skipped pre-clone. */
  reposUnchangedHead: number;
  reposFailed: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Per-path import skips (not_found / too_large), surfaced never silent. */
  skippedPaths: number;
}

/** Last successfully-synced HEAD sha per `${orgId}|${repo}`. In-memory only: a
 *  restart just re-verifies every repo once (all unchanged content no-ops). */
const lastSyncedSha = new Map<string, string>();

/** Test hook: forget synced HEADs so the next sweep re-scans everything. */
export function clearResyncStateForTest(): void {
  lastSyncedSha.clear();
}

/**
 * One resync sweep: list the org's repos, and for each (serial, paced, bounded)
 * scan for SKILL.md candidates and import them — the source-keyed upsert turns
 * unchanged content into no-ops, so only genuinely new/changed skills write.
 * Never throws; every failure is contained to its repo and counted.
 */
export async function runSkillsResyncSweep(
  orgId: string,
  deps: SkillsResyncDeps = defaultDeps(),
): Promise<SkillsResyncSummary> {
  const startedAt = Date.now();
  const summary: SkillsResyncSummary = {
    reposListed: 0,
    reposScanned: 0,
    reposUnchangedHead: 0,
    reposFailed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedPaths: 0,
  };

  let listing: Awaited<ReturnType<SkillsResyncDeps["listRepos"]>>;
  try {
    listing = await deps.listRepos(orgId);
  } catch (err) {
    console.error("[skills-resync] repo listing failed:", err);
    return summary;
  }
  if (!listing.configured) {
    console.log("[skills-resync] github not configured; sweep skipped");
    return summary;
  }
  if (listing.error) {
    console.error(`[skills-resync] repo listing failed: ${listing.error}`);
    return summary;
  }

  summary.reposListed = listing.repos.length;
  const repos = listing.repos.slice(0, deps.maxReposPerSweep);

  for (let i = 0; i < repos.length; i++) {
    if (i > 0) await deps.sleep(deps.repoPacingMs);
    const repo = repos[i]!.full_name;
    const shaKey = `${orgId}|${repo}`;
    try {
      // Steady-state short-circuit: one `git ls-remote` instead of a clone when
      // nothing moved. Note this also means a skill DELETED org-side is not
      // resurrected until the repo's HEAD advances — deliberate: resync mirrors
      // source changes, it does not fight operator deletions.
      const head = await deps.resolveHeadSha(repo);
      if (lastSyncedSha.get(shaKey) === head) {
        summary.reposUnchangedHead++;
        continue;
      }

      const scan = await deps.scan(orgId, repo);
      summary.reposScanned++;
      const paths = scan.candidates.map((c) => c.path);
      if (paths.length > 0) {
        // Import every candidate (not just !alreadyImported): changed content
        // on an already-imported path must append a revision, and the upsert's
        // hash compare makes the unchanged rest free.
        const imported = await deps.importPaths(orgId, repo, paths);
        for (const outcome of imported.results) {
          if (outcome.action === "created") summary.created++;
          else if (outcome.action === "updated") summary.updated++;
          else if (outcome.action === "unchanged") summary.unchanged++;
          else summary.skippedPaths++;
        }
      }
      lastSyncedSha.set(shaKey, scan.sha);
    } catch (err) {
      summary.reposFailed++;
      console.error(
        `[skills-resync] repo ${repo} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[skills-resync] sweep: repos listed=${summary.reposListed} ` +
      `scanned=${summary.reposScanned} unchanged-head=${summary.reposUnchangedHead} ` +
      `failed=${summary.reposFailed}; skills created=${summary.created} ` +
      `updated=${summary.updated} unchanged=${summary.unchanged} ` +
      `skipped=${summary.skippedPaths} (${Date.now() - startedAt}ms)`,
  );
  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * Start the periodic resync loop. No-op unless SKILLS_RESYNC_INTERVAL_MIN is a
 * positive number (disabled by default — enabling is an operator decision).
 * Runs one sweep at boot, then every interval; a still-running sweep skips the
 * tick (single-flight). `unref`'d so it never keeps the process alive.
 * Idempotent.
 */
export function startSkillsResync(): void {
  if (timer) return;
  const config = skillsResyncConfig();
  if (!config) return;

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      await runSkillsResyncSweep(config.orgId);
    } catch (err) {
      // runSkillsResyncSweep contains its own failures; this is the last-resort
      // guard so a resync bug can never take anything else down.
      console.error("[skills-resync] sweep failed:", err);
    } finally {
      sweeping = false;
    }
  };

  void sweep();
  timer = setInterval(() => {
    void sweep();
  }, config.intervalMin * 60_000);
  timer.unref?.();
  console.log(
    `[skills-resync] started (every ${config.intervalMin}min, org=${config.orgId})`,
  );
}
