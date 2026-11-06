// Ported from KiroCrew (https://github.com/kirodotdev/KiroCrew), Apache-2.0:
//   src/kiro_crew/cron.py
// Copyright Amazon.com, Inc. or its affiliates. Changed: rewritten in
// TypeScript for this codebase. License and NOTICE: third_party/licenses/kirocrew/.
// KiroCrew runs an asyncio timer that periodically fires due, enabled jobs;
// this is the Postgres-backed translation — a plain 60s interval tick.

import { botsEnabled } from "../bots/rollout";
import { isOccurrence } from "./cron";
import { firedThisMinute, listEnabledSchedules, markFired } from "./repo";
import { fireScheduleForOrg } from "./service";

const TICK_MS = process.env.SCHEDULER_TICK_MS
  ? Number(process.env.SCHEDULER_TICK_MS)
  : 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * One scheduler pass: fire every enabled schedule whose occurrence (cron.ts
 * isOccurrence, the rule nextOccurrence and so the API's next run follow) is
 * the current minute and that the tick has not fired in it yet. One minute's
 * check per schedule, however rare its cron. Across a DST change a fixed time
 * fires once, at its first reading of a repeated hour or right after a skipped
 * one. `markFired` stamps
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
    if (!isOccurrence(s.cron, s.timezone, now) || firedThisMinute(s, now)) continue;
    // Bot routines sit out while bots are switched off; they resume on the next
    // matching minute after the switch flips back.
    if (s.botId && !botsEnabled(s.orgId)) continue;
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
