import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveRepoHeadSha } from "../../github/discovery";
import { listRepos } from "../../github/repos";
import { DEV_ORG_ID } from "../../seed";
import { cloneRepoAtHead } from "../../wiki-gen/clone";
import { upsertContextRow } from "../store";
import {
  classifyExcluded,
  extractRepoRecords,
  MAX_FILE_BYTES,
  type RepoFile,
} from "./extractor";
import { projectCode } from "./projector";

// ---------------------------------------------------------------------------
// Periodic repository CODE indexer (self_improving.md section 5). The automatic
// counterpart to skills-resync, for the `code` context kind. For each org-approved
// repo (serial, paced, bounded) it: resolves HEAD via one `git ls-remote` and
// SKIPS unchanged repos (5.3 incrementality - no clone on a restart); else shallow
// clones at HEAD, reads the bounded indexable file set, extracts + redacts CODE
// records (extractor.ts), projects them into context_index as kind="code", and
// records the sha. Per-repo error isolation; a failure never touches anything else.
//
// Config (operator decisions, read once at boot), mirroring SKILLS_RESYNC_*:
//   CODE_INDEX_INTERVAL_MIN  minutes between sweeps. Default 0 = DISABLED -
//                            background GitHub traffic + clone I/O is an explicit
//                            operator choice, never implicit.
//   CODE_INDEX_ORG_ID        org the records are projected under (the GitHub
//                            credential is process-global, so the target org is
//                            deployment config). Defaults to the seeded dev org.
// ---------------------------------------------------------------------------

/** Repos processed per sweep, hard cap (above the org's ~120 repos w/ headroom). */
const MAX_REPOS_PER_SWEEP = 200;
/** Files read + extracted per repo per sweep (bounds clone-walk cost). */
const MAX_FILES_PER_REPO = 4_000;
/** Total bytes read per repo per sweep (a second guard against a huge tree). */
const MAX_BYTES_PER_REPO = 32 * 1024 * 1024;
/** Delay between repos - gentle on GitHub and on local clone I/O. */
const REPO_PACING_MS = 2_000;

export interface CodeIndexConfig {
  intervalMin: number;
  orgId: string;
}

/** Resolve the code-index config, or null when disabled (the default). A garbage
 *  interval (non-numeric / <= 0) disables with a warning rather than looping. */
export function codeIndexConfig(
  env: Record<string, string | undefined> = process.env,
): CodeIndexConfig | null {
  const raw = env.CODE_INDEX_INTERVAL_MIN?.trim();
  if (!raw) return null; // unset -> disabled by default
  const intervalMin = Number(raw);
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
    if (intervalMin !== 0) {
      console.warn(
        `[code-index] CODE_INDEX_INTERVAL_MIN=${raw} is not a positive number - code indexing disabled.`,
      );
    }
    return null;
  }
  return {
    intervalMin,
    orgId: env.CODE_INDEX_ORG_ID?.trim() || DEV_ORG_ID,
  };
}

/** One repo cloned at a pinned commit, with its indexable files already read. */
export interface RepoSnapshot {
  commitSha: string;
  files: RepoFile[];
}

/** The sweep's collaborators, injectable so tests drive orchestration (pacing,
 *  bounds, error isolation, unchanged-sha skip) with fakes and zero GitHub/DB. */
export interface CodeIndexDeps {
  listRepos: (orgId: string) => Promise<{
    configured: boolean;
    repos: readonly { full_name: string }[];
    error?: string;
  }>;
  resolveHeadSha: (repo: string) => Promise<string>;
  /** Clone the repo at HEAD and read its bounded indexable file set. */
  snapshot: (repo: string) => Promise<RepoSnapshot>;
  /** Project + upsert one extracted record's context row (org-scoped). */
  projectRecords: (orgId: string, repo: string, snap: RepoSnapshot) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  maxReposPerSweep: number;
  repoPacingMs: number;
}

/** Walk a cloned repo dir and read every indexable file within the bounds. Skips
 *  excluded trees UP FRONT (classifyExcluded) so a node_modules is never read. */
export async function readIndexableFiles(dir: string): Promise<RepoFile[]> {
  const all = (await readdir(dir, { recursive: true })) as string[];
  const out: RepoFile[] = [];
  let totalBytes = 0;
  for (const rel of all.sort((a, b) => a.localeCompare(b))) {
    if (out.length >= MAX_FILES_PER_REPO || totalBytes >= MAX_BYTES_PER_REPO) break;
    if (rel.startsWith(".git/") || rel === ".git") continue;
    // Cheap path-based exclusion before any stat/read.
    if (classifyExcluded(rel)) continue;
    const abs = join(dir, rel);
    let sizeBytes: number;
    try {
      const s = await stat(abs);
      if (!s.isFile()) continue;
      sizeBytes = s.size;
    } catch {
      continue;
    }
    if (sizeBytes > MAX_FILE_BYTES) {
      // Record the path with empty text so the extractor reports too_large; but
      // don't read a huge file into memory.
      out.push({ path: rel, text: "", sizeBytes });
      continue;
    }
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    totalBytes += sizeBytes;
    out.push({ path: rel, text, sizeBytes });
  }
  return out;
}

/** Real snapshot: shallow-clone at HEAD, read the bounded indexable file set,
 *  clean up the clone. */
async function realSnapshot(repo: string): Promise<RepoSnapshot> {
  const cloned = await cloneRepoAtHead(repo);
  try {
    const files = await readIndexableFiles(cloned.dir);
    return { commitSha: cloned.commitSha, files };
  } finally {
    await cloned.cleanup();
  }
}

/** Real projection: extract + redact records, project each as kind="code", upsert.
 *  Returns the number of rows upserted. */
async function realProjectRecords(
  orgId: string,
  repo: string,
  snap: RepoSnapshot,
): Promise<number> {
  const { records } = extractRepoRecords(snap.files);
  let projected = 0;
  for (const record of records) {
    const projection = projectCode({ repo, commitSha: snap.commitSha }, record);
    await upsertContextRow({ ...projection, orgId });
    projected++;
  }
  return projected;
}

function defaultDeps(): CodeIndexDeps {
  return {
    listRepos,
    resolveHeadSha: resolveRepoHeadSha,
    snapshot: realSnapshot,
    projectRecords: realProjectRecords,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    maxReposPerSweep: MAX_REPOS_PER_SWEEP,
    repoPacingMs: REPO_PACING_MS,
  };
}

export interface CodeIndexSummary {
  reposListed: number;
  reposIndexed: number;
  /** HEAD sha unchanged since the last successful index - skipped pre-clone. */
  reposUnchangedHead: number;
  reposFailed: number;
  /** Total context_index code rows upserted this sweep. */
  recordsProjected: number;
}

/** Last successfully-indexed HEAD sha per `${orgId}|${repo}`. In-memory only: a
 *  restart re-verifies each repo once via ls-remote (unchanged content is a no-op
 *  upsert), which is exactly the 5.3 "no full-rescan on restart" contract. */
const lastIndexedSha = new Map<string, string>();

/** Test hook: forget indexed HEADs so the next sweep re-indexes everything. */
export function clearCodeIndexStateForTest(): void {
  lastIndexedSha.clear();
}

/**
 * One code-index sweep: list the org's repos and, for each (serial, paced,
 * bounded), skip on an unchanged HEAD, else snapshot + project. Never throws;
 * every failure is contained to its repo and counted.
 */
export async function runCodeIndexSweep(
  orgId: string,
  deps: CodeIndexDeps = defaultDeps(),
): Promise<CodeIndexSummary> {
  const startedAt = Date.now();
  const summary: CodeIndexSummary = {
    reposListed: 0,
    reposIndexed: 0,
    reposUnchangedHead: 0,
    reposFailed: 0,
    recordsProjected: 0,
  };

  let listing: Awaited<ReturnType<CodeIndexDeps["listRepos"]>>;
  try {
    listing = await deps.listRepos(orgId);
  } catch (err) {
    console.error("[code-index] repo listing failed:", err);
    return summary;
  }
  if (!listing.configured) {
    console.log("[code-index] github not configured; sweep skipped");
    return summary;
  }
  if (listing.error) {
    console.error(`[code-index] repo listing failed: ${listing.error}`);
    return summary;
  }

  summary.reposListed = listing.repos.length;
  const repos = listing.repos.slice(0, deps.maxReposPerSweep);

  for (let i = 0; i < repos.length; i++) {
    if (i > 0) await deps.sleep(deps.repoPacingMs);
    const repo = repos[i]!.full_name;
    const shaKey = `${orgId}|${repo}`;
    try {
      const head = await deps.resolveHeadSha(repo);
      if (lastIndexedSha.get(shaKey) === head) {
        summary.reposUnchangedHead++;
        continue;
      }
      const snap = await deps.snapshot(repo);
      summary.reposIndexed++;
      summary.recordsProjected += await deps.projectRecords(orgId, repo, snap);
      // Record the SNAPSHOT sha (the commit we actually read), not the ls-remote
      // head, so a race that advanced HEAD mid-clone re-indexes next sweep.
      lastIndexedSha.set(shaKey, snap.commitSha);
    } catch (err) {
      summary.reposFailed++;
      console.error(
        `[code-index] repo ${repo} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[code-index] sweep: repos listed=${summary.reposListed} ` +
      `indexed=${summary.reposIndexed} unchanged-head=${summary.reposUnchangedHead} ` +
      `failed=${summary.reposFailed} records=${summary.recordsProjected} ` +
      `(${Date.now() - startedAt}ms)`,
  );
  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * Start the periodic code-index loop. No-op unless CODE_INDEX_INTERVAL_MIN is a
 * positive number (disabled by default - enabling is an operator decision). Runs
 * one sweep at boot, then every interval; a still-running sweep skips the tick
 * (single-flight). `unref`'d so it never keeps the process alive. Idempotent.
 */
export function startCodeIndex(): void {
  if (timer) return;
  const config = codeIndexConfig();
  if (!config) return;

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      await runCodeIndexSweep(config.orgId);
    } catch (err) {
      console.error("[code-index] sweep failed:", err);
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
    `[code-index] started (every ${config.intervalMin}min, org=${config.orgId})`,
  );
}
