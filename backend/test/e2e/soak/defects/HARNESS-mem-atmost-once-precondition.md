# HARNESS ARTIFACT (not a backend defect) — mem-atmost-once "exactly one add attempt in flight at kill" = 0

- **Verdict:** HARNESS RACE. The memory at-most-once invariant is INTACT.
- **Signature:** `[mem-atmost-once] exactly one add attempt in flight at kill — 0`, seed 1256096767, commit 457e627.
- **Fix:** commit `de4b796` (gate the kill on the receiver having received the POST).

## Ground truth
The failing check was only the PRECONDITION count. In the same failing cycle the
CORE at-most-once assertions PASSED (they were not in the defect list):
- "orphaned capture stays 'delivering' after reboot (never auto-reset)" ✅
- "no auto-retry after crash (at-most-once: ≤1 add ever)" ✅

So the documented design held: the crash-orphaned `delivering` row was left for
manual inspection, never auto-reset to pending, never re-delivered (no duplicate
L0 team-memory turn).

## Root cause (harness)
`claimDue` (memory capture-outbox) flips the row to `delivering` in a CTE UPDATE
BEFORE `deliverTeamMemory` sends the POST. The storm waited only on
`state='delivering'` then immediately counted the mock gateway's add hits — the
POST hadn't left the process yet, so `addsFor(prompt)` read 0. The kill then landed
before the delivery loop's POST went out; "0 in flight" was legitimate for that
timing, but the assertion wrongly required exactly 1.

Fix: gate the kill on `state='delivering' AND addsFor(prompt) >= 1` (the hanging
mock gateway records the hit on receipt, before its held-open response) — so the
kill always orphans a genuinely in-flight delivery.

## Evidence
Repro on the exact seed with the fixed harness:
`SOAK_SEED=1256096767 SOAK_MEMCRASH_CYCLES=8 bun storms/mem-atmost-once.ts`
→ 8 cycles, 40 checks, **0 failures**. Post-restart row stays `delivering`, adds ≤1
every cycle. Backend behavior was correct throughout.
