import postgres from "postgres";
import { env } from "../env";

// A fixed advisory-lock key identifying "THE skynet backend singleton for this database".
// Arbitrary 32-bit constant ("SkNt"); only its uniqueness within this app matters.
const SINGLETON_LOCK_KEY = 0x536b_4e74;

let held: postgres.ReservedSql | null = null;

/**
 * Enforce single-backend deployment for this release.
 *
 * WHY: canonicalization's provider-source drain/seal barrier (drainProviderEvents) and the
 * realtime SSE fan-out (thread-signals + canonical-events EventEmitters) are PROCESS-LOCAL.
 * `FOR UPDATE SKIP LOCKED` protects only which worker CLAIMS a canonicalization; it does
 * NOT make the seal or the live publish cross-replica. Two backends on the SAME database
 * therefore split the realtime fan-out and can canonicalize against a source another
 * replica is still writing. Until a durable, DB-backed provider-source seal exists,
 * exactly ONE backend per database is supported.
 *
 * HOW: acquire a SESSION-level Postgres advisory lock on a dedicated reserved connection
 * held for the process lifetime; a second backend on the same DB fails to acquire it.
 *   - default: log a clear WARNING and continue (dev + the test harness run many imports /
 *     throwaway DBs; never break them).
 *   - REQUIRE_SINGLE_BACKEND=1 (the release/production setting): a second backend REFUSES
 *     to boot (exit 1), so a duplicate replica can't silently split realtime + sealing.
 * The lock releases automatically when the process exits (the session ends). Returns
 * whether THIS process is the singleton (true = we hold the lock).
 */
export async function enforceSingleBackend(): Promise<boolean> {
  const holder = postgres(env.DATABASE_URL, { max: 1 });
  let acquired = false;
  try {
    const reserved = await holder.reserve();
    const [row] = await reserved`select pg_try_advisory_lock(${SINGLETON_LOCK_KEY}) as ok`;
    acquired = row?.ok === true;
    if (acquired) {
      held = reserved; // hold for the process lifetime; do NOT release
      return true;
    }
    await reserved.release();
  } catch (err) {
    // A guard failure must never wedge boot in dev; log and proceed (the lock is a safety
    // net, not a correctness dependency for a correctly-operated single backend).
    console.warn("[boot] single-backend guard skipped (advisory lock unavailable):", err instanceof Error ? err.message : err);
    await holder.end().catch(() => {});
    return true;
  }

  await holder.end().catch(() => {});
  const msg =
    "[boot] SINGLE-BACKEND: another skynet backend already holds the singleton lock on this database. " +
    "Canonicalization sealing + realtime SSE fan-out are process-local (single-replica); running two backends on one DB splits them.";
  if (process.env.REQUIRE_SINGLE_BACKEND === "1") {
    console.error(`${msg} Refusing to boot (REQUIRE_SINGLE_BACKEND=1). Run exactly one backend per database.`);
    process.exit(1);
  }
  console.warn(`${msg} Continuing (multi-replica realtime is UNSUPPORTED for this release; set REQUIRE_SINGLE_BACKEND=1 to make this fatal).`);
  return false;
}
