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

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "list") {
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
