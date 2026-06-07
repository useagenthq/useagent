# DEFECT-1 — Concurrent same-key POST /api/runs returns 500 instead of idempotent 200 replay

- **STATUS: FIXED** — commit `bd8356e fix(db): sqlStateOf walks the error cause chain (soak DEFECT-1)`.
  `sqlStateOf` now walks up to 5 `.cause` levels, fixing every `isUniqueViolation`
  caller at once. Re-verified by the soak: idempotency storm at 40-concurrency × 3
  rounds → 30 checks, 0 failures (was ~all-losers-500). Storm stays in rotation to
  guard against regression.
- **Found by:** soak storm `idempotency` (SIGKILL-free, pure concurrency)
- **Commit found against:** 75b12ae … 8bf24d7 (rebuild/useAgent-a)
- **Severity:** HIGH (availability + correctness of the Idempotency-Key contract).
  Data integrity is NOT compromised — exactly one run/command is still created.
- **Repro:**
  `SOAK_IDEM_ROUNDS=3 SOAK_IDEM_CONCURRENCY=20 bun test/e2e/soak/storms/idempotency.ts`
  Fire N concurrent POST /api/runs with the SAME `Idempotency-Key` + payload.
  Observed statuses (round 1): `500,201,500,500,…` — one 201 winner, the rest 500.
  Escalates across rounds (round 0 racy/clean → rounds 1+ ~all losers 500).

## Root cause (definitive)
`src/commands/service.ts::acceptRunCommand` catch:
```ts
if (input.idempotencyKey && isUniqueViolation(err)) { …re-read + replay… }
throw err;   // ← reached, because isUniqueViolation(err) === false
```
`insertCommandWithRun` throws on the concurrent `uq_commands_idem` violation, but
drizzle wraps the driver error: `err.constructor.name === "DrizzleQueryError"`,
`err.code === undefined`, and the SQLSTATE lives on `err.cause`:

```
CONSTRUCTOR= DrizzleQueryError
TOP.code= undefined
cause.code= "23505"
isUniqueViolation(err)        = false   ← the bug
isUniqueViolation(err.cause)  = true
```
`src/db/pg-errors.ts::isUniqueViolation` reads only the TOP-level `.code`, so it
misses the wrapped violation → the replay path is skipped → 500.

Why the fast-path masks it sometimes: `acceptRunCommand` first does
`findCommandByKey`; a loser that arrives AFTER the winner commits is caught there
(clean 200). Only losers that pass the fast-path and then lose the INSERT race hit
the un-detected violation → 500. Higher contention (later rounds) → more such losers.

## Fix direction (NOT applied — QA does not patch src/)
Make `isUniqueViolation` (and any pg-errors predicate) unwrap: check `err.code`
AND `err.cause?.code` (drizzle `DrizzleQueryError`), i.e. walk the cause chain.
That single change fixes every `isUniqueViolation` caller at once.

## Blast radius
Any `isUniqueViolation(err)` over a drizzle query error is blind the same way.
In the command path this is the only catch, but the predicate is shared.
