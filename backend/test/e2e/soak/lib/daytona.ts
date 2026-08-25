/**
 * Daytona cleanup helper for the soak suite. The soak's real-depth batches
 * create cloud sandboxes (label `skynet-run` → runId, per src/engines/sandbox.ts).
 * The user's hard rule: KEEP DAYTONA CLEAN — every sandbox a batch creates must
 * be deleted and its deletion VERIFIED via the API when the batch ends.
 *
 * SAFETY: other agent sessions run REAL sandboxes concurrently. We therefore
 * NEVER blanket-delete by label. `deleteById` deletes only ids the caller
 * recorded as its own; `listSkynet` is read-only inventory for reporting.
 *
 * CLI:
 *   bun test/e2e/soak/lib/daytona.ts list                 — inventory (read-only)
 *   bun test/e2e/soak/lib/daytona.ts delete <id> [<id>…]  — delete + verify these ids
 */
import { Daytona, type Sandbox } from "@daytona/sdk";
import postgres from "postgres";

export interface SandboxInfo {
  id: string;
  state: string | undefined;
  labels: Record<string, string>;
  createdAt: string | undefined;
}

function client(): Daytona {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("DAYTONA_API_KEY not set — cannot manage sandboxes");
  return new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });
}

/** Every sandbox visible to this org (read-only). Optionally filter by label. */
export async function listSkynet(labelKey = "skynet-run"): Promise<SandboxInfo[]> {
  const daytona = client();
  const out: SandboxInfo[] = [];
  for await (const sb of daytona.list()) {
    const labels = (sb as Sandbox).labels ?? {};
    if (labelKey && !(labelKey in labels)) continue;
    out.push({
      id: sb.id,
      state: (sb as { state?: string }).state,
      labels,
      createdAt: (sb as { createdAt?: string }).createdAt,
    });
  }
  return out;
}

/** All sandboxes (unfiltered) — for a true baseline count. */
export async function listAll(): Promise<SandboxInfo[]> {
  return listSkynet("");
}

/**
 * Delete the given sandbox ids and verify each is gone. Returns per-id outcome.
 * Idempotent: an already-absent id counts as deleted. Never throws for one bad id.
 */
export async function deleteById(
  ids: string[],
): Promise<{ deleted: string[]; failed: { id: string; error: string }[] }> {
  const daytona = client();
  const deleted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      const sb = await daytona.get(id).catch(() => null);
      if (!sb) {
        deleted.push(id); // already gone
        continue;
      }
      await daytona.delete(sb, 60, true); // wait: block until destroyed
      // Verify.
      const still = await daytona.get(id).catch(() => null);
      if (still && (still as { state?: string }).state !== "destroyed") {
        failed.push({ id, error: `still present after delete (state=${(still as { state?: string }).state})` });
      } else {
        deleted.push(id);
      }
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

/**
 * Orphan sweep (lead-authorized). Deletes skynet-run sandboxes that are safe to
 * reap, VERIFYING each deletion, and NEVER touching a box that belongs to live
 * work. A sandbox is deleted iff:
 *   (1) ORPHAN — its `skynet-run` label runId is NOT a row in the shared `useagent`
 *       runs table (a run whose sandbox outlived its (throwaway) DB), OR
 *   (2) STOPPED — its state is stopped/archived/paused (idle leftover).
 * `keepIds` (e.g. ids an agent reports active) are always spared. `dryRun` reports
 * the plan without deleting. Reads existing runIds from DATABASE_URL (read-only).
 */
export async function sweepOrphans(opts: { dryRun?: boolean; keepIds?: Set<string> } = {}): Promise<{
  scanned: number;
  existingRuns: number;
  spared: Array<{ id: string; run: string; state: string; reason: string }>;
  targeted: Array<{ id: string; run: string; state: string; reason: string }>;
  deleted: string[];
  failed: { id: string; error: string }[];
}> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL (shared useagent) not set — cannot classify orphans");
  const sql = postgres(dbUrl, { max: 1 });
  let existing: Set<string>;
  try {
    const rows = (await sql`select id from runs`) as unknown as Array<{ id: string }>;
    existing = new Set(rows.map((r) => r.id));
  } finally {
    await sql.end();
  }
  const boxes = await listSkynet();
  const keep = opts.keepIds ?? new Set<string>();
  const STOPPED = new Set(["stopped", "archived", "paused"]);
  const spared: Array<{ id: string; run: string; state: string; reason: string }> = [];
  const targeted: Array<{ id: string; run: string; state: string; reason: string }> = [];
  for (const b of boxes) {
    const run = b.labels["skynet-run"] ?? "";
    const state = b.state ?? "unknown";
    if (keep.has(b.id)) { spared.push({ id: b.id, run, state, reason: "keep-listed (agent active)" }); continue; }
    const isOrphan = !run || !existing.has(run);
    const isStopped = STOPPED.has(state);
    if (isOrphan) targeted.push({ id: b.id, run, state, reason: "orphan (runId absent from skynet.runs)" });
    else if (isStopped) targeted.push({ id: b.id, run, state, reason: `stopped (${state})` });
    else spared.push({ id: b.id, run, state, reason: "active (runId present, started)" });
  }
  let deleted: string[] = [];
  let failed: { id: string; error: string }[] = [];
  if (!opts.dryRun && targeted.length > 0) {
    const res = await deleteById(targeted.map((t) => t.id));
    deleted = res.deleted;
    failed = res.failed;
  }
  return { scanned: boxes.length, existingRuns: existing.size, spared, targeted, deleted, failed };
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "sweep-orphans" || mode === "sweep-dry") {
    const keepIds = new Set(rest.filter((x) => x.length > 8)); // any ids to spare
    const res = await sweepOrphans({ dryRun: mode === "sweep-dry", keepIds });
    console.log(`DAYTONA_SWEEP=${JSON.stringify({
      dryRun: mode === "sweep-dry",
      scanned: res.scanned,
      existingRuns: res.existingRuns,
      targeted: res.targeted.map((t) => ({ id: t.id.slice(0, 12), run: t.run.slice(0, 8), state: t.state, reason: t.reason })),
      spared: res.spared.map((s) => ({ id: s.id.slice(0, 12), run: s.run.slice(0, 8), state: s.state })),
      deleted: res.deleted.length,
      failed: res.failed,
    })}`);
    process.exit(res.failed.length === 0 ? 0 : 1);
  } else if (mode === "list") {
    const skynet = await listSkynet();
    const all = await listAll();
    console.log(
      `DAYTONA_INVENTORY=${JSON.stringify({
        total: all.length,
        skynetLabeled: skynet.length,
        skynet: skynet.map((s) => ({ id: s.id.slice(0, 12), state: s.state, run: s.labels["skynet-run"]?.slice(0, 8), createdAt: s.createdAt })),
      })}`,
    );
  } else if (mode === "delete") {
    if (rest.length === 0) {
      console.error("usage: daytona.ts delete <id> [<id>…]");
      process.exit(2);
    }
    const res = await deleteById(rest);
    console.log(`DAYTONA_DELETE=${JSON.stringify(res)}`);
    process.exit(res.failed.length === 0 ? 0 : 1);
  } else {
    console.error("usage: daytona.ts list | delete <id>…");
    process.exit(2);
  }
}
