// Ported from reference bot (Apache-2.0): src/kiro_crew/cron.py
// reference bot runs an asyncio timer that periodically fires due, enabled jobs;
// this is the Postgres-backed translation — a plain 60s interval tick.

import { cronMatches } from "./cron";
import { listEnabledSchedules, markFired } from "./repo";
import { fireScheduleForOrg } from "./service";

const TICK_MS = process.env.SCHEDULER_TICK_MS
  ? Number(process.env.SCHEDULER_TICK_MS)
  : 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Two dates fall in the same clock minute (epoch-minute bucket). */
function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
}

/**
 * One scheduler pass: fire every enabled schedule whose cron matches the
 * current minute and that hasn't already fired this minute. `markFired` stamps
 * the minute AFTER the durable command is accepted — stamping first opened a
 * loss window (accept fails after the stamp → that occurrence is skipped
 * forever; external audit finding). Duplicates from the reverse ordering are
 * already impossible at the durable layer: the firing's idempotency key buckets
 * to the occurrence minute, so a re-fire after a failed stamp resolves to the
 * same single run. Exported for tests.
 */
export async function tick(now: Date = new Date()): Promise<void> {
  let due;
  try {
    due = await listEnabledSchedules();
  } catch (err) {
    console.error("[scheduler] tick query failed:", err);
    return;
  }

  for (const s of due) {
    if (!cronMatches(s.cron, now, s.timezone)) continue;
    if (s.lastFiredAt && sameMinute(new Date(s.lastFiredAt), now)) continue;
    try {
      // Pass the tick time as the occurrence so the firing's idempotency key
      // buckets to this minute — the durable safety net that makes fire-then-
      // stamp safe (a re-fire for the same occurrence resolves to one run).
      await fireScheduleForOrg(s, "cron", now);
      await markFired(s.id, now);
      console.log(`[scheduler] fired schedule ${s.id} (${s.name})`);
    } catch (err) {
      console.error(`[scheduler] failed to fire schedule ${s.id}:`, err);
    }
  }
}

/**
 * Start the always-on scheduler loop. Harmless when no schedule is enabled
 * (default), and `unref`'d so it never keeps the process alive on its own.
 * Idempotent.
 */
export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
  console.log(`[scheduler] started (${TICK_MS}ms tick)`);
}
