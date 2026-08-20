import postgres from "postgres";
import { env } from "../env";

// A fixed advisory-lock key identifying "THE skynet backend singleton for this database".
// Arbitrary 32-bit constant ("SkNt"); only its uniqueness within this app matters.
const SINGLETON_LOCK_KEY = 0x536b_4e74;

let held: postgres.ReservedSql | null = null;

interface SingleBackendOptions {
  readonly required?: boolean;
  readonly connect?: typeof postgres;
}

/** Parse the deployment flag without truthy-string ambiguity. */
export function singleBackendRequired(value: string | undefined): boolean {
  switch (value?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "0":
    case "false":
      return false;
    case "1":
    case "true":
      return true;
    default:
      throw new Error("REQUIRE_SINGLE_BACKEND must be one of: 1, true, 0, false");
  }
}

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
 *   - REQUIRE_SINGLE_BACKEND=1/true (the release/production setting): contention or an
 *     unavailable guard throws during boot, so a duplicate can't split realtime + sealing.
 * The lock releases automatically when the process exits (the session ends). Returns
 * whether THIS process is the singleton (true = we hold the lock).
 */
export async function enforceSingleBackend(
  options: SingleBackendOptions = {},
): Promise<boolean> {
  const required =
    options.required ?? singleBackendRequired(process.env.REQUIRE_SINGLE_BACKEND);
  const holder = (options.connect ?? postgres)(env.DATABASE_URL, { max: 1 });
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
    const detail = err instanceof Error ? err.message : String(err);
    await holder.end().catch(() => {});
    if (required) {
      throw new Error(`[boot] single-backend guard unavailable: ${detail}`, { cause: err });
    }
    // Dev/test may deliberately run throwaway databases without strict singleton
    // enforcement. Production never reaches this fail-open branch.
    console.warn("[boot] single-backend guard skipped (advisory lock unavailable):", detail);
    return true;
  }

  await holder.end().catch(() => {});
  const msg =
    "[boot] SINGLE-BACKEND: another skynet backend already holds the singleton lock on this database. " +
    "Canonicalization sealing + realtime SSE fan-out are process-local (single-replica); running two backends on one DB splits them.";
  if (required) {
    throw new Error(`${msg} Refusing to boot. Run exactly one backend per database.`);
  }
  console.warn(`${msg} Continuing (multi-replica realtime is UNSUPPORTED for this release; set REQUIRE_SINGLE_BACKEND=true to make this fatal).`);
  return false;
}
